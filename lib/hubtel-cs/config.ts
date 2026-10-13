import type { SupabaseClient } from "@supabase/supabase-js"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS, isServiceKey, type HubtelCsServiceKey } from "./services"

export const HUBTEL_CS_CONFIG_KEY = "hubtel_cs_config"
export type HubtelCsMode = "direct" | "relay"

export interface HubtelCsConfig {
  enabled: boolean
  mode: HubtelCsMode
  paused: boolean
  pausedReason: string | null
  pausedAt: string | null
  lowBalanceThreshold: number | null
  services: Record<HubtelCsServiceKey, boolean>
}
export interface ConfigPatch {
  enabled?: boolean
  mode?: HubtelCsMode
  lowBalanceThreshold?: number | null
  services?: Partial<Record<HubtelCsServiceKey, boolean>>
  /** Admins may only CLEAR the pause; pausing is done by the 4075 handler. */
  paused?: false
}

export function resolveConfig(stored: unknown): HubtelCsConfig {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, any>
  const services = {} as Record<HubtelCsServiceKey, boolean>
  for (const k of HUBTEL_CS_SERVICE_KEYS) {
    const v = s.services && typeof s.services === "object" ? s.services[k] : undefined
    services[k] = typeof v === "boolean" ? v : HUBTEL_CS_SERVICES[k].defaultEnabled
  }
  const t = s.lowBalanceThreshold
  return {
    enabled: s.enabled === true,
    mode: s.mode === "relay" ? "relay" : "direct",
    paused: s.paused === true,
    pausedReason: typeof s.pausedReason === "string" ? s.pausedReason : null,
    pausedAt: typeof s.pausedAt === "string" ? s.pausedAt : null,
    lowBalanceThreshold: typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null,
    services,
  }
}

const PATCH_KEYS = new Set(["enabled", "mode", "lowBalanceThreshold", "services", "paused"])

export function validateConfigPatch(input: unknown): { ok: true; patch: ConfigPatch } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid JSON body" }
  const b = input as Record<string, unknown>
  for (const k of Object.keys(b)) if (!PATCH_KEYS.has(k)) return { ok: false, error: `Unknown field: ${k}` }
  const patch: ConfigPatch = {}
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }
    patch.enabled = b.enabled
  }
  if (b.mode !== undefined) {
    if (b.mode !== "direct" && b.mode !== "relay") return { ok: false, error: "mode must be 'direct' or 'relay'" }
    patch.mode = b.mode
  }
  if (b.lowBalanceThreshold !== undefined) {
    const t = b.lowBalanceThreshold
    if (t !== null && !(typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 10_000_000)) {
      return { ok: false, error: "lowBalanceThreshold must be a positive number or null" }
    }
    patch.lowBalanceThreshold = t as number | null
  }
  if (b.services !== undefined) {
    if (!b.services || typeof b.services !== "object" || Array.isArray(b.services)) return { ok: false, error: "services must be an object" }
    const out: Partial<Record<HubtelCsServiceKey, boolean>> = {}
    for (const [k, v] of Object.entries(b.services as Record<string, unknown>)) {
      if (!isServiceKey(k)) return { ok: false, error: `Unknown service: ${k}` }
      if (typeof v !== "boolean") return { ok: false, error: `services.${k} must be a boolean` }
      out[k] = v
    }
    patch.services = out
  }
  if (b.paused !== undefined) {
    if (b.paused !== false) return { ok: false, error: "paused can only be cleared (false)" }
    patch.paused = false
  }
  return { ok: true, patch }
}

/** Status checks always go through the relay, so relay env is required in both modes. */
export function hubtelCsEnvReady(
  mode: HubtelCsMode,
  env: Record<string, string | undefined> = process.env
): { ready: boolean; missing: string[] } {
  const required = ["HUBTEL_CS_CALLBACK_SECRET", "NEXT_PUBLIC_APP_URL", "HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"]
  if (mode === "direct") required.push("HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT")
  const missing = required.filter(k => !env[k])
  // A short HMAC secret is guessable; names only, never the value.
  if (env.HUBTEL_CS_CALLBACK_SECRET && env.HUBTEL_CS_CALLBACK_SECRET.length < 32) missing.push("HUBTEL_CS_CALLBACK_SECRET (min 32 chars)")
  return { ready: missing.length === 0, missing }
}

export async function getHubtelCsConfig(db: SupabaseClient): Promise<HubtelCsConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", HUBTEL_CS_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveConfig(data?.value)
}

/** Only the keys the admin actually changed; pause keys only on an explicit resume. Pure. */
export function buildConfigPatch(patch: ConfigPatch): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (patch.enabled !== undefined) p.enabled = patch.enabled
  if (patch.mode !== undefined) p.mode = patch.mode
  if (patch.lowBalanceThreshold !== undefined) p.lowBalanceThreshold = patch.lowBalanceThreshold
  if (patch.services !== undefined) p.services = patch.services
  if (patch.paused === false) { p.paused = false; p.pausedReason = null; p.pausedAt = null }
  return p
}

/** Atomic merge (migration 0115) — an admin save and a 4075 pause can no longer overwrite each other. */
async function patchConfig(db: SupabaseClient, p: Record<string, unknown>): Promise<HubtelCsConfig> {
  const { data, error } = await db.rpc("hubtel_cs_config_patch", { p_patch: p })
  if (error) throw error
  return resolveConfig(data)
}

export async function setHubtelCsConfig(db: SupabaseClient, patch: ConfigPatch): Promise<HubtelCsConfig> {
  return patchConfig(db, buildConfigPatch(patch))
}

/** reason=null resumes. */
export async function setHubtelCsPaused(db: SupabaseClient, reason: string | null): Promise<HubtelCsConfig> {
  return patchConfig(db, reason === null
    ? { paused: false, pausedReason: null, pausedAt: null }
    : { paused: true, pausedReason: reason, pausedAt: new Date().toISOString() })
}
