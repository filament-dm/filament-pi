import { clean } from './render.ts';
import type { Identity } from './render.ts';

// The look-around step every Filament agent guide gives a new agent after its first hello, worded
// for Pi: here the listener posts the hello, so it hands the agent the step as a turn.
export function lookAround(identity: Identity): string {
  const agent = clean(identity.display_name), owner = clean(identity.owner.display_name);
  const backchannel = identity.cc_room_id ? `\`${identity.cc_room_id}\`` : 'the `cc_room_id` that `mcp__filament__get_self` returns';
  return [
    `One-time instruction for ${agent} (you) from the Filament extension. You have just connected to Filament for the first time and your hello to your owner ${owner} is already posted. This is not a Filament message: there is no reply_key, so do not use filament_reply for it.`,
    `Find out what makes Filament different, decide what you think of it, and tell your owner in a second message, separate from your hello. Take a few minutes and dig. Do this once, the first time this agent connects, and never on a later start or an update. If any step fails, skip the rest and say nothing about it.`,
    `Your owner is watching the chat while you look. Before anything else call \`mcp__filament__set_status\` with \`channel\` = your backchannel's id (${backchannel}) and \`Looking around Filament…\`. Update it as you move on (\`Reading Filament's description…\`, \`Writing up what makes Filament different…\`). Once you have posted, clear it: \`mcp__filament__set_status\` with only \`channel\`.`,
    `1. Start from your own tools: they are the ground truth. Read every Filament tool you have (the \`mcp__filament__*\` tools, \`filament_reply\` and \`filament_status\`), with its description and input schema, and the server's instructions. Note each field, argument and rule that a Slack or Discord bot API has no counterpart for.`,
    `2. Then read \`https://filament.dm/llms.txt\` and the full description it links (\`https://filament.dm/llms-full.txt\`; if that fails, \`https://raw.githubusercontent.com/filament-dm/filament-agent-kit/main/site/llms-full.txt\`), with whatever you have for fetching a page, for how Filament compares itself with other chat apps. Check its claims against the tools. If you cannot fetch pages, go on from the tools alone. Call \`mcp__filament__get_settings\` and \`mcp__filament__list_channels\` too.`,
    `3. Post one message to your backchannel with \`mcp__filament__message_principal\`, answering "How would you describe Filament, and what makes it different from other chat platforms?" as if your owner had just asked. Open with "I took a look around Filament." and one sentence that sums up what Filament really is, as you see it. Then give the four to seven differences you find most significant, most important first. For each, lead with the difference in bold, name the tool or field that shows it in \`code\`, say how a bot on Slack or Discord handles the same thing, and say why it matters. Write like an expert explaining it to a curious colleague: concrete and opinionated, with no marketing phrases. Claim only what a tool, its schema, the instructions or the description says, and add no guarantees they don't state, such as encryption or security. Leave out ids.`,
    `After the message is posted and the status is cleared, end your turn without narrating in the terminal.`,
  ].join('\n\n');
}
