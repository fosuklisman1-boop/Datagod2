/**
 * Notify step for newly allowed MTN numbers (runs in the daily re-check cron, after the re-check).
 *  - Customer SMS ("number ready"), paid by Datagod: eligible surfaces only, three caps (per number, per notify phone,
 *    daily ceiling). Never for dealer surfaces.
 *  - Shop owner in-app notice, one per shop per run.
 *  - Dealer (account owner) in-app notice plus push, one per user per run.
 * planNotify is pure. runNotify claims each row BEFORE sending so overlapping runs cannot text twice.
 * Logs carry counts only, never phone numbers or SMS text.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { buildNumberReadySms } from "@/lib/sms/number-ready"
import { DEALER_SURFACES, SMS_SURFACES, type BlockSurface } from "./types"
import { getBlockedNumbersSettings, type BlockedNumbersSettings } from "./settings"

const TABLE = "mtn_blocked_numbers"
const DAY_MS = 86_400_000
const CAP_WINDOW_MS = 90 * DAY_MS
const MAX_PER_WINDOW = 2
const MAX_ATTEMPTS = 3
const ROW_LIMIT = 300
const CHUNK = 100
export const OWNER_PAGE = "/dashboard/blocked-numbers"
export const SMS_TYPE = "mtn_number_ready"
const NETWORK_LABEL = "Yellow" // networkColor("mtn")

export type NotifyRow = {
  id: string
  phone: string
  ready_sms_count: number
  ready_sms_window_start: string | null
  notify_attempts: number
  last_shop_id: string | null
}
export type NotifyAttempt = {
  surface: string
  shop_id: string | null
  user_id: string | null
  purchaser_phone: string | null
  created_at: string
}
export type SkipReason = "cap_number" | "cap_phone" | "ceiling" | "sms_off" | "not_eligible"
export type NotifyPlan = {
  sms: Array<{ numberId: string; to: string; text: string }>
  shopNotices: Array<{ shopId: string; count: number; texted: boolean }>
  dealerNotices: Array<{ userId: string; count: number }>
  skipped: Array<{ numberId: string; reason: SkipReason }>
}
export type NotifyContext = {
  shops?: Map<string, { name: string | null; subdomain: string | null }>
  rootDomain?: string
  mainUssdCode?: string | null
}

const isSmsSurface = (s: string) => (SMS_SURFACES as readonly string[]).includes(s as BlockSurface)
const isDealerSurface = (s: string) => (DEALER_SURFACES as readonly string[]).includes(s as BlockSurface)

function inRetention(attempts: NotifyAttempt[], now: Date, retentionDays: number): NotifyAttempt[] {
  const cutoff = now.getTime() - retentionDays * DAY_MS
  return attempts.filter((a) => new Date(a.created_at).getTime() >= cutoff)
}

/** Latest attempt (by created_at) on an SMS-eligible surface. */
function latestEligible(attempts: NotifyAttempt[]): NotifyAttempt | null {
  let best: NotifyAttempt | null = null
  for (const a of attempts) {
    if (!isSmsSurface(a.surface)) continue
    if (!best || new Date(a.created_at).getTime() >= new Date(best.created_at).getTime()) best = a
  }
  return best
}

/** Who would be texted for this number, or null when no eligible attempt exists. */
export function recipientFor(row: NotifyRow, attempts: NotifyAttempt[]): string | null {
  const a = latestEligible(attempts)
  if (!a) return null
  return a.purchaser_phone || row.phone
}

function windowActive(row: NotifyRow, now: Date): boolean {
  if (!row.ready_sms_window_start) return false
  return now.getTime() - new Date(row.ready_sms_window_start).getTime() < CAP_WINDOW_MS
}

/** Shop and dealer notices for the given rows. `textedShop` maps number id to the shop its SMS linked (or null). */
export function buildNotices(
  rows: NotifyRow[],
  attemptsByNumber: Map<string, NotifyAttempt[]>,
  textedShop: Map<string, string | null>,
  now: Date,
  retentionDays: number
): Pick<NotifyPlan, "shopNotices" | "dealerNotices"> {
  const shopNumbers = new Map<string, Set<string>>()
  const textedShops = new Set<string>()
  const dealerNumbers = new Map<string, Set<string>>()
  for (const row of rows) {
    const attempts = inRetention(attemptsByNumber.get(row.id) ?? [], now, retentionDays)
    for (const a of attempts) {
      if (a.shop_id) {
        if (!shopNumbers.has(a.shop_id)) shopNumbers.set(a.shop_id, new Set())
        shopNumbers.get(a.shop_id)!.add(row.id)
      }
      if (isDealerSurface(a.surface) && a.user_id) {
        if (!dealerNumbers.has(a.user_id)) dealerNumbers.set(a.user_id, new Set())
        dealerNumbers.get(a.user_id)!.add(row.id)
      }
    }
    const shop = textedShop.get(row.id)
    if (shop) textedShops.add(shop)
  }
  return {
    shopNotices: [...shopNumbers].map(([shopId, ids]) => ({ shopId, count: ids.size, texted: textedShops.has(shopId) })),
    dealerNotices: [...dealerNumbers].map(([userId, ids]) => ({ userId, count: ids.size })),
  }
}

