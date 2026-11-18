import type { ToolInfo } from './protocol.ts';
import type { Batch } from './render.ts';

export const PREFIX = 'mcp__filament__';
// Pi names MCP tools mcp__<server>__<tool>, every character outside [A-Za-z0-9_] replaced by `_`.
export const piName = (tool: string) => PREFIX + tool.replace(/[^A-Za-z0-9_]/g, '_');
// The first sentence of a description, short enough for a one-line catalog entry.
export function summary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  // A sentence ends before a capital letter, so `e.g. claude-code` stays whole.
  const sentence = flat.match(/^.*?[.!?](?=\s+[A-Z]|$)/)?.[0] ?? flat;
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}
export function catalog(tools: ToolInfo[]): string {
  return [
    'Every tool Filament offers this agent right now (the list refreshes while Pi runs). Call them from a `codemode` script as `tools.mcp__filament__<name>({...})` (`describeTool("mcp__filament__<name>")` shows the arguments), or load them with `tool_search`.',
    'Answer a delivered `filament-work` message only with `filament_reply`; use the other tools for everything else your principal asks of you.',
    ...[...tools].sort((a, b) => a.name.localeCompare(b.name)).map(t => `- ${piName(t.name)}: ${summary(t.description) || '(no description)'}`),
  ].join('\n');
}
// A digest of the server's tool names, to notice when the list changed.
export const digest = (tools: ToolInfo[]) => tools.map(t => t.name).sort().join('\n');
// The server tools Pi's MCP client has not registered, and the ones it still offers that the server dropped.
export function drift(server: ToolInfo[], registered: {name: string; exposure?: string}[]) {
  const known = new Set(registered.filter(t => t.name.startsWith(PREFIX)).map(t => t.name));
  const live = registered.filter(t => t.name.startsWith(PREFIX) && t.exposure !== 'hidden').map(t => t.name);
  const wanted = new Set(server.map(t => piName(t.name)));
  return {missing: [...wanted].filter(name => !known.has(name)), withdrawn: live.filter(name => !wanted.has(name)), known: known.size};
}
// A direct post that would answer delivered work, which must go through filament_reply.
export function answersWork(toolName: string, input: Record<string, unknown> | undefined, batches: Iterable<Batch>): boolean {
  if (toolName !== `${PREFIX}post_message` && toolName !== `${PREFIX}reply_in_thread`) return false;
  for (const batch of batches) {
    if (!['open', 'nudged'].includes(batch.state)) continue;
    const targets = new Set([...batch.eventIds, batch.thread_id, batch.reply_with?.args?.message_id, batch.reply_with?.args?.in_reply_to].filter(Boolean));
    if (toolName === `${PREFIX}post_message` && (input?.channel === batch.channel_id || targets.has(input?.in_reply_to as string))) return true;
    if (toolName === `${PREFIX}reply_in_thread` && targets.has(input?.message_id as string)) return true;
  }
  return false;
}
