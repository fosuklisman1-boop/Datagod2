import { getSurfaceConfig, invalidateGatewayConfigCache } from "./read-config"

// Public direct-charge gates, now answered by the per-surface payment-gateway config.
// With no payment_gateway_config row they resolve to exactly the legacy toggles.

export async function isStorefrontDirectChargeEnabled(): Promise<boolean> {
  return (await getSurfaceConfig("storefront")).mode === "direct"
}

export async function isWalletDirectChargeEnabled(): Promise<boolean> {
  return (await getSurfaceConfig("wallet_topup")).mode === "direct"
}

export async function isDashboardDirectChargeEnabled(): Promise<boolean> {
  return (await getSurfaceConfig("dashboard_direct")).mode === "direct"
}

export async function isSmsDirectChargeEnabled(): Promise<boolean> {
  return (await getSurfaceConfig("sms")).mode === "direct"
}

export function invalidateStorefrontDirectChargeCache(): void {
  invalidateGatewayConfigCache()
}

export function invalidateWalletDirectChargeCache(): void {
  invalidateGatewayConfigCache()
}
