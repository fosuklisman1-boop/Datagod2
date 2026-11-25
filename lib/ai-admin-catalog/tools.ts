import type Anthropic from "@anthropic-ai/sdk"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { ZodType } from "zod"
import { prepareAdminRouteCall } from "@/lib/ai-drafts/prepare-admin-route"
import type { DraftToolResult } from "@/lib/ai-drafts/types"
import { MAX_TOOL_RESULT_CHARS } from "@/lib/ai-tool-result-limit"
import { filterLookupResult } from "./filter"
import { getEntry, searchCatalog } from "./index"
import { resolveRequest } from "./resolve"
import type { CatalogEntry, EntryInput } from "./types"

// The three admin catalog tools (find_admin_actions, admin_lookup, prepare_admin_change). They are offered only while
// the admin catalog switch is on (see lib/ai-tools.ts). This file must NOT import lib/ai-tools.ts (that file imports
// these definitions at load time).

export const FIND_LIMIT = 8
const MAX_ERROR = 200
const RESULT_WRAPPER_ROOM = 400
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000

export const findAdminActionsTool: Anthropic.Tool = {
  name: "find_admin_actions",
  description:
    "Search the admin catalog for an action or a read-only lookup the admin can do on any admin page (refunds, settings, providers, users, shops, broadcasts and more). Returns up to 8 matches with their id, page, risk and the exact input shape. Use this first, then call admin_lookup (reads) or prepare_admin_change (changes) with the id.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Words describing the task, e.g. 'refund order' or 'mtn provider'" },
      page: { type: "string", description: "Optional admin page path to narrow the search, e.g. /admin/orders" },
    },
    required: ["query"],
  },
}

const inputProperty = {
  type: "object",
  description: "Request input: params (path ids), query and body, exactly as find_admin_actions describes them. Never include secrets.",
  properties: {
    params: { type: "object", additionalProperties: { type: "string" } },
    query: { type: "object", additionalProperties: true },
    body: { type: "object", additionalProperties: true },
  },
} as const

export const adminLookupTool: Anthropic.Tool = {
  name: "admin_lookup",
  description:
    "Read data from an admin page using a catalog entry of kind 'lookup' (find its id with find_admin_actions). Read-only: it never changes anything. Returns the useful fields only.",
  input_schema: {
    type: "object" as const,
    properties: {
      id: { type: "string", description: "Catalog entry id from find_admin_actions" },
      input: inputProperty,
    },
    required: ["id"],
  },
}

export const prepareAdminChangeTool: Anthropic.Tool = {
  name: "prepare_admin_change",
  description:
    "Prepare a change on an admin page using a catalog entry of kind 'change' (find its id with find_admin_actions). This executes nothing: it creates a confirm card the admin must tap. Tell the admin to review and tap Confirm on the card. Passwords, keys and secrets are typed by the admin into the card's secure box, never passed here.",
  input_schema: {
    type: "object" as const,
    properties: {
      id: { type: "string", description: "Catalog entry id from find_admin_actions" },
      input: inputProperty,
    },
    required: ["id"],
  },
}

export interface CatalogToolCtx {
  userId?: string
  jwtToken?: string
  baseUrl: string
  conversationKey?: string
  background?: boolean
}

type Refusal = { refused: true; code: string; message: string }
const refuse = (code: string, message: string): Refusal => ({ refused: true, code, message })

/** Catalog tools run only for a live, signed-in admin: never a background run, never the cron secret as the token. */
function interactiveRefusal(ctx: CatalogToolCtx): Refusal | null {
  const cron = process.env.CRON_SECRET
  if (ctx.background || !ctx.userId || !ctx.jwtToken || (cron && ctx.jwtToken === cron)) {
    return refuse("interactive_only", "This can only be used in a live admin chat.")
  }
  return null
}

// ── Input shape description (zod 4 introspection) ────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function typeOf(field: any): string {
  let f = field
  for (let i = 0; i < 6; i++) {
    const def = f?._zod?.def
    if (!def) return "value"
    if (def.type === "optional" || def.type === "nullable" || def.type === "default" || def.type === "readonly") {
      f = def.innerType
      continue
    }
    switch (def.type) {
      case "string":
      case "number":
      case "boolean":
        return def.type
      case "enum":
        return `one of ${Object.values(def.entries ?? {}).map(String).join("|")}`
      case "literal":
        return `literal ${(def.values ?? []).map(String).join("|")}`
      case "array":
        return `${typeOf(def.element)}[]`
      case "object":
        return "object"
      case "union":
        return (def.options ?? []).map(typeOf).join(" | ")
      default:
        return "value"
    }
  }
  return "value"
}

