import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { systemClock } from '../extensions/filament/protocol.ts';
import type { Clock, Fetch } from '../extensions/filament/protocol.ts';
import type { Item, Message } from '../extensions/filament/render.ts';
export class FakeClock implements Clock {
  time = Date.now(); next = 0;
  timers = new Map<number, {at: number; fn: () => void}>();
  sleeps: number[] = [];
  now = () => this.time;
  timer = (fn: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, {at: this.time + ms, fn}); this.sleeps.push(ms); return id; };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  async tick(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.time = end; await flush();
  }
}
export async function flush(rounds = 12) { for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
export function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
export type Script = {status?: number; error?: number; raw?: string; result?: any; delay?: number; gate?: Promise<void>; ignoreAbort?: boolean; sse?: boolean};
export class FakeFilament {
  endpoint = 'http://filament.invalid/mcp/agents';
  clock: Clock;
  requests: {name: string; body: any; args: any; session?: string}[] = [];
  scripts = new Map<string, Script[]>();
  channels = new Map<string, Item>();
  consume = false;
  acknowledged = 0;
  identity = {user_id: '@agent:fake.test', display_name: 'Test Agent', owner: {display_name: 'Test Principal'}, cc_room_id: '!private:fake.test'};
  mediaStatus = 200;
  mediaBytes = 3;
  server?: Server;
  session = 'fake-session';
  posts: any[] = [];
  constructor(clock: Clock = systemClock) { this.clock = clock; }
  script(name: string, ...scripts: Script[]) { this.scripts.set(name, [...this.scripts.get(name) ?? [], ...scripts]); }
  enqueue(id: string, channel = '!private:fake.test', options: Partial<Message> & {backchannel?: boolean; thread?: string} = {}) {
    const item = this.channels.get(channel) ?? {channel_id: channel, is_backchannel: options.backchannel ?? true, messages: [], reply_with: null};
    item.messages.push({event_id: id, sender: '@sender:fake.test', body: `Message ${id}`, ts: this.clock.now(), ...options});
    item.thread_id = options.thread;
    item.reply_with = options.thread ? {tool: 'reply_in_thread', args: {message_id: options.thread}} : {tool: 'post_message', args: {channel, in_reply_to: id}};
    this.channels.set(channel, item); return item;
  }
  count(name: string) { return this.requests.filter(r => r.name === name).length; }
  fetch: Fetch = async (url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const name = url.includes('/media?') ? 'media' : url.endsWith('/heartbeat') ? 'heartbeat' : body?.method === 'tools/call' ? body.params.name : body?.method;
    const args = body?.params?.arguments;
    this.requests.push({name, body, args, session: new Headers(init.headers).get('Mcp-Session-Id') ?? undefined});
    const script = this.scripts.get(name)?.shift();
    if (script?.delay || script?.gate) {
      await new Promise<void>((resolve, reject) => {
        const timer = script.delay ? this.clock.timer(resolve, script.delay) : undefined;
        script.gate?.then(resolve);
        if (!script.ignoreAbort) {
          const abort = () => { if (timer) this.clock.clear(timer); reject(new Error('aborted')); };
          if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, {once: true});
        }
      });
    }
    if (name === 'media') {
      const bytes = this.mediaBytes; let sent = 0;
      return new Response(new ReadableStream({pull(controller) {
        if (sent >= bytes) controller.close();
        else { const size = Math.min(1024 * 1024, bytes - sent); sent += size; controller.enqueue(new Uint8Array(size)); }
      }}), {status: script?.status ?? this.mediaStatus});
    }
    if (name === 'heartbeat') return new Response('', {status: script?.status ?? 200});
    if (script?.raw !== undefined) return new Response(script.raw, {status: script.status ?? 200, headers: {'Content-Type': 'text/html'}});
    if (script?.status && script.status !== 200) return new Response('HTTP failure', {status: script.status});
    if (script?.error) return Response.json({jsonrpc: '2.0', id: body.id, error: {code: script.error, message: 'scripted rejection'}});
    if (name === 'notifications/initialized') return new Response(null, {status: 204});
    let result: any = script?.result;
    if (result === undefined) {
      if (name === 'initialize') result = {protocolVersion: '2024-11-05'};
      else if (name === 'get_self') result = this.identity;
      else if (name === 'poll_work') result = {work: structuredClone([...this.channels.values()]), cursor: 'next', next_poll_ms: 1000, truncated: false, acknowledged: this.acknowledged};
      else if (name === 'get_recent_messages') result = {messages: structuredClone(this.channels.get(args.channel)?.messages ?? [])};
      else if (name === 'get_thread') result = {messages: structuredClone([...this.channels.values()].find(c => c.thread_id === args.message_id)?.messages ?? [])};
      else if (name === 'get_user_profile') result = {display_name: 'Sender'};
      else if (['post_message', 'reply_in_thread', 'message_principal'].includes(name)) {
        result = {event_id: `$posted-${this.posts.length + 1}`}; this.posts.push({name, args});
        if (this.consume && name !== 'message_principal') {
          for (const [channel, item] of this.channels) {
            if (channel === args.channel || item.thread_id === args.message_id) this.channels.delete(channel);
          }
        }
      } else result = {};
    }
    const payload = {jsonrpc: '2.0', id: body.id, result: name === 'initialize' ? result : {content: [{type: 'text', text: JSON.stringify(result)}]}};
    const headers = {'Mcp-Session-Id': this.session};
    return script?.sse ? new Response(`data: {}\n\ndata: ${JSON.stringify(payload)}\n\ndata: [DONE]\n`, {headers: {...headers, 'Content-Type': 'text/event-stream'}}) : Response.json(payload, {headers});
  };
  async listen() {
    this.server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await this.fetch(this.endpoint + req.url!.replace('/mcp/agents', ''), {method: req.method, headers: req.headers as any, body: chunks.length ? Buffer.concat(chunks).toString() : undefined});
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as any).port}/mcp/agents`; return this.endpoint;
  }
  async close() { this.server?.closeAllConnections(); await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve()); }
}
