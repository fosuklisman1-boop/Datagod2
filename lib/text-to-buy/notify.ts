import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyAdmins } from "@/lib/sms-service"
import { processInbound } from "./handle-inbound"
import { repricedReply } from "./replies"
import { sendReply } from "./send-reply"
import { adapterForLink, makeAdapters, type Adapters } from "./services"
import type { OrderKind } from "./services/types"
import type { TtbSettings } from "./settings"
import { addNotice, getHeartbeat, patchLink, purgeOld, strandedInbound, touchHeartbeat, watchedLinks, type WatchedLink } from "./store"

export { classifyOrder } from "./services/classify"
export type { OrderKind }

/**
 * Text-to-Buy follow-ups. Server-only; run by the text-to-buy-notify cron every minute.
 * Follows each linked order after the quote, recovers texts stranded by a crash, purges old data and alerts when the forwarder
 * phone goes quiet. Every customer SMS is exactly-once: the notice is RECORDED (guarded update) before it is sent, and a send
 * that fails afterwards is NOT retried (a missed SMS beats a duplicate SMS). All times come from the injected `now`.
 * Never logs phone numbers, texts or amounts: errors log a row id and the error name only.
 */

export type NotifyResult = {
  checked: number
  unpaid: number
  repriced: number
  delivered: number
  delayed: number
  /** Notices recorded but not sent because SMS is switched off globally (sendReply skipped). Not retried. */
  skipped: number
  closed: number
  recovered: number
  purged: number
  quietAlert: boolean
}
export type NotifyDeps = {
  reply?: typeof sendReply
  alert?: (message: string) => Promise<void>
  processInbound?: typeof processInbound
  /** Merged over the live adapters (makeAdapters()); a link is read, classified and told through its own service's adapter. */
  adapters?: Adapters
  /** Monotonic-enough milliseconds for the sweep time budget only (all notice logic uses `now`). Default Date.now. */
  clock?: () => number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const UNPAID_CLOSE_MS = 30 * MINUTE // an unpaid link stays awaiting_payment this long, then closes
const PAID_DELAY_MS = 30 * MINUTE // a paid order not completed this long after payment gets the delay notice
const PAID_WATCH_MS = 48 * HOUR // a paid order is followed until delivered or this long after payment
const REPRICE_EPSILON = 0.005
const SWEEP_LIMIT = 20
const SWEEP_BUDGET_MS = 30_000 // the cron route allows 60 s and each text may spend up to 10 s on the AI: leave the rest to the next minute
const PURGE_EVERY_MS = HOUR
const ALERT_EVERY_MS = 6 * HOUR
const ACCRA_OPEN_HOUR = 7 // Africa/Accra is UTC+0 all year: alert only 07:00..21:59
const ACCRA_CLOSE_HOUR = 22

const UNKNOWN_LINK_ALERT = "Text-to-Buy: link with unknown order table:"

const ms = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

function logError(where: string, id: string | null, e: unknown) {
  console.error(`[text-to-buy] notify ${where} error`, { id, error: e instanceof Error ? e.name : "unknown" })
}

export async function runTtbNotify(db: SupabaseClient, now: Date, settings: TtbSettings, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const reply = deps.reply ?? sendReply
  const alert = deps.alert ?? ((m: string) => notifyAdmins(m, "text_to_buy"))
  const inbound = deps.processInbound ?? processInbound
  const adapters: Adapters = { ...makeAdapters(), ...deps.adapters }
  let unknownLinkAlerted = false
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const result: NotifyResult = {
    checked: 0, unpaid: 0, repriced: 0, delivered: 0, delayed: 0, skipped: 0, closed: 0, recovered: 0, purged: 0, quietAlert: false,
  }

  /**
   * Records the notice, THEN sends. Returns true only when the SMS was actually sent (the caller counts it). Not recorded by this
   * call (another run won) or send failed: false. A failed send is never retried, and neither is a skipped one: a global
   * SMS-off period drops follow-up notices (counted in `skipped`).
   */
  async function notice(l: WatchedLink, key: string, body: string): Promise<boolean> {
    if (l.notices.includes(key)) return false
    if (!(await addNotice(db, l.id, l.notices, key))) return false
    l.notices = [...l.notices, key]
    try {
      const r = await reply(db, { line: l.line, sender: l.sender, body, settings, orderLinkId: l.id })
      if (r?.skipped) result.skipped++
      return r?.sent === true
    } catch {
      return false // sendReply never throws; if a stub does, the notice stays recorded and nothing is retried.
    }
  }

  async function close(l: WatchedLink, extra: { delivered_at?: string } = {}): Promise<void> {
    if (await patchLink(db, l.id, { state: "closed", closed_at: nowIso, ...extra }, ["awaiting_payment", "paid"])) result.closed++
  }

  async function followLink(l: WatchedLink): Promise<void> {
    const adapter = adapterForLink(adapters, l)
    if (!adapter) {
      // A pair we cannot read: reading it from the wrong table would find no row and close the link, silently dropping every
      // notice. Leave it open and tell the admins once per run (the link id only: no phone, text or amount).
      if (!unknownLinkAlerted) {
        unknownLinkAlerted = true
        try {
          await alert(`${UNKNOWN_LINK_ALERT} ${l.id}`)
        } catch {
          // an alert must never stop the run
        }
      }
      return
    }
    const order = await adapter.readOrder(db, l.orderId)
    if (!order) {
      if (l.state !== "closed") await close(l)
      return
    }
    const kind = adapter.classify(order)
    const age = nowMs - (ms(l.createdAt) ?? nowMs)

    if (kind === "waiting" || kind === "payment_failed") {
      if (l.state !== "awaiting_payment") return // a closed unpaid link is left alone; a paid link never goes back
      let repricedNow = false
      // Not once the prompt has expired: then the unpaid notice goes out as normal.
      if (kind === "waiting" && age < UNPAID_CLOSE_MS && Number.isFinite(order.amount) && Math.abs(order.amount - l.amount) > REPRICE_EPSILON) {
        repricedNow = !l.notices.includes("repriced") // first time only; then the unpaid notice waits for the next run
        if (await notice(l, "repriced", repricedReply(order.amount))) result.repriced++
      }
      if (kind === "payment_failed" || (!repricedNow && age >= settings.promptWindowMinutes * MINUTE)) {
        if (await notice(l, "unpaid", adapter.notices.unpaid(l.size))) result.unpaid++
      }
      if (kind === "payment_failed" || age >= UNPAID_CLOSE_MS) await close(l)
      return
    }

    // The order is paid (in progress, delivered or failed to deliver). A link still awaiting payment, or closed unpaid that a
    // late approval proves paid, becomes paid now; paid_at is set once.
    const paidAtMs = ms(l.paidAt) ?? nowMs
    if (l.state !== "paid" || l.paidAt === null) {
      if (!(await patchLink(db, l.id, { state: "paid", paid_at: l.paidAt ?? nowIso }, ["awaiting_payment", "closed", "paid"]))) return
      l.state = "paid"
      l.paidAt = new Date(paidAtMs).toISOString()
    }

    if (kind === "refunded") {
      await close(l) // the refund has its own channel: no SMS, whatever was sent before
      return
    }

    if (kind === "delivered") {
      const delivered = adapter.notices.delivered({ size: l.size, recipient: l.recipient, gift: l.gift })
      if (delivered !== null && (await notice(l, "delivered", delivered))) result.delivered++
      await close(l, { delivered_at: l.deliveredAt ?? nowIso })
      return
    }

    const sincePaid = nowMs - paidAtMs
    if (kind === "delivery_failed" || sincePaid >= PAID_DELAY_MS) {
      if (await notice(l, "paid_not_delivered", adapter.notices.paidNotDelivered())) result.delayed++
    }
    if (sincePaid >= PAID_WATCH_MS) await close(l)
  }

  // 1. Recovery sweep: a text the webhook stored but a crash left unprocessed. processInbound re-claims by itself.
  if (settings.mainEnabled) {
    try {
      const clock = deps.clock ?? Date.now
      const sweepStart = clock()
      for (const m of await strandedInbound(db, now, SWEEP_LIMIT)) {
        if (clock() - sweepStart >= SWEEP_BUDGET_MS) break
        try {
          const r = await inbound(db, m.id, { line: m.line, from: m.sender, text: m.body, receivedAt: m.receivedAt, now }, settings)
          if (r?.outcome !== "duplicate") result.recovered++ // a lost claim is not a recovery
        } catch (e) {
          logError("sweep", m.id, e)
        }
      }
    } catch (e) {
      logError("sweep-read", null, e)
    }
  }

  // 2. Follow each linked order.
  try {
    for (const l of await watchedLinks(db, now, 200)) {
      result.checked++
      try {
        await followLink(l)
      } catch (e) {
        logError("link", l.id, e)
      }
    }
  } catch (e) {
    logError("links-read", null, e)
  }

  // 3. Retention purge, at most once an hour. The marker is written first: a failed purge is retried next hour, never in a loop.
  try {
    const last = await getHeartbeat(db, "purge")
    if (!last || nowMs - last.getTime() >= PURGE_EVERY_MS) {
      await touchHeartbeat(db, "purge", now)
      result.purged = await purgeOld(db, new Date(nowMs - settings.retentionDays * 24 * HOUR))
    }
  } catch (e) {
    logError("purge", null, e)
  }

  // 4. Quiet-phone alert: only when on, in waking hours, and not more than once in 6 hours. No numbers or texts in the message.
  try {
    const hour = now.getUTCHours()
    if (settings.mainEnabled && hour >= ACCRA_OPEN_HOUR && hour < ACCRA_CLOSE_HOUR) {
      const seen = await getHeartbeat(db, "main")
      const quietMs = seen ? nowMs - seen.getTime() : Infinity
      if (quietMs > settings.quietAlertMinutes * MINUTE) {
        const lastAlert = await getHeartbeat(db, "quiet_alert")
        if (!lastAlert || nowMs - lastAlert.getTime() >= ALERT_EVERY_MS) {
          await touchHeartbeat(db, "quiet_alert", now)
          result.quietAlert = true
          const text = seen
            ? `Text-to-Buy: the forwarder phone has been quiet for ${Math.floor(quietMs / MINUTE)} minutes`
            : "Text-to-Buy: the forwarder phone has not been seen yet"
          await alert(text)
        }
      }
    }
  } catch (e) {
    logError("quiet-alert", null, e)
  }

  return result
}
