/** Customer-facing read model for the SMS pages (Phase 3): home summary, records, credit ledger. Throws on DB errors. */
import { createClient } from "@supabase/supabase-js"
import { loadSmsSettings, type SmsMode } from "./platform-settings"
import { platformSenderName } from "@/lib/sms-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const RECORDS_PAGE_SIZE = 25
const HOME_LEDGER_ROWS = 5
const STATS_DAYS = 30
const MESSAGE_CHUNK = 1000
const RECORD_STATUSES = new Set(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"])
const LOG_COLUMNS = "id, status, message, sender_id, recipients_count, segments, credits_reserved, credits_used, created_at, completed_at"
const LEDGER_COLUMNS = "id, delta, reason, balance_after, send_log_id, created_at"

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }
export interface LedgerRow {
  id: number; delta: number; reason: string; balance_after: number | null
  send_log_id: number | null; created_at: string; label: string
}

/** Customer-facing ledger wording (kept in step with ledgerLabel in app/dashboard/sms/_lib/view.ts). */
function ledgerLabel(reason: string, sendLogId: number | null): string {
  switch (reason) {
    case "bundle_wallet": case "bundle_paystack": return "Credits purchased"
    case "welcome_bonus": return "Welcome bonus"
    case "admin_alloc": return "Credits added by support"
    case "campaign_send": return sendLogId ? `SMS campaign #${sendLogId}` : "SMS campaign"
    case "campaign_refund": return sendLogId ? `Refund — campaign #${sendLogId}` : "Refund — failed delivery"
    default: return "Credit adjustment"
  }
}

/** PostgREST answers a range past the end of the data with 416 / PGRST103 (and no total). */
function isOutOfRange(e: { code?: string; status?: number } | null): boolean {
  return !!e && (e.code === "PGRST103" || e.status === 416)
}

function toLedgerRow(r: Omit<LedgerRow, "label">): LedgerRow {
  return { ...r, label: ledgerLabel(r.reason, r.send_log_id ?? null) }
}

async function recentLedger(accountId: string, limit: number): Promise<LedgerRow[]> {
  const { data, error } = await supabaseAdmin.from("sms_unit_transactions")
    .select(LEDGER_COLUMNS)
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Omit<LedgerRow, "label">[]).map(toLedgerRow)
}

async function loadStats(accountId: string) {
  const { data, error } = await supabaseAdmin.rpc("sms_customer_stats", { p_account_id: accountId, p_days: STATS_DAYS })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as { campaigns?: string | number; recipients?: string | number; credits_used?: string | number } | null | undefined
  return {
    campaigns: Number(row?.campaigns) || 0,
    recipients: Number(row?.recipients) || 0,
    creditsUsed: Number(row?.credits_used) || 0,
  }
}

async function loadMode(accountId: string): Promise<SmsMode> {
  const { data, error } = await supabaseAdmin.from("sms_accounts").select("mode").eq("id", accountId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { mode?: string } | null)?.mode === "business" ? "business" : "platform"
}

export async function getHomeSummary(accountId: string) {
  const [mode, stats, ledger, settings] = await Promise.all([
    loadMode(accountId), loadStats(accountId), recentLedger(accountId, HOME_LEDGER_ROWS), loadSmsSettings(),
  ])
  const caps = settings.caps[mode]
  return {
    mode,
    limits: { perSend: caps.per_send, perHour: caps.per_hour, perDay: caps.per_day },
    stats,
    recentLedger: ledger,
    featureEnabled: settings.featureEnabled,
    platformSender: platformSenderName(),
  }
}

export async function listRecords(accountId: string, i: { status: string; page: number }): Promise<Page<Record<string, unknown>>> {
  const page = Math.max(1, Math.floor(i.page) || 1)
  const from = (page - 1) * RECORDS_PAGE_SIZE
  const filtered = (cols: string, opts: { count: "exact"; head?: boolean }) => {
    let q = supabaseAdmin.from("sms_send_logs").select(cols, opts).eq("sms_account_id", accountId)
    if (RECORD_STATUSES.has(i.status)) q = q.eq("status", i.status)
    return q
  }
  const { data, error, count } = await filtered(LOG_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + RECORDS_PAGE_SIZE - 1)
  if (isOutOfRange(error)) {
    const head = await filtered("id", { count: "exact", head: true })
    if (head.error) throw new Error(head.error.message)
    return { rows: [], total: head.count ?? 0, page, pageSize: RECORDS_PAGE_SIZE }
  }
  if (error) throw new Error(error.message)
  return { rows: (data ?? []) as unknown as Record<string, unknown>[], total: count ?? 0, page, pageSize: RECORDS_PAGE_SIZE }
}

export async function listLedger(accountId: string, pageNum: number): Promise<Page<LedgerRow>> {
  const page = Math.max(1, Math.floor(pageNum) || 1)
  const from = (page - 1) * RECORDS_PAGE_SIZE
  const { data, error, count } = await supabaseAdmin.from("sms_unit_transactions")
    .select(LEDGER_COLUMNS, { count: "exact" })
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + RECORDS_PAGE_SIZE - 1)
  if (isOutOfRange(error)) {
    const head = await supabaseAdmin.from("sms_unit_transactions")
      .select("id", { count: "exact", head: true }).eq("sms_account_id", accountId)
    if (head.error) throw new Error(head.error.message)
    return { rows: [], total: head.count ?? 0, page, pageSize: RECORDS_PAGE_SIZE }
  }
  if (error) throw new Error(error.message)
  return { rows: ((data ?? []) as Omit<LedgerRow, "label">[]).map(toLedgerRow), total: count ?? 0, page, pageSize: RECORDS_PAGE_SIZE }
}

interface MessageRow { status: string; delivery_status: string | null; refunded: boolean | null }

/** One batch with its per-recipient rows and delivery counts, or null if it is not this account's. */
export async function getRecord(accountId: string, logId: number) {
  const { data: log, error: logErr } = await supabaseAdmin.from("sms_send_logs")
    .select(LOG_COLUMNS).eq("id", logId).eq("sms_account_id", accountId).maybeSingle()
  if (logErr) throw new Error(logErr.message)
  if (!log) return null

  const messages: (MessageRow & Record<string, unknown>)[] = []
  for (let from = 0; ; from += MESSAGE_CHUNK) {
    const { data, error } = await supabaseAdmin.from("sms_messages")
      .select("id, phone, status, attempts, last_error, processed_at, delivery_status, refunded")
      .eq("send_log_id", logId).eq("sms_account_id", accountId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + MESSAGE_CHUNK - 1)
    if (error) throw new Error(error.message)
    const chunk = (data ?? []) as (MessageRow & Record<string, unknown>)[]
    messages.push(...chunk)
    if (chunk.length < MESSAGE_CHUNK) break
  }

  const counts = { delivered: 0, failed: 0, pending: 0, refunded: 0 }
  for (const m of messages) {
    if (m.delivery_status === "delivered") counts.delivered++
    else if (m.status === "failed" || m.delivery_status === "failed") counts.failed++
    else counts.pending++
    if (m.refunded) counts.refunded++
  }
  return { log: log as Record<string, unknown>, messages, counts }
}
