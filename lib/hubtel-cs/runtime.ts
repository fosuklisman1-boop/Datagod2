import { createClient } from "@supabase/supabase-js"
import { checkTransactionStatus, fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"
import { notifyAdapter, registerOrderAdapter } from "./adapters"
import { airtimeOrdersAdapterFor } from "./adapters/airtime-orders"
import { makeOrderHook } from "./order-hook"
import type { AdminDeps } from "./admin-actions"
import { createHubtelCsClient } from "./client"
import { getHubtelCsConfig, setHubtelCsPaused } from "./config"
import { pauseForFloat, type FloatDeps } from "./float"
import { sendFloatAlert } from "./float-alert"
import { REVIEW_ALERT_DEBOUNCE_MS, reviewAlertText } from "./review-alert"
import { createSupabaseHubtelCsStore } from "./store"
import { transportFromEnv } from "./transport"

/** Shared by the status-check cron route (route files may only export handlers/config). */
export const HUBTEL_CS_CRON_TIME_BUDGET_MS = 240_000
export const HUBTEL_CS_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000

/** Always a real service-role client: never the anon fallback in lib/supabase (would silently fail RLS). */
function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("hubtel-cs: Supabase service-role credentials are not configured")
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

/** Single place that wires the pure hubtel-cs modules to Supabase, env and the relay. Call per request, not at import. */
export function getHubtelCsRuntime() {
  const db = serviceRoleClient()
  // Static registration (every entry point builds the runtime, so every entry point has the adapters).
  registerOrderAdapter(airtimeOrdersAdapterFor(db))
  const store = createSupabaseHubtelCsStore(db)
  const getConfig = () => getHubtelCsConfig(db)
  const orderHook = makeOrderHook({
    store, notify: notifyAdapter,
    alertReview: async tx => {
      const t = reviewAlertText(tx)
      await sendFloatAlert(db, "needs_review", t.subject, t.message, { windowMs: REVIEW_ALERT_DEBOUNCE_MS })
    },
  })
  const floatDeps: FloatDeps = {
    setPaused: reason => setHubtelCsPaused(db, reason),
    alert: (kind, subject, message, opts) => sendFloatAlert(db, kind, subject, message, opts),
    // A config read error rejects here; pauseForFloat then falls back to forcing the alert.
    wasPaused: async () => (await getConfig()).paused,
  }
  /** Never throws: the callback route awaits this before answering Hubtel. */
  const onFloat = async (reason: string) => {
    try { await pauseForFloat(floatDeps, reason) } catch (e) {
      console.error("[hubtel-cs] onFloat failed:", e instanceof Error ? e.message : "error")
    }
  }
  const client = createHubtelCsClient({
    store, getConfig,
    getTransport: mode => transportFromEnv(mode),
    callbackBaseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    callbackSecret: process.env.HUBTEL_CS_CALLBACK_SECRET ?? "",
    onFloat,
    onTransition: orderHook,
  })
  const adminDeps: AdminDeps = { store, checkStatus: checkTransactionStatus, onTransition: orderHook }
  return {
    db, store, getConfig, client, floatDeps, adminDeps, onFloat,
    onTransition: orderHook,
    checkStatus: checkTransactionStatus,
    fetchBalance: fetchDisbursementBalance,
  }
}
