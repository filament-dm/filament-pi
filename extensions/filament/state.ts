import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn); this.#tail = result.catch(() => {}); return result;
  }
}
export type Suppression = {id: string; s: 'replied' | 'acked' | 'uncertain'; t: number; a: string; endpoint: string};
export type Target = {tool: string; args: Record<string, unknown>};
export type Attempt = {id: string; state: 'attempting' | 'resending' | 'posted' | 'unknown' | 'rejected';
  endpoint: string; agent_user_id: string; tokens: string[]; channel_id: string; ids: string[]; reply_with: Target; body: string; at: number; error?: string};
export class Store {
  dir: string;
  mutex = new Mutex();
  replied = new Map<string, Suppression>();
  attempts = new Map<string, Attempt>();
  size = 0;
  guard: () => Promise<void>;
  notice: (message: string) => void;
  beforeWrite?: (file: string) => Promise<void>;
  constructor(dir: string, guard: () => Promise<void>, notice: (message: string) => void) { this.dir = dir; this.guard = guard; this.notice = notice; }
  async #lines(file: string): Promise<any[]> {
    let raw: string;
    try { raw = await readFile(join(this.dir, file), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const valid: any[] = []; let bad = 0;
    for (const line of raw.split('\n').filter(s => s.trim())) {
      try {
        const entry = JSON.parse(line);
        const okay = file === 'replied.jsonl' ? ['replied', 'acked', 'uncertain'].includes(entry.s) :
          ['attempting', 'resending', 'posted', 'unknown', 'rejected'].includes(entry.state) && Array.isArray(entry.ids) && typeof entry.body === 'string' && entry.reply_with;
        if (typeof entry.id !== 'string' || !okay) throw new Error();
        valid.push(entry);
      } catch { bad++; }
    }
    if (bad && !valid.length) {
      await this.guard(); await rename(join(this.dir, file), join(this.dir, `${file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`));
      this.notice(file === 'replied.jsonl' ? 'duplicate protection reset' : 'attempt history corrupt; recovery records quarantined');
    } else if (bad) this.notice(`Malformed line skipped in ${file}`);
    return valid;
  }
  async load() {
    this.replied = new Map((await this.#lines('replied.jsonl')).map(r => [r.id, r]));
    this.attempts = new Map((await this.#lines('attempts.jsonl')).map(r => [r.id, r]));
    for (const [id, value] of this.attempts) if (value.state === 'posted') this.attempts.delete(id);
    this.size = await stat(join(this.dir, 'replied.jsonl')).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
  }
  async #append(file: string, record: unknown) {
    await this.beforeWrite?.(file); await this.guard();
    const fd = await open(join(this.dir, file), 'a+', 0o600);
    try {
      const {size} = await fd.stat(); const tail = Buffer.alloc(1);
      if (size) await fd.read(tail, 0, 1, size - 1);
      // A crash may leave an unterminated line; do not merge the next record into it.
      const prefix = size && tail[0] !== 10 ? '\n' : '';
      const line = Buffer.from(prefix + JSON.stringify(record) + '\n');
      if (file === 'replied.jsonl' && line.length >= 4096) throw new Error('Suppression record exceeds 4 KB');
      await this.guard();
      const result = await fd.write(line);
      if (result.bytesWritten !== line.length) throw new Error('Incomplete journal write');
      await fd.sync();
    }
    finally { await fd.close(); }
    await this.load();
  }
  async suppress(ids: string[], s: Suppression['s'], agent: string, endpoint: string, now: number) {
    for (const id of ids) await this.#append('replied.jsonl', {id, s, t: now, a: agent, endpoint});
  }
  async attempt(record: Attempt) { await this.#append('attempts.jsonl', record); }
  async reconcile(now: number) {
    for (const entry of [...this.attempts.values()]) if (['attempting', 'resending'].includes(entry.state)) {
      await this.suppress(entry.ids, 'uncertain', entry.agent_user_id, entry.endpoint, now);
      await this.attempt({...entry, state: 'unknown'});
    }
  }
  async read(name: string): Promise<any> {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  async atomic(name: string, value: unknown) {
    await this.beforeWrite?.(name); await this.guard();
    const target = join(this.dir, name), temp = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = await open(temp, 'wx', 0o600);
    try {
      await fd.writeFile(JSON.stringify(value)); await fd.sync(); await fd.close();
      await this.guard(); await rename(temp, target);
    } finally { await fd.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  async remove(name: string) {
    await this.beforeWrite?.(name); await this.guard();
    await unlink(join(this.dir, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  async probe() {
    await mkdir(this.dir, {recursive: true, mode: 0o700});
    await this.atomic('write-probe', {at: Date.now()}); await unlink(join(this.dir, 'write-probe'));
  }
}
