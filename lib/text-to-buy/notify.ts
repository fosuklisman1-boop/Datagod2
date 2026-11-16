import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyAdmins } from "@/lib/sms-service"
import { processInbound } from "./handle-inbound"
import { repricedReply } from "./replies"
import { sendReply, type Payer } from "./send-reply"
import { adapterForLink, makeAdapters, type Adapters } from "./services"
import type { OrderKind } from "./services/types"
import { releaseReserve, shopAccountFor } from "./shop/credits"
import { lineEnabled, type TtbSettings } from "./settings"
import {
  addNotice, getHeartbeat, markReserveRetry, noticeOnce, patchLink, purgeOld, reserveMessageIdForLink, staleReserves, strandedInbound, STRANDED_MAX_AGE_MS,
  touchHeartbeat, watchedLinks, type HeartbeatLine, type WatchedLink,
} from "./store"
import type { Line } from "./types"

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
  /**
   * Shop credit reserves released (by a closing link or by the stale sweep) that gave credits back. Absent until the first one,
   * so a main-only run returns exactly the shape it always did (the lane golden pins it).
   */
  reservesReleased?: number
  quietAlert: boolean
}
export type NotifyDeps = {
  reply?: typeof sendReply
  alert?: (message: string) => Promise<void>
  processInbound?: typeof processInbound
  /** Merged over the live adapters (makeAdapters()); a link is read, classified and told through its own service's adapter. */
  adapters?: Adapters
  /** Merged over the shop line's read-only adapters; a shop link is read, classified and told through these. */
  shopAdapters?: Adapters
  /** The SMS account that pays for a shop's notices (read-only lookup); the real shopAccountFor when absent. */
  accountFor?: (db: SupabaseClient, shopId: string) => Promise<{ accountId: string } | null>
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

/** A reserve with no open order is given back once its text is older than the recovery sweep's window (it can never be re-run). */
const STALE_RESERVE_MS = STRANDED_MAX_AGE_MS
const RESERVE_GIVE_UP_MS = 7 * 24 * HOUR // a reserve that still cannot be refunded after this is left for a person
const RESERVE_READ_LIMIT = 100 // actionable reserves handled per run
const RESERVE_PAGE_SIZE = 100 // rows per read page
const RESERVE_MAX_PAGES = 5 // pages per run: skipped (open-link or backed-off) reserves are paged past, up to this many
const RESERVE_MAX_FAILURES_PER_RUN = 50 // failed release attempts per run (each is then backed off for the day)
const RESERVE_ALERT = "Text-to-Buy: a shop credit reserve could not be given back (check the stale reserves)"

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
  // The shop line's read-only set (no shop named): status and notices need no shop, and its resolve fails closed.
  const shopAdapters: Adapters = { ...makeAdapters({}, "shop", null), ...deps.shopAdapters }
  const accountFor = deps.accountFor ?? shopAccountFor
  let unknownLinkAlerted = false
  const nowMs = now.getTime()
  const nowIso = now.toISOString()
  const result: NotifyResult = {
    checked: 0, unpaid: 0, repriced: 0, delivered: 0, delayed: 0, skipped: 0, closed: 0, recovered: 0, purged: 0, quietAlert: false,
  }

  // Per run: a shop's account and a link's reserve key never change inside one run, so each is looked up once.
  const accounts = new Map<string, Promise<{ accountId: string } | null>>()
  const accountOf = (shopId: string) => {
    let p = accounts.get(shopId)
    if (!p) {
      p = accountFor(db, shopId).catch(() => null)
      accounts.set(shopId, p)
    }
    return p
  }
  const reserveKeys = new Map<string, Promise<string | null>>()
  const reserveKeyOf = (l: WatchedLink) => {
    let p = reserveKeys.get(l.id)
    if (!p) {
      p = reserveMessageIdForLink(db, l).catch(() => null)
      reserveKeys.set(l.id, p)
    }
    return p
  }

  /** The shop payer for one notice of a shop link: one credit, drawn from the order's reserve when it has one. Null: no account. */
  async function shopPayer(l: WatchedLink, key: string): Promise<Payer | null> {
    if (!l.shopId) return null
    const acct = await accountOf(l.shopId)
    if (!acct) return null
    return { kind: "shop", shopId: l.shopId, accountId: acct.accountId, messageId: await reserveKeyOf(l), replyKey: `n-${l.id}-${key}` }
  }

  /**
   * Records the notice, THEN sends. Returns true only when the SMS was actually sent (the caller counts it). Not recorded by this
   * call (another run won) or send failed: false. A failed send is never retried, and neither is a skipped one: a global
   * SMS-off period drops follow-up notices (counted in `skipped`).
   * A shop link's notice is paid by the shop (no Datagod fallback), except one marked `datagodIfUnpaid`: when the shop cannot
   * cover it, that single notice (recorded above, so at most once per order) is sent Datagod-paid instead.
   */
  async function notice(l: WatchedLink, key: string, body: string, o: { datagodIfUnpaid?: boolean } = {}): Promise<boolean> {
    if (l.notices.includes(key)) return false
    if (!(await addNotice(db, l.id, l.notices, key))) return false
    l.notices = [...l.notices, key]
    try {
      if (l.line !== "shop") {
        const r = await reply(db, { line: l.line, sender: l.sender, body, settings, orderLinkId: l.id })
        if (r?.skipped) result.skipped++
        return r?.sent === true
      }
      const payer = await shopPayer(l, key)
      let r: Awaited<ReturnType<typeof sendReply>> | undefined = payer
        ? await reply(db, { line: l.line, sender: l.sender, body, settings, orderLinkId: l.id, payer })
        : { sent: false, skipped: "unpaid" }
      if (r?.skipped === "unpaid" && o.datagodIfUnpaid) {
        r = await reply(db, { line: l.line, sender: l.sender, body, settings, orderLinkId: l.id, payer: { kind: "datagod" } })
      }
      if (r?.skipped) result.skipped++
      return r?.sent === true
    } catch {
      return false // sendReply never throws; if a stub does, the notice stays recorded and nothing is retried.
    }
  }

  /** Gives back the unused credits of one order's reserve. Idempotent in SQL. Throws only when the release itself failed. */
  async function release(messageId: string): Promise<number> {
    const credits = await releaseReserve(db, messageId)
    if (credits > 0) result.reservesReleased = (result.reservesReleased ?? 0) + 1
    return credits
  }

  async function close(l: WatchedLink, extra: { delivered_at?: string } = {}): Promise<void> {
    if (await patchLink(db, l.id, { state: "closed", closed_at: nowIso, ...extra }, ["awaiting_payment", "paid"])) result.closed++
    if (l.line !== "shop") return
    // The order is over: its reserve goes back (idempotent, so a repeat or a reserve already released refunds nothing more). A
    // failure never stops the run; the stale sweep finds a closed link with an unreleased reserve and retries it.
    try {
      const messageId = await reserveKeyOf(l)
      if (messageId) await release(messageId)
    } catch (e) {
      logError("release", l.id, e)
    }
  }

  async function followLink(l: WatchedLink): Promise<void> {
    // A shop link is read through the shop adapters and must name its shop (its notices are paid by it); otherwise it is
    // an unreadable pair, which is left open and alerted below, never closed and never read as a main row.
    const adapter = l.line === "shop" && !l.shopId ? null : adapterForLink(l.line === "shop" ? shopAdapters : adapters, l)
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
      // Silence after the customer has paid is worse than one SMS: this is the only notice Datagod pays for on the shop line.
      if (await notice(l, "paid_not_delivered", adapter.notices.paidNotDelivered(), { datagodIfUnpaid: true })) result.delayed++
    }
    if (sincePaid >= PAID_WATCH_MS) await close(l)
  }

  // 1. Recovery sweep: a text the webhook stored but a crash left unprocessed. processInbound re-claims by itself.
  // Each line is recovered only while its own switch is on; a stranded text re-runs with its own line (the lane's pre-write
  // guard stops a second order).
  const liveLines = (["main", "shop"] as Line[]).filter((x) => lineEnabled(settings, x))
  if (liveLines.length > 0) {
    try {
      const clock = deps.clock ?? Date.now
      const sweepStart = clock()
      for (const m of await strandedInbound(db, now, SWEEP_LIMIT, liveLines)) {
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

  // 2b. Stale reserve sweep: an unreleased shop reserve whose text is past the recovery window and has NO open order (a crash
  // between the reserve and the link, or a release that failed when its link closed) is given back. A reserve whose order link
  // is still open is left for that link to release. A release that keeps failing (its account was removed) is swallowed and
  // counted: one fixed, id-free admin alert a day, and it is not retried after RESERVE_GIVE_UP_MS.
  try {
    let failed = 0
    let released = 0
    const day = nowIso.slice(0, 10)
    // staleReserves returns only actionable reserves: none marked for backoff today, none owned by an open link.
    const due = await staleReserves(db, now, {
      olderThanMs: STALE_RESERVE_MS, maxAgeMs: RESERVE_GIVE_UP_MS, limit: RESERVE_READ_LIMIT, pageSize: RESERVE_PAGE_SIZE, maxPages: RESERVE_MAX_PAGES, day,
    })
    for (const r of due) {
      // The budget counts releases that gave credits back, and failures separately (each failure is marked, so a dead reserve
      // costs one attempt a day and can never starve the releasable ones behind it).
      if (released >= SWEEP_LIMIT || failed >= RESERVE_MAX_FAILURES_PER_RUN) break
      try {
        if ((await release(r.messageId)) > 0) released++
      } catch {
        failed++
        try {
          await markReserveRetry(db, r.messageId, day)
        } catch {
          // the marker is only a backoff; the next run simply tries again
        }
      }
    }
    if (failed > 0) {
      console.error("[text-to-buy] notify reserve sweep: releases failed", { failed })
      try {
        if (await noticeOnce(db, "reserve_release_failed", "shop", null, nowIso.slice(0, 10))) await alert(RESERVE_ALERT)
      } catch {
        // an alert must never stop the run
      }
    }
  } catch (e) {
    logError("reserve-sweep", null, e)
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
  // Once per line whose switch is on, each with its own marker (quiet_alert for main, quiet_alert_shop for shop).
  for (const line of liveLines) {
    try {
      const hour = now.getUTCHours()
      if (hour >= ACCRA_OPEN_HOUR && hour < ACCRA_CLOSE_HOUR) {
        const marker: HeartbeatLine = line === "shop" ? "quiet_alert_shop" : "quiet_alert"
        const who = line === "shop" ? "the shop line forwarder phone" : "the forwarder phone"
        const seen = await getHeartbeat(db, line)
        const quietMs = seen ? nowMs - seen.getTime() : Infinity
        if (quietMs > settings.quietAlertMinutes * MINUTE) {
          const lastAlert = await getHeartbeat(db, marker)
          if (!lastAlert || nowMs - lastAlert.getTime() >= ALERT_EVERY_MS) {
            await touchHeartbeat(db, marker, now)
            result.quietAlert = true
            const text = seen
              ? `Text-to-Buy: ${who} has been quiet for ${Math.floor(quietMs / MINUTE)} minutes`
              : `Text-to-Buy: ${who} has not been seen yet`
            await alert(text)
          }
        }
      }
    } catch (e) {
      logError("quiet-alert", null, e)
    }
  }

  return result
}
