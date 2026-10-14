// lib/api-v1/surface.ts
//
// The API-channel switch shared by the v1 Standard Bundles and Utility Bills endpoints (live keys only).

import type { CashbackConfig } from "@/lib/cashback/config"

export const NOT_AVAILABLE_BODY = { success: false, error: "not_available" } as const

/** Whether API-channel cashback pricing (and with it the bundles/bills endpoints) is switched on. */
export const apiSurfaceOn = (cfg: CashbackConfig): boolean => !!cfg.enabled && !!cfg.surfaces.api

/**
 * Reads the cashback config for the API gate.
 * - Config read: `open` is the API surface switch, `cfg` the config for pricing.
 * - Read failure: `open: false, cfg: null` — fail closed. The bundles/bills endpoints exist only while the admin's
 *   API switch is on; if we can't read that switch we must not assume it is on.
 */
export async function readApiSurface(
  getCashbackConfig: () => Promise<CashbackConfig>,
): Promise<{ open: boolean; cfg: CashbackConfig | null }> {
  try {
    const cfg = await getCashbackConfig()
    return { open: apiSurfaceOn(cfg), cfg }
  } catch (e) {
    console.warn("[V1] cashback config unavailable, API bundles/bills closed:", e instanceof Error ? e.message : "error")
    return { open: false, cfg: null }
  }
}
