import type { SupabaseClient } from "@supabase/supabase-js"

export type RetryBucket =
  | "rate_limited"
  | "out_of_balance"
  | "supplier_unavailable"
  | "not_enabled"
  | "no_bundle"
  | "wrong_number"
  | "rejected"

export type RetryRule = { retry: boolean; waitMinutes: number; maxTries: number }

export type AutoFulfilSettings = {
  enabled: boolean
  minAgeMinutes: number
  maxAgeDays: number
  perRun: number
  networks: string[]
  rules: Record<RetryBucket, RetryRule>
}

export const AUTO_FULFIL_SETTINGS_KEY = "auto_fulfil_pending"
export const AUTO_FULFIL_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

const BUCKETS: RetryBucket[] = [
  "rate_limited",
  "out_of_balance",
  "supplier_unavailable",
  "not_enabled",
  "no_bundle",
  "wrong_number",
  "rejected",
]

const BOUNDS = {
  minAgeMinutes: [10, 120],
  maxAgeDays: [1, 30],
  perRun: [1, 100],
  waitMinutes: [1, 10080],
  maxTries: [1, 20],
} as const

export const DEFAULT_AUTO_FULFIL_SETTINGS: AutoFulfilSettings = {
  enabled: false,
  minAgeMinutes: 10,
  maxAgeDays: 7,
  perRun: 20,
  networks: [...AUTO_FULFIL_NETWORKS],
  rules: {
    rate_limited: { retry: true, waitMinutes: 2, maxTries: 5 },
    out_of_balance: { retry: true, waitMinutes: 30, maxTries: 5 },
    supplier_unavailable: { retry: true, waitMinutes: 30, maxTries: 5 },
    not_enabled: { retry: true, waitMinutes: 1440, maxTries: 3 },
    // Never retried; the numbers are in-bounds placeholders so every rule validates the same way.
    no_bundle: { retry: false, waitMinutes: 60, maxTries: 1 },
    wrong_number: { retry: false, waitMinutes: 60, maxTries: 1 },
    rejected: { retry: true, waitMinutes: 60, maxTries: 3 },
  },
}

type Parsed = { ok: true; value: AutoFulfilSettings } | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function intIn(v: unknown, [min, max]: readonly [number, number]): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
}

export function parseAutoFulfilSettings(raw: unknown): Parsed {
  if (!isObj(raw)) return { ok: false, error: "settings must be an object" }
  if (typeof raw.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" }
  if (!intIn(raw.minAgeMinutes, BOUNDS.minAgeMinutes)) return { ok: false, error: "minAgeMinutes must be a whole number from 10 to 120" }
  if (!intIn(raw.maxAgeDays, BOUNDS.maxAgeDays)) return { ok: false, error: "maxAgeDays must be a whole number from 1 to 30" }
  if (!intIn(raw.perRun, BOUNDS.perRun)) return { ok: false, error: "perRun must be a whole number from 1 to 100" }

  const nets = raw.networks
  if (!Array.isArray(nets) || nets.length === 0) return { ok: false, error: "networks must be a non-empty list" }
  if (!nets.every((n) => typeof n === "string" && AUTO_FULFIL_NETWORKS.includes(n))) {
    return { ok: false, error: "networks contains an unsupported network" }
  }

  if (!isObj(raw.rules)) return { ok: false, error: "rules must be an object" }
  const rules = {} as Record<RetryBucket, RetryRule>
  for (const b of BUCKETS) {
    const r = raw.rules[b]
    if (!isObj(r)) return { ok: false, error: `rule ${b} is missing` }
    if (typeof r.retry !== "boolean") return { ok: false, error: `rule ${b}: retry must be true or false` }
    if (!intIn(r.waitMinutes, BOUNDS.waitMinutes)) return { ok: false, error: `rule ${b}: wait must be 1 to 10080 minutes` }
    if (!intIn(r.maxTries, BOUNDS.maxTries)) return { ok: false, error: `rule ${b}: tries must be 1 to 20` }
    rules[b] = { retry: r.retry, waitMinutes: r.waitMinutes, maxTries: r.maxTries }
  }

  return {
    ok: true,
    value: {
      enabled: raw.enabled,
      minAgeMinutes: raw.minAgeMinutes,
      maxAgeDays: raw.maxAgeDays,
      perRun: raw.perRun,
      networks: Array.from(new Set(nets as string[])),
      rules,
    },
  }
}

/** Fails closed: an unreadable or invalid row means off. A missing row means the (off) defaults. */
export async function loadAutoFulfilSettings(
  db: SupabaseClient,
): Promise<{ settings: AutoFulfilSettings; valid: boolean }> {
  const off = { ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: false }
  try {
    const { data, error } = await db
      .from("admin_settings")
      .select("value")
      .eq("key", AUTO_FULFIL_SETTINGS_KEY)
      .maybeSingle()
    if (error) return { settings: off, valid: false }
    if (!data) return { settings: DEFAULT_AUTO_FULFIL_SETTINGS, valid: true }
    const parsed = parseAutoFulfilSettings((data as { value: unknown }).value)
    if (!parsed.ok) return { settings: off, valid: false }
    return { settings: parsed.value, valid: true }
  } catch {
    return { settings: off, valid: false }
  }
}
