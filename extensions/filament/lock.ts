import { open, readFile, stat, unlink, readdir, mkdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sleep, systemClock } from './protocol.ts';
import type { Clock } from './protocol.ts';

export const ADMISSION = 'this Pi is not the active Filament listener; nothing sent';
type Record = {owner: string; pid: number; startedAt: number; refreshedAt: number; sessionId?: string};
type Snapshot = {owner: string; stale: boolean; pid?: number; malformed?: boolean};
export type LockHooks = {afterRead?: () => Promise<void>; afterMarker?: () => Promise<void>; beforeAdmission?: () => Promise<void>};
export class ListenerLock {
  path: string;
  ownsLock = false;
  status = 'stopped';
  fd?: FileHandle;
  record?: Record;
  clock: Clock;
  hooks: LockHooks;
  alive: (pid: number) => boolean;
  constructor(path: string, options: {clock?: Clock; hooks?: LockHooks; alive?: (pid: number) => boolean} = {}) {
    this.path = path; this.clock = options.clock ?? systemClock; this.hooks = options.hooks ?? {};
    this.alive = options.alive ?? (pid => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
  }
  async #snapshot(): Promise<Snapshot | undefined> {
    try {
      const meta = await stat(this.path);
      try {
        const value = JSON.parse(await readFile(this.path, 'utf8'));
        if (!/^[a-f0-9]{32}$/.test(value.owner) || !Number.isInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.refreshedAt)) throw new Error();
        return {owner: value.owner, pid: value.pid, stale: !this.alive(value.pid) || this.clock.now() - value.refreshedAt >= 600_000};
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        return {owner: `malformed-${meta.mtimeMs}`, stale: this.clock.now() - meta.mtimeMs >= 60_000, malformed: true};
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  }
  async #create(sessionId?: string): Promise<boolean> {
    try { this.fd = await open(this.path, 'wx', 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    this.record = {owner: randomBytes(16).toString('hex'), pid: process.pid, startedAt: this.clock.now(), refreshedAt: this.clock.now(), sessionId};
    try { await this.fd.writeFile(JSON.stringify(this.record)); await this.fd.sync(); this.ownsLock = true; return true; }
    catch (e) { await this.fd.close(); this.fd = undefined; throw e; }
  }
  async acquire(sessionId?: string): Promise<boolean> {
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    if (await this.#create(sessionId)) return true;
    let old = await this.#snapshot();
    for (let i = 0; old?.malformed && i < 3; i++) { await sleep(this.clock, 100); old = await this.#snapshot(); }
    if (!old) return this.#create(sessionId);
    if (!old.stale) { this.status = old.malformed ? 'lock error (unreadable lock file, retrying; run /filament start --reset-lock)' : `listening elsewhere (${old.pid})`; return false; }
    await this.hooks.afterRead?.();
    const marker = `${this.path}.takeover.${old.owner}`;
    let guard: FileHandle;
    try { guard = await open(marker, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const current = await this.#snapshot();
      const age = await stat(marker).then(s => this.clock.now() - s.mtimeMs, () => 0);
      this.status = current?.owner === old.owner && age >= 60_000 ?
        'lock error (abandoned takeover; run /filament start --reset-lock)' : `listening elsewhere (${current?.pid ?? 'takeover'})`;
      return false;
    }
    try {
      await this.hooks.afterMarker?.();
      const current = await this.#snapshot();
      if (current?.owner !== old.owner || !current.stale) { this.status = `listening elsewhere (${current?.pid ?? 'takeover'})`; return false; }
      await unlink(this.path);
      const acquired = await this.#create(sessionId);
      if (!acquired) this.status = 'listening elsewhere (takeover)';
      return acquired;
    } finally { await guard.close(); await unlink(marker).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async check(): Promise<boolean> {
    if (!this.ownsLock || !this.fd) return false;
    try {
      const [held, current] = await Promise.all([this.fd.stat(), stat(this.path)]);
      if (held.ino === current.ino && held.dev === current.dev) return true;
    } catch {}
    this.ownsLock = false; this.status = 'lost lock'; return false;
  }
  async admit(): Promise<void> {
    if (!this.ownsLock) throw new Error(ADMISSION);
    await this.hooks.beforeAdmission?.();
    if (!await this.check()) throw new Error(ADMISSION);
  }
  async refresh(): Promise<boolean> {
    if (!await this.check()) return false;
    this.record!.refreshedAt = this.clock.now();
    await this.fd!.truncate(0);
    await this.fd!.write(JSON.stringify(this.record), 0, 'utf8');
    await this.fd!.sync(); return true;
  }
  async release(): Promise<void> {
    if (!this.fd) return;
    if (await this.check()) await unlink(this.path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    this.ownsLock = false; await this.fd.close(); this.fd = undefined;
  }
  async reset(): Promise<void> {
    await this.release();
    const directory = dirname(this.path);
    await mkdir(directory, {recursive: true, mode: 0o700});
    for (const name of await readdir(directory)) {
      if (name === basename(this.path) || name.startsWith(`${basename(this.path)}.takeover.`)) await unlink(`${directory}/${name}`);
    }
  }
}
