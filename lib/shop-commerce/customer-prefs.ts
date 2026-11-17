import type { SupabaseClient } from "@supabase/supabase-js"
import type { ResolvedShopCode } from "./shop-code"

// One remembered shop per phone, shared by USSD (Hubtel + Uzo), SMS Text-to-Buy and the WhatsApp shop bot
// (table public.shop_customer_prefs, migration 0183). Pure over an injected client; nothing here logs a phone number.

type Db = Pick<SupabaseClient, "from">

export type PrefChannel = "ussd_hubtel" | "ussd_uzo" | "sms" | "whatsapp"

export const SHOP_MEMORY_SETTING_KEY = "ussd_shop_memory_enabled"

/** Fixed-message error: never carries database text (which can echo a phone number). */
export class CustomerPrefsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CustomerPrefsError"
  }
}

/** +233..., 233... or 0... as local 0XXXXXXXXX (the table's CHECK form); null for anything else. */
export function toLocalPhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "")
  if (/^0\d{9}$/.test(digits)) return digits
  if (/^233\d{9}$/.test(digits)) return "0" + digits.slice(3)
  return null
}

/** A shop name as shown on a USSD line: trimmed, at most 20 characters, no ellipsis. */
export function shortShopName(name: string): string {
  return (name ?? "").trim().slice(0, 20)
}

/** The shop code id remembered for this phone, or null. Throws CustomerPrefsError on a read error. */
export async function getCustomerShopCodeId(db: Db, phone: string): Promise<string | null> {
  const local = toLocalPhone(phone)
  if (!local) return null
  const { data, error } = await db.from("shop_customer_prefs").select("shop_code_id").eq("phone", local).maybeSingle()
  if (error) throw new CustomerPrefsError("could not read a shop preference")
  const id = (data as { shop_code_id?: unknown } | null)?.shop_code_id
  return typeof id === "string" ? id : null
}

/** Remembers the shop for this phone (one row per phone). No-op for a phone that will not normalise. */
export async function rememberCustomerShop(db: Db, phone: string, shopCodeId: string, channel: PrefChannel): Promise<void> {
  const local = toLocalPhone(phone)
  if (!local) return
  const { error } = await db
    .from("shop_customer_prefs")
    .upsert({ phone: local, shop_code_id: shopCodeId, last_channel: channel, last_used_at: new Date().toISOString() }, { onConflict: "phone" })
  if (error) throw new CustomerPrefsError("could not save a shop preference")
}

/**
 * ussd_shop_orders.dialing_phone is written as the channel gave it: +233... (Uzo, Hubtel), and the WhatsApp shop bot
 * passes the sender id through (233... without the plus); older rows may be local 0XXXXXXXXX. Match all three.
 */
const dialingForms = (local: string) => {
  const sig = local.replace(/^0/, "")
  return [`+233${sig}`, `233${sig}`, `0${sig}`]
}
// order_status values that mean the customer did not get the bundle (refund sets 'refunded'; 'refunding' is mid-refund).
const NOT_BOUGHT = new Set(["failed", "refunded", "refunding", "reversed"])

/**
 * The shop code of this phone's newest bought order: payment completed and the order not failed, refunded or reversed.
 * Null when there is none. Looks at the 20 newest paid rows of the phone; the status test runs here so the list can grow.
 */
export async function lastBoughtShopCodeId(db: Db, senderLocal: string): Promise<string | null> {
  const { data, error } = await db
    .from("ussd_shop_orders")
    .select("shop_code_id, order_status, payment_status")
    .in("dialing_phone", dialingForms(senderLocal))
    .eq("payment_status", "completed")
    .order("created_at", { ascending: false })
    .limit(20)
  if (error || !Array.isArray(data)) throw new CustomerPrefsError("could not read the last shop order")
  for (const r of data as Record<string, unknown>[]) {
    if (typeof r.shop_code_id === "string" && !NOT_BOUGHT.has(String(r.order_status))) return r.shop_code_id
  }
  return null
}

type CodeLookup = (code: string) => Promise<ResolvedShopCode | null>

// shop-code.ts builds a service-role client when it loads, so the real lookup is imported lazily (as the TTB wiring does).
const defaultLookup: CodeLookup = async (code) => {
  const { resolveShopCode } = await import("./shop-code")
  return resolveShopCode(code)
}

/** A remembered shop id back to its current facts: id to code string to the exact code lookup. Null when the id is gone. */
export async function resolveShopCodeById(db: Db, shopCodeId: string, lookup: CodeLookup = defaultLookup): Promise<ResolvedShopCode | null> {
  const { data, error } = await db.from("ussd_shop_codes").select("code").eq("id", shopCodeId).maybeSingle()
  const code = (data as { code?: unknown } | null)?.code
  if (error || typeof code !== "string" || !code) return null
  return lookup(code)
}

export type RememberedShop = { shopCodeId: string; shopName: string }

type EmbeddedShop = { shop_name?: string | null; ussd_display_name?: string | null; is_active?: boolean | null; is_blocked?: boolean | null }
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/**
 * The shop to offer as the "last used" shortcut on a USSD menu, or null. One embedded read for the remembered pref; with
 * no pref row, the phone's last bought shop is looked up and, when usable, seeded as the pref. A shop is usable when its
 * code is active, the shop is not blocked and not inactive (the rule resolveShopCode applies). Never throws.
 */
export async function rememberedShopForUssd(db: Db, phone: string, channel: PrefChannel, lookup: CodeLookup = defaultLookup): Promise<RememberedShop | null> {
  try {
    const local = toLocalPhone(phone)
    if (!local) return null
    const { data, error } = await db
      .from("shop_customer_prefs")
      .select("shop_code_id, ussd_shop_codes(status, user_shops(shop_name, ussd_display_name, is_active, is_blocked))")
      .eq("phone", local)
      .maybeSingle()
    if (error) throw new CustomerPrefsError("could not read a shop preference")

    const row = data as { shop_code_id?: unknown; ussd_shop_codes?: unknown } | null
    if (row && typeof row.shop_code_id === "string") {
      const code = one(row.ussd_shop_codes as { status?: string; user_shops?: EmbeddedShop | EmbeddedShop[] | null } | null)
      const shop = one(code?.user_shops)
      if (!code || !shop || code.status !== "active" || shop.is_blocked === true || shop.is_active === false) return null
      return { shopCodeId: row.shop_code_id, shopName: shop.ussd_display_name || shop.shop_name || "Shop" }
    }

    const lastId = await lastBoughtShopCodeId(db, local)
    if (!lastId) return null
    const resolved = await resolveShopCodeById(db, lastId, lookup)
    if (!resolved || resolved.status !== "active") return null
    try {
      await rememberCustomerShop(db, local, resolved.shopCodeId, channel)
    } catch (e) {
      console.error("rememberedShopForUssd: seed failed", { shopCodeId: resolved.shopCodeId, message: e instanceof CustomerPrefsError ? e.message : "unknown" })
    }
    return { shopCodeId: resolved.shopCodeId, shopName: resolved.shopName }
  } catch (e) {
    console.error("rememberedShopForUssd failed", { message: e instanceof CustomerPrefsError ? e.message : "unexpected error" })
    return null
  }
}

/** The admin switch for the shortcut. Only `{enabled: true}` turns it on; a missing row or any failure is off. Never throws. */
export async function isShopMemoryEnabled(db: Db): Promise<boolean> {
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", SHOP_MEMORY_SETTING_KEY).maybeSingle()
    if (error) return false
    return (data as { value?: { enabled?: unknown } | null } | null)?.value?.enabled === true
  } catch {
    return false
  }
}
