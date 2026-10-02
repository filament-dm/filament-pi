import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { ListenerLock } from '../extensions/filament/lock.ts';
export async function child(mode: string, directory: string, name: string) {
  const exists = async (file: string) => readFile(file).then(() => true, () => false);
  await writeFile(`${directory}/ready-${name}`, 'ready');
  while (!await exists(`${directory}/go`)) await new Promise(r => setTimeout(r, 5));
  if (mode === 'append') await appendFile(`${directory}/replied.jsonl`, JSON.stringify({id: name, s: 'replied', t: 1, a: 'agent', endpoint: 'fake'}) + '\n');
  else {
    const lock = new ListenerLock(`${directory}/listener.lock`);
    const owned = await lock.acquire();
    await writeFile(`${directory}/result-${name}`, JSON.stringify({owned, status: lock.status}));
    while (!await exists(`${directory}/finish`)) await new Promise(r => setTimeout(r, 5));
    await lock.release();
  }
}
export async function keyChild(directory: string, oldKey: string) {
  const [{Listener}, {FakeFilament}] = await Promise.all([import('../extensions/filament/listener.ts'), import('./fake-filament.ts')]);
  const fake = new FakeFilament(); const messages: any[] = [];
  const listener = new Listener({sendMessage: (m: any) => messages.push(m), appendEntry: () => {}}, {agentDir: () => directory, endpoint: () => fake.endpoint, fetch: fake.fetch, autoLoop: false, log: () => {}});
  const ctx: any = {mode: 'rpc', isIdle: () => true, sessionManager: {getSessionId: () => 'child', getBranch: () => [{message: {content: oldKey}}]}};
  await listener.start(ctx); fake.enqueue('A'); await listener.pollOnce(false);
  const rejected = await listener.reply({reply_key: oldKey, markdown_body: 'Must not post'}).then(() => false, e => /unknown or already used/.test(e.message));
  await writeFile(`${directory}/key-result.json`, JSON.stringify({key: messages.find(m => m.customType === 'filament-work').details.token, incarnation: listener.incarnation, rejected, posts: fake.count('post_message')}));
  await listener.stop();
}
