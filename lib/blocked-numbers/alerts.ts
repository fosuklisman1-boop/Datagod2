/**
 * Admin-facing alerts for blocked MTN number tracking: the daily digest and the spike alert.
 * Counts only, never phone numbers, in every message, log line and audit row.
 */

import { supabaseAdmin } from "@/lib/supabase"
import { getBlockedNumbersSettings, type BlockedNumbersSettings } from "./settings"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const SPIKE_COOLDOWN_MS = 6 * HOUR_MS
const SPIKE_MAX_PAGES = 10
const DIGEST_STAMP_KEY = "blocked_numbers_last_digest_day"
const DIGEST_READ_LIMIT = 50_000
const PAGE = 1000
const SPIKE_STAMP_KEY = "blocked_numbers_last_spike_alert_at"
const ADMIN_PAGE = "/admin/blocked-numbers"

export type DigestStats = {
  day: string // YYYY-MM-DD (UTC)
  attempts: number
  distinctNumbers: number
  topSurfaces: Array<{ surface: string; count: number }>
  becameAllowed: number
  customersTexted: number
  expired: number
  unchecked: number
  deferred: number
}

const fmt = (n: number) => n.toLocaleString("en-US")
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function buildDigest(s: DigestStats): { subject: string; html: string; pushTitle: string; pushBody: string } {
  const surfaces = s.topSurfaces.length > 0 ? s.topSurfaces.map((t) => `${t.surface} ${fmt(t.count)}`).join(", ") : "none"
  const summary =
    `${fmt(s.attempts)} blocked attempts (${fmt(s.distinctNumbers)} numbers), ${fmt(s.becameAllowed)} became allowed, ` +
    `${fmt(s.customersTexted)} customers texted, ${fmt(s.expired)} expired.`
  const notes: string[] = []
  if (s.unchecked > 0) notes.push(`${fmt(s.unchecked)} numbers could not be checked in the last run (provider errors).`)
  if (s.deferred > 0) notes.push(`${fmt(s.deferred)} numbers were deferred (run deadline); they stay due for the next run.`)
  const html =
    `<h3>Blocked MTN numbers: ${esc(s.day)}</h3>` +
    `<ul>` +
    `<li>Blocked attempts: <b>${fmt(s.attempts)}</b> across <b>${fmt(s.distinctNumbers)}</b> numbers</li>` +
    `<li>Top surfaces: ${esc(surfaces)}</li>` +
    `<li>Became allowed: <b>${fmt(s.becameAllowed)}</b></li>` +
    `<li>Customers texted: <b>${fmt(s.customersTexted)}</b></li>` +
    `<li>Expired: <b>${fmt(s.expired)}</b></li>` +
    `</ul>` +
    (notes.length > 0 ? `<p>${notes.map(esc).join("<br/>")}</p>` : "") +
    `<p>Open ${ADMIN_PAGE} in the admin area for details.</p>`
  return {
    subject: `Blocked MTN numbers: ${s.day}`,
    html,
    pushTitle: "Blocked numbers: yesterday",
    pushBody: summary + (notes.length > 0 ? ` ${notes.length} warning(s).` : ""),
  }
}

export function previousUtcDay(now: Date): { day: string; startIso: string; endIso: string } {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const start = new Date(todayStart - DAY_MS)
  return { day: start.toISOString().slice(0, 10), startIso: start.toISOString(), endIso: new Date(todayStart).toISOString() }
}

type PushPayload = { title: string; body: string; data?: Record<string, unknown> }

async function defaultNotifiers() {
  const { getDefaultDeps } = await import("@/lib/admin-actions/default-deps")
  const d = getDefaultDeps()
  return {
    notifyEmail: (subject: string, html: string) => d.notifyAdminsEmail(subject, html),
    notifyPush: (p: PushPayload) => d.notifyAdminsPush(p),
  }
}

// ---------------------------------------------------------------------------------------------- daily digest

export type DigestDeps = {
  now(): Date
  loadStats(startIso: string, endIso: string): Promise<Omit<DigestStats, "unchecked" | "deferred"> & Partial<DigestStats>>
  notifyEmail(subject: string, html: string): Promise<void>
  notifyPush(p: PushPayload): Promise<unknown>
  /** UTC date (YYYY-MM-DD) of the last digest sent, or null. */
  getLastDigestDay(): Promise<string | null>
  stampDigestDay(day: string, nowIso: string): Promise<void>
}

async function getLastDigestDayFromDb(): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("admin_settings").select("value").eq("key", DIGEST_STAMP_KEY).maybeSingle()
  if (error) throw new Error(`digest stamp read failed: ${error.code ?? "db"}`)
  const day = (data?.value as { day?: unknown } | null | undefined)?.day
  return typeof day === "string" ? day : null
}

