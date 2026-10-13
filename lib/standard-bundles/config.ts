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
export interface BundlesConfig { enabled: boolean; networks: Record<BundleNetwork, NetworkSetting> }
export interface BundlesPatch { enabled?: boolean; networks?: Partial<Record<BundleNetwork, NetworkSetting>> }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)

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
  return { enabled: r.enabled === true, networks }
}

export function validateBundlesPatch(body: unknown): { ok: true; patch: BundlesPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" }
  const allowed = new Set(["enabled", "networks"])
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
