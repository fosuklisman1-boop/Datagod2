/**
 * Whether a shop may bill its order confirmations to its own sender ID: the shop's SMS account
 * (sms_accounts.user_id = user_shops.user_id) must be 'active' and have an active own sender ID.
 * Never throws — any lookup failure is ok:false so callers refuse/fall back to the free sender.
 */
import { createClient } from "@supabase/supabase-js"
import { loadDefaultSender } from "./default-sender"
import { getRoutingConfig } from "./routing"
import { enqueueSend, type EnqueueSendError, type EnqueueSendResult } from "./send-service"

export type OwnSenderCheck = {
  ok: boolean
  reason?: string
  accountId?: string
  userId?: string
  senderId?: string
}

type Db = { from: (table: string) => any }

let admin: Db | null = null
function defaultDb(): Db {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return admin
}

export async function canUseOwnSenderForConfirmations(shopId: string, db?: Db): Promise<OwnSenderCheck> {
  try {
    const client = db ?? defaultDb()
    const { data: shop, error: shopErr } = await client.from("user_shops").select("user_id").eq("id", shopId).maybeSingle()
    if (shopErr) return { ok: false, reason: "Could not look up your shop. Try again." }
    const userId = (shop as { user_id?: string } | null)?.user_id
    if (!userId) return { ok: false, reason: "Shop not found." }

    const { data: acct, error: acctErr } = await client
      .from("sms_accounts")
      .select("id, status")
      .eq("user_id", userId)
      .maybeSingle()
    if (acctErr) return { ok: false, reason: "Could not look up your SMS account. Try again." }
    const account = acct as { id?: string; status?: string } | null
    if (!account?.id) return { ok: false, reason: "Set up Bulk SMS first to use your own sender ID for order confirmations." }
    if (account.status !== "active") return { ok: false, reason: "Your SMS account is not active." }

    const senderId = await loadDefaultSender(client, account.id)
    if (!senderId) return { ok: false, reason: "You need an active sender ID to use it for order confirmations." }

    return { ok: true, accountId: account.id, userId, senderId }
  } catch {
    return { ok: false, reason: "Could not verify your sender ID. Try again." }
  }
}

// ---------------------------------------------------------------------------------------------
// Billed order confirmations (Phase 4b). Called from order FULFILMENT: nothing below may throw or
// make a confirmation disappear — every failure resolves to "fallback" (the caller then sends the
// existing free platform-sender SMS), except "duplicate" (this order was already handled once).
// ---------------------------------------------------------------------------------------------

export type ConfirmationSender =
  | { useOwnSender: false }
  | { useOwnSender: true; accountId: string; userId: string; senderId: string }

/**
 * Which sender an order confirmation for this shop uses. Own sender ONLY when the shop turned on
 * shop_settings.order_confirmation_use_own_sender AND it is still eligible (active SMS account +
 * active own sender ID). Any gap or error ⇒ platform sender. Never throws.
 */
export async function resolveConfirmationSender(shopId: string, db?: Db): Promise<ConfirmationSender> {
  try {
    const client = db ?? defaultDb()
    const { data, error } = await client
      .from("shop_settings")
      .select("order_confirmation_use_own_sender")
      .eq("shop_id", shopId)
      .maybeSingle()
    if (error) return { useOwnSender: false }
    if ((data as { order_confirmation_use_own_sender?: boolean } | null)?.order_confirmation_use_own_sender !== true) {
      return { useOwnSender: false }
    }
    const check = await canUseOwnSenderForConfirmations(shopId, client)
    if (!check.ok || !check.accountId || !check.userId || !check.senderId) return { useOwnSender: false }
    return { useOwnSender: true, accountId: check.accountId, userId: check.userId, senderId: check.senderId }
  } catch {
    return { useOwnSender: false }
  }
}

/**
 * The admin-selected provider for own-sender order confirmations, or undefined for "global"
 * (use the normal routing). Never throws — any failure ⇒ undefined.
 */
export async function resolveOwnSenderProvider(): Promise<"moolre" | "hubtel" | undefined> {
  try {
    const sel = (await getRoutingConfig()).categoryProviders.order_confirmation_own_sender
    return sel === "moolre" || sel === "hubtel" ? sel : undefined
  } catch {
    return undefined
  }
}

export type BilledConfirmationStatus = "billed_sent" | "duplicate" | "fallback"
export type BilledConfirmationResult = { status: BilledConfirmationStatus; reason?: string }

export interface BilledConfirmationInput {
  shopOrderId: string
  shopId: string
  accountId: string
  userId: string
  senderId: string
  phone: string
  message: string
  /** Provider override for this send (own-sender category). Omit to use the global routing. */
  provider?: "moolre" | "hubtel"
}

export const UNBILLED_NOTIFY_TYPE = "sms_order_confirm_unbilled"

type Enqueue = (...args: Parameters<typeof enqueueSend>) => Promise<EnqueueSendResult | EnqueueSendError>

export interface BilledConfirmationDeps {
  db?: Db
  enqueue?: Enqueue
  now?: () => Date
}

const PG_UNIQUE_VIOLATION = "23505"

