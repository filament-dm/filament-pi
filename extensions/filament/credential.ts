import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const PRODUCTION = 'https://api.filament.dm/mcp/agents';
// The MCP endpoint the listener talks to and keys its credential by: FILAMENT_AGENT_API_BASE_URL,
// else the `filament` server the user registered (`pi mcp add filament --url …` writes
// <agentDir>/mcp.json; `pi mcp login` stores the token under `mcp__filament|<that url>`), else
// production. An unreadable or unusable entry falls back to production, like a missing one.
export async function endpoint(agentDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.FILAMENT_AGENT_API_BASE_URL) return env.FILAMENT_AGENT_API_BASE_URL;
  let data;
  try { data = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')); }
  catch { return PRODUCTION; }
  const url = data?.mcpServers?.filament?.url;
  return typeof url === 'string' && /^https?:\/\/\S+$/.test(url) ? url : PRODUCTION;
}
// The token: what `pi mcp login filament` stored for the endpoint, else the bearer header of the
// `filament` server at that endpoint (`pi mcp add filament --url … --bearer-token-env-var NAME`
// writes `Bearer ${NAME}`, read from the environment), the same token Pi's own MCP client sends.
export async function credential(agentDir: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  let data;
  try { data = JSON.parse(await readFile(join(agentDir, 'mcp-auth.json'), 'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read mcp-auth.json');
  }
  const primary = data?.[`mcp__filament|${endpoint}`]?.tokens?.access_token;
  const legacy = data?.[endpoint]?.tokens?.access_token;
  if (typeof primary === 'string' && primary) return primary;
  if (typeof legacy === 'string' && legacy) return legacy;
  return headerToken(agentDir, endpoint, env);
}
async function headerToken(agentDir: string, endpoint: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  let data;
  try { data = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')); }
  catch { return; }
  const server = data?.mcpServers?.filament;
  if (server?.url !== endpoint) return;
  const header = server?.headers?.Authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(\S+))$/) : null;
  const token = match?.[1] ? env[match[1]] : match?.[2];
  return token || undefined;
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
    toolsRefreshMinutes: integer(data.toolsRefreshMinutes, 60, 5, 1440),
    warnings: Object.keys(data).filter(k => !['wait', 'autoStart', 'contextMessages', 'toolsRefreshMinutes'].includes(k)).map(k => `Unknown setting: ${k}`),
  };
}
