import { createClient } from "@supabase/supabase-js"
import { logSecurityEvent } from "../security-log"
import {
  deriveFromLegacy,
  sanitizeGatewayConfig,
  type GatewayConfig,
  type SurfaceConfig,
  type SurfaceKey,
} from "./config"

export const GATEWAY_CONFIG_KEY = "payment_gateway_config"

const DEFAULT_TTL_MS = 30_000

export interface GatewayConfigReaderDeps {
  readRow: () => Promise<unknown | null>
  readLegacy: () => Promise<{ storefrontDirect: boolean; walletDirect: boolean }>
  now?: () => number
  ttlMs?: number
  logEvent?: (event: string, details?: Record<string, unknown>) => void
}

export function createGatewayConfigReader(deps: GatewayConfigReaderDeps): {
  get(): Promise<GatewayConfig>
  invalidate(): void
} {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const logEvent = deps.logEvent ?? logSecurityEvent
  let cache: { config: GatewayConfig; expiresAt: number } | null = null

  async function load(): Promise<GatewayConfig> {
    const row = await deps.readRow()
    const base = deriveFromLegacy(await deps.readLegacy())
    return row == null ? base : sanitizeGatewayConfig(row, base)
  }

  return {
    async get() {
      if (cache && cache.expiresAt > now()) return cache.config
      try {
        const config = await load()
        cache = { config, expiresAt: now() + ttlMs }
        return config
      } catch {
        // Fail to LAST-KNOWN state, never open. Only when nothing was ever read do we
        // derive from the legacy toggles; if even those are unreadable, everything is
        // hosted checkout (false/false), which is the safe default the legacy code used.
        if (cache) {
          logEvent("gate_read_failed_using_cache", { gate: "payment_gateway_config", fallback: "last_known" })
          return cache.config
        }
        logEvent("gate_read_failed_using_cache", { gate: "payment_gateway_config", fallback: "legacy" })
        try {
          return deriveFromLegacy(await deps.readLegacy())
        } catch {
          return deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
        }
      }
    },
    invalidate() {
      cache = null
    },
  }
}

// ── Module singleton ───────────────────────────────────────────────────────
const supabase =
  process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null

// Loaded lazily (dynamic import) to avoid a load-time cycle with lib/storefront-otp.
let legacyModule: typeof import("./legacy-direct-charge") | null = null

const reader = createGatewayConfigReader({
  async readRow() {
    if (!supabase) return null
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", GATEWAY_CONFIG_KEY)
      .maybeSingle()
    if (error) throw error
    return data ? (data.value ?? null) : null
  },
  async readLegacy() {
    legacyModule ??= await import("./legacy-direct-charge")
    const [storefrontDirect, walletDirect] = await Promise.all([
      legacyModule.readLegacyStorefrontDirectCharge(),
      legacyModule.readLegacyWalletDirectCharge(),
    ])
    return { storefrontDirect, walletDirect }
  },
})

export function getGatewayConfig(): Promise<GatewayConfig> {
  return reader.get()
}

export async function getSurfaceConfig(s: SurfaceKey): Promise<SurfaceConfig> {
  return (await reader.get()).surfaces[s]
}

export function invalidateGatewayConfigCache(): void {
  reader.invalidate()
  legacyModule?.invalidateLegacyDirectChargeCaches()
}
