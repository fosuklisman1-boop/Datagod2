import type { SupabaseClient } from "@supabase/supabase-js"
import type { sendSMS } from "@/lib/sms-service"
import { countOutbound } from "../store"
import type { TtbSettings } from "../settings"
import type { Line } from "../types"
import { sendViaPhone } from "./client"
import { parseKey } from "./sm4"

/**
 * The reply transport router: a drop-in `send` for sendReply, chosen per line. Server-only.
 *  - transport "hubtel" (default): the existing sendSMS, unchanged.
 *  - transport "sim": try the forwarder phone's own SIM; fall back to Hubtel on anything that proves nothing was sent.
 *  - an ambiguous timeout (request on the wire, no answer) counts as sent: never two copies to a customer.
 * Never logs the number, text, key or url: one fixed line per fallback with a reason code only.
 */

type Send = typeof sendSMS
type FallbackReason = "env" | "cap" | "refused" | "unreachable"

const WINDOW_MS = 30 * 60_000

export function createReplySend(args: {
  db: SupabaseClient
  line: Line
  settings: TtbSettings
  env?: NodeJS.ProcessEnv
  hubtel?: Send
  phone?: typeof sendViaPhone
  now?: () => Date
}): Send {
  const { db, line, settings } = args
  const env = args.env ?? process.env
  const phone = args.phone ?? sendViaPhone
  const now = args.now ?? (() => new Date())

  const hubtel: Send = args.hubtel ?? (async (p) => (await import("@/lib/sms-service")).sendSMS(p))

  const viaHubtel = (payload: Parameters<Send>[0], reason: FallbackReason): ReturnType<Send> => {
    console.warn(`text-to-buy: SIM reply fell back to Hubtel (${reason})`)
    return hubtel(payload)
  }

  return async (payload) => {
    const transport = line === "shop" ? settings.replyTransportShop : settings.replyTransportMain
    if (transport !== "sim") return hubtel(payload)

    const url = typeof env.SMS_PHONE_URL === "string" ? env.SMS_PHONE_URL.trim() : ""
    const keyHex = typeof env.SMS_PHONE_SM4_KEY === "string" ? env.SMS_PHONE_SM4_KEY.trim() : ""
    let urlOk = false
    try {
      urlOk = /^https?:$/.test(new URL(url).protocol)
    } catch {
      urlOk = false
    }
    if (!urlOk || !parseKey(keyHex)) return viaHubtel(payload, "env")

    // Rolling cap over every transport's out rows for this line; a count error counts as over the cap.
    let overCap = true
    try {
      const sent = await countOutbound(db, line, new Date(now().getTime() - WINDOW_MS))
      overCap = sent >= settings.simMaxPer30Min
    } catch {
      overCap = true
    }
    if (overCap) return viaHubtel(payload, "cap")

    let result: Awaited<ReturnType<typeof sendViaPhone>>
    try {
      result = await phone(
        { url, keyHex },
        { simSlot: line === "shop" ? settings.simSlotShop : settings.simSlotMain, to: payload.phone, text: payload.message },
      )
    } catch {
      result = { kind: "unreachable" }
    }
    if (result.kind === "sent" || result.kind === "ambiguous") return { success: true }
    return viaHubtel(payload, result.kind)
  }
}
