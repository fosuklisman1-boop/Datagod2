import type { SupabaseClient } from "@supabase/supabase-js"
import { isValidGhanaMobile } from "../phone-format"
import { BUNDLE_NETWORKS, type BundleNetwork } from "./categories"

export const BUNDLES_CONFIG_KEY = "standard_bundles_config"
export const MAX_HIDDEN_CATEGORIES = 20
export const MAX_CATEGORY_LENGTH = 40

// Hubtel's documented sample numbers, used as the default reference number.
export const DEFAULT_REFERENCE_NUMBERS: Record<BundleNetwork, string> = {
  MTN: "233246912184",
  TELECEL: "233206439599",
  AT: "233273833933",
}

export interface NetworkSetting { enabled: boolean; hiddenCategories: string[]; referenceNumber: string }
/** `unitValue` is the exact Hubtel catalog Value of the unit bundle (e.g. RACT_Data_GHC_3_Others). */
export interface SpecialSetting { enabled: boolean; multiples: number[]; unitAmount: number; unitValue: string }
export interface BundlesConfig { enabled: boolean; networks: Record<BundleNetwork, NetworkSetting>; special: SpecialSetting }
// `special` is replaced whole by the config RPC (top-level shallow merge), so a patch always carries all four fields.
export interface BundlesPatch { enabled?: boolean; networks?: Partial<Record<BundleNetwork, NetworkSetting>>; special?: SpecialSetting }

export const SPECIAL_MAX_MULTIPLES = 10
// 20, not the 0141 RPC's outer bound of 50: N children are dispatched one after another inside a 240s budget.
export const SPECIAL_MAX_MULTIPLE = 20
export const SPECIAL_MAX_UNIT_VALUE_LENGTH = 80
export const DEFAULT_SPECIAL_UNIT_VALUE = "RACT_Data_GHC_3_Others"
export const DEFAULT_SPECIAL: SpecialSetting = {
  enabled: false, multiples: [3, 5, 8, 10, 15], unitAmount: 3, unitValue: DEFAULT_SPECIAL_UNIT_VALUE,
}

const UNIT_VALUE_RE = /^[A-Za-z0-9_-]+$/
const validUnitValue = (v: unknown): v is string =>
  typeof v === "string" && v.length <= SPECIAL_MAX_UNIT_VALUE_LENGTH && UNIT_VALUE_RE.test(v)

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

/** Distinct integers 1..SPECIAL_MAX_MULTIPLE (20), at most 10, returned sorted. Null when the shape is invalid. */
function cleanMultiples(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null
  if (!v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SPECIAL_MAX_MULTIPLE)) return null
  const out = [...new Set(v as number[])].sort((a, b) => a - b)
  return out.length >= 1 && out.length <= SPECIAL_MAX_MULTIPLES ? out : null
}

/** Positive, finite, at most 2 decimal places. */
const validUnitAmount = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && Math.abs(Math.round(v * 100) - v * 100) < 1e-9

function cleanSpecial(v: unknown): SpecialSetting | null {
  if (!isObj(v) || typeof v.enabled !== "boolean") return null
  const multiples = cleanMultiples(v.multiples)
  if (!multiples || !validUnitAmount(v.unitAmount)) return null
  // A stored special from before unitValue existed gets the default; a present but invalid one is invalid.
  const unitValue = v.unitValue === undefined ? DEFAULT_SPECIAL_UNIT_VALUE : v.unitValue
  if (!validUnitValue(unitValue)) return null
  return { enabled: v.enabled, multiples, unitAmount: v.unitAmount, unitValue }
}

const REFERENCE_RE = /^233\d{9}$/
export const isValidReferenceNumber = (v: unknown): v is string =>
  typeof v === "string" && REFERENCE_RE.test(v) && isValidGhanaMobile(v)

const validCategories = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_HIDDEN_CATEGORIES &&
  v.every((c) => typeof c === "string" && c.length > 0 && c.length <= MAX_CATEGORY_LENGTH)

