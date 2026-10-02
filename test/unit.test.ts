import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, appendFile, stat, readdir, unlink, utimes, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { credential, fingerprint } from '../extensions/filament/credential.ts';
import { Store } from '../extensions/filament/state.ts';
import { ListenerLock, ADMISSION } from '../extensions/filament/lock.ts';
import { FakeClock, gate, flush } from './fake-filament.ts';
import { until } from './helpers.ts';
async function directory(t: any) { const dir = await mkdtemp(join(tmpdir(), 'filament-unit-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir; }
async function stale(path: string, changes = {}) { await writeFile(path, JSON.stringify({owner: 'a'.repeat(32), pid: process.pid, startedAt: 0, refreshedAt: 0, ...changes})); }
function launch(t: any, mode: string, dir: string, name: string) {
  const code = `import {child} from ${JSON.stringify(new URL('./child.ts', import.meta.url).href)}; await child(${JSON.stringify(mode)}, ${JSON.stringify(dir)}, ${JSON.stringify(name)});`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', s => { stderr += s; });
  const done = new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  done.catch(() => {}); t.after(() => { if (child.exitCode === null) child.kill(); }); return done;
}
async function fileAppears(path: string) { for (let n = 0; n < 500; n++) { if (await stat(path).then(() => true, () => false)) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Child barrier timeout'); }

test('U1 credential: documented key, legacy key, missing file, missing key; token only', async t => {
  const dir = await directory(t), endpoint = 'http://fake/mcp';
  assert.equal(await credential(dir, endpoint), undefined);
  await writeFile(join(dir, 'mcp-auth.json'), '{}'); assert.equal(await credential(dir, endpoint), undefined);
  await writeFile(join(dir, 'mcp-auth.json'), JSON.stringify({[endpoint]: {tokens: {access_token: 'legacy'}}})); assert.equal(await credential(dir, endpoint), 'legacy');
  await writeFile(join(dir, 'mcp-auth.json'), JSON.stringify({[endpoint]: {tokens: {access_token: 'legacy'}}, [`mcp__filament|${endpoint}`]: {tokens: {access_token: 'primary'}}}));
  assert.equal(await credential(dir, endpoint), 'primary'); assert.match(fingerprint('primary'), /^[0-9a-f]{16}$/);
});
test('U2 store: append/lookup, last line wins, 1,500 ids, growing inode and lines, malformed and corrupt', async t => {
  const dir = await directory(t), notices: string[] = [], store = new Store(dir, async () => {}, s => notices.push(s));
  await store.suppress(['A'], 'replied', 'agent', 'fake', 1); const inode = (await stat(join(dir, 'replied.jsonl'))).ino;
  for (let i = 0; i < 1500; i++) {
    await store.suppress([`id-${i}`], 'replied', 'agent', 'fake', i);
    if (i < 100) { assert.equal((await stat(join(dir, 'replied.jsonl'))).ino, inode); assert.equal((await readFile(join(dir, 'replied.jsonl'), 'utf8')).trim().split('\n').length, i + 2); }
  }
  assert.equal(store.replied.size, 1501); assert.ok(store.replied.has('id-0'));
  await store.suppress(['A'], 'uncertain', 'agent', 'fake', 2); assert.equal(store.replied.get('A')?.s, 'uncertain');
  await appendFile(join(dir, 'replied.jsonl'), 'broken\n'); await store.load(); assert.equal(store.replied.size, 1501); assert.match(notices[0], /Malformed/);
  await writeFile(join(dir, 'replied.jsonl'), 'totally invalid'); await store.load(); await store.load(); assert.equal(store.replied.size, 0);
  assert.equal(notices.filter(s => s === 'duplicate protection reset').length, 1); assert.ok((await readdir(dir)).some(s => s.startsWith('replied.jsonl.corrupt-')));
});
test('U2 store: concurrent reservations and overlapping process append preserve both lines', async t => {
  const dir = await directory(t), store = new Store(dir, async () => {}, () => {});
  const reserve = () => store.mutex.run(async () => { if (store.replied.has('A')) return false; await store.suppress(['A'], 'replied', 'agent', 'fake', 1); return true; });
  assert.deepEqual(await Promise.all([reserve(), reserve()]), [true, false]);
  const child = launch(t, 'append', dir, 'child'); await fileAppears(join(dir, 'ready-child'));
  store.beforeWrite = async () => { await writeFile(join(dir, 'go'), 'go'); await child; };
  await store.suppress(['parent'], 'replied', 'agent', 'fake', 1);
  assert.deepEqual([...store.replied.keys()].sort(), ['A', 'child', 'parent']);
});
test('U3 lock: acquire, live pid refusal, dead pid and stale timestamp takeover', async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock');
  const first = new ListenerLock(path), second = new ListenerLock(path); assert.equal(await first.acquire(), true); assert.equal(await second.acquire(), false); assert.match(second.status, /listening elsewhere/); await first.release();
  await stale(path, {pid: 99999999, refreshedAt: Date.now()}); assert.equal(await second.acquire(), true); await second.release();
  await stale(path); assert.equal(await second.acquire(), true); await second.release();
});
test('U3 lock: two spawned contenders race stale takeover through shared start barrier', async t => {
  const dir = await directory(t); await stale(join(dir, 'listener.lock'));
  const children = ['A', 'B'].map(name => launch(t, 'lock', dir, name));
  await Promise.all(['A', 'B'].map(n => fileAppears(join(dir, `ready-${n}`)))); await writeFile(join(dir, 'go'), 'go');
  await Promise.all(['A', 'B'].map(n => fileAppears(join(dir, `result-${n}`))));
  const results = await Promise.all(['A', 'B'].map(async n => JSON.parse(await readFile(join(dir, `result-${n}`), 'utf8'))));
  assert.equal(results.filter(r => r.owned).length, 1); await writeFile(join(dir, 'finish'), 'done'); await Promise.all(children);
});
test('U3 lock: paused interleaving and delayed contender abandon replacement owner', async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock'); await stale(path);
  const both = gate(), releaseB = gate(); let reads = 0;
  const A = new ListenerLock(path, {hooks: {afterRead: async () => { if (++reads === 2) both.resolve(); await both.promise; }}});
  const B = new ListenerLock(path, {hooks: {afterRead: async () => { if (++reads === 2) both.resolve(); await releaseB.promise; }}});
  const a = A.acquire(), b = B.acquire(); assert.equal(await a, true); const owner = await readFile(path, 'utf8'); releaseB.resolve();
  assert.equal(await b, false); assert.equal(await readFile(path, 'utf8'), owner); assert.equal((await readdir(dir)).filter(n => n.includes('takeover')).length, 0); await A.release();
});
test('U3 lock: marker O_EXCL and staggered unlink/create sequence is unreachable', async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock'); await stale(path);
  const holding = gate(), release = gate();
  const A = new ListenerLock(path, {hooks: {afterMarker: async () => { holding.resolve(); await release.promise; }}});
  const a = A.acquire(); await holding.promise;
  const B = new ListenerLock(path); assert.equal(await B.acquire(), false); assert.match(B.status, /elsewhere/);
  await assert.rejects(open(`${path}.takeover.${'a'.repeat(32)}`, 'wx'), {code: 'EEXIST'});
  release.resolve(); assert.equal(await a, true); await A.release();
});
test('U3 lock: crashed marker is never reclaimed; explicit reset clears and acquires', async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock'); await stale(path);
  const marker = `${path}.takeover.${'a'.repeat(32)}`; await writeFile(marker, ''); await utimes(marker, new Date(0), new Date(0));
  const lock = new ListenerLock(path); assert.equal(await lock.acquire(), false); assert.match(lock.status, /abandoned takeover.*--reset-lock/);
  await assert.rejects(open(marker, 'wx'), {code: 'EEXIST'}); await lock.reset(); assert.equal(await lock.acquire(), true); await lock.release();
});
for (const boundary of ['O_EXCL create before write', 'refresh ftruncate before write']) test(`U3 lock: malformed ${boundary} recovers after 60 seconds, young file reread three times`, async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock'), clock = new FakeClock();
  await writeFile(path, ''); const lock = new ListenerLock(path, {clock});
  let finished = false; const acquire = lock.acquire().then(v => { finished = true; return v; });
  for (let n = 0; n < 3; n++) { await until(() => clock.sleeps.filter(ms => ms === 100).length >= n + 1); await clock.tick(100); }
  assert.equal(await acquire, false); assert.equal(finished, true); assert.match(lock.status, /unreadable/); assert.equal(clock.sleeps.filter(n => n === 100).length, 3);
  await utimes(path, new Date(0), new Date(0)); const retry = lock.acquire(); for (let n = 0; n < 3; n++) { await until(() => clock.sleeps.filter(ms => ms === 100).length >= n + 4); await clock.tick(100); }
  assert.equal(await retry, true); await lock.release();
});
test('U3 lock: foreign inode refresh, release and admission refuse without modifying replacement', async t => {
  const dir = await directory(t), path = join(dir, 'listener.lock'), lock = new ListenerLock(path); await lock.acquire();
  await unlink(path); await stale(path, {owner: 'b'.repeat(32), refreshedAt: Date.now()}); const replacement = await readFile(path, 'utf8');
  assert.equal(await lock.refresh(), false); await assert.rejects(lock.admit(), new RegExp(ADMISSION)); await lock.release(); assert.equal(await readFile(path, 'utf8'), replacement);
});
test('U2 store: unterminated corrupt tail cannot swallow the next suppression record', async t => {
  const dir = await directory(t), store = new Store(dir, async () => {}, () => {});
  await store.suppress(['A'], 'replied', 'agent', 'fake', 1);
  await appendFile(join(dir, 'replied.jsonl'), '{"id":"partial'); await store.load();
  await store.suppress(['B'], 'replied', 'agent', 'fake', 2);
  assert.ok(store.replied.has('A')); assert.ok(store.replied.has('B'));
  const copy = new Store(dir, async () => {}, () => {}); await copy.load(); assert.ok(copy.replied.has('B'));
});
