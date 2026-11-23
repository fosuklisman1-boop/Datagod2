import type Anthropic from "@anthropic-ai/sdk"

/**
 * Typed AI tool registry: the single source of truth for which tool is offered (and callable) in which AI context.
 *
 * The entries live in lib/ai-tools.ts, next to the tool definition objects they reference. This file holds the
 * types (erased at build, so lib/ai-tools.ts importing them creates no runtime cycle) and re-exports the runtime
 * API, so callers and tests import everything from here.
 */
export type ToolCtx = "home" | "storefront" | "dashboard" | "admin" | "whatsapp" | "whatsapp_shop"

/** What calling the tool does: read-only, stage a draft/confirm menu only, move money, change an account, or change platform/ops state. */
export type ActsKind = "none" | "draft" | "money" | "account" | "ops"

export type StorefrontService = "data" | "airtime" | "results"

export interface ToolEntry {
  /** The existing definition object (name, description, input_schema). */
  tool: Anthropic.Tool
  contexts: ToolCtx[]
  adminOnly?: boolean
  acts: ActsKind
  /** Cron background runs: 'deny' drops the tool from the background tool list (nobody is there to tap a confirm card). */
  background?: "allow" | "deny"
  /** Offered (and callable) only in the admin context while the admin catalog switch is on. */
  catalogOnly?: boolean
  /** Storefront only: offered when ANY of these services is sold by the shop/domain (default: always offered). */
  storefrontNeeds?: StorefrontService[]
}

export { TOOL_REGISTRY, toolsFor, isToolAllowed } from "@/lib/ai-tools"
