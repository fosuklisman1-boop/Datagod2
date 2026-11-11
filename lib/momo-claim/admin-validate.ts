// Pure validation for the Send & Claim admin settings save. No I/O, never logs values.

export const NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const

export type SettingsInput = {
  enabled: boolean
  accounts: { network: (typeof NETWORKS)[number]; number: string }[]
  accountName: string
  feeCustomerPercent: number
  feeDealerPercent: number
  minNet: number
  maxSent: number
  senderAllowlist: string[]
  regressionThreshold: number
  reviewThreshold: number
  dailyCap: number
}

export type ValidationResult = { ok: true; value: SettingsInput } | { ok: false; field: string; error?: string }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when x has at most 2 decimal places (tolerates float noise). */
export function hasAtMostTwoDecimals(x: number): boolean {
  return Math.abs(Math.round(x * 100) - x * 100) < 1e-6
}

export function validateSettings(body: unknown): ValidationResult {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const bad = (field: string): ValidationResult => ({ ok: false, field })

  if (typeof b.enabled !== "boolean") return bad("enabled")

  if (!Array.isArray(b.accounts)) return bad("accounts")
  const accounts: SettingsInput["accounts"] = []
  for (const a of b.accounts) {
    const r = (a && typeof a === "object" ? a : {}) as Record<string, unknown>
    if (typeof r.network !== "string" || !(NETWORKS as readonly string[]).includes(r.network)) return bad("accounts")
    if (typeof r.number !== "string" || !/^0[0-9]{9}$/.test(r.number)) return bad("accounts")
    accounts.push({ network: r.network as (typeof NETWORKS)[number], number: r.number })
  }

  if (b.enabled && !accounts.some((a) => a.network === "MTN")) {
    return { ok: false, field: "accounts", error: "mtn_account_required" }
  }

  if (typeof b.accountName !== "string" || b.accountName.length > 80) return bad("accountName")

  if (!isNum(b.feeCustomerPercent) || b.feeCustomerPercent < 0 || b.feeCustomerPercent > 100) return bad("feeCustomerPercent")
  if (!isNum(b.feeDealerPercent) || b.feeDealerPercent < 0 || b.feeDealerPercent > 100) return bad("feeDealerPercent")

  if (!isNum(b.minNet) || b.minNet < 0 || !hasAtMostTwoDecimals(b.minNet)) return bad("minNet")
  if (!isNum(b.maxSent) || b.maxSent < b.minNet || !hasAtMostTwoDecimals(b.maxSent)) return bad("maxSent")

  if (!Array.isArray(b.senderAllowlist) || b.senderAllowlist.length === 0) return bad("senderAllowlist")
  const allow: string[] = []
  for (const s of b.senderAllowlist) {
    if (typeof s !== "string") return bad("senderAllowlist")
    const t = s.trim()
    if (t.length === 0 || t.length > 40) return bad("senderAllowlist")
    allow.push(t)
  }

  if (!isNum(b.regressionThreshold) || !Number.isInteger(b.regressionThreshold) || b.regressionThreshold < 0) {
    return bad("regressionThreshold")
  }
  if (!isNum(b.reviewThreshold) || b.reviewThreshold < 0 || !hasAtMostTwoDecimals(b.reviewThreshold)) return bad("reviewThreshold")
  if (!isNum(b.dailyCap) || b.dailyCap < 0 || !hasAtMostTwoDecimals(b.dailyCap)) return bad("dailyCap")

  return {
    ok: true,
    value: {
      enabled: b.enabled,
      accounts,
      accountName: b.accountName,
      feeCustomerPercent: b.feeCustomerPercent,
      feeDealerPercent: b.feeDealerPercent,
      minNet: b.minNet,
      maxSent: b.maxSent,
      senderAllowlist: allow,
      regressionThreshold: b.regressionThreshold,
      reviewThreshold: b.reviewThreshold,
      dailyCap: b.dailyCap,
    },
  }
}