async function stampDigestDayInDb(day: string, nowIso: string): Promise<void> {
  const { error } = await supabaseAdmin.from("admin_settings").upsert(
    {
      key: DIGEST_STAMP_KEY,
      value: { day },
      description: "Blocked MTN numbers: the UTC day the last daily digest covered (one digest per day).",
      updated_at: nowIso,
    },
    { onConflict: "key" }
  )
  if (error) throw new Error(`digest stamp write failed: ${error.code ?? "db"}`)
}

async function countRows(table: string, build: (q: any) => any): Promise<number> {
  const { count, error } = await build(supabaseAdmin.from(table).select("id", { count: "exact", head: true }))
  if (error) throw new Error(`digest count failed: ${error.code ?? "db"}`)
  return count ?? 0
}

async function loadStatsFromDb(startIso: string, endIso: string): Promise<Omit<DigestStats, "unchecked" | "deferred" | "day">> {
  const phones = new Set<string>()
  const bySurface = new Map<string, number>()
  let attempts = 0
  for (let from = 0; from < DIGEST_READ_LIMIT; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("mtn_blocked_attempts")
      .select("phone, surface")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`digest attempts failed: ${error.code ?? "db"}`)
    const rows = (data ?? []) as Array<{ phone: string; surface: string }>
    for (const r of rows) {
      attempts++
      phones.add(r.phone)
      bySurface.set(r.surface, (bySurface.get(r.surface) ?? 0) + 1)
    }
    if (rows.length < PAGE) break
  }
  const topSurfaces = [...bySurface.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([surface, count]) => ({ surface, count }))
  const becameAllowed = await countRows("mtn_blocked_numbers", (q) => q.gte("allowed_at", startIso).lt("allowed_at", endIso))
  const customersTexted = await countRows("mtn_blocked_numbers", (q) => q.gte("customer_notified_at", startIso).lt("customer_notified_at", endIso))
  // No expired_at column: a row's updated_at is stamped when it expires and nothing touches expired rows after.
  const expired = await countRows("mtn_blocked_numbers", (q) => q.eq("status", "expired").gte("updated_at", startIso).lt("updated_at", endIso))
  return { attempts, distinctNumbers: phones.size, topSurfaces, becameAllowed, customersTexted, expired }
}

/** Sends the digest for the previous UTC day. `run` carries this cron run's unchecked and deferred counts. */
export async function sendDailyDigest(
  run: { unchecked: number; deferred: number } = { unchecked: 0, deferred: 0 },
  deps?: Partial<DigestDeps>
): Promise<boolean> {
  const now = (deps?.now ?? (() => new Date()))()
  const win = previousUtcDay(now)
  // Once per UTC day: a second cron run the same day does not re-send.
  const lastDay = await (deps?.getLastDigestDay ?? getLastDigestDayFromDb)()
  if (lastDay === win.day) return false
  const loadStats = deps?.loadStats ?? loadStatsFromDb
  const stats = await loadStats(win.startIso, win.endIso)
  const digest = buildDigest({ ...stats, day: win.day, unchecked: run.unchecked, deferred: run.deferred })
  const n = deps?.notifyEmail && deps?.notifyPush ? { notifyEmail: deps.notifyEmail, notifyPush: deps.notifyPush } : await defaultNotifiers()
  // Both channels are attempted; one failing must not stop the other.
  const results = await Promise.allSettled([
    n.notifyEmail(digest.subject, digest.html),
    n.notifyPush({ title: digest.pushTitle, body: digest.pushBody, data: { url: ADMIN_PAGE } }),
  ])
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed > 0) console.error(`[BLOCKED-DIGEST] ${failed} of 2 channels failed`)
  if (failed >= 2) return false
  try {
    await (deps?.stampDigestDay ?? stampDigestDayInDb)(win.day, now.toISOString())
  } catch (err) {
    console.error("[BLOCKED-DIGEST] stamp failed:", err instanceof Error ? err.name : "UnknownError")
  }
  return true
}

// ---------------------------------------------------------------------------------------------- spike alert

export type SpikeDeps = {
  settings(): Promise<BlockedNumbersSettings>
  now(): Date
  /** Phones of attempts since the ISO time. May stop early once more than `stopAfterDistinct` distinct phones are seen. */
  recentPhones(sinceIso: string, stopAfterDistinct?: number): Promise<string[]>
  getLastAlertAt(): Promise<string | null>
  stampAlert(iso: string): Promise<void>
  notifyEmail(subject: string, html: string): Promise<void>
  notifyPush(p: PushPayload): Promise<unknown>
}

/**
 * Bounded paged read (1000-row pages, newest first, max 10 pages, ~400 ms budget). Stops as soon as the distinct
 * count exceeds `stopAfterDistinct` (the alert fires anyway), so a cut-off read can only under-count, never over-count.
 */
