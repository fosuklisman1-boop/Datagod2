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
  /** Uzo opt-in: Network Plans menu item (commission cashback bots). Default OFF. */
  networkPlans: boolean
  /** Uzo opt-in: Pay Bills menu item (commission cashback bots). Default OFF. */
  payBills: boolean
  /** Uzo opt-in: cashback pricing on Uzo main + shop airtime. Default OFF. Hubtel USSD never reads it. */
  cashbackAirtime: boolean
}

/** Every key the admin route accepts (the route validator). */
export const USSD_VISIBILITY_SERVICES: readonly (keyof UssdServiceVisibility)[] = [
  "data", "afa", "airtime", "resultsChecker", "networkPlans", "payBills", "cashbackAirtime",
]
export const isUssdVisibilityService = (s: unknown): s is keyof UssdServiceVisibility =>
  typeof s === "string" && (USSD_VISIBILITY_SERVICES as readonly string[]).includes(s)

/**
 * The Uzo commission-cashback opt-ins: OFF unless stored strictly `true`. These shipped while the shared cashback Bots
 * switches were already ON in prod (Hubtel USSD), so a missing key must mean "not live" (the deploy is dark).
 */
const UZO_OPT_INS = ["networkPlans", "payBills", "cashbackAirtime"] as const

const DEFAULT_VISIBILITY: UssdServiceVisibility = {
  data: true,
  afa: true,
  airtime: true,
  resultsChecker: true,
  networkPlans: false,
  payBills: false,
  cashbackAirtime: false,
}

/**
 * Reads the service-visibility map from admin_settings. For the four legacy services, a row that has never been
 * seeded, or one that's missing individual fields, defaults each field to true (nothing hidden) — a missing/partial
 * setting must never silently hide a service. The three Uzo opt-ins are the opposite: on only when stored `true`.
 */
export async function getUssdServiceVisibility(supabase: SupabaseClient): Promise<UssdServiceVisibility> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", USSD_SERVICE_VISIBILITY_KEY)
    .maybeSingle()
  if (error) throw error
  const stored = data?.value && typeof data.value === "object" ? (data.value as Partial<UssdServiceVisibility>) : {}
  const out: UssdServiceVisibility = { ...DEFAULT_VISIBILITY, ...stored }
  for (const k of UZO_OPT_INS) out[k] = stored[k] === true
  return out
}

async function writeUssdServiceVisibility(supabase: SupabaseClient, visibility: UssdServiceVisibility): Promise<void> {
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: USSD_SERVICE_VISIBILITY_KEY,
      value: visibility,
      description: "Which top-level services (data/afa/airtime/resultsChecker) show on the Uzo USSD menus, plus the Uzo commission-cashback opt-ins (networkPlans/payBills/cashbackAirtime, off unless true).",
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
