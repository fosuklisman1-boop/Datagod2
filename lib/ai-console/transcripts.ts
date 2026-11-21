// Server-side transcripts of web AI chats (service role only). Every function swallows its own failures: the chat
// must never break because a transcript could not be written. Logs carry a fixed marker only, never message text or
// the database error (which can echo values).
import type { SupabaseClient } from "@supabase/supabase-js"
import { redactTranscriptText } from "./redact"

export type TranscriptContext = "home" | "storefront" | "dashboard" | "admin"
export type FlagReason = "refusal" | "handoff" | "error" | "card_failed"

export interface RecordTurnInput {
  conversationKey: string
  context: TranscriptContext
  userId?: string | null
  shopId?: string | null
  userText: string
  assistantText: string
  /** Extra flag reasons known to the caller (e.g. "error" when the stream ended in an error). */
  extraReasons?: FlagReason[]
}

const FAIL_MARKER = "[ai-conversations] transcript write failed"

// Conservative on purpose: an apology that goes on to refuse, or an explicit "I can't help/assist". A bare "sorry" or a
// user-facing "you can't ..." does not flag.
const REFUSAL_A = /\b(?:sorry|afraid)\b[^.!?\n]{0,12}\bI(?:'m| am)?\s+(?:can(?:'|’)?t|cannot|unable to|not able to)\b/i
const REFUSAL_B = /\bI\s+(?:cannot|can(?:'|’)?t)\s+(?:help|assist)\b|\bI(?:'m| am)\s+(?:unable|not able) to\s+(?:help|assist)\b/i

export function refusalLike(text: string): boolean {
  const t = String(text ?? "")
  return REFUSAL_A.test(t) || REFUSAL_B.test(t)
}

function mergeReasons(existing: unknown, add: FlagReason[]): string[] {
  const set = new Set<string>(Array.isArray(existing) ? (existing as string[]) : [])
  for (const r of add) set.add(r)
  return [...set]
}

async function findConversation(db: SupabaseClient, key: string) {
  const { data, error } = await db
    .from("ai_conversations")
    .select("id, user_id, context, message_count, flag_reasons")
    .eq("conversation_key", key)
    .maybeSingle()
  if (error) throw new Error("select")
  return data as { id: string; user_id: string | null; context: string; message_count: number; flag_reasons: string[] | null } | null
}

async function recordTurnInner(db: SupabaseClient, input: RecordTurnInput): Promise<void> {
  const userId = input.userId ?? null
  let conv = await findConversation(db, input.conversationKey)
  if (!conv) {
    const { error } = await db
      .from("ai_conversations")
      .insert({ conversation_key: input.conversationKey, context: input.context, user_id: userId, shop_id: input.shopId ?? null })
    // A unique violation means a concurrent request created it first; the re-read below settles it.
    void error
    conv = await findConversation(db, input.conversationKey)
    if (!conv) throw new Error("create")
  }
  // A key belongs to the conversation that created it: another user or surface presenting it appends nothing.
  if (conv.context !== input.context || (conv.user_id ?? null) !== userId) return

  const { error: mErr } = await db.from("ai_conversation_messages").insert([
    { conversation_id: conv.id, role: "user", text: redactTranscriptText(input.userText) || "(empty)" },
    { conversation_id: conv.id, role: "assistant", text: redactTranscriptText(input.assistantText) || "(no reply)" },
  ])
  if (mErr) throw new Error("messages")

  const reasons: FlagReason[] = [...(input.extraReasons ?? [])]
  if (refusalLike(input.assistantText)) reasons.push("refusal")
  const patch: Record<string, unknown> = { message_count: (conv.message_count ?? 0) + 2, last_at: new Date().toISOString() }
  if (reasons.length > 0) {
    patch.flagged = true
    patch.flag_reasons = mergeReasons(conv.flag_reasons, reasons)
  }
  const { error: uErr } = await db.from("ai_conversations").update(patch).eq("id", conv.id)
  if (uErr) throw new Error("update")
}

/** Stores one redacted user/assistant exchange. Never throws. */
export async function recordTurn(db: SupabaseClient, input: RecordTurnInput): Promise<void> {
  try {
    await recordTurnInner(db, input)
  } catch {
    console.error(FAIL_MARKER)
  }
}

/** Adds a flag to an EXISTING conversation (never creates one). Returns whether it existed. Never throws. */
export async function flagConversation(db: SupabaseClient, conversationKey: string, reason: FlagReason): Promise<boolean> {
  try {
    const conv = await findConversation(db, conversationKey)
    if (!conv) return false
    const { error } = await db
      .from("ai_conversations")
      .update({ flagged: true, flag_reasons: mergeReasons(conv.flag_reasons, [reason]) })
      .eq("id", conv.id)
    if (error) throw new Error("update")
    return true
  } catch {
    console.error(FAIL_MARKER)
    return false
  }
}

/** When a confirm card ends failed/unknown, flags the conversation that prepared it (if it has one). Never throws. */
export async function flagCardFailure(db: SupabaseClient, draftId: string, status: string): Promise<void> {
  if (status !== "failed" && status !== "unknown") return
  try {
    const { data } = await db.from("ai_drafts").select("conversation_key").eq("id", draftId).maybeSingle()
    const key = (data as { conversation_key?: string | null } | null)?.conversation_key
    if (key) await flagConversation(db, key, "card_failed")
  } catch {
    console.error(FAIL_MARKER)
  }
}
