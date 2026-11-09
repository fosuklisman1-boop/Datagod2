import type { SupabaseClient } from "@supabase/supabase-js"
import { DIRECT_ONLY_SURFACES, type GatewayConfig, type PaymentMode, type SurfaceKey } from "./config"
import { GATEWAY_CONFIG_KEY, readGatewayConfigFresh, invalidateGatewayConfigCache } from "./read-config"

export async function saveGatewayConfig(
  db: SupabaseClient,
  config: GatewayConfig,
  _actor: string,
): Promise<void> {
  const updatedAt = new Date().toISOString()
  // One upsert so the config row and the legacy rows succeed or fail together.
  // The legacy storefront_direct_charge / wallet_direct_charge rows are kept in step
  // so a rollback of this deploy doesn't silently revert payment modes; remove in Plan 4.
  // They are write-only from this path: the reader treats payment_gateway_config as the
  // source of truth whenever it is present.
  const { error } = await db.from("admin_settings").upsert(
    [
      {
        key: GATEWAY_CONFIG_KEY,
        value: config,
        description: "Per-surface payment gateway config",
        updated_at: updatedAt,
      },
      {
        key: "storefront_direct_charge",
        value: { enabled: config.surfaces.storefront.mode === "direct" },
        updated_at: updatedAt,
      },
      {
        key: "wallet_direct_charge",
        value: { enabled: config.surfaces.wallet_topup.mode === "direct" },
        updated_at: updatedAt,
      },
    ],
    { onConflict: "key" },
  )
  if (error) throw new Error(error.message)
  invalidateGatewayConfigCache()
}

export async function setSurfaceModes(
  db: SupabaseClient,
  surfaces: SurfaceKey[],
  mode: PaymentMode,
  actor: string,
): Promise<GatewayConfig> {
  // Strict uncached read: a failed read throws and nothing is saved.
  const current = await readGatewayConfigFresh()
  const next: GatewayConfig = {
    ...current,
    surfaces: { ...current.surfaces },
  }
  for (const s of surfaces) {
    if (DIRECT_ONLY_SURFACES.includes(s)) continue
    next.surfaces[s] = { ...next.surfaces[s], mode }
  }
  await saveGatewayConfig(db, next, actor)
  return next
}
