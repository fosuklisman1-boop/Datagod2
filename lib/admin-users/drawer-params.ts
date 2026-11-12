// Admin user drawer: query-param and body parsing shared by the /api/admin/users/[id]/* routes, their
// tests and the drawer UI. Pure (no I/O).

import { isUuid } from "@/lib/pricing/custom-prices-input"

export { isUuid }

export const DRAWER_PAGE_SIZE = 20
export const DRAWER_MAX_PAGE_SIZE = 50
/** Keeps offset well inside a Postgres int and the PostgREST range header sane. */
export const DRAWER_MAX_PAGE = 10_000

export interface Paging {
  page: number
  pageSize: number
  /** 0-based row offset of the first row of the page. */
  offset: number
  /** Inclusive end index, for PostgREST .range(offset, to). */
  to: number
}

const INT_RE = /^\d{1,6}$/

/**
 * ?page=&pageSize= (both optional; defaults 1 and DRAWER_PAGE_SIZE). Anything that is not a whole
 * number in range is an error rather than silently clamped, so a client bug shows up as a 400.
 */
export function parsePaging(
  sp: URLSearchParams,
  opts: { defaultSize?: number; maxSize?: number; pageKey?: string } = {},
): { ok: true; value: Paging } | { ok: false; error: string } {
  const defaultSize = opts.defaultSize ?? DRAWER_PAGE_SIZE
  const maxSize = opts.maxSize ?? DRAWER_MAX_PAGE_SIZE
  const rawPage = sp.get(opts.pageKey ?? "page")
  const rawSize = sp.get("pageSize")
  let page = 1
  let pageSize = defaultSize
  if (rawPage !== null && rawPage !== "") {
    if (!INT_RE.test(rawPage)) return { ok: false, error: "page must be a positive whole number" }
    page = Number(rawPage)
    if (page < 1 || page > DRAWER_MAX_PAGE) return { ok: false, error: `page must be 1 to ${DRAWER_MAX_PAGE}` }
  }
  if (rawSize !== null && rawSize !== "") {
    if (!INT_RE.test(rawSize)) return { ok: false, error: "pageSize must be a positive whole number" }
    pageSize = Number(rawSize)
    if (pageSize < 1 || pageSize > maxSize) return { ok: false, error: `pageSize must be 1 to ${maxSize}` }
  }
  const offset = (page - 1) * pageSize
  return { ok: true, value: { page, pageSize, offset, to: offset + pageSize - 1 } }
}

// ── Orders tab ───────────────────────────────────────────────────────────────

/** Order sources in public.admin_user_orders (migrations/0172). */
export const ORDER_SOURCES = ["data", "api", "standard", "airtime", "bills", "results", "afa"] as const
export type OrderSource = (typeof ORDER_SOURCES)[number]
export const ORDER_SOURCE_LABELS: Record<OrderSource, string> = {
  data: "Data bundles",
  api: "API orders",
  standard: "Standard bundles",
  airtime: "Airtime",
  bills: "Utility bills",
  results: "Results checker",
  afa: "AFA",
}

/** Statuses the order tables use (each table uses a subset). Matched case-insensitively in SQL. */
export const ORDER_STATUSES = ["pending", "pending_payment", "processing", "completed", "delivered", "failed", "refunded", "cancelled"] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export function parseOrderFilters(
  sp: URLSearchParams,
): { ok: true; value: { source: OrderSource | null; status: OrderStatus | null } } | { ok: false; error: string } {
  const source = sp.get("source") || null
  const status = sp.get("status") || null
  if (source !== null && !(ORDER_SOURCES as readonly string[]).includes(source)) return { ok: false, error: "Unknown source" }
  if (status !== null && !(ORDER_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "Unknown status" }
  return { ok: true, value: { source: source as OrderSource | null, status: status as OrderStatus | null } }
}

/**
 * The Orders tab shows unpaid orders (labelled), rather than hiding them, so the counts stay true to the
 * tables. An order is unpaid when its table takes payment outside the wallet (standard, bills, results
 * checker) and that payment never completed.
 */
const UNPAID = new Set(["unpaid", "pending", "pending_payment", "failed"])
export const isUnpaid = (paymentStatus: string | null | undefined) => !!paymentStatus && UNPAID.has(paymentStatus.toLowerCase())

/** A per-source count from admin_user_orders, which stops counting at 1000. */
export const formatCappedCount = (n: number, capped: boolean) => `${n.toLocaleString("en-US")}${capped ? "+" : ""}`

// ── Wallet tab ───────────────────────────────────────────────────────────────

/** Wallet ledger filter: a transactions.type group. */
export const TX_FILTERS = {
  credit: ["credit"],
  debit: ["debit"],
  refund: ["refund"],
  admin: ["admin_credit", "admin_debit"],
  /** Shop profit clawed back from the wallet when an order is refunded, and the reversal of a clawback. */
  clawback: ["refund_clawback", "refund_clawback_undo"],
} as const
export type TxFilter = keyof typeof TX_FILTERS

export function parseTxFilter(sp: URLSearchParams): { ok: true; value: TxFilter | null } | { ok: false; error: string } {
  const t = sp.get("type") || null
  if (t === null) return { ok: true, value: null }
  if (!Object.prototype.hasOwnProperty.call(TX_FILTERS, t)) return { ok: false, error: "Unknown type" }
  return { ok: true, value: t as TxFilter }
}

// ── Wallet adjustment ────────────────────────────────────────────────────────

export const WALLET_ADJUST_MAX = 50_000
export const REASON_MIN = 5
export const REASON_MAX = 500

export interface WalletAdjustInput {
  userId: string
  type: "credit" | "debit"
  amount: number
  reason: string
  /** The balance the admin saw on the confirmation step; the RPC refuses if it has changed. */
  expectedBalance: number | null
}

/** Exactly representable with at most 2 decimals (same test as the RPC's amount = round(amount, 2)). */
export const hasAtMost2Decimals = (n: number) => Math.round(n * 100) / 100 === n

/** Validation of the amount field shared by the dialog (as typed) and the route. null = valid. */
export function amountError(amount: unknown): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "Amount must be a number"
  if (amount <= 0) return "Amount must be greater than 0"
  if (!hasAtMost2Decimals(amount)) return "Amount can have at most 2 decimals"
  if (amount > WALLET_ADJUST_MAX) return `Amount cannot exceed ${WALLET_ADJUST_MAX.toLocaleString()}`
  return null
}

