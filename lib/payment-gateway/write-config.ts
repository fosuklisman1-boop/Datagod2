import type { SupabaseClient } from "@supabase/supabase-js"
import { DIRECT_ONLY_SURFACES, type GatewayConfig, type PaymentMode, type SurfaceKey } from "./config"
import { GATEWAY_CONFIG_KEY, getGatewayConfig, invalidateGatewayConfigCache } from "./read-config"

export async function saveGatewayConfig(
  db: SupabaseClient,
  config: GatewayConfig,
  actor: string,
): Promise<void> {
  const { error } = await db.from("admin_settings").upsert(
    {
      key: GATEWAY_CONFIG_KEY,
      value: config,
      description: `Per-surface payment gateway config (last changed by ${actor})`,
      updated_at: new Date().toISOString(),
    },
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
  const current = await getGatewayConfig()
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
