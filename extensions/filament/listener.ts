import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { credential, fingerprint, settings } from './credential.ts';
import { FilamentClient, FilamentError, sleep, systemClock } from './protocol.ts';
import type { Clock, Fetch } from './protocol.ts';
import { ListenerLock, ADMISSION } from './lock.ts';
import type { LockHooks } from './lock.ts';
import { Store, Mutex } from './state.ts';
import type { Attempt } from './state.ts';
import { render, localpart, clean } from './render.ts';
import type { Batch, Identity, Item, Message } from './render.ts';

export type Run = {client: FilamentClient; abort: AbortController; polling: AbortController; lock: ListenerLock;
  fingerprint: string; stopping: boolean; timers: Set<unknown>; sends: Set<Promise<unknown>>; cursor?: string; ackIds: string[]; failures: number; namingAt?: number};
type Binding = {run: Run; gen: number};
export type ProcessState = {incarnation?: number; nonce?: string; counter?: number; notices?: Set<string>; names?: Map<string, string>; active?: Listener};
export type Options = {agentDir: () => string; endpoint?: () => string; clock?: Clock; fetch?: Fetch;
  autoLoop?: boolean; processState?: (directory: string) => ProcessState; log?: (message: string) => void; lockHooks?: LockHooks; checkpoint?: (name: string) => Promise<void>};
