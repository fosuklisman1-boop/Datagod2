import type Anthropic from "@anthropic-ai/sdk"
import { TOOL_REGISTRY } from "@/lib/ai-tool-registry"

/** Registry entries marked background:'deny' (e.g. the admin's own wallet order). */
function backgroundDenied(name: string): boolean {
  return TOOL_REGISTRY.some((e) => e.tool.name === name && e.background === "deny")
}

/**
 * Background (cron) runs have nobody to tap a confirm card, so a prepare_* tool would only mint a card nobody sees.
 * Strips EVERY prepare_* tool by name prefix, so a prepare tool added later is excluded without touching this file,
 * plus anything the registry marks background:'deny'. Reusable for the admin context too.
 */
export function withoutPrepareTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.filter((t) => !t.name.startsWith("prepare_") && !backgroundDenied(t.name))
}

/** Admin background runs keep the read tools and the admin prepare_* tools, but not anything the registry denies (the admin's own wallet order). */
export function adminBackgroundTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.filter((t) => !backgroundDenied(t.name))
}
