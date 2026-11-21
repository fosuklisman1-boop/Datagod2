import type Anthropic from "@anthropic-ai/sdk"

/**
 * Background (cron) runs have nobody to tap a confirm card, so a prepare_* tool would only mint a card nobody sees.
 * Strips EVERY prepare_* tool by name prefix, so a prepare tool added later is excluded without touching this file.
 * Reusable for the admin context too.
 */
export function withoutPrepareTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.filter((t) => !t.name.startsWith("prepare_"))
}

/** Admin background runs keep the read tools and the admin prepare_* tools, but not the admin's own wallet order. */
export function adminBackgroundTools(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  return tools.filter((t) => t.name !== "prepare_wallet_order")
}
