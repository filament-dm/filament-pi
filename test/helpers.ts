import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Listener } from '../extensions/filament/listener.ts';
import type { Options } from '../extensions/filament/listener.ts';
import { FakeClock, FakeFilament, flush } from './fake-filament.ts';
export async function fixture(t: any, overrides: Partial<Options> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'filament-pi-'));
  const clock = new FakeClock(), server = new FakeFilament(clock);
  const messages: any[] = [], entries: any[] = [], notices: string[] = [];
  const pi: any = {sendMessage: (message: any, options: any) => messages.push({...message, options}), appendEntry: (type: string, data: any) => entries.push({type, data})};
  const ctx: any = {mode: 'rpc', hasUI: true, isIdle: () => true, ui: {notify: (message: string) => notices.push(message)}, sessionManager: {getSessionId: () => 'test-session', getBranch: () => [], getEntries: () => []}};
  await writeFile(join(dir, 'mcp-auth.json'), JSON.stringify({[`mcp__filament|${server.endpoint}`]: {tokens: {access_token: 'fake-test-credential'}}}), {mode: 0o600});
  const options = {agentDir: () => dir, endpoint: () => server.endpoint, clock, fetch: server.fetch, log: (s: string) => notices.push(s), autoLoop: false, ...overrides};
  const listener = new Listener(pi, options);
  t.after(async () => { await listener.stop(); await server.close(); await flush(); await rm(dir, {recursive: true, force: true}); });
  await listener.start(ctx);
  const work = () => messages.filter(m => m.customType === 'filament-work');
  const poll = () => listener.pollOnce(false);
  const key = () => work().at(-1).details.token;
  return {dir, clock, server, pi, ctx, listener, options, messages, entries, notices, work, poll, key};
}
export async function until(fn: () => boolean, message = 'condition') {
  // Filesystem completion is real even when protocol time is virtual.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error(`Did not reach ${message}`);
}
