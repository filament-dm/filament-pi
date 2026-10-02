import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function credential(agentDir: string, endpoint: string): Promise<string | undefined> {
  let data;
  try { data = JSON.parse(await readFile(join(agentDir, 'mcp-auth.json'), 'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot read mcp-auth.json');
  }
  const primary = data?.[`mcp__filament|${endpoint}`]?.tokens?.access_token;
  const legacy = data?.[endpoint]?.tokens?.access_token;
  return typeof primary === 'string' && primary ? primary :
    typeof legacy === 'string' && legacy ? legacy : undefined;
}
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}
export async function settings(agentDir: string) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(await readFile(join(agentDir, 'filament.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read filament.json'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid filament.json');
  const integer = (value: unknown, fallback: number, low: number, high: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, Math.trunc(value))) : fallback;
  return {
    wait: integer(data.wait, 30, 1, 60), autoStart: data.autoStart !== false,
    contextMessages: integer(data.contextMessages, 25, 1, 100),
    warnings: Object.keys(data).filter(k => !['wait', 'autoStart', 'contextMessages'].includes(k)).map(k => `Unknown setting: ${k}`),
  };
}