/** Best-effort guard-row update; a failure here never changes the outcome. */
async function updateGuard(db: Db, shopOrderId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await db.from("sms_order_confirmations").update(patch).eq("shop_order_id", shopOrderId)
    if (error) console.error("[SMS-ORDER-CONFIRM] guard update failed:", error.message)
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM] guard update threw:", e)
  }
}

/** At most ONE "out of credits, using the platform sender" notification per owner per day. Never throws. */
async function notifyUnbilledOnce(db: Db, userId: string, now: Date): Promise<void> {
  try {
    // Ghana is UTC+0, so the UTC calendar day is the owner's day.
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    const { data: existing, error: lookupErr } = await db
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("type", UNBILLED_NOTIFY_TYPE)
      .gte("created_at", startOfDay)
      .limit(1)
      .maybeSingle()
    if (lookupErr) {
      // Can't prove we haven't notified today; skip rather than risk spamming the owner.
      console.error("[SMS-ORDER-CONFIRM] notification lookup failed:", lookupErr.message)
      return
    }
    if (existing) return
    const at = now.toISOString()
    const { error } = await db.from("notifications").insert({
      user_id: userId,
      title: "Order confirmations sent from the platform sender",
      message:
        "Your order confirmations are going out from the platform sender because you're out of SMS credits. Top up to send them from your own sender ID again.",
      type: UNBILLED_NOTIFY_TYPE,
      read: false,
      action_url: "/dashboard/sms",
      created_at: at,
      updated_at: at,
    })
    if (error) console.error("[SMS-ORDER-CONFIRM] notification insert failed:", error.message)
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM] notification threw:", e)
  }
}

/**
 * Send one order confirmation from the shop's own sender, billed in credits.
 *  1. Idempotency guard: INSERT sms_order_confirmations ... ON CONFLICT DO NOTHING. A conflict
 *     means this order was already handled ⇒ "duplicate" (the caller sends NOTHING). Any other
 *     guard error ⇒ "fallback" (never lose the confirmation).
 *  2. enqueueSend (kill switch, entitlement, content filter, debit, log, dispatch) tagged
 *     source='order_confirmation'. ok ⇒ "billed_sent". Anything else (incl. a throw) ⇒ guard
 *     mode='free' and "fallback"; INSUFFICIENT_CREDITS also notifies the owner (once a day).
 * Never throws.
 */
export async function sendBilledConfirmation(
  input: BilledConfirmationInput,
  deps: BilledConfirmationDeps = {}
): Promise<BilledConfirmationResult> {
  let db: Db
  try {
    db = deps.db ?? defaultDb()
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM] no db client:", e)
    return { status: "fallback", reason: "GUARD_FAILED" }
  }
  const enqueue: Enqueue = deps.enqueue ?? enqueueSend
  const now = deps.now ?? (() => new Date())

  // 1. Guard row first.
  try {
    const { data, error } = await db
      .from("sms_order_confirmations")
      .upsert(
        { shop_order_id: input.shopOrderId, shop_id: input.shopId, sms_account_id: input.accountId, mode: "billed" },
        { onConflict: "shop_order_id", ignoreDuplicates: true }
      )
      .select("shop_order_id")
    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) return { status: "duplicate" }
      console.error("[SMS-ORDER-CONFIRM] guard insert failed:", error.message)
      return { status: "fallback", reason: "GUARD_FAILED" }
    }
    if (!Array.isArray(data) || data.length === 0) return { status: "duplicate" }
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM] guard insert threw:", e)
    return { status: "fallback", reason: "GUARD_FAILED" }
  }

  // 2. Billed send.
  let result: EnqueueSendResult | EnqueueSendError
  try {
    result = await enqueue(
      input.userId, input.accountId, input.message, [input.phone],
      undefined, input.senderId, undefined, undefined, { source: "order_confirmation", ...(input.provider ? { provider: input.provider } : {}) }
    )
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM] enqueueSend threw:", e)
    await updateGuard(db, input.shopOrderId, { mode: "free" })
    return { status: "fallback", reason: "ENQUEUE_THREW" }
  }

  if (result && result.ok === true) {
    const logId = Number(result.sendLogId)
    await updateGuard(db, input.shopOrderId, { send_log_id: Number.isFinite(logId) ? logId : null })
    return { status: "billed_sent" }
  }

  const reason = (result as EnqueueSendError | undefined)?.error ?? "ENQUEUE_FAILED"
  await updateGuard(db, input.shopOrderId, { mode: "free" })
  if (reason === "INSUFFICIENT_CREDITS") await notifyUnbilledOnce(db, input.userId, now())
  return { status: "fallback", reason }
}

/**
 * Pure send decision for the fulfilment route (route files may only export HTTP handlers).
 *  "none"   — send nothing (shop turned confirmations off, or the billed path sent / already handled it)
 *  "billed" — attempt sendBilledConfirmation (own sender, toggle on, not attempted yet)
 *  "free"   — send the free platform-sender SMS (no senderId)
 */
export function decideConfirmationSend(input: {
  skipShopSms: boolean
  useOwnSender: boolean
  billedStatus?: BilledConfirmationStatus
}): "none" | "billed" | "free" {
  if (input.skipShopSms) return "none"
  if (!input.useOwnSender) return "free"
  if (input.billedStatus === undefined) return "billed"
  return input.billedStatus === "fallback" ? "free" : "none"
}
