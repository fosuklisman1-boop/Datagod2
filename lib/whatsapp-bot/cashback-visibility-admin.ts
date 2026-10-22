// Pure view helpers for the admin switches card on /admin/whatsapp (app/admin/whatsapp/cashback-switches.tsx).
// The API is /api/admin/whatsapp/cashback-visibility (GET/POST { switches, live }).
import type { WhatsAppCashbackVisibility } from "./cashback-visibility"

export type WaCashbackSwitchKey = keyof WhatsAppCashbackVisibility

export const WA_CASHBACK_SWITCHES: readonly { key: WaCashbackSwitchKey; label: string; hint: string }[] = [
  { key: "networkPlans", label: "Network Plans", hint: "Cashback data plans on both WhatsApp bots (hidden by the data whitelist)." },
  { key: "payBills", label: "Pay Bills", hint: "ECG, Ghana Water (asks for an email), DStv and more on both WhatsApp bots." },
  { key: "cashbackAirtime", label: "Cashback airtime", hint: "Airtime priced with commission cashback on both WhatsApp bots." },
] as const

export const WA_CASHBACK_API = "/api/admin/whatsapp/cashback-visibility"

export interface WaCashbackState { switches: WhatsAppCashbackVisibility; live: WhatsAppCashbackVisibility }

/** The API answer, or null when it is not the expected shape (every value must be a boolean). */
export function parseWaCashbackState(json: unknown): WaCashbackState | null {
  const j = json as { switches?: Record<string, unknown>; live?: Record<string, unknown> } | null
  if (!j || typeof j !== "object" || !j.switches || !j.live) return null
  const pick = (o: Record<string, unknown>): WhatsAppCashbackVisibility | null => {
    const out = {} as WhatsAppCashbackVisibility
    for (const { key } of WA_CASHBACK_SWITCHES) {
      if (typeof o[key] !== "boolean") return null
      out[key] = o[key] as boolean
    }
    return out
  }
  const switches = pick(j.switches)
  const live = pick(j.live)
  return switches && live ? { switches, live } : null
}

/**
 * What the admin is told about one item: "live" (switch on AND the shared cashback Bots gate on), "waiting" (switch
 * on but the gate keeps it hidden: Cashback page > Bots surface / Sell on bots for that group) or "off".
 */
export function waCashbackStatus(s: WaCashbackState, key: WaCashbackSwitchKey): "live" | "waiting" | "off" {
  if (!s.switches[key]) return "off"
  return s.live[key] ? "live" : "waiting"
}
