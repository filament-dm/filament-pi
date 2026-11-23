import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookAround } from '../extensions/filament/look-around.ts';
import { fixture } from './helpers.ts';

const looks = (f: any) => f.messages.filter((m: any) => m.customType === 'filament-look-around');
const state = (f: any, name: string) => join(f.dir, 'filament', name);
const signIn = (f: any, token: string) => writeFile(join(f.dir, 'mcp-auth.json'), JSON.stringify({[`mcp__filament|${f.server.endpoint}`]: {tokens: {access_token: token}}}), {mode: 0o600});

test('look-around: handed over once after the first hello, as a turn, with a durable marker', async t => {
  const f = await fixture(t); const [look] = looks(f);
  assert.equal(looks(f).length, 1); assert.equal(f.server.count('message_principal'), 1);
  assert.deepEqual(look.options, {triggerTurn: true, deliverAs: undefined}); assert.equal(look.content, lookAround(f.listener.identity!));
  assert.deepEqual(look.details, {endpoint: f.server.endpoint, agent_user_id: '@agent:fake.test'});
  const marker = JSON.parse(await readFile(state(f, 'look-around.json'), 'utf8'));
  assert.equal(marker.agents.length, 1); assert.equal(marker.agents[0].agent_user_id, '@agent:fake.test'); assert.equal(marker.agents[0].endpoint, f.server.endpoint);
  assert.equal(f.listener.status, 'listening'); assert.equal(f.listener.batches.size, 0);
});
test('look-around: not repeated by a restart, a reload, an explicit hello or a new sign-in', async t => {
  const f = await fixture(t);
  await f.listener.start(f.ctx); await f.listener.command('start', f.ctx); await f.listener.hello();
  await signIn(f, 'second-test-credential'); await f.listener.start(f.ctx);
  assert.equal(f.server.count('message_principal'), 3); assert.equal(looks(f).length, 1);
});
test('look-around: an agent whose hello was sent before never gets it, even with no marker', async t => {
  const f = await fixture(t); await unlink(state(f, 'look-around.json'));
  await f.listener.start(f.ctx); await signIn(f, 'second-test-credential'); await f.listener.start(f.ctx);
  assert.equal(f.server.count('message_principal'), 2); assert.equal(looks(f).length, 1);
});
test('look-around: a failed first hello defers it to the hello that posts', async t => {
  const f = await fixture(t); await f.listener.stop(); f.messages.length = 0;
  await unlink(state(f, 'hello.json')); await unlink(state(f, 'look-around.json'));
  f.server.script('message_principal', {status: 500}); await f.listener.start(f.ctx);
  assert.ok(JSON.parse(await readFile(state(f, 'hello.json'), 'utf8')).failedAt); assert.equal(looks(f).length, 0);
  await f.listener.start(f.ctx); assert.equal(looks(f).length, 1);
  await f.listener.start(f.ctx); assert.equal(looks(f).length, 1);
});
test('look-around: once per agent identity', async t => {
  const f = await fixture(t);
  f.server.identity = {...f.server.identity, user_id: '@other:fake.test', display_name: 'Other Agent'}; await f.listener.start(f.ctx);
  assert.equal(looks(f).length, 2); assert.match(looks(f)[1].content, /Other Agent/);
  f.server.identity = {...f.server.identity, user_id: '@agent:fake.test', display_name: 'Test Agent'}; await f.listener.start(f.ctx);
  assert.equal(f.server.count('message_principal'), 3); assert.equal(looks(f).length, 2);
  assert.deepEqual(JSON.parse(await readFile(state(f, 'look-around.json'), 'utf8')).agents.map((a: any) => a.agent_user_id), ['@agent:fake.test', '@other:fake.test']);
});
test('look-around: a marker that cannot be read skips it and leaves the listener running', async t => {
  const f = await fixture(t); await f.listener.stop(); f.messages.length = 0;
  for (const broken of [() => writeFile(state(f, 'look-around.json'), '{not json'), async () => { await unlink(state(f, 'look-around.json')); await mkdir(state(f, 'look-around.json')); }]) {
    await unlink(state(f, 'hello.json')); await broken(); await f.listener.start(f.ctx);
    assert.equal(looks(f).length, 0); assert.equal(f.listener.status, 'listening'); assert.ok(JSON.parse(await readFile(state(f, 'hello.json'), 'utf8')).sentAt);
    f.server.enqueue('A'); await f.poll(); assert.equal(f.work().length, 1); f.server.channels.clear(); f.messages.length = 0;
  }
});
test('look-around: a hand-over that throws is not retried and does not stop listening', async t => {
  const f = await fixture(t); await f.listener.stop(); f.messages.length = 0;
  await unlink(state(f, 'hello.json')); await unlink(state(f, 'look-around.json'));
  const send = f.pi.sendMessage; f.pi.sendMessage = () => { throw new Error('no session'); };
  await f.listener.start(f.ctx); f.pi.sendMessage = send;
  assert.equal(f.listener.status, 'listening'); assert.equal(JSON.parse(await readFile(state(f, 'look-around.json'), 'utf8')).agents.length, 1);
  await unlink(state(f, 'hello.json')); await f.listener.start(f.ctx); assert.equal(looks(f).length, 0);
});
test('look-around: queued as a follow-up while the agent is busy', async t => {
  const f = await fixture(t); await f.listener.stop(); f.messages.length = 0;
  await unlink(state(f, 'hello.json')); await unlink(state(f, 'look-around.json'));
  await f.listener.start({...f.ctx, isIdle: () => false});
  assert.deepEqual(looks(f)[0].options, {triggerTurn: true, deliverAs: 'followUp'});
});
test('look-around: the step names the Pi tools, the backchannel and the shared wording', () => {
  const identity = {user_id: '@agent:fake.test', display_name: 'Test Agent', owner: {display_name: '@pat:fake.test'}, cc_room_id: '!private:fake.test'};
  const text = lookAround(identity);
  for (const part of ['Test Agent (you)', 'your owner pat', 'do not use filament_reply', '`mcp__filament__set_status` with `channel` = your backchannel\'s id (`!private:fake.test`) and `Looking around Filament…`',
    '`mcp__filament__set_status` with only `channel`', 'https://filament.dm/llms.txt', '`mcp__filament__get_settings` and `mcp__filament__list_channels`',
    'Post one message to your backchannel with `mcp__filament__message_principal`', 'Open by saying, in your own words, that you took a look around Filament', 'If any step fails, skip the rest and say nothing about it.', 'Leave out ids.'])
    assert.ok(text.includes(part), part);
  assert.ok(!text.includes('—'));
  assert.match(lookAround({...identity, cc_room_id: undefined}), /the `cc_room_id` that `mcp__filament__get_self` returns/);
});
