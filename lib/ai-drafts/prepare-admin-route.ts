import type { SupabaseClient } from "@supabase/supabase-js"
import { getEntry } from "@/lib/ai-admin-catalog/index"
import { resolveRequest } from "@/lib/ai-admin-catalog/resolve"
import type { CardLine, EntryInput } from "@/lib/ai-admin-catalog/types"
import { createDraft } from "./repo"
import { EXPIRY_MS, type DraftToolResult } from "./types"
import type { PrepareAdminCtx } from "./prepare-admin"

// Generic admin_route_call draft builder: a catalog entry + input becomes a pending confirm card. It executes nothing;
// the confirm side runs the stored request after the admin taps Confirm. Card text comes only from entry.card(), never
// from model text. No names, phones, emails or secrets go to logs.

// A card must never hide text that will be sent: nothing is clipped or dropped. Anything over a limit is refused.
const MAX_LINES = 40
const MAX_VALUE = 6000
const MAX_SUMMARY = 500
const TOO_LARGE = "This change is too large to show on a card. Use the page."

const refuse = (code: string, message: string): DraftToolResult => ({ refused: true, code, message })

export async function prepareAdminRouteCall(
  db: SupabaseClient,
  ctx: PrepareAdminCtx,
  entryId: string,
  input: EntryInput,
): Promise<DraftToolResult> {
  if (!ctx.adminId) return refuse("admin_required", "A signed-in admin is required to prepare this action.")
  if (ctx.background) return refuse("interactive_only", "This action can only be prepared in a live admin chat.")

  const entry = getEntry(entryId)
  if (!entry) return refuse("unknown_action", "No such admin action. Search the catalog for the right entry id.")
  if (entry.kind !== "change") return refuse("not_a_change", "That entry only reads data. Use the lookup tool instead.")
  if (entry.typedCard) {
    return refuse("use_typed_tool", `This action has its own tool. Use ${entry.typedCard} instead.`)
  }

  const resolved = resolveRequest(entry, input)
  if (!resolved.ok) return refuse(resolved.code, resolved.message)

  if (typeof entry.card !== "function") return refuse("card_error", "This action cannot show a confirmation card.")
  let card: { summary: string; lines: CardLine[] }
  try {
    card = await entry.card(input, { db, adminId: ctx.adminId })
  } catch {
    return refuse("card_error", "The confirmation card could not be built. Check the input and try again.")
  }

  const rawLines = Array.isArray(card.lines) ? card.lines : []
  const lines: CardLine[] = rawLines.map((l) => ({ label: String(l.label), value: String(l.value) }))
  const summary = String(card.summary)
  if (
    lines.length > MAX_LINES ||
    summary.length > MAX_SUMMARY ||
    lines.some((l) => l.value.length > MAX_VALUE || l.label.length > MAX_SUMMARY)
  ) {
    return refuse("card_too_large", TOO_LARGE)
  }

  const display: Record<string, unknown> = {
    kind: "admin_route",
    entryId: entry.id,
    page: entry.page,
    pageTitle: entry.pageTitle,
    summary,
    lines,
    risk: entry.risk,
    secretFields: entry.secretFields ?? [],
  }

  const draft = await createDraft(db, {
    userId: ctx.adminId,
    context: "admin",
    action: "admin_route_call",
    params: { entryId: entry.id, req: resolved.req },
    display,
    amountGhs: null,
    conversationKey: ctx.conversationKey,
    expiresInMs: EXPIRY_MS.admin,
  })
  return { draft_id: draft.id, display, expires_at: draft.expires_at, warnings: [] }
}
