import { formatGhanaDate } from "@/lib/api-v1/retirement"

const DOCS_URL = "https://www.datagod.store/developers"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_EXEMPT_USERS = 50
const IN_CHUNK = 100

export type RetirementUpdate = { sunset_at: string | null; exempt_user_ids: string[] }

export function parseRetirementUpdate(
  body: unknown,
  now: Date
): { ok: true; value: RetirementUpdate } | { ok: false; error: string } {
  void now
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be an object" }
  const b = body as Record<string, unknown>

  let sunset: string | null = null
  if (b.sunset_at !== null) {
    if (typeof b.sunset_at !== "string") return { ok: false, error: "sunset_at must be an ISO date string or null" }
    const d = new Date(b.sunset_at)
    if (Number.isNaN(d.getTime())) return { ok: false, error: "sunset_at is not a valid date" }
    sunset = d.toISOString()
  }

  const ids = b.exempt_user_ids
  if (!Array.isArray(ids)) return { ok: false, error: "exempt_user_ids must be an array" }
  if (ids.length > MAX_EXEMPT_USERS) return { ok: false, error: `At most ${MAX_EXEMPT_USERS} exempt users are allowed` }
  for (const id of ids) {
    if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, error: "exempt_user_ids must contain UUIDs" }
  }
  return { ok: true, value: { sunset_at: sunset, exempt_user_ids: Array.from(new Set(ids.map((i) => (i as string).toLowerCase()))) } }
}

/**
 * The `updated_at` the admin's form was loaded with. Returned verbatim (never re-formatted) because the
 * route compares it to the stored timestamptz string for optimistic concurrency.
 */
export function parseExpectedUpdatedAt(body: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const v = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).expected_updated_at : undefined
  if (typeof v !== "string" || v.trim() === "" || Number.isNaN(new Date(v).getTime())) {
    return { ok: false, error: "expected_updated_at is required (reload the settings and try again)" }
  }
  return { ok: true, value: v }
}

export function buildNoticeMessage(sunsetAt: Date): string {
  return `Datagod API notice: API v1 will be retired on ${formatGhanaDate(sunsetAt)}. After that, v1 requests will be refused. Please move to API v2: ${DOCS_URL}`
}

export function buildExemptMessage(sunsetAt: Date): string {
  return `Datagod API notice: API v1 retires for most users on ${formatGhanaDate(sunsetAt)}. Your v1 access will keep working for now while you move to API v2: ${DOCS_URL}. We'll contact you before it ends.`
}

type Row = Record<string, any>
type Client = { from: (table: string) => any }

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Returns the subset of ids that do not exist in `users`. */
export async function findMissingUserIds(client: Client, ids: string[]): Promise<string[]> {
  const found = new Set<string>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await client.from("users").select("id").in("id", part)
    if (error) throw new Error("users lookup failed")
    for (const r of (data ?? []) as Row[]) found.add(String(r.id).toLowerCase())
  }
  return ids.filter((i) => !found.has(i.toLowerCase()))
}

export type Straggler = {
  user_id: string
  email: string | null
  last_call: string | null
  calls_7d: number
  orders_7d: number
  exempt: boolean
}

const MAX_LOG_ROWS = 5000
const MAX_ORDER_ROWS = 5000

/** v1 usage over the last 7 days, grouped by user. Bounded reads, aggregated in JS. */
export async function loadStragglers(client: Client, exemptIds: string[], now: Date): Promise<Straggler[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString()
  const logs = await client
    .from("user_api_logs")
    .select("user_id, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_LOG_ROWS)
  if (logs.error) throw new Error("log read failed")
  const orders = await client
    .from("api_orders")
    .select("user_id, created_at")
    .is("api_v2_key_id", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ORDER_ROWS)
  if (orders.error) throw new Error("order read failed")

  const agg = new Map<string, { last: string | null; calls: number; orders: number }>()
  const slot = (id: string) => {
    let s = agg.get(id)
    if (!s) agg.set(id, (s = { last: null, calls: 0, orders: 0 }))
    return s
  }
  for (const r of (logs.data ?? []) as Row[]) {
    if (!r.user_id) continue
    const s = slot(r.user_id)
    s.calls++
    if (!s.last || r.created_at > s.last) s.last = r.created_at
  }
  for (const r of (orders.data ?? []) as Row[]) {
    if (!r.user_id) continue
    slot(r.user_id).orders++
  }

  const ids = Array.from(agg.keys())
  const emails = new Map<string, string | null>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await client.from("users").select("id, email").in("id", part)
    if (error) throw new Error("users lookup failed")
    for (const u of (data ?? []) as Row[]) emails.set(u.id, u.email ?? null)
  }
  const exempt = new Set(exemptIds)
  return ids
    .map((id) => {
      const s = agg.get(id)!
      return { user_id: id, email: emails.get(id) ?? null, last_call: s.last, calls_7d: s.calls, orders_7d: s.orders, exempt: exempt.has(id) }
    })
    .sort((a, b) => b.calls_7d - a.calls_7d)
}

export type NoticeRecipient = { user_id: string; email: string | null; phone: string | null; first_name: string | null }
export type NoticeSenders = {
  sms: (r: { phone: string; message: string; userId: string }) => Promise<{ success: boolean }>
  email: (r: { email: string; name?: string; subject: string; text: string; userId: string }) => Promise<{ success: boolean }>
}

/** Sends in batches of 10; each recipient and each channel is isolated so one failure never aborts the run. */
export async function sendNotices(
  recipients: NoticeRecipient[],
  exemptIds: string[],
  sunsetAt: Date,
  senders: NoticeSenders
): Promise<{ sms_sent: number; email_sent: number; failed: number }> {
  const exempt = new Set(exemptIds)
  const result = { sms_sent: 0, email_sent: 0, failed: 0 }
  const attempt = async (fn: () => Promise<{ success: boolean }>, ok: "sms_sent" | "email_sent") => {
    try {
      const r = await fn()
      if (r.success) result[ok]++
      else result.failed++
    } catch {
      result.failed++
    }
  }
  for (const batch of chunk(recipients, 10)) {
    await Promise.all(
      batch.map(async (r) => {
        const message = exempt.has(r.user_id) ? buildExemptMessage(sunsetAt) : buildNoticeMessage(sunsetAt)
        const tasks: Promise<void>[] = []
        if (r.phone) tasks.push(attempt(() => senders.sms({ phone: r.phone as string, message, userId: r.user_id }), "sms_sent"))
        if (r.email) {
          tasks.push(
            attempt(
              () => senders.email({ email: r.email as string, name: r.first_name ?? undefined, subject: "Datagod API v1 notice", text: message, userId: r.user_id }),
              "email_sent"
            )
          )
        }
        await Promise.all(tasks)
      })
    )
  }
  return result
}
