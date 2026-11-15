// Missed-call decision (spec 4.3). Every dependency is injected; ./default-deps.ts holds the real wiring.
// Never throws, never logs, and never puts a phone number or any text in an alert.

import type { ResolvedShopCode } from "../../shop-commerce/shop-code"
import type { Payer } from "../send-reply"
import type { TtbSettings } from "../settings"
import type { CallOutcome } from "../store"
import type { Line } from "../types"
import { callShopReply, callSupportReply } from "./replies"

export type CallDeps = {
  settings: TtbSettings
  /** The caller as a local Ghana mobile (0XXXXXXXXX), or null for anything else (short code, international, anonymous). */
  normalizeSender: (raw: string) => string | null
  isBlocked: (sender: string) => Promise<boolean>
  noticeOnce: (kind: string, sender: string, shopId: string | null, day: string) => Promise<boolean>
  repliedCallsLastHour: (line: Line) => Promise<number>
  getShopPref: (sender: string) => Promise<{ shopCodeId: string } | null>
  lastBoughtShopCodeId: (senderLocal: string) => Promise<string | null>
  shopCodeById: (shopCodeId: string) => Promise<ResolvedShopCode | null>
  shopAccountFor: (shopId: string) => Promise<{ accountId: string } | null>
  shopReplyCapReached: (shopId: string) => Promise<boolean>
  sendReply: (r: { line: Line; sender: string; body: string; settings: TtbSettings; payer?: Payer }) => Promise<{ sent: boolean; skipped?: boolean | "unpaid" }>
  readSupportWhatsapp: () => Promise<string | null>
  logCall: (c: { line: Line; sender: string; shopId: string | null; outcome: CallOutcome }) => Promise<void>
  /** A fixed message with no number or customer text. */
  alertAdmin: (message: string) => Promise<void>
}

export type CallInput = { line: Line; fromRaw: string; receivedMs: number | null; nowMs: number }

const STALE_MS = 15 * 60_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type Linked = { shopId: string; name: string; owner: string }

/** The shop this caller belongs to (pref, else last bought) when it is open and has an owner number; null otherwise. */
async function linkedShop(deps: CallDeps, sender: string): Promise<Linked | null> {
  try {
    const pref = await deps.getShopPref(sender)
    let found: ResolvedShopCode | null = null
    if (pref) {
      found = await deps.shopCodeById(pref.shopCodeId) // a remembered shop that no longer resolves is final: no fallback
    } else {
      const lastId = await deps.lastBoughtShopCodeId(sender)
      if (lastId) found = await deps.shopCodeById(lastId)
    }
    if (!found || found.status !== "active") return null
    const owner = typeof found.ownerPhone === "string" ? found.ownerPhone.trim() : ""
    if (!owner) return null
    return { shopId: found.shopId, name: found.shopName, owner }
  } catch {
    return null
  }
}

export async function handleMissedCall(deps: CallDeps, input: CallInput): Promise<{ outcome: CallOutcome }> {
  const { line, nowMs } = input
  let sender = ""
  let shopId: string | null = null

  const finish = async (outcome: CallOutcome): Promise<{ outcome: CallOutcome }> => {
    try {
      await deps.logCall({ line, sender, shopId, outcome })
    } catch {
      // Logging must never break the lane.
    }
    return { outcome }
  }

  try {
    if (!deps.settings.callsEnabled) return await finish("skipped_off")

    const who = deps.normalizeSender(input.fromRaw)
    if (!who) return await finish("skipped_invalid")
    sender = who

    const receivedMs = input.receivedMs ?? nowMs
    if (nowMs - receivedMs > STALE_MS) return await finish("skipped_stale")

    if (await deps.isBlocked(sender)) return await finish("skipped_blocked")

    const day = dayOf(nowMs)
    // The marker is taken first and a failed send never releases it: the caller gets at most one SMS per line per day.
    if (!(await deps.noticeOnce(line === "main" ? "call_main" : "call_shop", sender, null, day))) return await finish("skipped_duplicate")

    if ((await deps.repliedCallsLastHour(line)) >= deps.settings.callsPerHourPerLine) return await finish("skipped_cap")

    const wa = await deps.readSupportWhatsapp()
    if (!wa) {
      await deps.alertAdmin("Text-to-Buy missed-call SMS skipped: the support WhatsApp number is missing in support settings.").catch(() => {})
      return await finish("error")
    }
    const supportBody = callSupportReply(wa)

    const sendSupport = async (ok: CallOutcome): Promise<{ outcome: CallOutcome }> => {
      const res = await deps.sendReply({ line, sender, body: supportBody, settings: deps.settings })
      return finish(res.sent ? ok : "error")
    }

    if (line === "main") return await sendSupport("replied_main")

    const shop = await linkedShop(deps, sender)
    if (shop && !(await deps.shopReplyCapReached(shop.shopId))) {
      const account = await deps.shopAccountFor(shop.shopId)
      if (account) {
        const res = await deps.sendReply({
          line,
          sender,
          body: callShopReply(shop.name, shop.owner),
          settings: deps.settings,
          payer: { kind: "shop", shopId: shop.shopId, accountId: account.accountId, messageId: null, replyKey: `call-${day}-${sender}` },
        })
        if (res.sent) {
          shopId = shop.shopId
          return await finish("replied_shop")
        }
        if (res.skipped !== "unpaid") return await finish("error")
      }
    }
    return await sendSupport("replied_support")
  } catch {
    return finish("error")
  }
}