export class Listener {
  pi: Pick<ExtensionAPI, 'sendMessage' | 'appendEntry'>;
  ctx?: ExtensionContext;
  options: Options;
  clock: Clock;
  current?: Run;
  store?: Store;
  generation = 0;
  batches = new Map<string, Batch>();
  inFlight = new Set<string>();
  unanswered = new Map<string, Set<string>>();
  names = new Map<string, string>();
  mediaMutex = new Mutex();
  mediaFiles = new Map<string, Set<string>>();
  identity?: Identity;
  status = 'stopped';
  lastPoll?: number;
  config = {wait: 30, autoStart: true, contextMessages: 25, warnings: [] as string[]};
  processState: ProcessState = {};
  get incarnation() { return this.processState.incarnation; }
  set incarnation(value: number | undefined) { this.processState.incarnation = value; }
  get nonce() { return this.processState.nonce; }
  set nonce(value: string | undefined) { this.processState.nonce = value; }
  get counter() { return this.processState.counter ?? 0; }
  set counter(value: number) { this.processState.counter = value; }
  runStartedAt = 0;
  notices = new Set<string>();
  lifecycle = new Mutex();
  scope = new AsyncLocalStorage<Binding>();
  constructor(pi: Listener['pi'], options: Options) { this.pi = pi; this.options = options; this.clock = options.clock ?? systemClock; }
  binding(): Binding { if (!this.current) throw new Error(ADMISSION); return {run: this.current, gen: this.generation}; }
  valid(b: Binding): boolean { return this.current === b.run && this.generation === b.gen && !b.run.abort.signal.aborted; }
  notice(key: string, message: string) {
    if (this.notices.has(key)) return; this.notices.add(key);
    (this.options.log ?? (s => console.error(s)))(`[filament] ${message}`);
    if (this.ctx?.mode === 'tui') this.ctx.ui.notify(message, 'warning');
    if (this.ctx?.mode === 'rpc') this.pi.sendMessage({customType: 'filament-notice', content: message, display: true, details: {status: this.status}}, {triggerTurn: false});
  }
  async guard(b = this.scope.getStore() ?? this.binding()) {
    if (!this.valid(b) || !await b.run.lock.check()) throw new Error(ADMISSION);
  }
  async admit(b: Binding) {
    if (!this.valid(b) || b.run.stopping || this.status.startsWith('storage error')) throw new Error(ADMISSION);
    try { await b.run.lock.admit(); } catch (e) { await this.lost(b); throw e; }
    if (!this.valid(b)) throw new Error(ADMISSION);
  }
  async lost(b: Binding) {
    if (!this.valid(b)) return;
    this.status = 'lost lock'; this.notice('lost lock', 'Filament listener lost lock; run /filament start.');
    await this.halt(b.run);
  }
  async storageError(e: unknown, b?: Binding) {
    if (b && !this.valid(b)) return;
    if ((e as Error).message === ADMISSION) { if (b) await this.lost(b); return; }
    const code = (e as NodeJS.ErrnoException).code;
    this.status = `storage error (${code ?? 'state read/write failed'})`;
    this.notice('storage', `${this.status}; run /filament start.`);
    if (this.current) await this.halt(this.current);
  }
  async persist<T>(b: Binding, fn: () => Promise<T>): Promise<T> {
    try { return await this.scope.run(b, fn); }
    catch (e) { await this.storageError(e, b); throw e; }
  }
  clear() {
    const old = [...this.batches.values()];
    this.generation++; this.batches.clear(); this.inFlight.clear(); this.unanswered.clear();
    void this.deleteMedia(old);
  }
  start(ctx: ExtensionContext, explicit = false, reset = false): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.stopInner(); this.ctx = ctx; this.clear(); this.identity = undefined;
      if (ctx.mode === 'json' || ctx.mode === 'print') { this.status = 'stopped'; return; }
      try {
        const dir = join(this.options.agentDir(), 'filament');
        this.processState = this.options.processState?.(dir) ?? this.processState;
        if (this.processState.active && this.processState.active !== this) await this.processState.active.stop();
        this.processState.active = this;
        this.notices = this.processState.notices ??= this.notices;
        this.names = this.processState.names ??= this.names;
        this.config = await settings(this.options.agentDir());
        if (!explicit && !this.config.autoStart) { this.status = 'stopped'; return; }
        await mkdir(dir, {recursive: true, mode: 0o700});
        if (!explicit) {
          const paused = await readFile(join(dir, 'paused.json'), 'utf8').then(JSON.parse, e => { if (e.code !== 'ENOENT') throw e; });
          if (paused) { this.status = `paused (${paused.reason})`; return; }
        }
        const endpoint = this.options.endpoint?.() ?? process.env.FILAMENT_AGENT_API_BASE_URL ?? 'https://api.filament.dm/mcp/agents';
        const token = await credential(this.options.agentDir(), endpoint);
        if (!token) { this.status = 'not signed in'; this.notice('credential missing', 'Not signed in. Run pi mcp login filament, then /filament start.'); return; }
        const lock = new ListenerLock(join(dir, 'listener.lock'), {clock: this.clock, hooks: this.options.lockHooks});
        if (reset) await lock.reset();
        if (!await lock.acquire(ctx.sessionManager.getSessionId())) { this.status = lock.status; if (this.status.startsWith('lock error')) this.notice(this.status, this.status); return; }
        const run: Run = {client: new FilamentClient(endpoint, token, this.options.fetch, this.clock), fingerprint: fingerprint(token), lock,
          abort: new AbortController(), polling: new AbortController(), stopping: false, timers: new Set(), sends: new Set(), ackIds: [], failures: 0};
        this.current = run;
        this.store = new Store(dir, () => this.guard(), message => this.notice(message, message));
        while (!run.abort.signal.aborted) {
          const binding = this.binding();
          try { await this.initialise(binding, explicit); }
          catch (e) { if (this.valid(binding) || run.abort.signal.aborted) throw e; }
          if (this.valid(binding)) break;
        }
        if (run.abort.signal.aborted) return;
        const b = this.binding();
        this.status = 'connecting (retrying)';
        this.repeat(run, 30_000, async binding => { if (!await run.lock.refresh()) await this.lost(binding); });
        if (this.options.autoLoop === false) await this.connect(b);
        else void this.loop(run).catch(e => this.storageError(e, {run, gen: this.generation}));
      } catch (e) { await this.storageError(e); }
    });
  }
  async initialise(b: Binding, unpause: boolean) {
    const store = this.store!;
    await this.persist(b, () => store.mutex.run(async () => {
      await store.probe();
      if (unpause) await store.remove('paused.json');
      await store.load(); await store.reconcile(this.clock.now());
      if (this.incarnation === undefined) {
        const previous = await store.read('incarnation') ?? 0;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid incarnation');
        await store.atomic('incarnation', previous + 1);
        this.incarnation = previous + 1; this.nonce = randomBytes(4).toString('hex');
      }
    }));
  }
  repeat(run: Run, ms: number, fn: (b: Binding) => Promise<void>) {
    let active = false;
    const schedule = () => {
      if (run.abort.signal.aborted || run.stopping) return;
      const id = this.clock.timer(() => {
        run.timers.delete(id); schedule();
        if (active) return;
        active = true; const b = {run, gen: this.generation};
        void (async () => {
          try { if (this.valid(b)) await fn(b); }
          catch (e) {
            if (this.valid(b)) {
              if (e instanceof FilamentError && e.auth) await this.pause(b, 'credential rejected');
              else if (ms === 30_000) await this.storageError(e, b);
              else this.notice('heartbeat', 'Filament heartbeat failed; retrying.');
            }
          } finally { active = false; }
        })().catch(e => this.storageError(e, b));
      }, ms); run.timers.add(id);
    }; schedule();
  }
  async connect(b: Binding): Promise<boolean> {
    await b.run.client.handshake(b.run.polling.signal);
    if (!this.valid(b)) return false;
    const self = await b.run.client.callTool('get_self', {}, 15_000, b.run.polling.signal);
    if (!this.valid(b)) return false;
    if (typeof self.user_id !== 'string') throw new FilamentError('Missing agent identity');
    this.identity = {user_id: self.user_id, display_name: clean(self.display_name ?? localpart(self.user_id)),
      owner: {display_name: clean(self.owner?.display_name ?? 'principal')}, cc_room_id: self.cc_room_id};
    await this.hello(false, b);
    if (!this.valid(b)) return false;
    this.status = 'listening'; b.run.failures = 0;
    this.repeat(b.run, 25_000, async binding => { await b.run.client.heartbeat(b.run.polling.signal); if (!this.valid(binding)) return; });
    return true;
  }
  async loop(run: Run) {
    let connected = false;
    while (this.current === run && !run.abort.signal.aborted && !run.stopping) {
      const b = {run, gen: this.generation};
      try {
        if (!await run.lock.check()) { await this.lost(b); break; }
        if (!connected) { connected = await this.connect(b); if (!connected) continue; }
        await this.pollOnce();
      } catch (e) { if (this.valid(b) && !run.stopping) await this.retry(e, b); }
    }
  }
  async retry(e: unknown, b: Binding) {
    if (!this.valid(b)) return;
    if (e instanceof FilamentError && e.auth) { await this.pause(b, 'credential rejected'); return; }
    if (e instanceof FilamentError && e.code === -32002) {
      b.run.namingAt ??= this.clock.now(); this.status = 'waiting for naming';
      this.notice('naming', 'Finish naming the agent in the Filament app, then run /filament start.');
      if (this.clock.now() - b.run.namingAt >= 600_000) { await this.pause(b, 'agent not named'); return; }
      await sleep(this.clock, 15_000, b.run.polling.signal); return;
    }
    const count = ++b.run.failures;
    if (!this.identity) this.status = 'connecting (retrying)';
    if (count === 3) this.notice('connection failures', 'Filament connection failed repeatedly; retrying.');
    await sleep(this.clock, Math.min(60_000, 2000 * 2 ** Math.min(count - 1, 5)), b.run.polling.signal);
  }
  async pause(b: Binding, reason: string) {
    if (!this.valid(b)) return;
    await this.persist(b, () => this.store!.atomic('paused.json', {reason, at: this.clock.now(), endpoint: b.run.client.endpoint}));
    this.status = `paused (${reason})`;
    this.notice(reason, reason === 'credential rejected' ? `Filament rejected ${this.identity?.display_name ?? 'the agent'}'s credential. Run pi mcp login filament, then /filament start.` : 'Finish naming the agent in the Filament app, then run /filament start.');
    await this.halt(b.run);
  }
  async halt(run: Run) {
    run.stopping = true; run.polling.abort(); run.abort.abort();
    for (const timer of run.timers) this.clock.clear(timer); run.timers.clear();
    await run.lock.release();
  }
  async stopInner() {
    const run = this.current; if (!run) return;
    run.stopping = true; run.polling.abort();
    for (const timer of run.timers) this.clock.clear(timer); run.timers.clear();
    const wait = new AbortController();
    await Promise.race([Promise.allSettled([...run.sends]), sleep(this.clock, 5000, wait.signal)]);
    wait.abort(); await this.halt(run); if (this.current === run) this.current = undefined;
  }
  stop(): Promise<void> { return this.lifecycle.run(async () => { await this.stopInner(); this.status = 'stopped'; }); }
  async pollOnce(sleepAfter = true): Promise<void> {
    const b = this.binding(); if (!this.valid(b) || b.run.stopping) return;
    if (!await b.run.lock.check()) { await this.lost(b); return; }
    const args = {cursor: b.run.cursor, wait_seconds: this.config.wait, max_items: 10, ...(b.run.ackIds.length ? {ack: b.run.ackIds} : {})};
    if (b.run.ackIds.length) await this.admit(b);
    const result = await b.run.client.callTool('poll_work', args, (this.config.wait + 15) * 1000, b.run.polling.signal);
    if (!this.valid(b) || b.run.stopping) return;
    b.run.failures = 0; b.run.namingAt = undefined; this.status = 'listening'; this.lastPoll = this.clock.now(); b.run.cursor = result.cursor;
    const fresh = await this.processWork(result, b);
    if (sleepAfter && this.valid(b) && !result.truncated) await sleep(this.clock,
      result.work?.length && !fresh ? 5000 : Math.max(0, Math.min(60_000, Number(result.next_poll_ms ?? 1000) || 0)), b.run.polling.signal);
  }
  async processWork(result: any, b = this.binding()): Promise<number> {
    if (!Array.isArray(result.work)) throw new FilamentError('Malformed poll result');
    const pending: Batch[] = [];
    await this.store!.mutex.run(async () => {
      if (!this.valid(b) || b.run.stopping) return;
      b.run.ackIds = [];
      for (const item of result.work as Item[]) {
        if (!item.reply_with || !Array.isArray(item.messages)) continue;
        if (item.messages.every(m => this.store!.replied.has(m.event_id))) { b.run.ackIds.push(...item.messages.map(m => m.event_id)); continue; }
        const parked = this.unanswered.get(item.channel_id);
        const fresh = item.messages.filter(m => !this.store!.replied.has(m.event_id) && !this.inFlight.has(m.event_id) && !parked?.has(m.event_id));
        if (!fresh.length) continue;
        const messages = item.messages.filter(m => (fresh.includes(m) || parked?.has(m.event_id)) && !this.inFlight.has(m.event_id) && !this.store!.replied.has(m.event_id));
        messages.forEach(m => parked?.delete(m.event_id));
        if (!parked?.size) this.unanswered.delete(item.channel_id);
        const batch: Batch = {...structuredClone(item), messages: structuredClone(messages), token: `${localpart(item.channel_id)}#${this.incarnation}-${this.nonce}-${++this.counter}`,
          eventIds: [...new Set(messages.map(m => m.event_id))], media: [], deliveredAt: Infinity, generation: b.gen, state: 'open'};
        batch.eventIds.forEach(id => this.inFlight.add(id)); this.batches.set(batch.token, batch); pending.push(batch);
      }
    });
    await this.enrichAll(pending, b); return pending.length;
  }
  async enrichAll(pending: Batch[], b: Binding) {
    if (!pending.length) return;
    const abort = new AbortController();
    const cancel = () => abort.abort(); b.run.polling.signal.addEventListener('abort', cancel, {once: true});
    const finished = new Set<string>(); let index = 0;
    const deliver = (batch: Batch, enriched?: Partial<Batch>) => {
      if (finished.has(batch.token)) return; finished.add(batch.token);
      if (!this.valid(b) || b.run.stopping || !this.batches.has(batch.token)) { void this.deleteMedia([batch]); return; }
      if (enriched?.contextError) void this.deleteMedia([batch]);
      const ready = {...batch, ...enriched, deliveredAt: this.clock.now()};
      this.batches.set(batch.token, ready); this.deliver(ready);
    };
    let timer: unknown;
    const deadline = new Promise<void>(resolve => {
      timer = this.clock.timer(() => { abort.abort(); for (const batch of pending) deliver(batch, {contextError: 'batch deadline exceeded'}); resolve(); }, 20_000);
    });
    const worker = async () => {
      while (index < pending.length && !abort.signal.aborted && this.valid(b)) {
        const batch = pending[index++];
        try { deliver(batch, await this.enrich(batch, b, abort.signal)); }
        catch (e) {
          if (e instanceof FilamentError && e.auth && this.valid(b) && !abort.signal.aborted) await this.pause(b, 'credential rejected');
          else deliver(batch, {contextError: e instanceof FilamentError ? e.message : 'enrichment failed'});
        }
      }
    };
    try { await Promise.race([Promise.all(Array.from({length: Math.min(3, pending.length)}, worker)), deadline]); }
    finally { this.clock.clear(timer); abort.abort(); b.run.polling.signal.removeEventListener('abort', cancel); }
  }
  async enrich(batch: Batch, b: Binding, signal: AbortSignal): Promise<Partial<Batch>> {
    const call = (name: string, args: Record<string, unknown>) => b.run.client.callTool(name, args, 8000, signal);
    const messages = (result: any): Message[] => Array.isArray(result) ? result : result.messages ?? result.events ?? [];
    const recent = messages(await call('get_recent_messages', {channel: batch.is_backchannel ? this.identity?.cc_room_id ?? batch.channel_id : batch.channel_id, limit: this.config.contextMessages}));
    // Locate work ids rather than relying on timestamps (history can return null ts).
    const anchors = [...this.batches.values()].filter(other => other.channel_id === batch.channel_id)
      .flatMap(other => other === batch ? batch.eventIds : [other.eventIds[0]]);
    const positions = anchors.map(id => recent.findIndex(m => m.event_id === id)).filter(i => i >= 0);
    const reversed = positions.length > 1 ? positions[0] > positions.at(-1)! : positions[0] === 0;
    const ordered = reversed ? [...recent].reverse() : recent;
    await this.store!.mutex.run(async () => {
      if (!this.valid(b) || signal.aborted || b.run.stopping || this.batches.get(batch.token) !== batch) return;
      const last = ordered.findLastIndex(m => batch.eventIds.includes(m.event_id));
      const own = (m: Message) => m.is_from_self === true || m.sender === this.identity?.user_id;
      const start = ordered.findLastIndex(own);
      for (const message of ordered.slice(start + 1, last + 1)) {
        const id = message.event_id;
        if (own(message) || !message.media?.length || message.body?.trim() ||
          this.store!.replied.has(id) || this.inFlight.has(id) ||
          [...this.unanswered.values()].some(ids => ids.has(id))) continue;
        batch.eventIds.push(id); this.inFlight.add(id);
        batch.messages.push({...message, body: ''}); batch.adopted = true;
      }
      if (batch.adopted) {
        const order = new Map(ordered.map((m, i) => [m.event_id, i]));
        batch.messages.sort((a, b) => (order.get(a.event_id) ?? -1) - (order.get(b.event_id) ?? -1));
      }
    });
    const thread = !batch.is_backchannel && batch.thread_id ? messages(await call('get_thread', {message_id: batch.thread_id})) : [];
    for (const sender of new Set([...batch.messages, ...recent, ...thread].map(m => m.sender))) {
      if (this.names.has(sender)) continue;
      try {
        const profile = await call('get_user_profile', {user_id: sender});
        if (this.valid(b) && !signal.aborted) this.names.set(sender, clean(profile.display_name ?? localpart(sender)));
      } catch (e) { if (e instanceof FilamentError && e.auth) throw e; }
    }
    const fetched = [...ordered, ...thread]; const media: any[] = []; const seen = new Set<string>();
    const dir = join(this.options.agentDir(), 'filament', 'media');
    for (const message of fetched.filter(m => batch.eventIds.includes(m.event_id))) {
      for (const attachment of message.media ?? []) {
        if (seen.has(attachment.mxc_url) || seen.size >= 3) continue; seen.add(attachment.mxc_url);
        try {
          const bytes = await b.run.client.media(attachment.mxc_url, signal);
          if (!this.valid(b) || signal.aborted) return {contextError: 'enrichment cancelled'};
          const extension = ({'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf'} as Record<string, string>)[attachment.mimetype] ?? 'bin';
          const path = join(dir, `${createHash('sha1').update(attachment.mxc_url).digest('hex')}.${extension}`);
          const saved = await this.mediaMutex.run(async () => {
            if (!this.valid(b) || signal.aborted) return false;
            await mkdir(dir, {recursive: true, mode: 0o700});
            if (!this.valid(b) || signal.aborted) return false;
            await writeFile(path, bytes, {mode: 0o600});
            if (!this.valid(b) || signal.aborted) { await unlink(path).catch(() => {}); return false; }
            const paths = this.mediaFiles.get(batch.token) ?? new Set<string>();
            paths.add(path); this.mediaFiles.set(batch.token, paths); return true;
          });
          if (!saved) return {contextError: 'enrichment cancelled'};
          media.push({...attachment, event_id: message.event_id, path, size: bytes.length});
        } catch { media.push({...attachment, event_id: message.event_id, path: undefined}); }
      }
    }
    return {recent: recent.filter(m => !batch.eventIds.includes(m.event_id)), thread, media,
      metadataUnavailable: batch.messages.some(m => !m.body && !fetched.some(f => f.event_id === m.event_id))};
  }
  deliver(batch: Batch, nudge = false) {
    const earlier = [...this.batches.values()].filter(other => other.token !== batch.token && other.channel_id === batch.channel_id && other.deliveredAt <= batch.deliveredAt).map(other => other.token);
    this.pi.sendMessage({customType: 'filament-work', display: true, content: render(batch, this.identity!, this.names, earlier, nudge),
      details: {token: batch.token, channel_id: batch.channel_id, thread_id: batch.thread_id, is_backchannel: batch.is_backchannel, eventIds: batch.eventIds, generation: batch.generation}},
      {triggerTurn: true, deliverAs: this.ctx?.isIdle() ? undefined : 'followUp'});
  }
  agentStart() { this.runStartedAt = this.clock.now(); }
  settled() {
    for (const batch of [...this.batches.values()]) {
      if (batch.deliveredAt >= this.runStartedAt) continue;
      if (batch.state === 'open') {
        const nudged = {...batch, state: 'nudged' as const, deliveredAt: this.clock.now()};
        this.batches.set(batch.token, nudged); this.deliver(nudged, true);
      } else if (batch.state === 'nudged') {
        this.batches.delete(batch.token);
        const parked = this.unanswered.get(batch.channel_id) ?? new Set<string>();
        for (const id of batch.eventIds) { this.inFlight.delete(id); parked.add(id); }
        this.unanswered.set(batch.channel_id, parked);
        void this.deleteMedia([batch]);
      }
    }
  }
  async deleteMedia(batches: Batch[]) {
    await this.mediaMutex.run(async () => {
      const paths = new Set(batches.flatMap(b => [...this.mediaFiles.get(b.token) ?? [], ...b.media.map(m => m.path).filter(Boolean)]));
      for (const batch of batches) this.mediaFiles.delete(batch.token);
      const active = new Set([...this.mediaFiles.values()].flatMap(paths => [...paths]));
      for (const path of paths) if (!active.has(path)) await unlink(path).catch(() => {});
    });
  }
  consume(batches: Batch[], dropIds = true) {
    for (const batch of batches) { this.batches.delete(batch.token); if (dropIds) batch.eventIds.forEach(id => this.inFlight.delete(id)); }
  }
  reply(params: {reply_key: string; markdown_body?: string; ack?: boolean; also_keys?: string[]}): Promise<string> {
    const b = this.binding();
    const task = this.replyInner(params, b); b.run.sends.add(task);
    void task.finally(() => b.run.sends.delete(task)).catch(() => {}); return task;
  }
  async replyInner(params: {reply_key: string; markdown_body?: string; ack?: boolean; also_keys?: string[]}, b: Binding): Promise<string> {
    await this.admit(b);
    let ackResult: any;
    const result = await this.store!.mutex.run(async () => {
      await this.admit(b);
      const keys = [...new Set([params.reply_key, ...params.also_keys ?? []])];
      const batches: Batch[] = [];
      for (const key of keys) {
        const batch = this.batches.get(key);
        if (!batch || !['open', 'nudged'].includes(batch.state) || (batches[0] && batch.channel_id !== batches[0].channel_id)) throw new Error(`unknown or already used reply_key ${key}; nothing sent`);
        batches.push(batch);
      }
      const ids = [...new Set(batches.flatMap(batch => batch.eventIds))];
      if (ids.every(id => this.store!.replied.has(id))) { this.consume(batches); await this.deleteMedia(batches); return 'Already answered earlier; nothing sent.'; }
      if (params.ack === true) {
        await this.persist(b, () => this.store!.suppress(ids, 'acked', this.identity!.user_id, b.run.client.endpoint, this.clock.now()));
        this.consume(batches); await this.deleteMedia(batches);
        this.pi.appendEntry('filament-replied', {token: params.reply_key, ids, status: 'acked'});
        await this.admit(b);
        try { ackResult = await b.run.client.callTool('poll_work', {wait_seconds: 0, ack: ids}, 15_000, b.run.abort.signal); }
        catch (e) {
          if (this.valid(b) && e instanceof FilamentError && e.auth) await this.pause(b, 'credential rejected');
          return 'Acknowledged locally (server acknowledgement unavailable).';
        }
        if (!this.valid(b)) return 'Acknowledged locally.';
        return `Acknowledged locally (server acknowledged ${ackResult.acknowledged ?? 0}).`;
      }
      const body = params.markdown_body?.trim() ?? '';
      if (!body || /^\s*---\s*$/m.test(body) || /<\/?[a-z][^>]*>/i.test(body) || /@[^\s:()]+:[a-zA-Z0-9.-]+/.test(body.replace(/\[[^\]]+\]\(member:[^)]+\)/g, ''))) throw new Error('Use non-empty markdown, no HTML, horizontal rules or raw ids; fix the body and try again.');
      const attempt: Attempt = {id: randomBytes(12).toString('hex'), state: 'attempting', endpoint: b.run.client.endpoint,
        agent_user_id: this.identity!.user_id, tokens: keys, channel_id: batches[0].channel_id, ids,
        reply_with: structuredClone(batches[0].reply_with!), body, at: this.clock.now()};
      await this.options.checkpoint?.('before-attempt');
      await this.persist(b, () => this.store!.attempt(attempt));
      await this.options.checkpoint?.('after-attempt');
      await this.persist(b, () => this.store!.suppress(ids, 'replied', attempt.agent_user_id, attempt.endpoint, this.clock.now()));
      await this.options.checkpoint?.('after-suppression');
      this.consume(batches, false);
      try { return await this.sendAttempt(attempt, b); }
      finally {
        if (this.current === b.run && this.generation === b.gen) { ids.forEach(id => this.inFlight.delete(id)); await this.deleteMedia(batches); }
      }
    });
    if (ackResult && this.valid(b)) await this.processWork(ackResult, b);
    return result;
  }
  async sendAttempt(attempt: Attempt, b: Binding): Promise<string> {
    await this.admit(b);
    let state: Attempt['state'] = 'unknown', error: string | undefined, auth = false;
    try {
      const response = await b.run.client.callTool(attempt.reply_with.tool, {...attempt.reply_with.args, markdown_body: attempt.body}, 30_000, b.run.abort.signal);
      if (typeof response.event_id === 'string' && response.event_id) state = 'posted';
    } catch (e) {
      auth = e instanceof FilamentError && e.auth;
      if (e instanceof FilamentError && e.rpc && !auth) { state = 'rejected'; error = e.message; }
    }
    if (!this.valid(b)) return 'outcome unknown; not retried; saved for the user (/filament status)';
    if (!await b.run.lock.check()) { await this.lost(b); return 'outcome unknown; not retried; saved for the user (/filament status)'; }
    await this.persist(b, async () => {
      if (state === 'unknown') await this.store!.suppress(attempt.ids, 'uncertain', attempt.agent_user_id, attempt.endpoint, this.clock.now());
      await this.store!.attempt({...attempt, state, ...(error ? {error} : {})});
    });
    this.pi.appendEntry('filament-replied', {token: attempt.tokens[0], ids: attempt.ids, status: state});
    await this.options.checkpoint?.('after-outcome');
    if (auth) await this.pause(b, 'credential rejected');
    return state === 'posted' ? 'Posted.' : state === 'rejected' ? `${error}; not retried; saved for the user` : 'outcome unknown; not retried; saved for the user (/filament status)';
  }
  resend(id: string): Promise<string> {
    const b = this.binding();
    const task = this.store!.mutex.run(async () => {
      await this.admit(b);
      const attempt = this.store!.attempts.get(id);
      if (!attempt || !['unknown', 'rejected'].includes(attempt.state)) throw new Error('No unresolved attempt with that id');
      if (attempt.endpoint !== b.run.client.endpoint || attempt.agent_user_id !== this.identity?.user_id) throw new Error('Attempt belongs to a different endpoint or agent; nothing sent');
      await this.persist(b, () => this.store!.attempt({...attempt, state: 'resending'}));
      return this.sendAttempt(attempt, b);
    });
    b.run.sends.add(task); void task.finally(() => b.run.sends.delete(task)).catch(() => {}); return task;
  }
  async hello(force = true, b = this.binding()): Promise<string> {
    return this.store!.mutex.run(async () => {
      await this.admit(b);
      const prior = await this.persist(b, () => this.store!.read('hello.json'));
      if (!force && prior?.sentAt !== undefined && prior.fingerprint === b.run.fingerprint && prior.endpoint === b.run.client.endpoint && prior.agent_user_id === this.identity?.user_id) return 'Hello already sent.';
      if (!this.identity) throw new Error('Agent identity not ready; nothing sent');
      const record = {fingerprint: b.run.fingerprint, endpoint: b.run.client.endpoint, agent_user_id: this.identity.user_id};
      await this.admit(b);
      let response: any, failure: unknown;
      try { response = await b.run.client.callTool('message_principal', {markdown_body: `${this.identity.display_name} is now connected through Pi.`}, 15_000, b.run.polling.signal); }
      catch (e) { failure = e; }
      if (!this.valid(b)) return 'Hello completion discarded.';
      const posted = response?.event_id;
      await this.persist(b, () => this.store!.atomic('hello.json', {...record, ...(posted ? {sentAt: this.clock.now(), eventId: posted} : {failedAt: this.clock.now(), error: 'Hello failed or outcome unknown'})}));
      if (failure instanceof FilamentError && failure.auth) await this.pause(b, 'credential rejected');
      return posted ? 'Hello sent.' : 'Hello failed; will retry on the next start.';
    });
  }
  statusObject() {
    return {identity: this.identity, status: this.status, pid: process.pid, generation: this.generation,
      batches: [...this.batches.values()].map(b => ({token: b.token, channel: b.channel_id, state: b.state, age: Math.max(0, this.clock.now() - b.deliveredAt)})),
      unanswered: [...this.unanswered].map(([channel, ids]) => ({channel, ids: [...ids]})), lastPoll: this.lastPoll,
      attempts: [...this.store?.attempts.values() ?? []].map(a => ({id: a.id, state: a.state, body: a.body.slice(0, 80),
        ...(a.state === 'unknown' ? {warning: 'the original may have posted; check the room before resending'} : {})})),
      repliedBytes: this.store?.size ?? 0, warnings: this.config.warnings,
      instruction: this.status === 'not signed in' || this.status.includes('credential rejected') ? 'Run pi mcp login filament, then /filament start.' :
        this.status.includes('naming') || this.status.includes('not named') ? 'Finish naming the agent in the Filament app, then run /filament start.' :
        this.status.startsWith('lock error') ? 'Run /filament start --reset-lock.' : this.status.startsWith('paused') ? 'Run /filament start.' : undefined};
  }
  output(ctx: ExtensionContext, text?: string) {
    const details = this.statusObject(); const content = text ? `${text}\n${JSON.stringify(details, null, 2)}` : JSON.stringify(details, null, 2);
    if (ctx.mode === 'tui') ctx.ui.notify(text ?? `Filament: ${this.status}`, 'info');
    if (ctx.mode === 'rpc' || ctx.mode === 'tui') this.pi.sendMessage({customType: 'filament-status', display: true, content, details}, {triggerTurn: false});
  }
  async command(args: string, ctx: ExtensionContext) {
    const [command = 'status', argument] = args.trim().split(/\s+/).filter(Boolean); let result: string | undefined;
    try {
      if (command === 'start') await this.start(ctx, true, argument === '--reset-lock');
      else if (command === 'stop') await this.stop();
      else if (command === 'resync') this.clear();
      else if (command === 'hello') result = await this.hello();
      else if (command === 'resend') result = await this.resend(argument);
      else if (command !== 'status') result = 'Use /filament [status|start [--reset-lock]|stop|hello|resync|resend <id>]';
    } catch (e) { result = (e as Error).message; }
    this.output(ctx, result);
  }
}