type Decision = { plan: NotifyPlan; textedShop: Map<string, string | null> }

function decide(
  rows: NotifyRow[],
  attemptsByNumber: Map<string, NotifyAttempt[]>,
  now: Date,
  settings: BlockedNumbersSettings,
  sentToday: number,
  notifyPhoneCounts: Map<string, number>,
  ctx: NotifyContext
): Decision {
  const sms: NotifyPlan["sms"] = []
  const skipped: NotifyPlan["skipped"] = []
  const textedShop = new Map<string, string | null>()
  const plannedByPhone = new Map<string, number>()
  let planned = 0
  const rootDomain = (ctx.rootDomain || "datagod.store").toLowerCase()

  for (const row of rows) {
    const attempts = inRetention(attemptsByNumber.get(row.id) ?? [], now, settings.retention_days)
    const a = latestEligible(attempts)
    if (!a) { skipped.push({ numberId: row.id, reason: "not_eligible" }); continue }
    if (!settings.customer_sms_enabled) { skipped.push({ numberId: row.id, reason: "sms_off" }); continue }
    if (windowActive(row, now) && row.ready_sms_count >= MAX_PER_WINDOW) {
      skipped.push({ numberId: row.id, reason: "cap_number" })
      continue
    }
    const to = a.purchaser_phone || row.phone
    const used = (notifyPhoneCounts.get(to) ?? 0) + (plannedByPhone.get(to) ?? 0)
    if (used >= MAX_PER_WINDOW) { skipped.push({ numberId: row.id, reason: "cap_phone" }); continue }
    if (sentToday + planned >= settings.daily_sms_ceiling) { skipped.push({ numberId: row.id, reason: "ceiling" }); continue }

    const shop = a.shop_id ? ctx.shops?.get(a.shop_id) ?? null : null
    const text = buildNumberReadySms({
      phone: row.phone,
      networkLabel: NETWORK_LABEL,
      shopName: shop?.name ?? null,
      subdomain: shop?.subdomain ?? null,
      rootDomain,
      mainUssdCode: ctx.mainUssdCode ?? null,
    })
    sms.push({ numberId: row.id, to, text })
    plannedByPhone.set(to, (plannedByPhone.get(to) ?? 0) + 1)
    planned += 1
    textedShop.set(row.id, shop ? a.shop_id : null)
  }

  const notices = buildNotices(rows, attemptsByNumber, textedShop, now, settings.retention_days)
  return { plan: { sms, skipped, ...notices }, textedShop }
}

export function planNotify(
  rows: NotifyRow[],
  attemptsByNumber: Map<string, NotifyAttempt[]>,
  now: Date,
  settings: BlockedNumbersSettings,
  sentToday: number,
  notifyPhoneCounts: Map<string, number>,
  ctx: NotifyContext = {}
): NotifyPlan {
  return decide(rows, attemptsByNumber, now, settings, sentToday, notifyPhoneCounts, ctx).plan
}

// ---------------------------------------------------------------------------------------------------------------

export type NotifyDeps = {
  db: SupabaseClient
  sendSms(p: { phone: string; message: string; type: string; reference?: string }): Promise<{ success: boolean; skipped?: boolean; error?: string }>
  insertNotification(userId: string, title: string, message: string, actionUrl: string): Promise<void>
  sendPush(userId: string, payload: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>
  readUssdCodes(db: SupabaseClient): Promise<{ main: string | null; shop: string | null }>
  settings(): Promise<BlockedNumbersSettings>
  now(): Date
  rootDomain: string
}

export type NotifyResult = { texted: number; shopNotices: number; dealerNotices: number; skipped: number; failed: number }

async function defaultDeps(): Promise<NotifyDeps> {
  const { sendSMS } = await import("@/lib/sms-service")
  const { sendPushToUser } = await import("@/lib/push-service")
  const { readPublicUssdCodes } = await import("@/lib/seo/ussd-codes")
  return {
    db: supabaseAdmin as unknown as SupabaseClient,
    sendSms: (p) => sendSMS(p),
    // notificationService uses the browser (anon) client, which cannot insert here; same row shape, service role.
    insertNotification: async (userId, title, message, actionUrl) => {
      const nowIso = new Date().toISOString()
      const { error } = await supabaseAdmin.from("notifications").insert([
        { user_id: userId, title, message, type: "order_update", read: false, action_url: actionUrl, created_at: nowIso, updated_at: nowIso },
      ])
      if (error) throw error
    },
    sendPush: (userId, payload) => sendPushToUser(userId, payload),
    readUssdCodes: (db) => readPublicUssdCodes(db),
    settings: () => getBlockedNumbersSettings(),
    now: () => new Date(),
    rootDomain: (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase(),
  }
}

const chunks = <T,>(xs: T[]): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK))
  return out
}

