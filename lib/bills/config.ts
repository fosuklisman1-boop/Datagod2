import type { SupabaseClient } from "@supabase/supabase-js"
import { BILLER_KEYS, type BillerKey } from "./billers"

export const BILLS_CONFIG_KEY = "utility_bills_config"
export const BILL_LIMIT_FLOOR = 1
export const BILL_LIMIT_CEIL = 10000
export const BILL_DEFAULT_MIN = 5
export const BILL_DEFAULT_MAX = 10000

export interface BillerSetting { enabled: boolean; min: number; max: number }
export interface BillsConfig { enabled: boolean; autoFulfil: boolean; billers: Record<BillerKey, BillerSetting> }
export interface BillsPatch { enabled?: boolean; autoFulfil?: boolean; billers?: Partial<Record<BillerKey, BillerSetting>> }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const validLimits = (min: unknown, max: unknown): min is number =>
  typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) &&
  min >= BILL_LIMIT_FLOOR && max <= BILL_LIMIT_CEIL && min <= max

export function resolveBillsConfig(raw: unknown): BillsConfig {
  const r = isObj(raw) ? raw : {}
  const billers = {} as Record<BillerKey, BillerSetting>
  for (const k of BILLER_KEYS) {
    const b = isObj(r.billers) && isObj(r.billers[k]) ? r.billers[k] : {}
    const ok = validLimits(b.min, b.max)
    billers[k] = { enabled: b.enabled === true, min: ok ? b.min : BILL_DEFAULT_MIN, max: ok ? (b.max as number) : BILL_DEFAULT_MAX }
  }
  return { enabled: r.enabled === true, autoFulfil: r.autoFulfil !== false, billers }
}

export function validateBillsPatch(body: unknown): { ok: true; patch: BillsPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" }
  const allowed = new Set(["enabled", "autoFulfil", "billers"])
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: `Unknown field ${k}` }
  const patch: BillsPatch = {}
  for (const k of ["enabled", "autoFulfil"] as const) {
    if (k in body) {
      if (typeof body[k] !== "boolean") return { ok: false, error: `${k} must be true or false` }
      patch[k] = body[k]
    }
  }
  if ("billers" in body) {
    if (!isObj(body.billers)) return { ok: false, error: "billers must be an object" }
    const out: Partial<Record<BillerKey, BillerSetting>> = {}
    for (const [k, v] of Object.entries(body.billers)) {
      if (!(BILLER_KEYS as readonly string[]).includes(k)) return { ok: false, error: `Unknown biller ${k}` }
      if (!isObj(v) || typeof v.enabled !== "boolean" || !validLimits(v.min, v.max)) {
        return { ok: false, error: `${k}: send enabled, min and max with ${BILL_LIMIT_FLOOR} ≤ min ≤ max ≤ ${BILL_LIMIT_CEIL}` }
      }
      out[k as BillerKey] = { enabled: v.enabled, min: v.min, max: v.max }
    }
    patch.billers = out
  }
  return { ok: true, patch }
}

export function checkBillAmount(s: BillerSetting, amount: number): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return "Enter a valid amount"
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) return "Amount can have at most 2 decimal places"
  if (amount < s.min) return `Amount must be at least GHS ${s.min.toFixed(2)}`
  if (amount > s.max) return `Amount must be at most GHS ${s.max.toFixed(2)}`
  return null
}

export async function getBillsConfig(db: SupabaseClient): Promise<BillsConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", BILLS_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveBillsConfig(data?.value)
}

export async function setBillsConfig(db: SupabaseClient, patch: BillsPatch): Promise<BillsConfig> {
  const { data, error } = await db.rpc("utility_bills_config_patch", { p_patch: patch })
  if (error) throw error
  return resolveBillsConfig(data)
}