export function reasonError(reason: unknown): string | null {
  if (typeof reason !== "string") return "A reason is required"
  const r = reason.trim()
  if (r.length < REASON_MIN) return `Reason must be at least ${REASON_MIN} characters`
  if (r.length > REASON_MAX) return `Reason must be at most ${REASON_MAX} characters`
  return null
}

const AMOUNT_INPUT_RE = /^\d+(\.\d{1,2})?$/

/** An amount as typed in the dialog ("12.5"), or why it is not acceptable. */
export function parseAmountInput(raw: string): { ok: true; amount: number } | { ok: false; error: string } {
  const s = raw.trim()
  if (!s) return { ok: false, error: "Enter an amount" }
  if (!AMOUNT_INPUT_RE.test(s)) return { ok: false, error: "Amount must be a number with at most 2 decimals" }
  const amount = Number(s)
  const err = amountError(amount)
  return err ? { ok: false, error: err } : { ok: true, amount }
}

/** Body of POST /api/admin/update-balance. */
export function parseWalletAdjustBody(body: unknown): { ok: true; value: WalletAdjustInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid body" }
  const b = body as Record<string, unknown>
  if (typeof b.userId !== "string" || !b.userId) return { ok: false, error: "Missing required fields" }
  if (!isUuid(b.userId)) return { ok: false, error: "Invalid userId format" }
  if (b.type !== "credit" && b.type !== "debit") return { ok: false, error: "type must be 'credit' or 'debit'" }
  const aErr = amountError(b.amount)
  if (aErr) return { ok: false, error: aErr }
  const rErr = reasonError(b.reason)
  if (rErr) return { ok: false, error: rErr }
  let expectedBalance: number | null = null
  if (b.expectedBalance !== undefined && b.expectedBalance !== null) {
    if (typeof b.expectedBalance !== "number" || !Number.isFinite(b.expectedBalance)) {
      return { ok: false, error: "expectedBalance must be a number" }
    }
    expectedBalance = b.expectedBalance
  }
  return {
    ok: true,
    value: { userId: b.userId, type: b.type, amount: b.amount as number, reason: (b.reason as string).trim(), expectedBalance },
  }
}

/** Balance after the adjustment, in pesewas-exact 2-decimal arithmetic (for the confirmation step). */
export function balanceAfter(balance: number, type: "credit" | "debit", amount: number): number {
  const cents = Math.round(balance * 100) + (type === "credit" ? 1 : -1) * Math.round(amount * 100)
  return cents / 100
}

/** Map an admin_wallet_adjust error message to an HTTP status and a message for the admin. */
export function walletAdjustError(message: string | undefined, detail?: string | null): { status: number; error: string } {
  switch (message) {
    case "INSUFFICIENT_BALANCE":
      return { status: 409, error: "Debit refused: the wallet balance is too low" }
    case "BALANCE_CHANGED":
      return { status: 409, error: "The balance changed since you confirmed. Review the new balance and try again." }
    case "WALLET_NOT_FOUND":
      return { status: 404, error: "Wallet not found for user" }
    case "AMBIGUOUS_WALLET":
      return { status: 409, error: "This user has more than one wallet row; fix it before adjusting" }
    case "NOT_ADMIN":
      return { status: 403, error: "Admin access required" }
    case "SELF_ADJUST":
      return { status: 403, error: "You cannot adjust your own wallet; ask another admin" }
    case "BAD_INPUT":
      return { status: 400, error: detail || "Invalid input" }
    default:
      return { status: 500, error: "Failed to update balance" }
  }
}
