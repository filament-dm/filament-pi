import test from 'node:test';
import assert from 'node:assert/strict';
import { FilamentClient, FilamentError } from '../extensions/filament/protocol.ts';
import { catalog, drift, summary } from '../extensions/filament/tools.ts';
import { fixture, until } from './helpers.ts';
import { FakeClock } from './fake-filament.ts';

// A stand-in for Pi's MCP client: the Filament tools it registered, and the commands the listener sent it.
function piMcp(names: string[]) {
  const registered = names.map(name => ({name: `mcp__filament__${name}`, exposure: 'codemode'}));
  const sent: {text: string; options: any}[] = [];
  return {registered, sent, extras: {getAllTools: () => [{name: 'read', exposure: 'direct'}, ...registered], sendUserMessage: (text: string, options: any) => sent.push({text, options})}};
}
const reconnect = {text: '/mcp reconnect filament', options: {expandPromptTemplates: true}};

test('T-tools-1 connect fetches the tool list; the prompt section lists every tool', async t => {
  const f = await fixture(t);
  assert.equal(f.server.count('tools/list'), 1); assert.equal(f.listener.tools?.length, 8);
  const section = f.listener.promptSection()!;
  for (const tool of f.server.tools) assert.ok(section.includes(`- mcp__filament__${tool.name}: Fake ${tool.name}.\n`) || section.endsWith(`- mcp__filament__${tool.name}: Fake ${tool.name}.`), tool.name);
  assert.doesNotMatch(section, /Second sentence/);
  assert.equal(f.listener.statusObject().tools, 8);
});
test('T-tools-2 refresh: a new server tool appears in the prompt after the refresh interval', async t => {
  const f = await fixture(t);
  f.server.tools.push({name: 'search_messages', description: 'Search messages by meaning.'});
  assert.doesNotMatch(f.listener.promptSection()!, /search_messages/);
  await f.clock.tick(60 * 60_000);
  assert.equal(f.server.count('tools/list'), 2); assert.match(f.listener.promptSection()!, /- mcp__filament__search_messages: Search messages by meaning\./);
});
test('T-tools-3 Pi missing server tools: reconnect its MCP server once per server list', async t => {
  const pi = piMcp(['get_self', 'poll_work']);
  const f = await fixture(t, {}, pi.extras);
  assert.deepEqual(pi.sent, [reconnect]);
  await f.clock.tick(60 * 60_000); assert.equal(pi.sent.length, 1, 'same server list: not again');
  f.server.tools.push({name: 'react', description: 'React.'}); await f.clock.tick(60 * 60_000);
  assert.deepEqual(pi.sent, [reconnect, reconnect]);
});
test('T-tools-4 Pi in step with the server, or with no Filament tools yet: no reconnect', async t => {
  const inStep = piMcp(['get_self', 'poll_work', 'post_message', 'reply_in_thread', 'message_principal', 'get_recent_messages', 'get_thread', 'get_user_profile']);
  await fixture(t, {}, inStep.extras); assert.deepEqual(inStep.sent, []);
  const none = piMcp([]);
  await fixture(t, {}, none.extras); assert.deepEqual(none.sent, []);
});
test('T-tools-5 Pi still offering a withdrawn tool: reconnect; one Pi already hid is fine', async t => {
  const pi = piMcp(['get_self', 'poll_work', 'post_message', 'reply_in_thread', 'message_principal', 'get_recent_messages', 'get_thread', 'get_user_profile', 'old_tool']);
  await fixture(t, {}, pi.extras); assert.deepEqual(pi.sent, [reconnect]);
  const hidden = piMcp(['get_self', 'poll_work', 'post_message', 'reply_in_thread', 'message_principal', 'get_recent_messages', 'get_thread', 'get_user_profile', 'old_tool']);
  hidden.registered.at(-1)!.exposure = 'hidden';
  await fixture(t, {}, hidden.extras); assert.deepEqual(hidden.sent, []);
});
test('T-tools-6 a busy agent is never interrupted: the reconnect waits for agent_settled', async t => {
  const pi = piMcp(['get_self']); let idle = false;
  const f = await fixture(t, {autoLoop: false}, pi.extras);
  assert.equal(pi.sent.length, 1);
  f.ctx.isIdle = () => idle; f.server.tools.push({name: 'react', description: 'React.'}); await f.clock.tick(60 * 60_000);
  assert.equal(pi.sent.length, 1); assert.ok(f.listener.reconnectPending);
  f.listener.settled(); assert.equal(pi.sent.length, 1);
  idle = true; f.listener.settled(); assert.equal(pi.sent.length, 2); assert.equal(f.listener.reconnectPending, undefined);
});
test('T-tools-7 a failed refresh keeps the previous list and the listener; a rejected credential pauses', async t => {
  const f = await fixture(t);
  f.server.script('tools/list', {status: 500});
  await f.clock.tick(60 * 60_000); assert.equal(f.listener.status, 'listening'); assert.equal(f.listener.tools?.length, 8);
  f.server.script('tools/list', {error: -32001}); await f.clock.tick(60 * 60_000);
  await until(() => f.listener.status === 'paused (credential rejected)', 'credential pause');
});
test('T-tools-8 /filament tools refreshes now and shows the catalog', async t => {
  const f = await fixture(t); f.server.tools.push({name: 'create_channel', description: 'Make a private channel.'});
  await f.listener.command('tools', f.ctx);
  const status = f.messages.filter(m => m.customType === 'filament-status').at(-1);
  assert.match(status.content, /- mcp__filament__create_channel: Make a private channel\./);
  assert.equal(f.server.count('tools/list'), 2);
});
test('T-tools-9 settings clamp the refresh interval', async t => {
  const {settings} = await import('../extensions/filament/credential.ts');
  const {writeFile} = await import('node:fs/promises'); const {join} = await import('node:path');
  const f = await fixture(t);
  await writeFile(join(f.dir, 'filament.json'), JSON.stringify({toolsRefreshMinutes: 1})); assert.equal((await settings(f.dir)).toolsRefreshMinutes, 5);
  await writeFile(join(f.dir, 'filament.json'), JSON.stringify({toolsRefreshMinutes: 99999})); assert.equal((await settings(f.dir)).toolsRefreshMinutes, 1440);
});
test('T-tools-10 client: tools/list follows nextCursor; malformed lists are errors', async () => {
  const pages: any[] = [{tools: [{name: 'a', description: 'A.'}], nextCursor: 'p2'}, {tools: [{name: 'b'}, {nope: 1}]}]; const cursors: unknown[] = [];
  const client = new FilamentClient('http://fake/mcp', 'secret', async (_url, init) => {
    const body = JSON.parse(String(init.body)); cursors.push(body.params?.cursor);
    return Response.json({jsonrpc: '2.0', id: body.id, result: pages.shift()});
  }, new FakeClock());
  assert.deepEqual(await client.listTools(), [{name: 'a', description: 'A.'}, {name: 'b', description: ''}]); assert.deepEqual(cursors, [undefined, 'p2']);
  const broken = new FilamentClient('http://fake/mcp', 'secret', async (_url, init) => Response.json({jsonrpc: '2.0', id: JSON.parse(String(init.body)).id, result: {}}), new FakeClock());
  await assert.rejects(broken.listTools(), FilamentError);
});
test('T-tools-11 catalog text: first sentence, capped, sorted; drift compares by Pi name', () => {
  assert.equal(summary('Post in a channel. Then more.'), 'Post in a channel.');
  assert.equal(summary('x'.repeat(300)).length, 158);
  assert.equal(summary('Report a harness (e.g. claude-code, codex). Each report replaces the last.'), 'Report a harness (e.g. claude-code, codex).');
  const text = catalog([{name: 'react', description: 'React.'}, {name: 'get_self', description: ''}]);
  assert.ok(text.indexOf('mcp__filament__get_self: (no description)') < text.indexOf('mcp__filament__react: React.'));
  assert.deepEqual(drift([{name: 'a-b', description: ''}], [{name: 'mcp__filament__a_b'}, {name: 'mcp__other__x'}]), {missing: [], withdrawn: [], known: 1});
});
