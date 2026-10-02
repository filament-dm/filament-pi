import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Listener } from '../extensions/filament/listener.ts';
import { Store } from '../extensions/filament/state.ts';
import { render } from '../extensions/filament/render.ts';
import { register, blockPosting, guidelines } from '../extensions/filament/index.ts';
import { settings } from '../extensions/filament/credential.ts';
import { ADMISSION } from '../extensions/filament/lock.ts';
import { fixture, until } from './helpers.ts';
import { gate, flush } from './fake-filament.ts';

for (const event of ['resume', 'session_tree', 'resync']) test(`L13 generation: ${event} clears open batch, drops late enrichment, next poll redelivers`, async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const oldKey = f.key();
  f.server.enqueue('B'); const wait = gate(); f.server.script('get_recent_messages', {gate: wait.promise, ignoreAbort: true});
  const pending = f.poll(); await until(() => f.server.count('get_recent_messages') === 2);
  if (event === 'resume') await f.listener.start(f.ctx); else if (event === 'resync') await f.listener.command('resync', f.ctx); else f.listener.clear();
  wait.resolve(); await pending; assert.equal(f.listener.batches.size, 0); assert.equal(f.work().length, 1);
  await f.poll(); assert.equal(f.work().length, 2); assert.notEqual(f.key(), oldKey); assert.deepEqual(f.work()[1].details.eventIds, ['A', 'B']);
});
test('L13 binding: new credential start ignores old poll 401 and remains listening', async t => {
  const f = await fixture(t); const wait = gate(); f.server.script('poll_work', {gate: wait.promise, ignoreAbort: true, status: 401});
  const oldRun = f.listener.current; const pending = f.poll().catch(() => {}); await until(() => f.server.count('poll_work') === 1);
  await writeFile(join(f.dir, 'mcp-auth.json'), JSON.stringify({[`mcp__filament|${f.server.endpoint}`]: {tokens: {access_token: 'fake-new-credential'}}}));
  await f.listener.start(f.ctx, true); wait.resolve(); await pending; await flush();
  assert.notEqual(f.listener.current, oldRun); assert.equal(f.listener.status, 'listening'); assert.equal(f.listener.current!.lock.ownsLock, true);
});
test('L13 binding: send after five-second shutdown writes nothing; next owner restores suppression', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const wait = gate(); f.server.script('post_message', {gate: wait.promise, ignoreAbort: true});
  const sending = f.listener.reply({reply_key: f.key(), markdown_body: 'Late result'}); await until(() => f.server.count('post_message') === 1);
  const journal = await readFile(join(f.dir, 'filament', 'attempts.jsonl'), 'utf8');
  const stopping = f.listener.stop(); await flush(); await f.clock.tick(5000); await stopping;
  wait.resolve(); await sending; await flush(); assert.equal(await readFile(join(f.dir, 'filament', 'attempts.jsonl'), 'utf8'), journal);
  const next = new Listener(f.pi, f.options); t.after(() => next.stop()); await next.start(f.ctx);
  assert.equal([...next.store!.attempts.values()][0].state, 'unknown'); assert.equal(next.store!.replied.get('A')?.s, 'uncertain');
});
test('L13 binding: send within shutdown grace records posted outcome', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const wait = gate(); f.server.script('post_message', {gate: wait.promise});
  const sending = f.listener.reply({reply_key: f.key(), markdown_body: 'Within grace'}); await until(() => f.server.count('post_message') === 1);
  const stopping = f.listener.stop(); await flush(); wait.resolve(); assert.equal(await sending, 'Posted.'); await stopping;
  assert.equal(f.listener.store!.attempts.size, 0); assert.match(await readFile(join(f.dir, 'filament', 'attempts.jsonl'), 'utf8'), /"state":"posted"/);
});
test('L13 recovery: interrupted resending becomes unknown; interrupted reconciliation is repeatable', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.server.script('post_message', {result: {}}); await f.listener.reply({reply_key: f.key(), markdown_body: 'Recovery'});
  const attempt = [...f.listener.store!.attempts.values()][0]; await f.listener.store!.attempt({...attempt, state: 'resending'});
  let fail = true; f.listener.store!.beforeWrite = async file => { if (file === 'attempts.jsonl' && fail) { fail = false; throw new Error('reconciliation interrupted'); } };
  await assert.rejects(f.listener.store!.mutex.run(() => f.listener.store!.reconcile(f.clock.now())), /interrupted/);
  assert.equal(f.listener.store!.replied.get('A')?.s, 'uncertain'); assert.equal(f.listener.store!.attempts.get(attempt.id)?.state, 'resending');
  await f.listener.store!.mutex.run(() => f.listener.store!.reconcile(f.clock.now())); assert.equal(f.listener.store!.attempts.get(attempt.id)?.state, 'unknown');
});
test('L14 stranded: one nudge, then unanswered across five settles; new input recombines, resync releases', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll();
  const settle = async () => { await f.clock.tick(1); f.listener.agentStart(); await f.clock.tick(1); f.listener.settled(); };
  await settle(); assert.equal(f.work().length, 2); assert.match(f.work()[1].content, /handed this Filament message earlier/);
  await settle(); assert.equal(f.listener.batches.size, 0); assert.ok(f.listener.unanswered.get('!private:fake.test')?.has('A'));
  for (let i = 0; i < 5; i++) { await settle(); await f.poll(); } assert.equal(f.work().length, 2);
  f.server.enqueue('B'); await f.poll(); assert.equal(f.work().length, 3); assert.deepEqual(f.work()[2].details.eventIds, ['A', 'B']);
  await settle(); await settle(); f.listener.clear(); await f.poll(); assert.equal(f.work().length, 5);
});
test('L14 stranded: delivery during running turn evaluated only after following run', async t => {
  const f = await fixture(t); f.listener.agentStart(); await f.clock.tick(1); f.server.enqueue('A'); await f.poll(); f.listener.settled(); assert.equal(f.work().length, 1);
  await f.clock.tick(1); f.listener.agentStart(); f.listener.settled(); assert.equal(f.work().length, 2);
});
test('L15 enrichment: slow context text-only within deadline, next poll proceeds', async t => {
  const f = await fixture(t); f.server.enqueue('A', '!room:fake.test', {backchannel: false}); f.server.script('get_recent_messages', {delay: 60_000});
  const poll = f.poll(); await until(() => f.server.count('get_recent_messages') === 1); await f.clock.tick(8000); await poll;
  assert.match(f.work()[0].content, /context unavailable/); assert.ok(f.clock.now() - f.listener.lastPoll! <= 20_000); await f.poll(); assert.equal(f.server.count('poll_work'), 2);
});
test('L15 enrichment: ten slow items all delivered by batch-wide 20-second deadline, concurrency three', async t => {
  const f = await fixture(t); for (let i = 0; i < 10; i++) { f.server.enqueue(`A${i}`, `!room${i}:fake.test`, {backchannel: false}); f.server.script('get_recent_messages', {delay: 60_000}); }
  const poll = f.poll(); await until(() => f.server.count('get_recent_messages') === 3); assert.equal(f.server.count('get_recent_messages'), 3);
  await f.clock.tick(20_000); await poll; assert.equal(f.work().length, 10); assert.ok(f.work().every(w => w.content.includes('context unavailable')));
});
test('L15 enrichment: media 403 is unavailable, >20 MB cut off, successful file removed on reply', async t => {
  const f = await fixture(t); f.server.mediaStatus = 403; f.server.enqueue('A', undefined, {media: [{mxc_url: 'mxc://fake/1', filename: 'image.png', mimetype: 'image/png'}]}); await f.poll();
  assert.match(f.work()[0].content, /attachment unavailable/); assert.equal(f.listener.status, 'listening');
  await f.listener.reply({reply_key: f.key(), ack: true}); f.server.mediaStatus = 200; f.server.mediaBytes = 21 * 1024 * 1024;
  f.server.enqueue('B', undefined, {media: [{mxc_url: 'mxc://fake/2', filename: 'huge.png', mimetype: 'image/png'}]}); await f.poll(); assert.match(f.work().at(-1).content, /attachment unavailable/);
  await f.listener.reply({reply_key: f.key(), ack: true}); f.server.mediaBytes = 12;
  f.server.enqueue('C', undefined, {media: [{mxc_url: 'mxc://fake/3', filename: 'good.png', mimetype: 'image/png'}]}); await f.poll();
  const batch = f.listener.batches.get(f.key())!; assert.equal((await readFile(batch.media[0].path)).length, 12);
  await f.listener.reply({reply_key: f.key(), markdown_body: 'Image seen'}); await assert.rejects(readFile(batch.media[0].path), {code: 'ENOENT'});
});
test('L15 enrichment: independent heartbeat fires during slow enrichment', async t => {
  const f = await fixture(t); await f.clock.tick(24_000); f.server.enqueue('A'); f.server.script('get_recent_messages', {delay: 60_000});
  const polling = f.poll(); await until(() => f.server.count('get_recent_messages') === 1); await f.clock.tick(1000); assert.equal(f.server.count('heartbeat'), 1);
  await f.clock.tick(7000); await polling;
});
test('L16 render: no raw mxid; token, prior key and nudge header present', async t => {
  const f = await fixture(t); f.server.enqueue('A', '!room:fake.test', {backchannel: false, thread: '$root', body: 'Hello @person:fake.test'}); await f.poll();
  const text = render(f.listener.batches.get(f.key())!, f.listener.identity!, f.listener.names, ['earlier#1'], true);
  assert.ok(text.includes(f.key())); assert.ok(text.includes('earlier#1')); assert.match(text, /handed this Filament message earlier/); assert.doesNotMatch(text, /@\w+:fake.test/); assert.match(text, /Recent context/); assert.match(text, /Thread so far/);
});
test('L17 admission: lost lock refuses reply, ack and hello with no requests', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); await unlink(join(f.dir, 'filament', 'listener.lock')); const count = f.server.requests.length;
  for (const action of [() => f.listener.reply({reply_key: f.key(), markdown_body: 'No'}), () => f.listener.reply({reply_key: f.key(), ack: true}), () => f.listener.hello()]) await assert.rejects(action(), new RegExp(ADMISSION));
  assert.equal(f.server.requests.length, count);
});
test('L18 bypass: direct posting always blocked, principal ping and reads allowed', () => {
  for (const tool of ['post_message', 'reply_in_thread']) for (const _owned of [true, false]) assert.deepEqual(blockPosting(`mcp__filament__${tool}`), {block: true, reason: 'reply to Filament messages through filament_reply'});
  for (const tool of ['message_principal', 'get_thread']) assert.equal(blockPosting(`mcp__filament__${tool}`), undefined);
  assert.equal(guidelines.length, 8);
});
test('L19 settings: missing defaults, wait clamp, unknown warning', async t => {
  const f = await fixture(t); assert.deepEqual(await settings(f.dir), {wait: 30, autoStart: true, contextMessages: 25, warnings: []});
  await writeFile(join(f.dir, 'filament.json'), JSON.stringify({wait: 90, unexpected: 1})); const config = await settings(f.dir); assert.equal(config.wait, 60); assert.deepEqual(config.warnings, ['Unknown setting: unexpected']);
});
test('L20 rpc output: exactly one status message, structured details, no stdout', async t => {
  const f = await fixture(t), count = f.messages.length; let writes = 0; const original = process.stdout.write;
  process.stdout.write = (() => { writes++; return true; }) as any;
  try { await f.listener.command('status', f.ctx); } finally { process.stdout.write = original; }
  assert.equal(writes, 0); assert.equal(f.messages.length, count + 1); const msg = f.messages.at(-1); assert.equal(msg.customType, 'filament-status'); assert.equal(msg.details.status, 'listening'); assert.equal(msg.options.triggerTurn, false); assert.equal(JSON.parse(msg.content).status, 'listening');
});
test('L21 reply-key uniqueness: next incarnation rejects transcript key; same-process stop/start preserves identity', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const old = f.key(), incarnation = f.listener.incarnation, nonce = f.listener.nonce;
  await f.listener.stop(); await f.listener.start(f.ctx, true); assert.equal(f.listener.incarnation, incarnation); assert.equal(f.listener.nonce, nonce); await f.poll(); assert.notEqual(f.key(), old);
  await f.listener.stop(); const next = new Listener(f.pi, f.options); t.after(() => next.stop()); f.ctx.sessionManager.getBranch = () => [{message: {content: `reply_key ${old}`}}]; await next.start(f.ctx); await next.pollOnce(false);
  assert.equal(next.incarnation, incarnation! + 1); assert.notEqual([...next.batches.keys()][0], old); await assert.rejects(next.reply({reply_key: old, markdown_body: 'Old instruction'}), /unknown or already used/); assert.equal(f.server.count('post_message'), 0);
});
test('L21 forced collision: identical incarnation, nonce and counter resolves old instruction to current batch (accepted residual)', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const old = f.key(); f.listener.clear(); f.listener.counter = 0; await f.poll(); assert.equal(f.key(), old);
  assert.equal(await f.listener.reply({reply_key: old, markdown_body: 'Collision accepted by contract'}), 'Posted.'); assert.equal(f.server.count('post_message'), 1);
});
test('L22 horizon: id older than 1,500 retained, corruption notice then delivery; 150 unresolved attempts retained', async t => {
  const f = await fixture(t); const store = f.listener.store!;
  const lines = Array.from({length: 1501}, (_, n) => JSON.stringify({id: `A${n}`, s: 'replied', t: n, a: 'agent', endpoint: f.server.endpoint})).join('\n') + '\n';
  await appendFile(join(f.dir, 'filament', 'replied.jsonl'), lines); await store.load(); f.server.enqueue('A0'); await f.poll(); assert.equal(f.work().length, 0);
  const attempt = {state: 'unknown', endpoint: f.server.endpoint, agent_user_id: f.listener.identity!.user_id, tokens: [], channel_id: '!room', ids: ['A0'], reply_with: {tool: 'post_message', args: {}}, body: 'Saved', at: 1};
  await appendFile(join(f.dir, 'filament', 'attempts.jsonl'), Array.from({length: 150}, (_, n) => JSON.stringify({...attempt, id: `attempt-${n}`})).join('\n') + '\n'); await store.load(); assert.equal(store.attempts.size, 150);
  await writeFile(join(f.dir, 'filament', 'replied.jsonl'), 'corrupt'); await f.listener.stop(); await f.listener.start(f.ctx, true); await f.poll(); assert.equal(f.work().length, 1); assert.ok(f.notices.some(s => s.includes('duplicate protection reset'))); assert.equal(f.listener.store!.attempts.size, 150);
});
test('L23 startup: handshake 5xx twice retries, get_self timeout retries, explicit start overrides autoStart false', async t => {
  const f = await fixture(t); await f.listener.stop(); f.listener.options.autoLoop = true;
  await writeFile(join(f.dir, 'filament.json'), JSON.stringify({autoStart: false})); await f.listener.start(f.ctx); assert.equal(f.listener.status, 'stopped');
  f.server.script('initialize', {status: 500}, {status: 503}); f.server.script('get_self', {delay: 60_000});
  await f.listener.start(f.ctx, true); await until(() => f.listener.current!.failures === 1); await f.clock.tick(2000);
  await until(() => f.listener.current!.failures === 2); await f.clock.tick(4000); await until(() => f.server.count('get_self') === 2);
  await f.clock.tick(15_000); await until(() => f.listener.current!.failures === 3); await f.clock.tick(8000);
  await until(() => f.listener.status === 'listening'); assert.equal(f.listener.current!.failures, 0);
});
test('L23 unclassified outcome: HTTP 418 HTML is unknown, never retried', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.server.script('post_message', {status: 418, raw: '<html>teapot</html>'});
  assert.match(await f.listener.reply({reply_key: f.key(), markdown_body: 'Try once'}), /outcome unknown/); assert.equal([...f.listener.store!.attempts.values()][0].state, 'unknown'); assert.equal(f.server.count('post_message'), 1);
});
test('L23 persistence: EACCES stops, releases lock, refuses writes; start probes and recovers', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.listener.store!.beforeWrite = async () => { throw Object.assign(new Error('denied'), {code: 'EACCES'}); };
  await assert.rejects(f.listener.reply({reply_key: f.key(), markdown_body: 'Cannot record'}), /denied/); assert.equal(f.listener.status, 'storage error (EACCES)'); assert.equal(f.listener.current!.lock.ownsLock, false);
  await assert.rejects(f.listener.reply({reply_key: f.key(), markdown_body: 'Do not send'}), new RegExp(ADMISSION)); assert.equal(f.server.count('post_message'), 0);
  await f.listener.start(f.ctx, true); assert.equal(f.listener.status, 'listening');
});
test('L24 admission race: pre-send inode replacement refuses reply without request', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const lock = f.listener.current!.lock; let checks = 0;
  lock.hooks.beforeAdmission = async () => { if (++checks === 3) { await unlink(lock.path); await writeFile(lock.path, 'foreign'); } };
  await assert.rejects(f.listener.reply({reply_key: f.key(), markdown_body: 'Race'}), new RegExp(ADMISSION)); assert.equal(f.server.count('post_message'), 0); assert.equal(await readFile(lock.path, 'utf8'), 'foreign');
});
