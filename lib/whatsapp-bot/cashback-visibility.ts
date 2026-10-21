// Dark-rollout switches for the commission-cashback items on the WhatsApp bots (main + shop): "Network Plans",
// "Pay Bills" and cashback airtime. In prod the shared Bots surface and every botGroups switch are already on (Uzo /
// Hubtel USSD), so these per-channel switches keep WhatsApp dark until an admin flips them.
//
// - admin_settings key `whatsapp_cashback_visibility` = { networkPlans, payBills, cashbackAirtime }.
// - Each switch is on ONLY when stored `=== true`: a missing key, a partial map or a read error reads as off.
// - An item is live only when the shared cashback bots gate (enabled && surfaces.bots && botGroups[group]) AND its
//   switch are on. Group mapping: bundles => networkPlans, bills => payBills, airtime => cashbackAirtime.
// Mirrors lib/ussd/bots/gate.ts (the Uzo equivalent).
import type { SupabaseClient } from "@supabase/supabase-js"
import { botGroupOn } from "@/lib/bot-commission/context"
import { getCashbackConfig } from "@/lib/cashback/config"

export const WHATSAPP_CASHBACK_VISIBILITY_KEY = "whatsapp_cashback_visibility"

export interface WhatsAppCashbackVisibility { networkPlans: boolean; payBills: boolean; cashbackAirtime: boolean }

const ITEMS = ["networkPlans", "payBills", "cashbackAirtime"] as const satisfies readonly (keyof WhatsAppCashbackVisibility)[]

const ALL_OFF: Readonly<WhatsAppCashbackVisibility> = Object.freeze({ networkPlans: false, payBills: false, cashbackAirtime: false })

const TAG = "[WA-CASHBACK]"

/** Strict read: throws on a DB error. Each switch is `stored === true`. */
async function readStrict(db: SupabaseClient): Promise<WhatsAppCashbackVisibility> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", WHATSAPP_CASHBACK_VISIBILITY_KEY).maybeSingle()
  if (error) throw error
  const v = data?.value
  const stored = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  return { networkPlans: stored.networkPlans === true, payBills: stored.payBills === true, cashbackAirtime: stored.cashbackAirtime === true }
}

/** The WhatsApp switches. Missing key or any read error => all off. Never throws. */
export async function getWhatsAppCashbackVisibility(db: SupabaseClient): Promise<WhatsAppCashbackVisibility> {
  try {
    return await readStrict(db)
  } catch (e) {
    console.error(TAG, "switch read failed; all off:", e instanceof Error ? e.message : "error")
    return { ...ALL_OFF }
  }
}

/**
 * Read-modify-write over the whole map (admin). A read error throws BEFORE any write (a failed read must never be
 * written back as "all off"). Only the three known keys with boolean values are accepted.
 */
export async function setWhatsAppCashbackVisibility(db: SupabaseClient, patch: Partial<WhatsAppCashbackVisibility>): Promise<void> {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(ITEMS as readonly string[]).includes(k)) throw new Error(`Unknown WhatsApp cashback switch: ${k}`)
    if (typeof v !== "boolean") throw new Error(`WhatsApp cashback switch ${k} must be true or false`)
  }
  const current = await readStrict(db)
  const value: WhatsAppCashbackVisibility = { ...current, ...patch }
  const { error } = await db.from("admin_settings").upsert(
    {
      key: WHATSAPP_CASHBACK_VISIBILITY_KEY,
      value,
      description: "WhatsApp bots (main + shop) commission-cashback items: networkPlans/payBills/cashbackAirtime, off unless true. Live only with the cashback bots gate.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  )
  if (error) throw error
}

/** Which cashback items the WhatsApp bots offer right now: cashback bots gate AND the WhatsApp switch. Never throws. */
export async function whatsappBotItemsVisible(db: SupabaseClient): Promise<WhatsAppCashbackVisibility> {
  try {
    const sw = await readStrict(db)
    if (!sw.networkPlans && !sw.payBills && !sw.cashbackAirtime) return { ...ALL_OFF }
    const cfg = await getCashbackConfig(db)
    return {
      networkPlans: sw.networkPlans && botGroupOn(cfg, "bundles"),
      payBills: sw.payBills && botGroupOn(cfg, "bills"),
      cashbackAirtime: sw.cashbackAirtime && botGroupOn(cfg, "airtime"),
    }
  } catch (e) {
    console.error(TAG, "cashback gate unavailable; hiding WhatsApp cashback items:", e instanceof Error ? e.message : "error")
    return { ...ALL_OFF }
  }
}
