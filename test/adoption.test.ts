import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.ts';

const image = (id: string, extra = {}) => ({event_id: id, sender: '@principal:fake.test', body: '  ', ts: null,
  is_from_self: false, is_from_principal: true,
  media: [{mxc_url: `mxc://fake/${id}`, filename: `${id}.png`, mimetype: 'image/png'}], ...extra});

test('L25 adoption: history-only image downloads, renders, replies and stays suppressed', async t => {
  for (const reverse of [false, true]) {
    const f = await fixture(t);
    const item = f.server.enqueue('text');
    const history = [image('old'), image('own', {sender: f.server.identity.user_id}), image('orphan'), ...item.messages];
    f.server.script('get_recent_messages', {result: {messages: reverse ? [...history].reverse() : history}});
    await f.poll();
    const batch = f.listener.batches.get(f.key())!;
    assert.deepEqual(batch.eventIds, ['text', 'orphan']);
    assert.equal(f.listener.inFlight.has('orphan'), true);
    assert.equal(batch.media.length, 1);
    assert.equal((await readFile(batch.media[0].path)).length, 3);
    const content = f.work()[0].content;
    assert.equal((content.match(/\[attachment:/g) ?? []).length, 1);
    assert.ok(content.indexOf('Sender (unknown time)') < content.indexOf('Message text'));
    assert.match(content, /\(An image-only message above was attached to this batch because Filament delivers it without text\.\)/);
    assert.equal(await f.listener.reply({reply_key: f.key(), markdown_body: 'Thanks'}), 'Posted.');
    assert.deepEqual(f.entries.at(-1).data.ids, ['text', 'orphan']);
    const journal = await readFile(join(f.dir, 'filament', 'replied.jsonl'), 'utf8');
    assert.match(journal, /orphan/);
    assert.equal(f.listener.store!.replied.has('orphan'), true);
    f.server.enqueue('next');
    f.server.script('get_recent_messages', {result: {messages: [...history, item.messages.at(-1)]}});
    await f.poll();
    assert.deepEqual(f.work().at(-1).details.eventIds, ['next']);
    assert.equal(f.server.count('media'), 1);
  }
});

test('L25b adoption: no own message, exclusions, shared download cap and concurrent reservations', async t => {
  for (const reverse of [false, true]) {
    const f = await fixture(t);
    const item = f.server.enqueue('text');
    await f.listener.store!.suppress(['replied'], 'acked', f.server.identity.user_id, f.server.endpoint, f.clock.now());
    f.listener.inFlight.add('in-flight');
    f.listener.unanswered.set(item.channel_id, new Set(['parked']));
    const history = [image('replied'), image('in-flight'), image('parked'), image('one'), image('two'), image('three'), image('four'),
      {...item.messages[0], media: image('text').media}, image('future')];
    // Two batch ids establish direction even though history continues after them.
    f.server.enqueue('last'); history.splice(history.length - 1, 0, item.messages[1]);
    f.server.script('get_recent_messages', {result: {messages: reverse ? [...history].reverse() : history}});
    await f.poll();
    const batch = f.listener.batches.get(f.key())!;
    assert.deepEqual(batch.eventIds, ['text', 'last', 'one', 'two', 'three', 'four']);
    assert.equal(batch.media.length, 3); assert.equal(f.server.count('media'), 3);
    assert.deepEqual(batch.media.map(m => m.filename), ['one.png', 'two.png', 'three.png']);
    await f.listener.reply({reply_key: f.key(), ack: true});
    for (const id of batch.eventIds) assert.equal(f.listener.store!.replied.get(id)?.s, 'acked');
  }
  for (const own of [{is_from_self: true}, {sender: '@agent:fake.test'}]) {
    const f = await fixture(t); const item = f.server.enqueue('text');
    f.server.script('get_recent_messages', {result: {messages: [image('old'), image('self', own), image('orphan'), ...item.messages]}});
    await f.poll(); assert.deepEqual(f.work()[0].details.eventIds, ['text', 'orphan']);
  }
  const f = await fixture(t); const item = f.server.enqueue('A');
  const other = {...structuredClone(item), messages: [{...item.messages[0], event_id: 'B'}]};
  const history = [image('shared'), ...item.messages, ...other.messages];
  f.server.script('poll_work', {result: {work: [item, other]}});
  f.server.script('get_recent_messages', {result: {messages: history}}, {result: {messages: history}});
  await f.poll();
  assert.equal(f.work().flatMap(w => w.details.eventIds).filter(id => id === 'shared').length, 1);
  assert.equal(f.server.count('media'), 1);
});
