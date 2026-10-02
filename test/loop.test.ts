import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Listener } from '../extensions/filament/listener.ts';
import { FilamentError } from '../extensions/filament/protocol.ts';
import { ADMISSION } from '../extensions/filament/lock.ts';
import { fixture, until } from './helpers.ts';
import { gate, flush } from './fake-filament.ts';

test('L1 delivery once: [A] polled three times gives one delivery', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); await f.poll(); await f.poll(); assert.equal(f.work().length, 1);
  assert.equal(f.work()[0].options.triggerTurn, true);
});
test('L2 batches: immutable A and B follow-up, also_keys posts once and consumes both', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const a = f.key();
  f.ctx.isIdle = () => false; f.server.enqueue('B'); await f.poll(); const b = f.key();
  assert.deepEqual(f.work()[1].details.eventIds, ['B']); assert.match(f.work()[1].content, new RegExp(a)); assert.equal(f.work()[1].options.deliverAs, 'followUp');
  assert.equal(await f.listener.reply({reply_key: b, also_keys: [a], markdown_body: 'Answer both'}), 'Posted.');
  assert.equal(f.server.count('post_message'), 1); assert.equal(f.server.requests.find(r => r.name === 'post_message')?.args.in_reply_to, 'B');
  for (const id of ['A', 'B']) assert.equal(f.listener.store!.replied.get(id)?.s, 'replied');
  await assert.rejects(f.listener.reply({reply_key: a, markdown_body: 'again'}), /already used/);
});
test('L3 B unseen: arrival during send becomes its own batch, never marked replied', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const wait = gate();
  f.server.script('post_message', {gate: wait.promise}); const sending = f.listener.reply({reply_key: f.key(), markdown_body: 'A only'});
  await until(() => f.server.count('post_message') === 1); f.server.enqueue('B'); const polling = f.poll(); await flush();
  wait.resolve(); await sending; await polling; assert.deepEqual(f.work()[1].details.eventIds, ['B']); assert.equal(f.listener.store!.replied.has('B'), false);
});
test('L4 stale key: old answered key cannot reply to new batch in same channel', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const old = f.key(); await f.listener.reply({reply_key: old, markdown_body: 'A'});
  f.server.enqueue('B'); await f.poll(); assert.notEqual(f.key(), old); await assert.rejects(f.listener.reply({reply_key: old, markdown_body: 'B'}), /already used/); assert.equal(f.server.count('post_message'), 1);
});
test('L5 parallel replies: same token sends once', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const params = {reply_key: f.key(), markdown_body: 'Answer'};
  const results = await Promise.allSettled([f.listener.reply(params), f.listener.reply(params)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.server.count('post_message'), 1);
});
test('L6 non-consuming server: ack offered, no redelivery, five second floor', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); await f.listener.reply({reply_key: f.key(), markdown_body: 'Answer'});
  const pending = f.listener.pollOnce(); await until(() => f.clock.sleeps.includes(5000));
  const before = f.server.count('poll_work'); await f.clock.tick(4999); assert.equal(f.server.count('poll_work'), before);
  await f.clock.tick(1); await pending; await f.poll(); assert.deepEqual(f.server.requests.filter(r => r.name === 'poll_work').at(-1)?.args.ack, ['A']); assert.equal(f.work().length, 1);
});
test('L7 ack: durable local ack, server acknowledged zero, work in response delivered', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const key = f.key(); f.server.enqueue('B', '!room:fake.test');
  assert.equal(await f.listener.reply({reply_key: key, ack: true}), 'Acknowledged locally (server acknowledged 0).');
  assert.equal(f.listener.store!.replied.get('A')?.s, 'acked'); assert.deepEqual(f.work()[1].details.eventIds, ['B']);
  await f.poll(); assert.equal(f.work().length, 2); assert.equal(f.server.count('post_message'), 0);
});
test('L8 truncated: pages delivered in order without sleep', async t => {
  const f = await fixture(t), a = structuredClone(f.server.enqueue('A')), b = structuredClone(f.server.enqueue('B', '!other:fake.test'));
  f.server.script('poll_work', {result: {work: [a], truncated: true, cursor: 'page2'}}, {result: {work: [b], truncated: false, next_poll_ms: 0}});
  const count = f.clock.sleeps.length; await f.listener.pollOnce();
  assert.ok(!f.clock.sleeps.slice(count).includes(1000)); await f.poll(); assert.deepEqual(f.work().map(w => w.details.eventIds), [['A'], ['B']]);
  assert.equal(f.server.requests.filter(r => r.name === 'poll_work').at(-1)?.args.cursor, 'page2');
});
test('L9 errors: 5xx x3 yields 2/4/8 backoff, one notice; malformed counts; success resets', async t => {
  const f = await fixture(t); f.server.script('poll_work', {status: 500}, {status: 503}, {status: 502}, {raw: '{broken'});
  for (const duration of [2000, 4000, 8000, 16000]) {
    const error = await f.poll().then(() => undefined, e => e); assert.ok(error instanceof FilamentError);
    const pending = f.listener.retry(error, f.listener.binding()); await flush(); assert.equal(f.clock.sleeps.at(-1), duration); await f.clock.tick(duration); await pending;
  }
  assert.equal(f.notices.filter(s => s.includes('failed repeatedly')).length, 1); await f.poll(); assert.equal(f.listener.current!.failures, 0);
});
for (const error of [{status: 401}, {status: 403}, {error: -32001}]) test(`L9 errors: auth ${JSON.stringify(error)} pauses, releases lock and heartbeat, no more requests`, async t => {
  const f = await fixture(t); f.server.script('poll_work', error);
  const failure = await f.poll().catch(e => e); await f.listener.retry(failure, f.listener.binding());
  assert.match(f.listener.status, /paused/); assert.equal(f.listener.current!.lock.ownsLock, false); assert.equal(f.listener.current!.timers.size, 0);
  const count = f.server.requests.length; await f.clock.tick(120_000); await f.poll(); assert.equal(f.server.requests.length, count);
  assert.equal(JSON.parse(await readFile(join(f.dir, 'filament', 'paused.json'), 'utf8')).reason, 'credential rejected');
});
test('L9 errors: -32002 waits every 15 seconds, pauses after ten minute grace', async t => {
  const f = await fixture(t); const b = f.listener.binding();
  for (let i = 0; i < 40; i++) { const pending = f.listener.retry(new FilamentError('reserved', -32002, true), b); await flush(); assert.equal(f.listener.status, 'waiting for naming'); await f.clock.tick(15_000); await pending; }
  await f.listener.retry(new FilamentError('reserved', -32002, true), b); assert.equal(f.listener.status, 'paused (agent not named)'); assert.equal(f.notices.filter(s => s.includes('Finish naming')).length, 2);
});
for (const [label, script, outcome] of [
  ['missing event_id', {result: {}}, 'unknown'], ['5xx', {status: 500}, 'unknown'], ['bad arguments', {error: -32602}, 'rejected'], ['timeout', {delay: 60_000}, 'unknown'],
] as const) test(`L10 outcome map: ${label} => ${outcome}, consumes and saves target/body`, async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.server.script('post_message', script);
  const sending = f.listener.reply({reply_key: f.key(), markdown_body: 'Saved body'}); await until(() => f.server.count('post_message') === 1);
  if (label === 'timeout') await f.clock.tick(30_000);
  assert.match(await sending, /not retried/); assert.equal(f.listener.batches.size, 0); assert.equal(f.listener.inFlight.size, 0);
  const entry = [...f.listener.store!.attempts.values()][0]; assert.equal(entry.state, outcome); assert.equal(entry.body, 'Saved body'); assert.equal(entry.reply_with.tool, 'post_message');
});
for (const boundary of ['before-attempt', 'after-attempt', 'after-suppression', 'after-outcome']) test(`L11 crash point: ${boundary}`, async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll();
  f.listener.options.checkpoint = async point => { if (point === boundary) throw new Error('simulated crash'); };
  await assert.rejects(f.listener.reply({reply_key: f.key(), markdown_body: 'Recover me'}), /simulated crash/);
  await f.listener.stop(); f.listener.options.checkpoint = undefined;
  const next = new Listener(f.pi, f.options); t.after(() => next.stop()); await next.start(f.ctx); await next.pollOnce(false);
  if (boundary === 'before-attempt') { assert.equal(next.batches.size, 1); assert.equal(next.store!.attempts.size, 0); }
  else if (boundary === 'after-outcome') { assert.equal(next.batches.size, 0); assert.equal(next.store!.attempts.size, 0); assert.equal(f.server.count('post_message'), 1); }
  else {
    assert.equal(next.batches.size, 0); const attempt = [...next.store!.attempts.values()][0]; assert.equal(attempt.state, 'unknown'); assert.equal(next.store!.replied.get('A')?.s, 'uncertain');
    assert.equal(await next.resend(attempt.id), 'Posted.'); assert.equal(f.server.count('post_message'), 1);
  }
});
test('L11 active send: second listener cannot reconcile the owner’s attempt', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); const wait = gate(); f.server.script('post_message', {gate: wait.promise});
  const send = f.listener.reply({reply_key: f.key(), markdown_body: 'Sending'}); await until(() => f.server.count('post_message') === 1);
  const before = await readFile(join(f.dir, 'filament', 'attempts.jsonl'), 'utf8'); const other = new Listener(f.pi, f.options); await other.start(f.ctx);
  assert.match(other.status, /listening elsewhere/); assert.equal(await readFile(join(f.dir, 'filament', 'attempts.jsonl'), 'utf8'), before); wait.resolve(); await send;
});
test('L12 resend: endpoint/identity mismatch refused, warning, resending before send, concurrent once, polling serialised', async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.server.script('post_message', {result: {}}); await f.listener.reply({reply_key: f.key(), markdown_body: 'Saved'});
  const attempt = [...f.listener.store!.attempts.values()][0]; assert.match(JSON.stringify(f.listener.statusObject()), /check the room before resending/);
  const original = f.listener.identity!.user_id; f.listener.identity!.user_id = 'other'; await assert.rejects(f.listener.resend(attempt.id), /different/); f.listener.identity!.user_id = original;
  attempt.endpoint = 'wrong'; await assert.rejects(f.listener.resend(attempt.id), /different/); attempt.endpoint = f.server.endpoint;
  const wait = gate(); f.server.script('post_message', {gate: wait.promise});
  const results = Promise.allSettled([f.listener.resend(attempt.id), f.listener.resend(attempt.id)]); await until(() => f.server.count('post_message') === 2);
  assert.equal(f.listener.store!.attempts.get(attempt.id)?.state, 'resending'); f.server.enqueue('B'); const poll = f.poll(); await flush(); assert.equal(f.work().length, 1);
  wait.resolve(); assert.equal((await results).filter(r => r.status === 'fulfilled').length, 1); await poll; assert.equal(f.listener.store!.attempts.size, 0); assert.equal(f.work().length, 2);
});
for (const [name, script, state] of [['rejection', {error: -32602}, 'rejected'], ['timeout', {delay: 40_000}, 'unknown']] as const) test(`L12 resend: ${name} retains recovery record`, async t => {
  const f = await fixture(t); f.server.enqueue('A'); await f.poll(); f.server.script('post_message', {result: {}}); await f.listener.reply({reply_key: f.key(), markdown_body: 'Saved'});
  const id = [...f.listener.store!.attempts.keys()][0]; f.server.script('post_message', script); const resend = f.listener.resend(id); await until(() => f.server.count('post_message') === 2);
  if (name === 'timeout') await f.clock.tick(30_000); await resend; assert.equal(f.listener.store!.attempts.get(id)?.state, state);
});
