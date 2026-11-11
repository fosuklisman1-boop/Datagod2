import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * Send & Claim settings loader + strict phone-verification gate.
 * Server-only. Never logs setting values.
 */

export type MomoClaimSettings = {
  enabled: boolean
  accounts: { network: string; number: string }[]
  accountName: string
  feeCustomerPercent: number
  feeDealerPercent: number
  minNetPesewas: number
  maxSentPesewas: number
  senderAllowlist: string[]
  regressionThreshold: number
  reviewThresholdPesewas: number
  dailyCapPesewas: number
  /** "defaults" when the DB read failed or threw, so callers can tell fallback values from saved ones. */
  source: "db" | "defaults"
}

const KEYS = [
  "momo_claim_enabled",
  "momo_payment_accounts",
  "momo_account_name",
  "momo_claim_fee_customer",
  "momo_claim_fee_dealer",
  "momo_min_claimable",
  "momo_max_claimable",
  "momo_sms_sender_allowlist",
  "momo_txid_regression_threshold",
  "momo_auto_claim_review_threshold",
  "momo_auto_claim_daily_cap",
] as const

const DEFAULTS: MomoClaimSettings = {
  enabled: false,
  accounts: [],
  accountName: "",
  feeCustomerPercent: 0,
  feeDealerPercent: 0,
  minNetPesewas: 1000,
  maxSentPesewas: 200000,
  senderAllowlist: ["MobileMoney"],
  regressionThreshold: 1000000,
  reviewThresholdPesewas: 50000,
  dailyCapPesewas: 300000,
  source: "defaults",
}

function defaults(): MomoClaimSettings {
  return {
    ...DEFAULTS,
    accounts: [],
    senderAllowlist: [...DEFAULTS.senderAllowlist],
  }
}

function isValidNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0
}

function pesewas(x: unknown, fallback: number): number {
  return isValidNumber(x) ? Math.round(x * 100) : fallback
}

function plainNumber(x: unknown, fallback: number): number {
  return isValidNumber(x) ? x : fallback
}

function percent(x: unknown): number {
  return isValidNumber(x) && x <= 100 ? x : 0
}

export async function loadMomoClaimSettings(client: SupabaseClient): Promise<MomoClaimSettings> {
  try {
    const { data, error } = await client
      .from("admin_settings")
      .select("key, value")
      .in("key", [...KEYS])
    if (error || !Array.isArray(data)) return defaults()

    const raw: Record<string, unknown> = {}
    for (const row of data as { key: string; value: unknown }[]) {
      const val = row?.value
      raw[row?.key] =
        val && typeof val === "object" && !Array.isArray(val) ? (val as { value?: unknown }).value : undefined
    }

    const d = defaults()

    const accounts = Array.isArray(raw.momo_payment_accounts)
      ? (raw.momo_payment_accounts as unknown[]).flatMap((a) => {
          if (!a || typeof a !== "object") return []
          const { network, number } = a as { network?: unknown; number?: unknown }
          return typeof network === "string" && typeof number === "string" ? [{ network, number }] : []
        })
      : []

    const allow = Array.isArray(raw.momo_sms_sender_allowlist)
      ? (raw.momo_sms_sender_allowlist as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : []

    return {
      enabled: raw.momo_claim_enabled === true,
      accounts,
      accountName: typeof raw.momo_account_name === "string" ? raw.momo_account_name : d.accountName,
      feeCustomerPercent: percent(raw.momo_claim_fee_customer),
      feeDealerPercent: percent(raw.momo_claim_fee_dealer),
      minNetPesewas: pesewas(raw.momo_min_claimable, d.minNetPesewas),
      maxSentPesewas: pesewas(raw.momo_max_claimable, d.maxSentPesewas),
      senderAllowlist: allow.length > 0 ? allow : d.senderAllowlist,
      regressionThreshold: plainNumber(raw.momo_txid_regression_threshold, d.regressionThreshold),
      reviewThresholdPesewas: pesewas(raw.momo_auto_claim_review_threshold, d.reviewThresholdPesewas),
      dailyCapPesewas: pesewas(raw.momo_auto_claim_daily_cap, d.dailyCapPesewas),
      source: "db",
    }
  } catch {
    return defaults()
  }
}

/**
 * Strict check: public.users.phone_verified must be exactly true. Deliberately
 * ignores the phone-gate grace period and kill switch. Any error -> false.
 */
export async function isStrictlyPhoneVerified(client: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await client
      .from("users")
      .select("phone_verified")
      .eq("id", userId)
      .maybeSingle()
    if (error || !data) return false
    return (data as { phone_verified?: unknown }).phone_verified === true
  } catch {
    return false
  }
}