export function resolveBundlesConfig(raw: unknown): BundlesConfig {
  const r = isObj(raw) ? raw : {}
  const networks = {} as Record<BundleNetwork, NetworkSetting>
  for (const n of BUNDLE_NETWORKS) {
    const s = isObj(r.networks) && isObj(r.networks[n]) ? r.networks[n] : {}
    networks[n] = {
      enabled: s.enabled === true,
      hiddenCategories: validCategories(s.hiddenCategories) ? [...s.hiddenCategories] : [],
      referenceNumber: isValidReferenceNumber(s.referenceNumber) ? s.referenceNumber : DEFAULT_REFERENCE_NUMBERS[n],
    }
  }
  const special = cleanSpecial(r.special) ?? { ...DEFAULT_SPECIAL, multiples: [...DEFAULT_SPECIAL.multiples] }
  return { enabled: r.enabled === true, networks, special }
}

export function validateBundlesPatch(body: unknown): { ok: true; patch: BundlesPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" }
  const allowed = new Set(["enabled", "networks", "special"])
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: `Unknown field ${k}` }
  const patch: BundlesPatch = {}
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" }
    patch.enabled = body.enabled
  }
  if ("networks" in body) {
    if (!isObj(body.networks)) return { ok: false, error: "networks must be an object" }
    const out: Partial<Record<BundleNetwork, NetworkSetting>> = {}
    for (const [k, v] of Object.entries(body.networks)) {
      if (!(BUNDLE_NETWORKS as readonly string[]).includes(k)) return { ok: false, error: `Unknown network ${k}` }
      if (!isObj(v) || typeof v.enabled !== "boolean") return { ok: false, error: `${k}: enabled must be true or false` }
      if (!validCategories(v.hiddenCategories)) {
        return { ok: false, error: `${k}: hiddenCategories must be up to ${MAX_HIDDEN_CATEGORIES} non-empty strings of at most ${MAX_CATEGORY_LENGTH} characters` }
      }
      if (!isValidReferenceNumber(v.referenceNumber)) {
        return { ok: false, error: `${k}: referenceNumber must be a valid Ghana mobile number in 233XXXXXXXXX form` }
      }
      out[k as BundleNetwork] = { enabled: v.enabled, hiddenCategories: [...v.hiddenCategories], referenceNumber: v.referenceNumber }
    }
    patch.networks = out
  }
  if ("special" in body) {
    const s = body.special
    if (!isObj(s)) return { ok: false, error: "special must be an object" }
    for (const k of Object.keys(s)) if (!["enabled", "multiples", "unitAmount", "unitValue"].includes(k)) return { ok: false, error: `special: unknown field ${k}` }
    if (typeof s.enabled !== "boolean") return { ok: false, error: "special: enabled must be true or false" }
    const multiples = cleanMultiples(s.multiples)
    if (!multiples) {
      return { ok: false, error: `special: multiples must be 1 to ${SPECIAL_MAX_MULTIPLES} whole numbers between 1 and ${SPECIAL_MAX_MULTIPLE}` }
    }
    if (!validUnitAmount(s.unitAmount)) return { ok: false, error: "special: unit amount must be more than 0 with at most 2 decimal places" }
    if (!validUnitValue(s.unitValue)) {
      return { ok: false, error: `special: Hubtel unit value must be 1 to ${SPECIAL_MAX_UNIT_VALUE_LENGTH} letters, digits, _ or -` }
    }
    patch.special = { enabled: s.enabled, multiples, unitAmount: s.unitAmount, unitValue: s.unitValue }
  }
  return { ok: true, patch }
}

export async function getBundlesConfig(db: SupabaseClient): Promise<BundlesConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", BUNDLES_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveBundlesConfig(data?.value)
}

export async function setBundlesConfig(db: SupabaseClient, patch: BundlesPatch): Promise<BundlesConfig> {
  const { data, error } = await db.rpc("standard_bundles_config_patch", { p_patch: patch })
  if (error) throw error
  return resolveBundlesConfig(data)
}
