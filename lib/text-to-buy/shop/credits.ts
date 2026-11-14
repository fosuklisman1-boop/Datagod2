import type { SupabaseClient } from "@supabase/supabase-js"
import type { TtbSettings } from "../settings"

/**
 * Shop-line SMS credits: thin wrappers over the SQL functions of migration 0180. Server-only, service-role client.
 * All money moves inside SQL (adjust_sms_units); nothing here updates a balance. Never logs, and never echoes database error
 * text (it can carry row values): failures are fixed messages or plain false.
 */

type DbError = { message?: string } | null | undefined
const has = (e: DbError, word: string) => typeof e?.message === "string" && e.message.includes(word)

/** The ledger ref 0180 uses for an order's reserve debit. Single-reply refs must never equal or contain it. */
export const reserveRef = (messageId: string) => `ttb:${messageId}`

/**
 * The unique ledger ref of one single-reply debit: `ttb:reply:<key>`. The key is restricted to letters, digits, "_" and "-"
 * (no colon), so a ref can never equal or contain `ttb:<message>` (the reserve debit) or end in `:release` / `:refund` (the
 * reserve release and the reply refund). Null for an unsafe key: the caller must treat that as unpaid.
 */
export function singleReplyRef(key: string): string | null {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(key)) return null
  if (key === "release" || key === "refund") return null // `ttb:reply:release` would look like a release/refund ref
  return `ttb:reply:${key}`
}

/**
 * The SMS account that pays for a shop's replies: the shop owner's own account (user_shops.user_id -> sms_accounts.user_id).
 * Read-only: it NEVER creates an account, and a sub-agent's shop uses the sub-agent's own account, never the parent's.
 * Null (the caller pauses) for an unknown shop, no account, or any read error.
 */
export async function shopAccountFor(db: SupabaseClient, shopId: string): Promise<{ accountId: string } | null> {
  const shop = await db.from("user_shops").select("user_id").eq("id", shopId).maybeSingle()
  const userId = (shop.data as { user_id?: unknown } | null)?.user_id
  if (shop.error || typeof userId !== "string" || !userId) return null
  const acct = await db.from("sms_accounts").select("id").eq("user_id", userId).maybeSingle()
  const id = (acct.data as { id?: unknown } | null)?.id
  if (acct.error || typeof id !== "string" || !id) return null
  return { accountId: id }
}

/**
 * Sets credits aside for one order message (ttb_reserve_credits). ok:true also when the message was already reserved (the SQL
 * returns false and debits nothing twice). SUSPENDED and NOT_ACTIVATED are "inactive". Any other error throws (fixed message).
 */
export async function reserveForOrder(
  db: SupabaseClient,
  a: { accountId: string; shopId: string; messageId: string; credits: number },
): Promise<{ ok: true } | { ok: false; reason: "no_account" | "inactive" | "insufficient" }> {
  if (!a.accountId) return { ok: false, reason: "no_account" }
  const { error } = await db.rpc("ttb_reserve_credits", {
    p_account_id: a.accountId,
    p_message_id: a.messageId,
    p_shop_id: a.shopId,
    p_credits: a.credits,
  })
  if (!error) return { ok: true }
  if (has(error, "INSUFFICIENT_CREDITS")) return { ok: false, reason: "insufficient" }
  if (has(error, "SUSPENDED") || has(error, "NOT_ACTIVATED")) return { ok: false, reason: "inactive" }
  throw new Error("text-to-buy credits: could not reserve credits")
}

/** Uses n credits of the order's open reserve. False when there is no open reserve or not enough left (or on any error). */
export async function drawReserve(db: SupabaseClient, messageId: string, credits: number): Promise<boolean> {
  const { data, error } = await db.rpc("ttb_draw_reserve", { p_message_id: messageId, p_credits: credits })
  return !error && data === true
}

/**
 * Gives back the unused part of the order's reserve, once. Returns the credits refunded; 0 on a repeat, an unknown message or
 * when all were used. A database error THROWS (fixed message): the release is atomic in SQL, so it can simply be retried.
 */
export async function releaseReserve(db: SupabaseClient, messageId: string): Promise<number> {
  const { data, error } = await db.rpc("ttb_release_reserve", { p_message_id: messageId })
  if (error || typeof data !== "number" || !Number.isFinite(data)) throw new Error("text-to-buy credits: could not release a reserve")
  return data
}

/** Debits one reply under a unique ref (ttb_debit_reply). True only when THIS call debited; false on a repeat or any refusal. */
export async function chargeSingleReply(db: SupabaseClient, a: { accountId: string; credits: number; ref: string }): Promise<boolean> {
  const { data, error } = await db.rpc("ttb_debit_reply", { p_account_id: a.accountId, p_credits: a.credits, p_ref: a.ref })
  return !error && data === true
}

/** Gives back a single-reply debit made under the SAME ref, once (ttb_refund_reply). False when nothing was refunded. */
export async function refundSingleReply(db: SupabaseClient, a: { accountId: string; credits: number; ref: string }): Promise<boolean> {
  const { data, error } = await db.rpc("ttb_refund_reply", { p_account_id: a.accountId, p_credits: a.credits, p_ref: a.ref })
  return !error && data === true
}

/**
 * True when this shop has already had settings.shopRepliesPerHourPerShop shop-paid replies in the last hour (out rows of
 * ttb_messages with this shop_id and credits > 0; the (shop_id, created_at DESC) partial index serves it). At most `cap` ids
 * are read. Fails CLOSED: a read error reports the cap as reached, so a broken count never lets spend run free.
 */
export async function shopReplyCapReached(db: SupabaseClient, shopId: string, settings: TtbSettings, now: Date = new Date()): Promise<boolean> {
  const cap = settings.shopRepliesPerHourPerShop
  const since = new Date(now.getTime() - 60 * 60_000).toISOString()
  const { data, error } = await db
    .from("ttb_messages")
    .select("id")
    .eq("shop_id", shopId)
    .eq("direction", "out")
    .gt("credits", 0)
    .gte("created_at", since)
    .limit(cap)
  if (error || !Array.isArray(data)) return true
  return data.length >= cap
}
