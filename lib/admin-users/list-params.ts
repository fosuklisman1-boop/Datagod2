// Admin users list: query-param parsing, RPC argument building and row mapping.
//
// Pure (no I/O) so the route, the page and the tests share one definition of
// "what does ?role=dealer&page=3 mean". The database function
// public.admin_list_users (migrations/0145_admin_list_users.sql) re-validates
// sort/dir/pricing mode, clamps limit/offset and escapes the search term, so this
// layer is the friendly front door, not the only guard.

import { normaliseTag } from "./notes-tags"
import type { UserSignalsView } from "./risk-signals"

export const USER_ROLES = ["user", "dealer", "sub_agent", "admin"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const USER_SORTS = ["created_at", "balance", "email", "shop_balance", "last_sign_in_at"] as const
export type UserSort = (typeof USER_SORTS)[number]
export type SortDir = "asc" | "desc"

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
export const MAX_SEARCH_LENGTH = 100
/** page * pageSize must stay well inside a Postgres int offset. */
export const MAX_PAGE = 100_000

export interface UsersListFilters {
  q: string | null
  role: UserRole | null
  suspended: boolean | null
  hasShop: boolean | null
  pricingMode: "role" | "custom" | null
  /** Signup date range, YYYY-MM-DD, both ends inclusive (calendar days, GMT = Ghana time). */
  from: string | null
  to: string | null
  /** Only users carrying this admin tag (lib/admin-users/notes-tags.ts rules). */
  tag: string | null
  sort: UserSort
  dir: SortDir
}

export interface UsersListParams extends UsersListFilters {
  page: number
  pageSize: number
}

export const DEFAULT_FILTERS: UsersListFilters = {
  q: null,
  role: null,
  suspended: null,
  hasShop: null,
  pricingMode: null,
  from: null,
  to: null,
  tag: null,
  sort: "created_at",
  dir: "desc",
}

export type ParseResult = { ok: true; params: UsersListParams } | { ok: false; errors: string[] }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** Years outside this range are rejected: 9999-12-31 would make the exclusive upper bound year 10000. */
export const MIN_YEAR = 1970
export const MAX_YEAR = 2999

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30), year MIN_YEAR..MAX_YEAR. */
export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const year = Number(s.slice(0, 4))
  if (year < MIN_YEAR || year > MAX_YEAR) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** A reversed range (from after to) is swapped, not dropped: the admin meant the days between them. */
export function normaliseDateRange<T extends { from: string | null; to: string | null }>(r: T): T {
  if (r.from && r.to && r.from > r.to) return { ...r, from: r.to, to: r.from }
  return r
}

/** Trim, drop control characters, collapse whitespace, cap length. Empty -> null. */
export function normaliseSearch(raw: string | null | undefined): string | null {
  if (raw == null) return null
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return s ? s.slice(0, MAX_SEARCH_LENGTH) : null
}

/** Clamp a page size to 1..MAX_PAGE_SIZE (non-finite -> default). */
export function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_SIZE)
}

function parseBool(v: string): boolean | null | undefined {
  const s = v.trim().toLowerCase()
  if (s === "" || s === "all") return null
  if (s === "true" || s === "1" || s === "yes") return true
  if (s === "false" || s === "0" || s === "no") return false
  return undefined
}

function parseIntStrict(v: string): number | undefined {
  const s = v.trim()
  if (!/^\d{1,9}$/.test(s)) return undefined
  return Number(s)
}

/**
 * Strict parse for the API. Unknown values are errors (400) rather than being
 * silently ignored, so a typo never returns "everyone". Absent / empty / "all"
 * means no filter. pageSize is clamped, not rejected (same as the RPC).
 */
