// Presentation profile of the commission-cashback bot flows (Network Plans, Pay Bills): one state machine, two
// presentations.
// - Uzo USSD (main + shop menus): 160-char screens, 5 per page, every Hubtel name rewritten by uzoSafeLabel (no
//   "data" / "bundle" words) in printable ASCII, the dialling number pays, no Ghana Water.
// - WhatsApp (main + shop bots): up to 1000 chars, 10 per page, Hubtel names as sent, the buyer types the MoMo number
//   to charge (never the sender's own number by default), Ghana Water offered (it needs an email).
import { shopHeaderName } from "@/lib/ussd-shop/menus"
import { uzoSafeLabel, UZO_SCREEN_LIMIT } from "./screen"

export interface BotFlowProfile {
  kind: "uzo" | "whatsapp"
  limit: number                     // uzo 160, whatsapp 1000
  pageSize: number                  // uzo 5, whatsapp 10
  label(name: string): string       // uzo: uzoSafeLabel; whatsapp: identity (trimmed)
  askPayPhone: boolean              // whatsapp: true
  allowGhanaWater: boolean          // whatsapp: true
}

export const WHATSAPP_MESSAGE_LIMIT = 1000

export const UZO_PROFILE: BotFlowProfile = Object.freeze({
  kind: "uzo",
  limit: UZO_SCREEN_LIMIT,
  pageSize: 5,
  // Printable ASCII on top of the wording rule (UCS-2 would halve the screen).
  label: (name: string) => shopHeaderName(uzoSafeLabel(name)),
  askPayPhone: false,
  allowGhanaWater: false,
})

export const WHATSAPP_PROFILE: BotFlowProfile = Object.freeze({
  kind: "whatsapp",
  limit: WHATSAPP_MESSAGE_LIMIT,
  pageSize: 10,
  // As Hubtel sends it; only runs of whitespace (a newline would fake a menu line) collapse to one space.
  label: (name: string) => String(name ?? "").replace(/\s+/g, " ").trim(),
  askPayPhone: true,
  allowGhanaWater: true,
})
