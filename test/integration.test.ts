import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FilamentClient, FilamentError } from '../extensions/filament/protocol.ts';
import { Listener } from '../extensions/filament/listener.ts';
import { register, guidelines } from '../extensions/filament/index.ts';
import { FakeFilament, FakeClock, flush, gate } from './fake-filament.ts';
import { fixture, until } from './helpers.ts';

test('protocol: initialize, initialized, session echo, SSE last JSON, tool content decoding', async () => {
  const fake = new FakeFilament(); fake.script('initialize', {sse: true}); fake.script('get_self', {sse: true});
  const client = new FilamentClient(fake.endpoint, 'fake-secret', fake.fetch);
  await Promise.all([client.handshake(), client.handshake()]); const self = await client.callTool('get_self', {}); assert.equal(self.display_name, 'Test Agent');
  assert.deepEqual(fake.requests.map(r => r.name), ['initialize', 'notifications/initialized', 'get_self']); assert.equal(fake.requests[0].body.params.protocolVersion, '2025-03-26'); assert.equal(fake.requests[1].session, fake.session);
  await client.handshake(); assert.equal(fake.count('initialize'), 1);
});
test('protocol: request deadlines include response body; redirects never followed; token echoes redacted', async () => {
  const clock = new FakeClock(); let request: any;
  const client = new FilamentClient('http://fake/mcp', 'fake-secret', async (_url, init) => {
    request = init; return Response.json({jsonrpc: '2.0', result: {content: [{text: JSON.stringify({text: 'fake-secret'})}]}});
  }, clock);
  const result = await client.callTool('get_self', {}); assert.equal(result.text, '[credential redacted]'); assert.equal(request.redirect, 'error');
  const slow = new FilamentClient('http://fake/mcp', 'fake-secret', async () => new Response(new ReadableStream({start() {}})), clock);
  const pending = slow.callTool('get_self', {}, 50).catch(e => e); await clock.tick(50); assert.ok(await pending instanceof FilamentError);
});
test('factory registrations: no I/O, tools and handlers wired; print/json never start', async t => {
  const f = await fixture(t); await f.listener.stop();
  const tools: any[] = [], handlers = new Map(), commands = new Map(); let dirs = 0;
  const Type: any = {Object: (v: any) => v, String: () => ({type: 'string'}), Boolean: () => ({type: 'boolean'}), Array: (v: any) => ({items: v}), Optional: (v: any) => v};
  const pi: any = {...f.pi, registerTool: (tool: any) => tools.push(tool), on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command)};
  const listener = register(pi, Type, {...f.options, agentDir: () => { dirs++; return f.dir; }}); assert.equal(dirs, 0); assert.equal(tools.length, 2);
  assert.equal(tools[0].executionMode, 'sequential'); assert.deepEqual(tools[0].promptGuidelines, guidelines); assert.equal(tools[1].annotations.readOnlyHint, true);
  for (const mode of ['print', 'json']) await handlers.get('session_start')({reason: 'startup'}, {...f.ctx, mode});
  assert.equal(dirs, 0); const requests = f.server.requests.length;
  await handlers.get('session_start')({reason: 'resume'}, f.ctx); assert.equal(listener.status, 'listening');
  f.server.enqueue('A'); await listener.pollOnce(false); const key = [...listener.batches.keys()][0];
  const result = await tools[0].execute('id', {reply_key: key, ack: true}); assert.equal(result.content[0].type, 'text'); assert.ok('details' in result);
  assert.equal(handlers.get('tool_call')({toolName: 'mcp__filament__post_message'}).block, true);
  assert.equal((await tools[1].execute()).details.status, 'listening');
  await handlers.get('session_tree')({}); assert.equal(listener.batches.size, 0);
  await commands.get('filament').handler('status', f.ctx); await handlers.get('session_shutdown')({}); assert.ok(f.server.requests.length > requests);
});
test('L21 actual new process: durable incarnation advances and transcript key is refused', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const key = f.key(), incarnation = f.listener.incarnation!; await f.listener.stop();
  const code = `import {keyChild} from ${JSON.stringify(new URL('./child.ts', import.meta.url).href)}; await keyChild(${JSON.stringify(f.dir)}, ${JSON.stringify(key)});`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { if (child.exitCode === null) child.kill(); }); let stderr = ''; child.stderr.on('data', s => { stderr += s; });
  await new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  const result = JSON.parse(await readFile(join(f.dir, 'key-result.json'), 'utf8')); assert.equal(result.incarnation, incarnation + 1); assert.notEqual(result.key, key); assert.equal(result.rejected, true); assert.equal(result.posts, 0);
});
test('L21 reload process state: same identity and monotonic key counter across extension instances', async t => {
  const f = await fixture(t); await f.listener.stop(); const processState = {};
  const options = {...f.options, processState: () => processState};
  const first = new Listener(f.pi, options); await first.start(f.ctx); f.server.enqueue('A'); await first.pollOnce(false); const old = [...first.batches.keys()][0]; await first.stop();
  const next = new Listener(f.pi, options); t.after(() => next.stop()); await next.start(f.ctx); await next.pollOnce(false);
  assert.equal(next.incarnation, first.incarnation); assert.equal(next.nonce, first.nonce); assert.equal(next.counter, 2); assert.notEqual([...next.batches.keys()][0], old);
});
test('reply validation: empty, HTML, horizontal rule, raw id retain batch; member mention accepted', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll();
  for (const body of ['', '<b>Hello</b>', 'Hello\n---\nEnd', '@user:fake.test']) { await assert.rejects(f.listener.reply({reply_key: f.key(), markdown_body: body}), /non-empty markdown/); assert.equal(f.listener.batches.size, 1); }
  assert.equal(await f.listener.reply({reply_key: f.key(), markdown_body: 'Hello [User](member:@user:fake.test)'}), 'Posted.');
});
test('L2 additional keys: other channel or missing token refuses whole reply', async t => {
  const f = await fixture(t); f.server.enqueue('A'); f.server.enqueue('B', '!other:fake.test'); await f.poll(); const [a, b] = f.work().map(w => w.details.token);
  for (const key of [b, 'nonexistent']) await assert.rejects(f.listener.reply({reply_key: a, also_keys: [key], markdown_body: 'No'}), /unknown or already used/);
  assert.equal(f.server.count('post_message'), 0); assert.equal(f.listener.batches.size, 2);
});
test('hello: persisted once per credential; failed next-start retry; explicit hello always sends', async t => {
  const f = await fixture(t); assert.equal(f.server.count('message_principal'), 1); await f.listener.start(f.ctx); assert.equal(f.server.count('message_principal'), 1);
  await f.listener.hello(); assert.equal(f.server.count('message_principal'), 2);
  f.server.script('message_principal', {status: 500}); assert.match(await f.listener.hello(), /failed/); assert.ok(JSON.parse(await readFile(join(f.dir, 'filament', 'hello.json'), 'utf8')).failedAt);
  await f.listener.start(f.ctx); assert.equal(f.server.count('message_principal'), 4); assert.ok(JSON.parse(await readFile(join(f.dir, 'filament', 'hello.json'), 'utf8')).sentAt);
  const state = await Promise.all((await readdir(join(f.dir, 'filament'))).filter(n => !n.startsWith('media')).map(n => readFile(join(f.dir, 'filament', n), 'utf8')));
  assert.ok(!state.join('').includes('fake-test-credential')); assert.ok(!JSON.stringify(f.messages).includes('fake-test-credential')); assert.ok(!f.notices.join('').includes('fake-test-credential'));
});
test('L13 heartbeat and hello old-generation auth completions cannot pause new session', async t => {
  const f = await fixture(t); const old = gate(); f.server.script('heartbeat', {gate: old.promise, status: 401, ignoreAbort: true}); await f.clock.tick(25_000); await until(() => f.server.count('heartbeat') === 1);
  await f.listener.start(f.ctx, true); old.resolve(); await flush(); assert.equal(f.listener.status, 'listening');
  const hello = gate(); f.server.script('message_principal', {gate: hello.promise, status: 401, ignoreAbort: true}); const pending = f.listener.hello(); await until(() => f.server.count('message_principal') === 2);
  f.listener.clear(); hello.resolve(); await pending; assert.equal(f.listener.status, 'listening');
});
test('L15 enrichment MCP auth pauses, media auth stays attachment-only', async t => {
  const f = await fixture(t); f.server.enqueue('A'); f.server.script('get_recent_messages', {status: 401}); await f.poll(); assert.match(f.listener.status, /paused/); assert.equal(f.work().length, 0);
});
test('L23 persistence failure in hello and paused records closes listener and releases lock', async t => {
  for (const filename of ['hello.json', 'paused.json']) {
    const f = await fixture(t); f.listener.store!.beforeWrite = async file => { if (file === filename) throw Object.assign(new Error('denied'), {code: 'EACCES'}); };
    if (filename === 'hello.json') await assert.rejects(f.listener.hello(), /denied/);
    else await assert.rejects(f.listener.pause(f.listener.binding(), 'credential rejected'), /denied/);
    assert.match(f.listener.status, /storage error/); assert.equal(f.listener.current!.lock.ownsLock, false);
  }
});
test('L13 factory reload: old listener stopped, process identity and notice cache retained', async t => {
  const f = await fixture(t); await f.listener.stop(); const state = {};
  const options = {...f.options, processState: () => state};
  const old = new Listener(f.pi, options); await old.start(f.ctx); old.notice('test-once', 'Once');
  const next = new Listener(f.pi, options); t.after(() => next.stop()); await next.start(f.ctx); next.notice('test-once', 'Once');
  assert.equal(old.status, 'stopped'); assert.equal(next.status, 'listening'); assert.equal(next.incarnation, old.incarnation); assert.equal(f.notices.filter(s => s === '[filament] Once').length, 1);
});
test('L23 heartbeat auth plus paused-store failure stops cleanly without unhandled rejection', async t => {
  const f = await fixture(t); f.listener.store!.beforeWrite = async file => { if (file === 'paused.json') throw Object.assign(new Error('denied'), {code: 'EACCES'}); };
  f.server.script('heartbeat', {status: 401}); await f.clock.tick(25_000); await until(() => f.listener.status.startsWith('storage error'));
  await until(() => !f.listener.current!.lock.ownsLock); assert.equal(f.listener.current!.timers.size, 0); assert.equal(f.listener.status, 'storage error (EACCES)');
});