export function parseUsersListParams(sp: URLSearchParams): ParseResult {
  const errors: string[] = []
  const get = (k: string) => sp.get(k) ?? ""

  const q = normaliseSearch(sp.get("q"))

  let role: UserRole | null = null
  const roleRaw = get("role").trim().toLowerCase()
  if (roleRaw && roleRaw !== "all") {
    if ((USER_ROLES as readonly string[]).includes(roleRaw)) role = roleRaw as UserRole
    else errors.push(`role must be one of: ${USER_ROLES.join(", ")}`)
  }

  const suspended = parseBool(get("suspended"))
  if (suspended === undefined) errors.push("suspended must be true or false")
  const hasShop = parseBool(get("hasShop"))
  if (hasShop === undefined) errors.push("hasShop must be true or false")

  let pricingMode: "role" | "custom" | null = null
  const pm = get("pricingMode").trim().toLowerCase()
  if (pm && pm !== "all") {
    if (pm === "role" || pm === "custom") pricingMode = pm
    else errors.push("pricingMode must be role or custom")
  }

  const from = get("from").trim() || null
  const to = get("to").trim() || null
  if (from && !isIsoDate(from)) errors.push("from must be a date (YYYY-MM-DD)")
  if (to && !isIsoDate(to)) errors.push("to must be a date (YYYY-MM-DD)")
  if (from && to && isIsoDate(from) && isIsoDate(to) && from > to) errors.push("from must not be after to")

  let tag: string | null = null
  const tagRaw = get("tag").trim()
  if (tagRaw && tagRaw.toLowerCase() !== "all") {
    tag = normaliseTag(tagRaw)
    if (!tag) errors.push("tag must be 1 to 32 characters: a-z, 0-9 and -")
  }

  let sort: UserSort = DEFAULT_FILTERS.sort
  const sortRaw = get("sort").trim().toLowerCase()
  if (sortRaw) {
    if ((USER_SORTS as readonly string[]).includes(sortRaw)) sort = sortRaw as UserSort
    else errors.push(`sort must be one of: ${USER_SORTS.join(", ")}`)
  }

  let dir: SortDir = DEFAULT_FILTERS.dir
  const dirRaw = get("dir").trim().toLowerCase()
  if (dirRaw) {
    if (dirRaw === "asc" || dirRaw === "desc") dir = dirRaw
    else errors.push("dir must be asc or desc")
  }

  let page = 1
  if (get("page").trim()) {
    const p = parseIntStrict(get("page"))
    if (p === undefined || p < 1 || p > MAX_PAGE) errors.push(`page must be an integer from 1 to ${MAX_PAGE}`)
    else page = p
  }

  let pageSize = DEFAULT_PAGE_SIZE
  if (get("pageSize").trim()) {
    const n = parseIntStrict(get("pageSize"))
    if (n === undefined) errors.push(`pageSize must be an integer from 1 to ${MAX_PAGE_SIZE}`)
    else pageSize = clampPageSize(n)
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    params: {
      q,
      role,
      suspended: suspended ?? null,
      hasShop: hasShop ?? null,
      pricingMode,
      from,
      to,
      tag,
      sort,
      dir,
      page,
      pageSize,
    },
  }
}

/**
 * Lenient parse for the page's URL: anything invalid falls back to its default
 * instead of failing, so a hand-edited or stale link still opens the page.
 */
export function readListParamsFromUrl(sp: URLSearchParams): UsersListParams {
  const keys = ["q", "role", "suspended", "hasShop", "pricingMode", "from", "to", "tag", "sort", "dir", "page", "pageSize"]
  const clean = new URLSearchParams()
  for (const k of keys) {
    const v = sp.get(k)
    if (v == null) continue
    const one = new URLSearchParams({ [k]: v })
    if (parseUsersListParams(one).ok) clean.set(k, v)
  }
  // Only from > to can still fail once each key is valid alone: swap the two dates.
  const from = clean.get("from")
  const to = clean.get("to")
  if (from && to && from > to) {
    clean.set("from", to)
    clean.set("to", from)
  }
  const r = parseUsersListParams(clean)
  return r.ok ? r.params : { ...DEFAULT_FILTERS, page: 1, pageSize: DEFAULT_PAGE_SIZE }
}

/**
 * Serialise to a query string, leaving out defaults so URLs stay short and a
 * shared link only carries what was chosen. Same keys the API parses.
 */
export function listParamsToSearchParams(p: Partial<UsersListParams>): URLSearchParams {
  const sp = new URLSearchParams()
  if (p.q) sp.set("q", p.q)
  if (p.role) sp.set("role", p.role)
  if (p.suspended != null) sp.set("suspended", String(p.suspended))
  if (p.hasShop != null) sp.set("hasShop", String(p.hasShop))
  if (p.pricingMode) sp.set("pricingMode", p.pricingMode)
  if (p.from) sp.set("from", p.from)
  if (p.to) sp.set("to", p.to)
  if (p.tag) sp.set("tag", p.tag)
  if (p.sort && p.sort !== DEFAULT_FILTERS.sort) sp.set("sort", p.sort)
  if (p.dir && p.dir !== DEFAULT_FILTERS.dir) sp.set("dir", p.dir)
  if (p.page && p.page !== 1) sp.set("page", String(p.page))
  if (p.pageSize && p.pageSize !== DEFAULT_PAGE_SIZE) sp.set("pageSize", String(p.pageSize))
  return sp
}

