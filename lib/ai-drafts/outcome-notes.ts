import type { AiDraft } from "./types"

// Card outcome notes for the model. The SERVER builds them from ai_drafts rows only; any client text that looks like a
// note is stripped first, so the model can never be told a card succeeded by anything but the draft row.

/** Lines (or line tails) a client could send to forge a card result. Case-insensitive on the uuid. */
const CLIENT_NOTE = /\[card [0-9a-f-]{36}:[^\n]*/gi

export function stripClientCardNotes(text: string): string {
  return text.replace(CLIENT_NOTE, "").replace(/\n{3,}/g, "\n\n").trim()
}

/** Look back this far for terminal drafts (drafts expire in minutes to 12 h, so 24 h covers every turn). */
export const OUTCOME_LOOKBACK_MS = 24 * 60 * 60 * 1000

const SAFE_CODE = /^[a-z0-9_]{1,40}$/i
const SAFE_ORDER_CODE = /^[A-Za-z0-9_-]{1,40}$/

function shortOutcome(d: Pick<AiDraft, "status" | "outcome">): string {
  const o = (d.outcome ?? {}) as Record<string, unknown>
  const parts: string[] = []
  if (typeof o.order_code === "string" && SAFE_ORDER_CODE.test(o.order_code)) parts.push(`order ${o.order_code}`)
  if (typeof o.applied === "number" && typeof o.total === "number") parts.push(`${o.applied} of ${o.total} done`)
  if (typeof o.code === "string" && SAFE_CODE.test(o.code)) parts.push(o.code)
  if (parts.length === 0) parts.push(d.status === "succeeded" ? "done" : d.status)
  return parts.join(", ")
}

/** One note line per terminal draft; "" when there are none. Built from the draft row only. */
export function buildOutcomeNote(drafts: Array<Pick<AiDraft, "id" | "status" | "outcome">>): string {
  return drafts.map(d => `[card ${d.id}: ${d.status}; ${shortOutcome(d)}]`).join("\n")
}
