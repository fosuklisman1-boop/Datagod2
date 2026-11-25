/**
 * Release 3 developer dashboard, server side: query parsing for the session routes under /api/user/v2-dashboard and thin
 * wrappers over the 0199 read functions. The user id always comes from the verified session (the routes), never from the
 * query string. Every parser drops unknown values rather than passing them on, and refuses only what a person could fix.
 */

export interface RpcLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_MS = 31 * 86_400_000
export const ORDER_PRODUCTS = ["data", "airtime", "bill", "bundle", "results", "afa"] as const
export type OrderProduct = (typeof ORDER_PRODUCTS)[number]
export const ORDER_STATUSES = ["pending", "processing", "completed", "failed", "refunded", "queued", "unknown"] as const
export const PRODUCT_LABEL: Record<OrderProduct, string> = {
  data: "Data",
  airtime: "Airtime",
  bill: "Bill",
  bundle: "Bundle",
  results: "Results checker",
  afa: "AFA",
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** YYYY-MM-DD -> the first or last millisecond of that UTC day (Ghana time is GMT). null when not a real day. */
function dayEdge(s: string, edge: "start" | "end"): string | null {
  if (!DAY_RE.test(s)) return null
  const d = new Date(`${s}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null
  return edge === "start" ? d.toISOString() : new Date(d.getTime() + 86_400_000 - 1).toISOString()
}

function readRange(p: URLSearchParams): Parsed<{ from?: string; to?: string }> {
  const out: { from?: string; to?: string } = {}
  const from = p.get("from")
  const to = p.get("to")
  if (from) {
    const v = dayEdge(from, "start")
    if (!v) return { ok: false, error: "Dates must be real days written YYYY-MM-DD." }
    out.from = v
  }
  if (to) {
    const v = dayEdge(to, "end")
    if (!v) return { ok: false, error: "Dates must be real days written YYYY-MM-DD." }
    out.to = v
  }
  // A From date alone means that day plus the next 30 (final review I2): never the silent "last 31 days" clamp.
  if (out.from && !out.to) out.to = new Date(Date.parse(out.from) + MAX_RANGE_MS - 1).toISOString()
  if (out.from && out.to) {
    const span = Date.parse(out.to) - Date.parse(out.from)
    if (span < 0) return { ok: false, error: "The start date is after the end date." }
    if (span > MAX_RANGE_MS) return { ok: false, error: "Choose at most 31 days." }
  }
  return { ok: true, value: out }
}

const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

/**
 * "time|rest" -> [time, rest]; "bad" when malformed. The time is passed through UNCHANGED: Postgres keeps microseconds
 * and a JavaScript Date keeps milliseconds, so re-serialising it would skip rows inside the last millisecond (review I2).
 */
function readCursor(raw: string | null): [string, string] | null | "bad" {
  if (!raw) return null
  const at = raw.indexOf("|")
  if (at < 1) return "bad"
  const time = raw.slice(0, at)
  const rest = raw.slice(at + 1)
  if (!CURSOR_TIME_RE.test(time) || Number.isNaN(Date.parse(time)) || !rest || rest.length > 120) return "bad"
  return [time, rest]
}

export interface LogsQuery {
  filters: { key?: string; env?: "live" | "test"; status?: "ok" | "client" | "server"; endpoint?: string; from?: string; to?: string }
  beforeAt: string | null
  beforeId: string | null
  limit: number
}

export function parseLogsQuery(p: URLSearchParams): Parsed<LogsQuery> {
  const filters: LogsQuery["filters"] = {}
  const key = p.get("key")
  if (key) {
    if (!UUID_RE.test(key)) return { ok: false, error: "Unknown key." }
    filters.key = key.toLowerCase()
  }
  const env = p.get("env")
  if (env === "live" || env === "test") filters.env = env
  const status = p.get("status")
  if (status === "ok" || status === "client" || status === "server") filters.status = status
  const endpoint = p.get("endpoint")
  if (endpoint && /^\/api\/v2\/[A-Za-z0-9/_[\]-]{1,180}$/.test(endpoint)) filters.endpoint = endpoint
  const range = readRange(p)
  if (!range.ok) return range
  Object.assign(filters, range.value)
  const cursor = readCursor(p.get("before"))
  if (cursor === "bad" || (cursor && !UUID_RE.test(cursor[1]))) return { ok: false, error: "Bad page cursor." }
  const limit = Number(p.get("limit"))
  return {
    ok: true,
    value: {
      filters,
      beforeAt: cursor ? cursor[0] : null,
      beforeId: cursor ? cursor[1].toLowerCase() : null,
      limit: Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50,
    },
  }
}

/** A Ghana number in any common form -> local 0XXXXXXXXX; null when the text is not a phone number. */
export function localPhone(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "")
  if (/^0[235]\d{8}$/.test(s)) return s
  const m = /^\+?233([235]\d{8})$/.exec(s)
  return m ? "0" + m[1] : null
}

export interface OrdersQuery {
  filters: { reference?: string; recipient?: string; product?: OrderProduct; status?: string; from?: string; to?: string }
  beforeAt: string | null
  beforeKey: string | null
  limit: number
}

export const CSV_MAX_ROWS = 5000

export function parseOrdersQuery(p: URLSearchParams, opts: { csv?: boolean } = {}): Parsed<OrdersQuery> {
  const filters: OrdersQuery["filters"] = {}
  const search = (p.get("q") ?? "").trim()
  if (search) {
    if (search.length > 100) return { ok: false, error: "Search for at most 100 characters." }
    const phone = localPhone(search)
    if (phone) filters.recipient = phone
    else filters.reference = search
  }
  const product = p.get("product")
  if (product && (ORDER_PRODUCTS as readonly string[]).includes(product)) filters.product = product as OrderProduct
  const status = p.get("status")
  if (status && (ORDER_STATUSES as readonly string[]).includes(status)) filters.status = status
  const range = readRange(p)
  if (!range.ok) return range
  Object.assign(filters, range.value)
  const cursor = readCursor(p.get("before"))
  if (cursor === "bad") return { ok: false, error: "Bad page cursor." }
  const limit = Number(p.get("limit"))
  return {
    ok: true,
    value: {
      filters,
      beforeAt: cursor ? cursor[0] : null,
      beforeKey: cursor ? cursor[1] : null,
      limit: opts.csv ? CSV_MAX_ROWS : Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50,
    },
  }
}

/** GHS 0.01..100000, at most two decimals; empty or null removes the alert. */
export function parseThreshold(raw: unknown): Parsed<number | null> {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null }
  if (typeof raw !== "number" && typeof raw !== "string") return { ok: false, error: "Enter an amount in GHS." }
  const n = typeof raw === "number" ? raw : Number(raw.trim())
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return { ok: false, error: "Enter an amount between GHS 0.01 and GHS 100,000." }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { ok: false, error: "Use at most two decimal places." }
  return { ok: true, value: Math.round(n * 100) / 100 }
}

// ---------------------------------------------------------------- CSV

const BOM = String.fromCharCode(0xfeff)
const FORMULA_START = new Set(["=", "+", "-", "@", String.fromCharCode(9), String.fromCharCode(13)])

/** One text cell: formula guard (a leading = + - @ tab or CR gets a ') and RFC 4180 quoting. */
export function csvCell(v: string | null | undefined): string {
  let s = v ?? ""
  if (s && FORMULA_START.has(s[0])) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export interface OrderRow {
  product: string
  reference: string
  created_at: string
  recipient: string | null
  amount: number | string | null
  item: string | null
  status: string
}

function gmt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ")
}

export function ordersCsv(rows: OrderRow[]): string {
  const lines = ["Date (GMT),Product,Reference,Recipient,Item,Amount (GHS),Status"]
  for (const r of rows) {
    const n = Number(r.amount)
    lines.push(
      [
        gmt(r.created_at),
        csvCell(PRODUCT_LABEL[r.product as OrderProduct] ?? r.product),
        csvCell(r.reference),
        csvCell(r.recipient),
        csvCell(r.item),
        r.amount === null || r.amount === undefined || !Number.isFinite(n) ? "" : n.toFixed(2),
        csvCell(r.status),
      ].join(","),
    )
  }
  return BOM + lines.join("\r\n") + "\r\n"
}

// ---------------------------------------------------------------- reads and writes

type Read<T> = { ok: true; value: T } | { ok: false }

async function rpc<T>(client: RpcLike, fn: string, args: Record<string, unknown>): Promise<Read<T>> {
  try {
    const { data, error } = await client.rpc(fn, args)
    if (error) return { ok: false }
    return { ok: true, value: data as T }
  } catch {
    return { ok: false }
  }
}

export function readUsage(client: RpcLike, userId: string, days: number, env: string | null): Promise<Read<unknown>> {
  return rpc(client, "api_v2_dev_usage", {
    p_user: userId,
    p_days: days === 30 ? 30 : 7,
    p_env: env === "live" || env === "test" ? env : null,
  })
}

export function readLogs(client: RpcLike, userId: string, q: LogsQuery): Promise<Read<unknown[]>> {
  return rpc(client, "api_v2_dev_logs", { p_user: userId, p_filters: q.filters, p_before_at: q.beforeAt, p_before_id: q.beforeId, p_limit: q.limit })
}

export function readOrders(client: RpcLike, userId: string, q: OrdersQuery): Promise<Read<OrderRow[]>> {
  return rpc(client, "api_v2_dev_orders", { p_user: userId, p_filters: q.filters, p_before_at: q.beforeAt, p_before_key: q.beforeKey, p_limit: q.limit })
}

export interface Out {
  status: number
  body: Record<string, unknown>
}
const UNAVAILABLE: Out = { status: 503, body: { error: "This is temporarily unavailable. Try again shortly.", code: "unavailable" } }

export async function getBalanceAlert(client: RpcLike, userId: string): Promise<Out> {
  const r = await rpc<Record<string, unknown>>(client, "api_v2_get_balance_alert", { p_user: userId })
  return r.ok && r.value ? { status: 200, body: r.value } : UNAVAILABLE
}

export async function setBalanceAlert(client: RpcLike, userId: string, raw: unknown): Promise<Out> {
  const t = parseThreshold(raw)
  if (!t.ok) return { status: 400, body: { error: t.error, code: "bad_input" } }
  const r = await rpc<Record<string, unknown>>(client, "api_v2_set_balance_alert", { p_user: userId, p_threshold: t.value })
  return r.ok && r.value ? { status: 200, body: r.value } : UNAVAILABLE
}
