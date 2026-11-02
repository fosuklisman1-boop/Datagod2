// Activity and risk signals for the admin users page: the thresholds, and the pure rules that turn the counts
// from public.admin_user_signals (migrations/0149_admin_user_notes_tags.sql) into explainable flags.
// The database only counts, over the windows passed from here; every threshold lives in this file.

export const RISK_THRESHOLDS = {
  /** Failed (status failed / error) orders across all order tables in the window. */
  failedOrdersWindowHours: 24,
  failedOrdersMin: 5,
  /** Refund transactions credited to the wallet in the window. */
  refundsWindowHours: 24 * 7,
  refundsMin: 3,
  /** Wallet credits made by an admin (admin_audit_log 'wallet_credit') in the window. */
  adminCreditWindowHours: 24,
  adminCreditsMin: 1,
  /** An account younger than this with at least this much in the wallet (GHS). */
  newAccountHours: 24,
  newAccountBalanceMin: 500,
  /** Accounts (this one included) with the same phone number in any stored form. */
  sharedPhoneAccountsMin: 3,
} as const

export type RiskThresholds = { [K in keyof typeof RISK_THRESHOLDS]: number }

export type RiskFlagCode = "failed_orders" | "refunds" | "admin_credit" | "new_account_high_balance" | "shared_phone"

export interface RiskFlag {
  code: RiskFlagCode
  /** Plain sentence for the tooltip, with the numbers that triggered it. */
  reason: string
}

/** One user's object from admin_user_signals. Counts stop at 50 per table (see the migration). */
export interface RawUserSignals {
  last_order_at: string | null
  failed_orders: number
  refunds: number
  admin_credits: number
  admin_credit_amount: number
  created_at: string | null
  wallet_balance: number
  phone_number: string | null
  phone_verified: boolean
  same_phone_accounts: number
}

/** What the list and the drawer show. */
export interface UserSignalsView {
  lastOrderAt: string | null
  phoneVerified: boolean
  phoneBlacklisted: boolean
  flags: RiskFlag[]
}

/** Arguments for admin_user_signals: the ids, and the windows from RISK_THRESHOLDS. */
export function signalsRpcArgs(ids: string[], t: RiskThresholds = RISK_THRESHOLDS) {
  return {
    p_user_ids: ids,
    p_failed_hours: t.failedOrdersWindowHours,
    p_refund_hours: t.refundsWindowHours,
    p_credit_hours: t.adminCreditWindowHours,
  }
}

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown) => (typeof v === "string" && v ? v : null)

/** Shape check for admin_user_signals' jsonb result: {"<id>": {...}}. Throws on anything that is not an object. */
export function parseSignalsResult(data: unknown): Map<string, RawUserSignals> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("admin_user_signals returned bad data")
  const out = new Map<string, RawUserSignals>()
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue
    const r = v as Record<string, unknown>
    out.set(id, {
      last_order_at: str(r.last_order_at),
      failed_orders: num(r.failed_orders),
      refunds: num(r.refunds),
      admin_credits: num(r.admin_credits),
      admin_credit_amount: num(r.admin_credit_amount),
      created_at: str(r.created_at),
      wallet_balance: num(r.wallet_balance),
      phone_number: str(r.phone_number),
      phone_verified: r.phone_verified === true,
      same_phone_accounts: num(r.same_phone_accounts),
    })
  }
  return out
}

const HOUR_MS = 3_600_000
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const windowText = (hours: number) => (hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : plural(hours, "hour"))

/** The flags for one user. `now` is a parameter so the rules are testable. */
export function computeRiskFlags(s: RawUserSignals, now: number = Date.now(), t: RiskThresholds = RISK_THRESHOLDS): RiskFlag[] {
  const flags: RiskFlag[] = []
  if (s.failed_orders >= t.failedOrdersMin) {
    flags.push({ code: "failed_orders", reason: `${plural(s.failed_orders, "failed order")} in the last ${windowText(t.failedOrdersWindowHours)} (flag at ${t.failedOrdersMin})` })
  }
  if (s.refunds >= t.refundsMin) {
    flags.push({ code: "refunds", reason: `${plural(s.refunds, "refund")} in the last ${windowText(t.refundsWindowHours)} (flag at ${t.refundsMin})` })
  }
  if (s.admin_credits >= t.adminCreditsMin) {
    flags.push({
      code: "admin_credit",
      reason: `Wallet credited by an admin ${s.admin_credits === 1 ? "once" : `${s.admin_credits} times`} in the last ${windowText(t.adminCreditWindowHours)}` +
        (s.admin_credit_amount > 0 ? ` (GHS ${s.admin_credit_amount.toFixed(2)})` : ""),
    })
  }
  const created = s.created_at ? Date.parse(s.created_at) : NaN
  if (Number.isFinite(created)) {
    const ageHours = (now - created) / HOUR_MS
    if (ageHours >= 0 && ageHours < t.newAccountHours && s.wallet_balance >= t.newAccountBalanceMin) {
      flags.push({
        code: "new_account_high_balance",
        reason: `Account is ${ageHours < 1 ? "under an hour" : plural(Math.floor(ageHours), "hour")} old with GHS ${s.wallet_balance.toFixed(2)} in the wallet (flag at GHS ${t.newAccountBalanceMin} within ${windowText(t.newAccountHours)})`,
      })
    }
  }
  if (s.same_phone_accounts >= t.sharedPhoneAccountsMin) {
    flags.push({ code: "shared_phone", reason: `${s.same_phone_accounts} accounts use the phone number ${s.phone_number ?? ""} (flag at ${t.sharedPhoneAccountsMin})`.replace("  ", " ") })
  }
  return flags
}

export function toSignalsView(s: RawUserSignals | undefined, phoneBlacklisted: boolean, now: number = Date.now()): UserSignalsView | null {
  if (!s) return null
  return { lastOrderAt: s.last_order_at, phoneVerified: s.phone_verified, phoneBlacklisted, flags: computeRiskFlags(s, now) }
}
