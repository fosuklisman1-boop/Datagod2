// Voice calls (channel "voice" on /api/ai/chat) may only use tools that cannot act on their own: read-only
// tools and prepare_* tools that stage a confirm card. Anything that moves money, changes an account or changes
// platform state is dropped from the offered list, and runAgenticLoop refuses a call to a dropped tool.
import type Anthropic from "@anthropic-ai/sdk"
import { TOOL_REGISTRY } from "@/lib/ai-tool-registry"

const ACTS_BY_NAME = new Map<string, string>(TOOL_REGISTRY.map((e) => [e.tool.name, e.acts]))

export function isVoiceSafeTool(name: string): boolean {
  const acts = ACTS_BY_NAME.get(name)
  return acts === "none" || acts === "draft"
}

export function voiceToolFilter(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.filter((t) => isVoiceSafeTool(t.name))
}

/** Only the exact string "voice" selects the voice channel; anything else is treated as ordinary text chat. */
export function isVoiceChannel(channel: unknown): boolean {
  return channel === "voice"
}
