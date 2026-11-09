// Pure per-surface payment-gateway config model. No Supabase / Next imports.

export type SurfaceKey =
  | "wallet_topup"
  | "storefront"
  | "dashboard_direct"
  | "sms"
  | "ussd"
  | "whatsapp"

export const SURFACE_KEYS: readonly SurfaceKey[] = [
  "wallet_topup",
  "storefront",
  "dashboard_direct",
  "sms",
  "ussd",
  "whatsapp",
]

export type Gateway = "paystack" | "hubtel"
export type PaymentMode = "checkout" | "direct"
export type FeeBearer = "customer" | "merchant"

export interface SurfaceConfig {
  gateway: Gateway
  mode: PaymentMode
  feeBearer: FeeBearer
}

export interface GatewayConfig {
  version: 1
  surfaces: Record<SurfaceKey, SurfaceConfig>
  hubtelFeePercent: number
}

export const DIRECT_ONLY_SURFACES: readonly SurfaceKey[] = ["ussd", "whatsapp"]

const GATEWAYS: readonly Gateway[] = ["paystack", "hubtel"]
const MODES: readonly PaymentMode[] = ["checkout", "direct"]
const FEE_BEARERS: readonly FeeBearer[] = ["customer", "merchant"]

function isDirectOnly(k: SurfaceKey): boolean {
  return DIRECT_ONLY_SURFACES.includes(k)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : undefined
}

export function deriveFromLegacy(l: {
  storefrontDirect: boolean
  walletDirect: boolean
}): GatewayConfig {
  const mk = (direct: boolean): SurfaceConfig => ({
    gateway: "paystack",
    mode: direct ? "direct" : "checkout",
    feeBearer: "customer",
  })
  return {
    version: 1,
    surfaces: {
      wallet_topup: mk(l.walletDirect),
      storefront: mk(l.storefrontDirect),
      dashboard_direct: mk(l.walletDirect),
      sms: mk(l.walletDirect),
      ussd: mk(true),
      whatsapp: mk(true),
    },
    hubtelFeePercent: 0,
  }
}

export function sanitizeGatewayConfig(
  raw: unknown,
  fallback: GatewayConfig,
): GatewayConfig {
  const root = isRecord(raw) ? raw : {}
  const rawSurfaces = isRecord(root.surfaces) ? root.surfaces : {}

  const surfaces = {} as Record<SurfaceKey, SurfaceConfig>
  for (const k of SURFACE_KEYS) {
    const fb = fallback.surfaces[k]
    const s = isRecord(rawSurfaces[k]) ? (rawSurfaces[k] as Record<string, unknown>) : {}
    const mode = isDirectOnly(k) ? "direct" : (pick(s.mode, MODES) ?? fb.mode)
    surfaces[k] = {
      gateway: pick(s.gateway, GATEWAYS) ?? fb.gateway,
      mode,
      feeBearer: pick(s.feeBearer, FEE_BEARERS) ?? fb.feeBearer,
    }
  }

  const fee = root.hubtelFeePercent
  const hubtelFeePercent =
    typeof fee === "number" && Number.isFinite(fee)
      ? Math.min(100, Math.max(0, fee))
      : fallback.hubtelFeePercent

  return { version: 1, surfaces, hubtelFeePercent }
}

export function validateGatewayConfigUpdate(
  raw: unknown,
  opts: { hubtelReady: boolean },
): { ok: true; config: GatewayConfig } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "Invalid config" }
  if (!isRecord(raw.surfaces)) return { ok: false, error: "Missing surfaces" }

  const surfaces = {} as Record<SurfaceKey, SurfaceConfig>
  for (const k of SURFACE_KEYS) {
    const s = raw.surfaces[k]
    if (!isRecord(s)) return { ok: false, error: `Missing surface: ${k}` }
    const gateway = pick(s.gateway, GATEWAYS)
    const mode = pick(s.mode, MODES)
    const feeBearer = pick(s.feeBearer, FEE_BEARERS)
    if (!gateway) return { ok: false, error: `Invalid gateway for ${k}` }
    if (!mode) return { ok: false, error: `Invalid mode for ${k}` }
    if (!feeBearer) return { ok: false, error: `Invalid feeBearer for ${k}` }
    if (isDirectOnly(k) && mode !== "direct") {
      return { ok: false, error: `${k} must use direct mode` }
    }
    if (gateway === "hubtel" && !opts.hubtelReady) {
      return { ok: false, error: "Hubtel is not configured" }
    }
    surfaces[k] = { gateway, mode, feeBearer }
  }

  const fee = raw.hubtelFeePercent
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0 || fee > 100) {
    return { ok: false, error: "hubtelFeePercent must be between 0 and 100" }
  }

  return { ok: true, config: { version: 1, surfaces, hubtelFeePercent: fee } }
}