export async function runNotify(deps?: NotifyDeps): Promise<NotifyResult> {
  const d = deps ?? (await defaultDeps())
  const { db } = d
  const now = d.now()
  const nowIso = now.toISOString()
  const result: NotifyResult = { texted: 0, shopNotices: 0, dealerNotices: 0, skipped: 0, failed: 0 }

  const settings = await d.settings()

  const sel = await db
    .from(TABLE)
    .select("id, phone, ready_sms_count, ready_sms_window_start, notify_attempts, last_shop_id")
    .eq("status", "allowed")
    .is("customer_notified_at", null)
    .lt("notify_attempts", MAX_ATTEMPTS)
    .order("allowed_at", { ascending: true })
    .limit(ROW_LIMIT)
  if (sel.error) throw new Error(`notify select failed: ${sel.error.code ?? "db"}`)
  const rows = (sel.data ?? []) as NotifyRow[]
  if (rows.length === 0) return result

  // Attempts inside the retention window.
  const since = new Date(now.getTime() - settings.retention_days * DAY_MS).toISOString()
  const attemptsByNumber = new Map<string, NotifyAttempt[]>()
  for (const part of chunks(rows.map((r) => r.id))) {
    const { data, error } = await db
      .from("mtn_blocked_attempts")
      .select("blocked_number_id, surface, shop_id, user_id, purchaser_phone, created_at")
      .in("blocked_number_id", part)
      .gte("created_at", since)
    if (error) throw new Error(`notify attempts failed: ${error.code ?? "db"}`)
    for (const a of (data ?? []) as Array<NotifyAttempt & { blocked_number_id: string }>) {
      const list = attemptsByNumber.get(a.blocked_number_id) ?? []
      list.push(a)
      attemptsByNumber.set(a.blocked_number_id, list)
    }
  }

  // Today's texts (UTC day) and per-notify-phone counts over 90 days.
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const todayRes = await db
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .gte("customer_notified_at", dayStart)
    .not("customer_notify_phone", "is", null)
  if (todayRes.error) throw new Error(`notify count failed: ${todayRes.error.code ?? "db"}`)
  const sentToday = todayRes.count ?? 0

  const candidatePhones = [
    ...new Set(rows.map((r) => recipientFor(r, inRetention(attemptsByNumber.get(r.id) ?? [], now, settings.retention_days))).filter((p): p is string => !!p)),
  ]
  const notifyPhoneCounts = new Map<string, number>()
  const phoneSince = new Date(now.getTime() - CAP_WINDOW_MS).toISOString()
  for (const part of chunks(candidatePhones)) {
    const { data, error } = await db
      .from(TABLE)
      .select("customer_notify_phone")
      .in("customer_notify_phone", part)
      .gte("customer_notified_at", phoneSince)
    if (error) throw new Error(`notify phone counts failed: ${error.code ?? "db"}`)
    for (const r of (data ?? []) as Array<{ customer_notify_phone: string }>) {
      notifyPhoneCounts.set(r.customer_notify_phone, (notifyPhoneCounts.get(r.customer_notify_phone) ?? 0) + 1)
    }
  }

  // Shops referenced by any attempt (names for notices, subdomains for links).
  const shopIds = new Set<string>()
  for (const list of attemptsByNumber.values()) for (const a of list) if (a.shop_id) shopIds.add(a.shop_id)
  const shops = new Map<string, { name: string | null; subdomain: string | null; user_id: string | null }>()
  for (const part of chunks([...shopIds])) {
    const { data, error } = await db.from("user_shops").select("id, user_id, shop_name, subdomain").in("id", part)
    if (error) throw new Error(`notify shops failed: ${error.code ?? "db"}`)
    for (const s of (data ?? []) as Array<{ id: string; user_id: string | null; shop_name: string | null; subdomain: string | null }>) {
      shops.set(s.id, { name: s.shop_name, subdomain: s.subdomain, user_id: s.user_id })
    }
  }

  let mainUssdCode: string | null = null
  try {
    mainUssdCode = (await d.readUssdCodes(db)).main
  } catch {
    mainUssdCode = null
  }

  const { plan, textedShop } = decide(rows, attemptsByNumber, now, settings, sentToday, notifyPhoneCounts, {
    shops,
    rootDomain: d.rootDomain,
    mainUssdCode,
  })
  const rowById = new Map(rows.map((r) => [r.id, r]))

  // Claim helper: only the run that flips customer_notified_at from NULL owns the row.
  async function claim(id: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const { data, error } = await db
      .from(TABLE)
      .update({ customer_notified_at: nowIso, updated_at: nowIso, ...extra })
      .eq("id", id)
      .eq("status", "allowed")
      .is("customer_notified_at", null)
      .select("id")
    if (error) {
      console.error("[BLOCKED-NOTIFY] claim failed:", error.code ?? "db")
      return false
    }
    return (data ?? []).length > 0
  }

  const included = new Set<string>() // rows whose owner/dealer notices go out this run
  const includedTexted = new Map<string, string | null>()

  for (const s of plan.skipped) {
    if (await claim(s.numberId)) {
      result.skipped += 1
      included.add(s.numberId)
    }
  }

  for (const item of plan.sms) {
    const row = rowById.get(item.numberId)!
    if (!(await claim(item.numberId, { customer_notify_phone: item.to }))) continue

    let outcome: "sent" | "skipped" | "failed" = "failed"
    try {
      const r = await d.sendSms({ phone: item.to, message: item.text, type: SMS_TYPE, reference: item.numberId })
      outcome = r.success ? (r.skipped ? "skipped" : "sent") : "failed"
    } catch {
      outcome = "failed"
    }

    if (outcome === "sent") {
      const reset = !row.ready_sms_window_start || !windowActive(row, now)
      const { error } = await db
        .from(TABLE)
        .update({
          ready_sms_count: reset ? 1 : row.ready_sms_count + 1,
          ready_sms_window_start: reset ? nowIso : row.ready_sms_window_start,
          updated_at: nowIso,
        })
        .eq("id", item.numberId)
      if (error) console.error("[BLOCKED-NOTIFY] count write failed:", error.code ?? "db")
      result.texted += 1
      included.add(item.numberId)
      includedTexted.set(item.numberId, textedShop.get(item.numberId) ?? null)
    } else if (outcome === "skipped") {
      // SMS is switched off at the provider layer: nothing was sent, so no cap is consumed.
      await db.from(TABLE).update({ customer_notify_phone: null, updated_at: nowIso }).eq("id", item.numberId)
      result.skipped += 1
      included.add(item.numberId)
    } else {
      const attempts = row.notify_attempts + 1
      const { error } = await db
        .from(TABLE)
        .update({ customer_notified_at: null, customer_notify_phone: null, notify_attempts: attempts, updated_at: nowIso })
        .eq("id", item.numberId)
      if (error) console.error("[BLOCKED-NOTIFY] failure write failed:", error.code ?? "db")
      result.failed += 1
      // Retries remain: hold the owner notices until the SMS settles. The last failure releases them (untexted).
      if (attempts >= MAX_ATTEMPTS) included.add(item.numberId)
    }
  }

  const noticeRows = rows.filter((r) => included.has(r.id))
  const notices = buildNotices(noticeRows, attemptsByNumber, includedTexted, now, settings.retention_days)

  for (const n of notices.shopNotices) {
    const shop = shops.get(n.shopId)
    if (!shop?.user_id) continue
    const message =
      `${n.count} customer number(s) blocked on ${shop.name ?? "your shop"} are now ready` +
      (n.texted ? ", we've texted them to buy again." : ".")
    try {
      await d.insertNotification(shop.user_id, "Customer numbers ready", message, OWNER_PAGE)
      result.shopNotices += 1
    } catch (err) {
      console.error("[BLOCKED-NOTIFY] shop notice failed:", err instanceof Error ? err.name : "UnknownError")
    }
  }

  for (const n of notices.dealerNotices) {
    const message = `${n.count} of your blocked numbers are now ready for data; open Blocked numbers to re-order`
    try {
      await d.insertNotification(n.userId, "Blocked numbers ready", message, OWNER_PAGE)
      result.dealerNotices += 1
    } catch (err) {
      console.error("[BLOCKED-NOTIFY] dealer notice failed:", err instanceof Error ? err.name : "UnknownError")
    }
    try {
      await d.sendPush(n.userId, { title: "Blocked numbers ready", body: message, data: { url: OWNER_PAGE } })
    } catch {
      // push is best effort
    }
  }

  console.log(
    `[BLOCKED-NOTIFY] texted=${result.texted} shopNotices=${result.shopNotices} dealerNotices=${result.dealerNotices} skipped=${result.skipped} failed=${result.failed}`
  )
  return result
}
