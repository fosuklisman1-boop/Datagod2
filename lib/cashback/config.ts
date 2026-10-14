import type { SupabaseClient } from "@supabase/supabase-js"
import { isServiceKey } from "../hubtel-cs/services"

export const CASHBACK_CONFIG_KEY = "commission_cashback_config"

export const CASHBACK_CHANNELS = ["dashboard", "bots", "storefront", "api"] as const
/** Surfaces that may be switched on. bots stays off until a later part wires its pricing. */
export const SUPPORTED_SURFACES = ["dashboard", "storefront", "api"] as const
export const CASHBACK_GROUPS = ["airtime", "bundles", "bills"] as const
export const CASHBACK_PROVIDERS = ["hubtel", "digiwapy"] as const
export const SHARE_FIELDS = ["customer", "dealer", "storefrontCustomer", "storefrontShop"] as const

export type CashbackChannel = (typeof CASHBACK_CHANNELS)[number]
export type CashbackGroup = (typeof CASHBACK_GROUPS)[number]
export type CashbackProvider = (typeof CASHBACK_PROVIDERS)[number]
export type ShareField = (typeof SHARE_FIELDS)[number]

export const MAX_RATE = 20
export const MAX_SHARE = 100
export const MAX_PAYMENT_FEE = 10

export interface GroupShares { customer: number; dealer: number; storefrontCustomer: number; storefrontShop: number }
export interface CashbackConfig {
  enabled: boolean
  surfaces: Record<CashbackChannel, boolean>
  rates: Record<string, number> // "<serviceKey>:<provider>" -> %
  shares: Record<CashbackGroup, GroupShares> & { overrides: Record<string, Partial<GroupShares>> }
  /** Storefront payment-fee percentage per group (0-10, 2 dp). */
  paymentFee: Record<CashbackGroup, number>
  /** Per-group storefront switch. */
  storefrontGroups: Record<CashbackGroup, boolean>
}
/** Patch shape: top-level keys replace; surfaces / rates / shares merge one level (as the 0119 RPC does). */
export interface CashbackPatch {
  enabled?: boolean
  surfaces?: Partial<Record<CashbackChannel, boolean>>
  rates?: Record<string, number>
  shares?: Partial<Record<CashbackGroup, GroupShares>> & { overrides?: Record<string, Partial<GroupShares>> }
  paymentFee?: Partial<Record<CashbackGroup, number>>
  storefrontGroups?: Partial<Record<CashbackGroup, boolean>>
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const RATE_KEY_RE = /^(airtime|data|bill)_[a-z_]+:(hubtel|digiwapy)$/

export function groupOf(serviceKey: string): CashbackGroup | null {
  if (typeof serviceKey !== "string") return null
  if (serviceKey.startsWith("airtime_")) return "airtime"
  if (serviceKey.startsWith("data_")) return "bundles"
  if (serviceKey.startsWith("bill_")) return "bills"
  return null
}

const hasMaxDecimals = (v: number, dp: number): boolean => {
  const f = 10 ** dp
  return Math.abs(Math.round(v * f) - v * f) < 1e-6
}
const validRate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_RATE && hasMaxDecimals(v, 3)
const validShare = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_SHARE && hasMaxDecimals(v, 2)

/** True when `key` is "<knownServiceKey>:<provider>". */
export function isValidRateKey(key: string): boolean {
  if (!RATE_KEY_RE.test(key)) return false
  return isServiceKey(key.split(":")[0])
}

const validFee = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_PAYMENT_FEE && hasMaxDecimals(v, 2)

const zeroShares =(): GroupShares => ({ customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 })

export function resolveCashbackConfig(raw: unknown): CashbackConfig {
  const r = isObj(raw) ? raw : {}
  const surfaces = {} as Record<CashbackChannel, boolean>
  for (const c of CASHBACK_CHANNELS) surfaces[c] = isObj(r.surfaces) && r.surfaces[c] === true

  const rates: Record<string, number> = {}
  if (isObj(r.rates)) {
    for (const [k, v] of Object.entries(r.rates)) {
      if (!isValidRateKey(k)) continue
      rates[k] = validRate(v) ? v : 0
    }
  }

  const sh = isObj(r.shares) ? r.shares : {}
  const shares = {} as CashbackConfig["shares"]
  for (const g of CASHBACK_GROUPS) {
    const s = isObj(sh[g]) ? sh[g] : {}
    const out = zeroShares()
    for (const f of SHARE_FIELDS) out[f] = validShare(s[f]) ? s[f] : 0
    shares[g] = out
  }
  const overrides: Record<string, Partial<GroupShares>> = {}
  if (isObj(sh.overrides)) {
    for (const [k, v] of Object.entries(sh.overrides)) {
      if (!isServiceKey(k) || !isObj(v)) continue
      const o: Partial<GroupShares> = {}
      for (const f of SHARE_FIELDS) if (f in v) o[f] = validShare(v[f]) ? v[f] : 0
      overrides[k] = o
    }
  }
  shares.overrides = overrides
  const paymentFee = {} as Record<CashbackGroup, number>
  const storefrontGroups = {} as Record<CashbackGroup, boolean>
  for (const g of CASHBACK_GROUPS) {
    paymentFee[g] = isObj(r.paymentFee) && validFee(r.paymentFee[g]) ? r.paymentFee[g] : 0
    storefrontGroups[g] = isObj(r.storefrontGroups) && r.storefrontGroups[g] === true
  }
  return { enabled: r.enabled === true, surfaces, rates, shares, paymentFee, storefrontGroups }
}

export function effectiveShares(cfg: CashbackConfig, serviceKey: string): GroupShares {
  const g = groupOf(serviceKey)
  if (!g) return zeroShares()
  const base = cfg.shares[g]
  const o = cfg.shares.overrides?.[serviceKey]
  return o ? { ...base, ...o } : { ...base }
}

/** Merge a (validated) patch onto a config exactly like the 0119 RPC; overrides merge per service key. */
export function mergeCashbackPatch(current: CashbackConfig, patch: CashbackPatch): CashbackConfig {
  const { overrides: patchOverrides, ...patchGroups } = patch.shares ?? {}
  const overrides: Record<string, Partial<GroupShares>> = { ...current.shares.overrides }
  for (const [k, v] of Object.entries(patchOverrides ?? {})) overrides[k] = { ...(overrides[k] ?? {}), ...v }
  return {
    enabled: patch.enabled ?? current.enabled,
    surfaces: { ...current.surfaces, ...(patch.surfaces ?? {}) },
    rates: { ...current.rates, ...(patch.rates ?? {}) },
    shares: { ...current.shares, ...patchGroups, overrides } as CashbackConfig["shares"],
    paymentFee: { ...current.paymentFee, ...(patch.paymentFee ?? {}) },
    storefrontGroups: { ...current.storefrontGroups, ...(patch.storefrontGroups ?? {}) },
  }
}

const storefrontSumOk = (s: Partial<GroupShares>): boolean =>
  (s.storefrontCustomer ?? 0) + (s.storefrontShop ?? 0) <= MAX_SHARE + 1e-9

function validateShareObject(label: string, v: unknown, requireAll: boolean): string | null {
  if (!isObj(v)) return `${label} must be an object`
  for (const k of Object.keys(v)) if (!(SHARE_FIELDS as readonly string[]).includes(k)) return `${label}: unknown field ${k}`
  for (const f of SHARE_FIELDS) {
    if (!(f in v)) {
      if (requireAll) return `${label}.${f} is required`
      continue
    }
    if (!validShare(v[f])) return `${label}.${f} must be a number from 0 to ${MAX_SHARE} with at most 2 decimals`
  }
  return null
}

/**
 * Validate a patch body against the current config. Group shares must be sent complete (the RPC replaces a
 * group's object wholesale). The merged result (current + patch) must satisfy storefrontCustomer +
 * storefrontShop <= 100 for every group and every group+override combination.
 */
export function validateCashbackPatch(
  body: unknown,
  current: CashbackConfig,
): { ok: true; patch: CashbackPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" }
  const allowed = new Set(["enabled", "surfaces", "rates", "shares", "paymentFee", "storefrontGroups"])
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: `Unknown field ${k}` }
  const patch: CashbackPatch = {}

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" }
    patch.enabled = body.enabled
  }
  if ("surfaces" in body) {
    if (!isObj(body.surfaces)) return { ok: false, error: "surfaces must be an object" }
    const out: Partial<Record<CashbackChannel, boolean>> = {}
    for (const [k, v] of Object.entries(body.surfaces)) {
      if (!(CASHBACK_CHANNELS as readonly string[]).includes(k)) return { ok: false, error: `Unknown surface ${k}` }
      if (typeof v !== "boolean") return { ok: false, error: `surfaces.${k} must be true or false` }
      if (v && !(SUPPORTED_SURFACES as readonly string[]).includes(k)) {
        return { ok: false, error: `surfaces.${k} cannot be enabled yet: only the dashboard, storefront and api surfaces are supported` }
      }
      out[k as CashbackChannel] = v
    }
    patch.surfaces = out
  }
  if ("rates" in body) {
    if (!isObj(body.rates)) return { ok: false, error: "rates must be an object" }
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(body.rates)) {
      if (!isValidRateKey(k)) return { ok: false, error: `Unknown rate key ${k}` }
      if (!validRate(v)) return { ok: false, error: `rates.${k} must be a number from 0 to ${MAX_RATE} with at most 3 decimals` }
      out[k] = v
    }
    patch.rates = out
  }
  if ("paymentFee" in body) {
    if (!isObj(body.paymentFee)) return { ok: false, error: "paymentFee must be an object" }
    const out: Partial<Record<CashbackGroup, number>> = {}
    for (const [k, v] of Object.entries(body.paymentFee)) {
      if (!(CASHBACK_GROUPS as readonly string[]).includes(k)) return { ok: false, error: `Unknown paymentFee group ${k}` }
      if (!validFee(v)) return { ok: false, error: `paymentFee.${k} must be a number from 0 to ${MAX_PAYMENT_FEE} with at most 2 decimals` }
      out[k as CashbackGroup] = v
    }
    patch.paymentFee = out
  }
  if ("storefrontGroups" in body) {
    if (!isObj(body.storefrontGroups)) return { ok: false, error: "storefrontGroups must be an object" }
    const out: Partial<Record<CashbackGroup, boolean>> = {}
    for (const [k, v] of Object.entries(body.storefrontGroups)) {
      if (!(CASHBACK_GROUPS as readonly string[]).includes(k)) return { ok: false, error: `Unknown storefrontGroups group ${k}` }
      if (typeof v !== "boolean") return { ok: false, error: `storefrontGroups.${k} must be true or false` }
      out[k as CashbackGroup] = v
    }
    patch.storefrontGroups = out
  }
  if ("shares" in body) {
    if (!isObj(body.shares)) return { ok: false, error: "shares must be an object" }
    const out: NonNullable<CashbackPatch["shares"]> = {}
    for (const [k, v] of Object.entries(body.shares)) {
      if (k === "overrides") {
        if (!isObj(v)) return { ok: false, error: "shares.overrides must be an object" }
        const ov: Record<string, Partial<GroupShares>> = {}
        for (const [sk, sv] of Object.entries(v)) {
          if (!isServiceKey(sk)) return { ok: false, error: `Unknown service key ${sk}` }
          const err = validateShareObject(`shares.overrides.${sk}`, sv, false)
          if (err) return { ok: false, error: err }
          ov[sk] = { ...(sv as Partial<GroupShares>) }
        }
        out.overrides = ov
      } else if ((CASHBACK_GROUPS as readonly string[]).includes(k)) {
        const err = validateShareObject(`shares.${k}`, v, true)
        if (err) return { ok: false, error: err }
        out[k as CashbackGroup] = { ...(v as GroupShares) }
      } else {
        return { ok: false, error: `Unknown shares field ${k}` }
      }
    }
    patch.shares = out
  }

  // Merged-result invariant. Check the per-key-merged overrides AND the wholesale-replaced overrides,
  // since the RPC replaces shares.overrides as a unit while the documented model merges per key.
  const merged = mergeCashbackPatch(current, patch)
  const replacedOverrides = patch.shares?.overrides ?? merged.shares.overrides
  for (const overrides of [merged.shares.overrides, replacedOverrides]) {
    for (const g of CASHBACK_GROUPS) {
      if (!storefrontSumOk(merged.shares[g])) {
        return { ok: false, error: `shares.${g}: storefrontCustomer + storefrontShop must not exceed ${MAX_SHARE}` }
      }
    }
    for (const [sk, o] of Object.entries(overrides)) {
      const g = groupOf(sk)
      if (!g) continue
      if (!storefrontSumOk({ ...merged.shares[g], ...o })) {
        return { ok: false, error: `shares.overrides.${sk}: storefrontCustomer + storefrontShop must not exceed ${MAX_SHARE}` }
      }
    }
  }
  return { ok: true, patch }
}

export async function getCashbackConfig(db: SupabaseClient): Promise<CashbackConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", CASHBACK_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveCashbackConfig(data?.value)
}

/**
 * The RPC replaces `shares` sub-objects wholesale, so a shares patch is sent as the fully merged `shares`
 * (current ⊕ patch, the same merge the validator checked) — a partial group or override can never wipe stored values.
 */
export async function setCashbackConfig(db: SupabaseClient, patch: CashbackPatch, current: CashbackConfig): Promise<CashbackConfig> {
  const merged = mergeCashbackPatch(current, patch)
  const toSend: CashbackPatch = { ...patch }
  if (patch.shares) toSend.shares = merged.shares
  if (patch.paymentFee) toSend.paymentFee = merged.paymentFee
  if (patch.storefrontGroups) toSend.storefrontGroups = merged.storefrontGroups
  const { data, error } = await db.rpc("commission_cashback_config_patch", { p_patch: toSend })
  if (error) throw error
  return resolveCashbackConfig(data)
}