/** Next calendar day of a YYYY-MM-DD date, as YYYY-MM-DD. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export interface AdminListUsersArgs {
  p_search: string | null
  p_role: string | null
  p_suspended: boolean | null
  p_has_shop: boolean | null
  p_pricing_mode: string | null
  p_created_from: string | null
  p_created_to: string | null
  p_sort: UserSort
  p_dir: SortDir
  p_limit: number
  p_offset: number
  p_tag: string | null
}

/**
 * RPC arguments for public.admin_list_users. Dates are whole days in GMT
 * (Ghana's time zone, no DST): from = start of that day (inclusive),
 * to = start of the NEXT day (the RPC's upper bound is exclusive).
 */
export function toRpcArgs(p: UsersListParams): AdminListUsersArgs {
  const pageSize = clampPageSize(p.pageSize)
  const page = Math.min(Math.max(Math.trunc(p.page) || 1, 1), MAX_PAGE)
  return {
    p_search: normaliseSearch(p.q),
    p_role: p.role,
    p_suspended: p.suspended,
    p_has_shop: p.hasShop,
    p_pricing_mode: p.pricingMode,
    p_created_from: p.from ? `${p.from}T00:00:00Z` : null,
    p_created_to: p.to ? `${nextDay(p.to)}T00:00:00Z` : null,
    p_sort: p.sort,
    p_dir: p.dir,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_tag: p.tag ?? null,
  }
}

/** One row of admin_list_users' jsonb "rows". */
export interface AdminListUsersRow {
  id: string
  email: string | null
  phone_number: string | null
  first_name: string | null
  last_name: string | null
  role: string
  is_suspended: boolean
  pricing_mode: string
  created_at: string
  last_sign_in_at: string | null
  shop_id: string | null
  shop_name: string | null
  shop_created_at: string | null
  wallet_balance: number | string | null
  shop_balance: number | string | null
  customer_count: number | string | null
  sub_agent_count: number | string | null
  /** The user's admin tags, A-Z (0145 + 0149). */
  tags?: unknown
}

/**
 * The user object GET /api/admin/users has always returned (same field names and
 * meaning), plus first_name / last_name / last_sign_in_at.
 * `balance` stays wallet + shop balance for backwards compatibility.
 * `id` is the auth user id: the stable row key for selection and later bulk actions.
 */
export interface AdminUserListItem {
  id: string
  email: string
  phoneNumber: string
  created_at: string
  shop: { id: string; user_id: string; shop_name: string; created_at: string | null } | null
  walletBalance: number
  shopBalance: number
  balance: number
  role: string
  customerCount: number
  subAgentCount: number
  is_suspended: boolean
  pricing_mode: string
  first_name: string | null
  last_name: string | null
  last_sign_in_at: string | null
  /** Admin tags, A-Z. */
  tags: string[]
  /** Activity and risk signals; only on GET /api/admin/users (the current page), never in the export. */
  signals?: UserSignalsView | null
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function mapRowToUser(r: AdminListUsersRow): AdminUserListItem {
  const walletBalance = num(r.wallet_balance)
  const shopBalance = r.shop_id ? num(r.shop_balance) : 0
  return {
    id: r.id,
    email: r.email ?? "",
    phoneNumber: r.phone_number || "",
    created_at: r.created_at,
    shop: r.shop_id
      ? { id: r.shop_id, user_id: r.id, shop_name: r.shop_name ?? "", created_at: r.shop_created_at }
      : null,
    walletBalance,
    shopBalance,
    balance: walletBalance + shopBalance,
    role: r.role || "user",
    customerCount: r.shop_id ? num(r.customer_count) : 0,
    subAgentCount: r.shop_id ? num(r.sub_agent_count) : 0,
    is_suspended: !!r.is_suspended,
    pricing_mode: r.pricing_mode ?? "role",
    first_name: r.first_name ?? null,
    last_name: r.last_name ?? null,
    last_sign_in_at: r.last_sign_in_at ?? null,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
  }
}

export interface UsersListResponse {
  users: AdminUserListItem[]
  total: number
  page: number
  pageSize: number
  /** The page loaded but its signals could not be computed (each user's signals is null). */
  signalsUnavailable?: boolean
}

/** GET /api/admin/users/export response. */
export interface UsersExportResponse {
  users: AdminUserListItem[]
  /** Opaque; pass back as ?cursor= for the next chunk. null when the export is complete. */
  nextCursor: string | null
}

/** Shape check for the RPC's jsonb result; throws on anything unexpected. */
export function parseRpcResult(data: unknown): { total: number; rows: AdminListUsersRow[] } {
  if (!data || typeof data !== "object") throw new Error("admin_list_users returned no data")
  const d = data as { total?: unknown; rows?: unknown }
  const total = Number(d.total)
  if (!Number.isFinite(total) || total < 0) throw new Error("admin_list_users returned a bad total")
  if (!Array.isArray(d.rows)) throw new Error("admin_list_users returned bad rows")
  return { total, rows: d.rows as AdminListUsersRow[] }
}
