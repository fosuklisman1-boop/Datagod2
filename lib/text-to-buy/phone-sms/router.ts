import type { SupabaseClient } from "@supabase/supabase-js"
import type { sendSMS } from "@/lib/sms-service"
import type { TtbSettings } from "../settings"
import type { Line } from "../types"
import { sendViaPhone } from "./client"
import { readPhoneLink } from "./config"

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

    // The same global kill switch sendSMS honours: nothing at all is sent (not even by SIM) while SMS is off.
    if (env.SMS_ENABLED !== "true") return { success: true, skipped: true }

    const link = readPhoneLink(env)
    if (!link) return viaHubtel(payload, "env")
    const { url, keyHex } = link

    // Rolling cap over every outbound reply of BOTH lines (one phone, one app: Android's limit is per app); a count error
    // counts as over the cap.
    let overCap = true
    try {
      const { count, error } = await db
        .from("ttb_messages")
        .select("id", { count: "exact", head: true })
        .eq("direction", "out")
        .gte("created_at", new Date(now().getTime() - WINDOW_MS).toISOString())
      overCap = error || typeof count !== "number" || !Number.isFinite(count) ? true : count >= settings.simMaxPer30Min
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
