export interface Clock {
  now(): number;
  timer(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(), timer: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
};
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => { clock.clear(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = clock.timer(finish, ms);
    signal?.addEventListener('abort', finish, {once: true});
  });
}
export class FilamentError extends Error {
  code?: number;
  auth: boolean;
  rpc: boolean;
  constructor(message: string, code?: number, rpc = false) {
    super(message); this.code = code; this.rpc = rpc; this.auth = code === -32001;
  }
}
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class FilamentClient {
  readonly endpoint: string;
  #token: string;
  #fetch: Fetch;
  #clock: Clock;
  #session?: string;
  #id = 0;
  #ready = false;
  #handshake?: Promise<void>;
  constructor(endpoint: string, token: string, fetcher: Fetch = fetch, clock: Clock = systemClock) {
    this.endpoint = endpoint.replace(/\/$/, ''); this.#token = token; this.#fetch = fetcher; this.#clock = clock;
  }
  async #request<T>(path: string, body: unknown, timeout: number, signal: AbortSignal | undefined,
    consume: (response: Response) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    let timer: unknown;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.#clock.timer(() => { abort.abort(); reject(new FilamentError('Request timed out')); }, timeout);
      abort.signal.addEventListener('abort', () => reject(new FilamentError('Request aborted')), {once: true});
    });
    try {
      const operation = (async () => {
        if (abort.signal.aborted) throw new FilamentError('Request aborted');
        const response = await this.#fetch(this.endpoint + path, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: abort.signal,
          headers: {Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream', ...(this.#session ? {'Mcp-Session-Id': this.#session} : {})},
          body: body === undefined ? undefined : body === '' ? '' : JSON.stringify(body),
        });
        if (!path.startsWith('/media') && [401, 403].includes(response.status)) throw new FilamentError('Credential rejected', -32001);
        const session = response.headers.get('Mcp-Session-Id');
        if (session) this.#session = session;
        return consume(response);
      })();
      return await Promise.race([operation, deadline]);
    } catch (e) {
      if (e instanceof FilamentError) throw e;
      throw new FilamentError('Network or malformed response');
    } finally { this.#clock.clear(timer); signal?.removeEventListener('abort', cancel); }
  }
  async #rpc(method: string, params: unknown, timeout: number, signal?: AbortSignal, notification = false) {
    return this.#request('', {jsonrpc: '2.0', ...(notification ? {} : {id: ++this.#id}), method, params}, timeout, signal, async response => {
      if (notification && response.ok) return;
      const raw = (await response.text()).split(this.#token).join('[credential redacted]');
      let data: any;
      try {
        if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
          for (const line of raw.split(/\r?\n/)) {
            if (!line.trim().startsWith('data:')) continue;
            try { const parsed = JSON.parse(line.trim().slice(5)); if (parsed && typeof parsed === 'object') data = parsed; } catch {}
          }
        } else data = JSON.parse(raw);
      } catch { throw new FilamentError(`Malformed response (HTTP ${response.status})`); }
      if (data?.jsonrpc !== '2.0') throw new FilamentError(`Invalid JSON-RPC response (HTTP ${response.status})`);
      if (data.error) throw new FilamentError(`Filament rejected request (${Number(data.error.code)})`, Number(data.error.code), true);
      if (!response.ok) throw new FilamentError(`HTTP ${response.status}`);
      if (!('result' in data)) throw new FilamentError('Missing JSON-RPC result');
      if (data.result?._sessionId) this.#session = data.result._sessionId;
      return data.result;
    });
  }
  async handshake(signal?: AbortSignal) {
    if (this.#ready) return;
    if (!this.#handshake) this.#handshake = (async () => {
      const deadline = this.#clock.now() + 15_000;
      await this.#rpc('initialize', {protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {name: 'filament-pi', version: '0.1.0'}}, 15_000, signal);
      await this.#rpc('notifications/initialized', {}, Math.max(1, deadline - this.#clock.now()), signal, true);
      this.#ready = true;
    })().finally(() => { this.#handshake = undefined; });
    await this.#handshake;
  }
  async callTool(name: string, args: Record<string, unknown>, timeout = 30_000, signal?: AbortSignal): Promise<any> {
    const result = await this.#rpc('tools/call', {name, arguments: args}, timeout, signal);
    try {
      if (result?.isError) throw new Error();
      const parsed = JSON.parse(result.content[0].text);
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return parsed;
    } catch { throw new FilamentError('Malformed tool result'); }
  }
  async heartbeat(signal?: AbortSignal) {
    return this.#request('/heartbeat', '', 10_000, signal, async response => {
      await response.arrayBuffer();
      if (!response.ok) throw new FilamentError(`Heartbeat HTTP ${response.status}`);
    });
  }
  async media(mxc: string, signal?: AbortSignal): Promise<Uint8Array> {
    return this.#request(`/media?mxc_url=${encodeURIComponent(mxc)}`, undefined, 15_000, signal, async response => {
      if (!response.ok || !response.body) throw new FilamentError('Attachment unavailable');
      const reader = response.body.getReader(); const parts: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const {done, value} = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > 20 * 1024 * 1024) throw new FilamentError('Attachment exceeds 20 MB');
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const output = new Uint8Array(bytes); let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.length; }
      return output;
    });
  }
}
