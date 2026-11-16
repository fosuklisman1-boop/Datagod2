import type { SupabaseClient } from "@supabase/supabase-js"
import { loadTtbSettings } from "./settings"

/**
 * Shop-owner "Text Orders" page: a read-only picture of the owner's own shop on the Text-to-Buy shop line.
 * The pure part (status rules, masking, view building) is unit tested; loadOwnerRaw is the thin database read.
 * The shop is always derived from the signed-in user (never from the client). The customer's sender number is never
 * selected, and the recipient is masked, so the page cannot leak a customer's phone number.
 */

/** The smallest order reserve (own-number order). Below this the shop line pauses the shop. */
export const MIN_ORDER_CREDITS = 2
/** Below this the page warns the owner to top up. */
export const LOW_CREDITS = 10

export type OwnerStatus = "off" | "closed" | "no_sms" | "paused" | "low" | "live"

export type OwnerOrderRow = {
  id: string
  size: string
  recipient: string
  gift: boolean
  amount: number
  state: string
  created_at: string
  paid_at: string | null
  delivered_at: string | null
}

export type OwnerRaw = {
  shopEnabled: boolean
  shopNumber: string
  shop: { name: string; isActive: boolean; isBlocked: boolean }
  code: { code: string; status: string } | null
  account: { status: string; balance: number } | null
  /** Newest first, already limited by the loader. */
  orders: OwnerOrderRow[]
  /** The 30-day window's orders (timestamps only). */
  windowOrders: { paid_at: string | null; delivered_at: string | null }[]
  /** Sum of reply credits spent by this shop in the window. */
  credits30d: number
}

export type OwnerView = {
  status: OwnerStatus
  shopName: string
  shopNumber: string | null
  shopCode: string | null
  balance: number | null
  shareMessage: string | null
  stats: { orders: number; paid: number; delivered: number; creditsUsed: number }
  orders: { id: string; size: string; recipient: string; gift: boolean; amount: number; status: string; createdAt: string }[]
}

export function maskPhone(p: string): string {
  return /^\d{10}$/.test(p) ? `${p.slice(0, 3)}••••${p.slice(7)}` : "•••"
}

export function deriveOwnerStatus(r: OwnerRaw): OwnerStatus {
  if (!r.shopEnabled) return "off"
  if (!r.code || r.code.status !== "active" || !r.shop.isActive || r.shop.isBlocked) return "closed"
  if (!r.account || r.account.status !== "active") return "no_sms"
  if (r.account.balance < MIN_ORDER_CREDITS) return "paused"
  if (r.account.balance < LOW_CREDITS) return "low"
  return "live"
}

export function orderStatusLabel(o: { state: string; paid_at: string | null; delivered_at: string | null }): string {
  if (o.delivered_at) return "Delivered"
  if (o.paid_at) return o.state === "closed" ? "Paid, needs review" : "Paid, delivering"
  return o.state === "awaiting_payment" ? "Waiting for payment" : "Not paid"
}

export function buildOwnerView(r: OwnerRaw, _now: Date = new Date()): OwnerView {
  const shareable = r.shopEnabled && !!r.code && r.shopNumber.trim() !== ""
  return {
    status: deriveOwnerStatus(r),
    shopName: r.shop.name,
    shopNumber: r.shopNumber.trim() || null,
    shopCode: r.code?.code ?? null,
    balance: r.account ? r.account.balance : null,
    shareMessage: shareable
      ? `Buy data from ${r.shop.name} by text! SMS ${r.shopNumber.trim()} with the size and our shop code ${r.code!.code}. Example: 5GB ${r.code!.code}. Approve the MoMo prompt and your data arrives in minutes. Next time just text 5GB.`
      : null,
    stats: {
      orders: r.windowOrders.length,
      paid: r.windowOrders.filter((o) => o.paid_at).length,
      delivered: r.windowOrders.filter((o) => o.delivered_at).length,
      creditsUsed: r.credits30d,
    },
    orders: r.orders.map((o) => ({
      id: o.id,
      size: o.size,
      recipient: maskPhone(o.recipient),
      gift: o.gift,
      amount: o.amount,
      status: orderStatusLabel(o),
      createdAt: o.created_at,
    })),
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0)

/**
 * Reads everything the page needs for the shop owned by `userId`. Null when the user owns no shop. Throws (fixed message,
 * no row text) on a database error so the route can answer 500. Customer sender numbers are never selected.
 */
export async function loadOwnerRaw(db: SupabaseClient, userId: string, now: Date = new Date()): Promise<OwnerRaw | null> {
  const shopRes = await db.from("user_shops").select("id, shop_name, ussd_display_name, is_active, is_blocked").eq("user_id", userId).limit(1).maybeSingle()
  if (shopRes.error) throw new Error("text-orders: could not read the shop")
  const shop = shopRes.data as { id: string; shop_name: string | null; ussd_display_name: string | null; is_active: boolean | null; is_blocked: boolean | null } | null
  if (!shop) return null

  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const [settings, codeRes, acctRes, ordersRes, windowRes, creditsRes] = await Promise.all([
    loadTtbSettings(db),
    db.from("ussd_shop_codes").select("code, status").eq("shop_id", shop.id).limit(1).maybeSingle(),
    db.from("sms_accounts").select("status, unit_balance").eq("user_id", userId).maybeSingle(),
    db.from("ttb_orders").select("id, size, recipient, gift, amount, state, created_at, paid_at, delivered_at").eq("shop_id", shop.id).order("created_at", { ascending: false }).limit(20),
    db.from("ttb_orders").select("paid_at, delivered_at").eq("shop_id", shop.id).gte("created_at", since).limit(5000),
    db.from("ttb_messages").select("credits").eq("shop_id", shop.id).eq("direction", "out").gt("credits", 0).gte("created_at", since).limit(5000),
  ])
  if (codeRes.error || acctRes.error || ordersRes.error || windowRes.error || creditsRes.error) throw new Error("text-orders: could not read the shop line data")

  const code = codeRes.data as { code: string; status: string } | null
  const acct = acctRes.data as { status: string; unit_balance: number } | null
  return {
    shopEnabled: settings.shopEnabled,
    shopNumber: settings.shopNumber,
    shop: { name: shop.ussd_display_name || shop.shop_name || "Your shop", isActive: shop.is_active !== false, isBlocked: shop.is_blocked === true },
    code: code ? { code: String(code.code), status: String(code.status) } : null,
    account: acct ? { status: String(acct.status), balance: num(acct.unit_balance) } : null,
    orders: ((ordersRes.data ?? []) as OwnerOrderRow[]).map((o) => ({ ...o, amount: num(o.amount) })),
    windowOrders: (windowRes.data ?? []) as { paid_at: string | null; delivered_at: string | null }[],
    credits30d: ((creditsRes.data ?? []) as { credits: number | null }[]).reduce((s, m) => s + num(m.credits), 0),
  }
}