export async function readRecentPhones(
  db: { from(t: string): any },
  sinceIso: string,
  stopAfterDistinct = Number.POSITIVE_INFINITY,
  budgetMs = 400
): Promise<string[]> {
  const started = Date.now()
  const out: string[] = []
  const distinct = new Set<string>()
  for (let page = 0; page < SPIKE_MAX_PAGES; page++) {
    const { data, error } = await db
      .from("mtn_blocked_attempts")
      .select("phone")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error(`spike read failed: ${error.code ?? "db"}`)
    const rows = (data ?? []) as Array<{ phone: string }>
    for (const r of rows) {
      out.push(r.phone)
      distinct.add(r.phone)
    }
    if (rows.length < PAGE || distinct.size > stopAfterDistinct || Date.now() - started > budgetMs) break
  }
  return out
}

async function defaultSpikeDeps(): Promise<SpikeDeps> {
  const n = await defaultNotifiers()
  return {
    settings: () => getBlockedNumbersSettings(),
    now: () => new Date(),
    recentPhones: (sinceIso, stopAfterDistinct) => readRecentPhones(supabaseAdmin, sinceIso, stopAfterDistinct),
    async getLastAlertAt() {
      const { data, error } = await supabaseAdmin.from("admin_settings").select("value").eq("key", SPIKE_STAMP_KEY).maybeSingle()
      if (error) throw new Error(`spike stamp read failed: ${error.code ?? "db"}`)
      const at = (data?.value as { at?: unknown } | null | undefined)?.at
      return typeof at === "string" ? at : null
    },
    async stampAlert(iso) {
      const { error } = await supabaseAdmin.from("admin_settings").upsert(
        {
          key: SPIKE_STAMP_KEY,
          value: { at: iso },
          description: "Blocked MTN numbers: when the last spike alert was sent (6 hour cooldown).",
          updated_at: iso,
        },
        { onConflict: "key" }
      )
      if (error) throw new Error(`spike stamp write failed: ${error.code ?? "db"}`)
    },
    ...n,
  }
}

/**
 * True when an alert was sent. Distinct numbers (not attempts) in the last 60 minutes must exceed the threshold and
 * no alert may have gone out in the last 6 hours. The cooldown is stamped BEFORE sending so concurrent recorders
 * and a failing notifier cannot cause an alert storm. Rough heuristic by design (spec section 7).
 */
export async function maybeSendSpikeAlert(deps?: SpikeDeps): Promise<boolean> {
  const d = deps ?? (await defaultSpikeDeps())
  const settings = await d.settings()
  if (!settings.enabled) return false
  const now = d.now()
  const phones = await d.recentPhones(new Date(now.getTime() - HOUR_MS).toISOString(), settings.spike_threshold_per_hour)
  const distinct = new Set(phones).size
  if (distinct <= settings.spike_threshold_per_hour) return false

  const last = await d.getLastAlertAt()
  if (last) {
    const t = Date.parse(last)
    if (Number.isFinite(t) && now.getTime() - t < SPIKE_COOLDOWN_MS) return false
  }

  await d.stampAlert(now.toISOString())
  const subject = "Blocked MTN numbers spike"
  const html =
    `<h3>Blocked MTN numbers spike</h3>` +
    `<p><b>${fmt(distinct)}</b> distinct numbers were refused in the last hour (threshold ${fmt(settings.spike_threshold_per_hour)}).</p>` +
    `<p>A sudden jump can mean a provider is wrongly rejecting numbers. Check the providers, then ${ADMIN_PAGE} in the admin area.</p>`
  const results = await Promise.allSettled([
    d.notifyEmail(subject, html),
    d.notifyPush({
      title: subject,
      body: `${fmt(distinct)} distinct numbers refused in the last hour (threshold ${fmt(settings.spike_threshold_per_hour)}).`,
      data: { url: ADMIN_PAGE },
    }),
  ])
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed > 0) console.error(`[BLOCKED-SPIKE] ${failed} of 2 channels failed`)
  console.log(`[BLOCKED-SPIKE] alert sent distinct=${distinct}`)
  return true
}

// In-process throttle for the recorder hook: the check reads up to 5000 rows, so run it at most once a minute per instance.
let lastSpikeCheckAt = 0
const SPIKE_CHECK_EVERY_MS = 60_000

export function _resetSpikeThrottle(): void {
  lastSpikeCheckAt = 0
}

/** Recorder hook. Bounded (throttled, one query + at most one stamp) and never throws. */
export async function spikeCheckAfterInsert(): Promise<void> {
  const t = Date.now()
  if (t - lastSpikeCheckAt < SPIKE_CHECK_EVERY_MS) return
  lastSpikeCheckAt = t
  try {
    await maybeSendSpikeAlert()
  } catch (err) {
    console.error("[BLOCKED-SPIKE] check failed:", err instanceof Error ? err.name : "UnknownError")
  }
}
