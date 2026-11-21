// Watches Hubnet tracking rows stored as "abandoned" with mtn_order_id UNKNOWN_*
// (placement outcome unknown). If Hubnet in fact created one of the attempts,
// re-sending would deliver twice: alert an admin to check first.
// Read-only on the tracking row. No phone numbers in logs or alert text.

import { hubnetRef, HUBNET_MAX_ATTEMPTS } from "./core"
import type { HubnetClient } from "./client"

const WINDOW_MS = 48 * 3_600_000
const BATCH_LIMIT = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type HubnetAlert = (type: string, title: string, message: string) => Promise<void>

/** Throttle key is the type, so the tracking id goes in it: each row alerts once (rows live <= 48h). */
export const defaultHubnetAlert: HubnetAlert = async (type, title, message) => {
  const { notifyAdminsThrottled } = await import("@/lib/sms/notify")
  await notifyAdminsThrottled(type, title, message, "/admin/settings/mtn", WINDOW_MS)
}

type Row = { id: string; shop_order_id: string | null; order_id: string | null; api_order_id: string | null; created_at: string }

export async function checkHubnetUnknownAttempts(
  db: any,
  client: Pick<HubnetClient, "getStatus">,
  alert: HubnetAlert = defaultHubnetAlert,
  now: number = Date.now(),
): Promise<{ checked: number; found: number }> {
  const since = new Date(now - WINDOW_MS).toISOString()
  const { data, error } = await db
    .from("mtn_fulfillment_tracking")
    .select("id, shop_order_id, order_id, api_order_id, created_at")
    .eq("provider", "hubnet")
    .eq("status", "abandoned")
    .like("mtn_order_id", "UNKNOWN_%")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT)
  if (error) throw new Error(`hubnet unknown-attempts lookup failed: ${error.message}`)

  const out = { checked: 0, found: 0 }
  for (const row of (data ?? []) as Row[]) {
    if (new Date(row.created_at).getTime() < now - WINDOW_MS) continue
    // Same id the resend path hands the provider as client_ref (lib/mtn-fulfillment.ts).
    const id = row.shop_order_id || row.order_id || row.api_order_id
    if (!id || !UUID_RE.test(id)) continue
    out.checked++
    try {
      for (let n = 1; n <= HUBNET_MAX_ATTEMPTS; n++) {
        const ref = hubnetRef("data", id, n)
        const res = await client.getStatus(ref)
        if (res.kind !== "found") continue // missing or unknown: not evidence
        if (res.status === "failed") continue // failed/refunded attempt delivered nothing: no "do not re-send" alert
        await alert(
          `hubnet_unknown_found:${row.id}`,
          "Hubnet: order exists for an unknown attempt",
          `Hubnet did create this order (ref ${ref}, status ${res.status}) - check before re-sending.`,
        )
        out.found++
        break
      }
    } catch (e) {
      console.error(`[HUBNET-UNKNOWN] check failed for tracking ${row.id}:`, (e as Error).message)
    }
  }
  return out
}
