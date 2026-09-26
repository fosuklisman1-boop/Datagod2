//
// Admin-configurable toggle for hiding whole top-level services (Data Bundle
// / AFA Registration / Airtime / Results Checker) from the main USSD menu.
//
// Pure display toggle, zero downstream data effects — unlike network-stock
// (see lib/network-stock-service.ts), there is nothing to snapshot or
// restore here. Read-modify-write over a single JSON blob in admin_settings,
// same convention as network_stock_status / network_prefix_map.
//
// Caller owns the Supabase client (passed in, never created here) so this
// module is testable with a plain fake object — no @supabase/supabase-js
// mocking required.

import type { SupabaseClient } from "@supabase/supabase-js"

export const USSD_SERVICE_VISIBILITY_KEY = "ussd_service_visibility"

export interface UssdServiceVisibility {
  data: boolean
  afa: boolean
  airtime: boolean
  resultsChecker: boolean
}

const DEFAULT_VISIBILITY: UssdServiceVisibility = { data: true, afa: true, airtime: true, resultsChecker: true }

/**
 * Reads the service-visibility map from admin_settings. A row that has never
 * been seeded, or one that's missing individual fields, defaults each field
 * to true (nothing hidden) — a missing/partial setting must never silently
 * hide a service.
 */
export async function getUssdServiceVisibility(supabase: SupabaseClient): Promise<UssdServiceVisibility> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", USSD_SERVICE_VISIBILITY_KEY)
    .maybeSingle()
  if (error) throw error
  const stored = data?.value && typeof data.value === "object" ? (data.value as Partial<UssdServiceVisibility>) : {}
  return { ...DEFAULT_VISIBILITY, ...stored }
}

async function writeUssdServiceVisibility(supabase: SupabaseClient, visibility: UssdServiceVisibility): Promise<void> {
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: USSD_SERVICE_VISIBILITY_KEY,
      value: visibility,
      description: "Which top-level services (data/afa/airtime/resultsChecker) show on the main USSD menu.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
}

/**
 * Flips one service's visibility via read-modify-write over the whole map,
 * and returns the resulting full map.
 */
export async function setUssdServiceVisibility(
  supabase: SupabaseClient,
  service: keyof UssdServiceVisibility,
  visible: boolean
): Promise<UssdServiceVisibility> {
  const current = await getUssdServiceVisibility(supabase)
  const updated: UssdServiceVisibility = { ...current, [service]: visible }
  await writeUssdServiceVisibility(supabase, updated)
  return updated
}