function describeObject(prefix: string, schema: ZodType | undefined): string[] {
  const shape = (schema as any)?.shape as Record<string, ZodType> | undefined
  if (!shape) return []
  return Object.entries(shape).map(([key, field]) => {
    const optional = (field as any).safeParse(undefined).success
    return `${prefix}.${key}: ${typeOf(field)} (${optional ? "optional" : "required"})`
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Compact one-line input description. Secret field values and names are never listed, only the card's secure box label. */
export function describeEntryInput(entry: CatalogEntry): string {
  if (entry.typedCard) return `use ${entry.typedCard}`
  const parts: string[] = []
  for (const [name, kind] of Object.entries(entry.params ?? {})) parts.push(`params.${name}: ${kind} (required)`)
  parts.push(...describeObject("query", entry.query))
  parts.push(...describeObject("body", entry.body))
  for (const s of entry.secretFields ?? []) parts.push(`set in the card's secure box: ${s.label}`)
  return parts.length > 0 ? parts.join("; ") : "no input"
}

export interface FoundAction {
  id: string
  pageTitle: string
  page: string
  summary: string
  kind: CatalogEntry["kind"]
  risk: CatalogEntry["risk"]
  input: string
}

export function findAdminActions(input: { query?: unknown; page?: unknown }): { count: number; actions: FoundAction[] } {
  const query = typeof input.query === "string" ? input.query : ""
  const page = typeof input.page === "string" && input.page ? input.page : undefined
  const actions = searchCatalog(query, page, FIND_LIMIT).map((e) => ({
    id: e.id,
    pageTitle: e.pageTitle,
    page: e.page,
    summary: e.summary,
    kind: e.kind,
    risk: e.risk,
    input: describeEntryInput(e),
  }))
  return { count: actions.length, actions }
}

// ── admin_lookup ─────────────────────────────────────────────────────────────

function asEntryInput(raw: unknown): EntryInput {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const out: EntryInput = {}
  if (o.params && typeof o.params === "object") out.params = o.params as Record<string, string>
  if (o.query && typeof o.query === "object") out.query = o.query as Record<string, unknown>
  if (o.body && typeof o.body === "object") out.body = o.body as Record<string, unknown>
  return out
}

export async function adminLookup(
  args: { id?: unknown; input?: unknown },
  ctx: CatalogToolCtx,
): Promise<unknown> {
  const blocked = interactiveRefusal(ctx)
  if (blocked) return blocked

  const entry = typeof args.id === "string" ? getEntry(args.id) : undefined
  if (!entry) return refuse("unknown_action", "No such admin action. Search the catalog for the right entry id.")
  if (entry.kind !== "lookup") return refuse("not_a_lookup", "That entry changes data. Use prepare_admin_change instead.")

  const resolved = resolveRequest(entry, asEntryInput(args.input))
  if (!resolved.ok) return refuse(resolved.code, resolved.message)
  const { req } = resolved

  const timeoutMs = Math.min(entry.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const url = `${ctx.baseUrl}${req.path}${req.query ? `?${req.query}` : ""}`
  let res: Response
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.jwtToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    return { error: timedOut ? "The page did not answer in time. Try again." : "The page could not be reached. Try again." }
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const text = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `The request failed (status ${res.status}).`
    return { error: text.slice(0, MAX_ERROR) }
  }
  // The agentic loop wraps this result in the <data> fence like every other tool result.
  // The loop cuts any tool result at MAX_TOOL_RESULT_CHARS, so filter to a budget that leaves room for the
  // {"data":...,"truncated":...} wrapper: the model gets valid JSON with truncated:true, never a mid-JSON cut.
  return filterLookupResult(entry, body, MAX_TOOL_RESULT_CHARS - RESULT_WRAPPER_ROOM)
}

// ── prepare_admin_change ─────────────────────────────────────────────────────

export async function prepareAdminChange(
  db: SupabaseClient,
  args: { id?: unknown; input?: unknown },
  ctx: CatalogToolCtx,
): Promise<DraftToolResult> {
  const blocked = interactiveRefusal(ctx)
  if (blocked) return blocked
  return prepareAdminRouteCall(
    db,
    { adminId: ctx.userId as string, conversationKey: ctx.conversationKey ?? null, background: ctx.background },
    typeof args.id === "string" ? args.id : "",
    asEntryInput(args.input),
  )
}
