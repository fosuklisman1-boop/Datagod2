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

  // One admin alert per kind per UTC day (never per call). Fixed text, no number. Never throws.
  const alertOnce = async (kind: string, message: string): Promise<void> => {
    try {
      if (await deps.noticeOnce(kind, "system", null, dayOf(nowMs))) await deps.alertAdmin(message)
    } catch {
      // An alert that cannot be raised must not change the caller's outcome.
    }
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

    // Nothing that can end in "no SMS" for a reason other than a genuine skip may burn the daily marker, so the support number
    // and the hourly cap are checked BEFORE it. A missing support number alerts the admin once per day, not once per caller.
    const wa = await deps.readSupportWhatsapp()
    if (!wa) {
      await alertOnce("call_support_missing", "Text-to-Buy missed-call SMS skipped: the support WhatsApp number is missing in support settings.")
      return await finish("error")
    }
    if ((await deps.repliedCallsLastHour(line)) >= deps.settings.callsPerHourPerLine) return await finish("skipped_cap")

    // From here the marker is taken, and a failed send never releases it: the caller gets at most one SMS per line per day.
    if (!(await deps.noticeOnce(line === "main" ? "call_main" : "call_shop", sender, null, day))) return await finish("skipped_duplicate")

    const supportBody = callSupportReply(wa)

    // A throw from sendReply is an ambiguous send: it ends as a failed send and is never retried.
    const send = async (r: Parameters<CallDeps["sendReply"]>[0]): Promise<{ sent: boolean; skipped?: boolean | "unpaid" }> => {
      try {
        return await deps.sendReply(r)
      } catch {
        return { sent: false }
      }
    }
    const failed = async (): Promise<{ outcome: CallOutcome }> => {
      await alertOnce("call_send_error", "Text-to-Buy missed-call SMS could not be sent. Check the SMS provider and the ttb_calls error rows.")
      return finish("error")
    }
    const sendSupport = async (ok: CallOutcome): Promise<{ outcome: CallOutcome }> => {
      const res = await send({ line, sender, body: supportBody, settings: deps.settings })
      return res.sent ? finish(ok) : failed()
    }

    if (line === "main") return await sendSupport("replied_main")

    // Anything that throws before the shop-paid send falls through to the one Datagod support SMS.
    let plan: { shop: Linked; accountId: string } | null = null
    try {
      const shop = await linkedShop(deps, sender)
      if (shop && !(await deps.shopReplyCapReached(shop.shopId))) {
        const account = await deps.shopAccountFor(shop.shopId)
        if (account) plan = { shop, accountId: account.accountId }
      }
    } catch {
      plan = null
    }
    if (plan) {
      const res = await send({
        line,
        sender,
        body: callShopReply(plan.shop.name, plan.shop.owner),
        settings: deps.settings,
        payer: { kind: "shop", shopId: plan.shop.shopId, accountId: plan.accountId, messageId: null, replyKey: `call-${day}-${sender}` },
      })
      if (res.sent) {
        shopId = plan.shop.shopId
        return await finish("replied_shop")
      }
      if (res.skipped !== "unpaid") return await failed()
    }
    return await sendSupport("replied_support")
  } catch {
    return finish("error")
  }
}
