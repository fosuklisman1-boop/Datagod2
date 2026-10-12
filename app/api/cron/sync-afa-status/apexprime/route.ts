import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { alertAdminsOfRequest, notifyUserOfOutcome } from "@/lib/admin-actions"

export const maxDuration = 300

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type AfaTable = "afa_orders" | "ussd_afa_orders"

const TABLES: { table: AfaTable; statusCol: "status" | "order_status" }[] = [
  { table: "afa_orders", statusCol: "status" },
  { table: "ussd_afa_orders", statusCol: "order_status" },
]

// Columns read back from the flipped row; ussd_afa_orders has no user_id/order_code so only id.
const NOTIFY_COLUMNS: Record<AfaTable, string> = {
  afa_orders: "id, user_id, phone_number, order_code, full_name",
  ussd_afa_orders: "id",
}

async function syncTable(table: AfaTable, statusCol: "status" | "order_status"): Promise<{ synced: number; failed: number }> {
  const { ApexPrimeProvider } = await import("@/lib/mtn-providers/apexprime-provider")
  const provider = new ApexPrimeProvider()

  const { data: rows, error } = await supabase
    .from(table)
    .select(`id, fulfillment_ref, ${statusCol}`)
    .eq("fulfillment_provider", "apexprime")
    .eq("fulfillment_status", "pending")
    .not("fulfillment_ref", "is", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE)

  if (error || !rows) {
    console.error(`[CRON-AFA-APEXPRIME] Error fetching ${table}:`, error)
    return { synced: 0, failed: 0 }
  }

  let synced = 0
  let failed = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as any
    try {
      const chk = await provider.checkAfaStatus(row.fulfillment_ref)

      if (chk.success && chk.status === "completed") {
        const { data: completedRows } = await supabase
          .from(table)
          .update({
            fulfillment_status: "fulfilled",
            fulfillment_error: null,
            fulfilled_at: new Date().toISOString(),
            [statusCol]: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .select(NOTIFY_COLUMNS[table])
        const completedRow = (completedRows as any[] | null)?.[0]
        // Reconciliation above is unconditional; only a real transition (pre-image not already
        // completed, e.g. by an admin who already notified the user) notifies. Worst case the
        // notice is delayed by one cron run over a batch of 50, which is acceptable.
        if (table === "afa_orders" && completedRow && row[statusCol] !== "completed") {
          await notifyUserOfOutcome(
            "afa",
            "completed",
            { userId: completedRow.user_id, phone: completedRow.phone_number, reference: row.id },
            { orderCode: completedRow.order_code || "", fullName: completedRow.full_name || "" },
          )
        }
        console.log(`[CRON-AFA-APEXPRIME] ✅ ${table} ${row.id}: fulfilled`)
        synced++
      } else if (chk.success && chk.status === "failed") {
        const { data: failedRows } = await supabase
          .from(table)
          .update({
            fulfillment_status: "failed",
            fulfillment_error: chk.message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("fulfillment_status", "pending")
          .select(NOTIFY_COLUMNS[table])
        const failedRow = (failedRows as any[] | null)?.[0]
        if (table === "afa_orders" && failedRow) {
          await alertAdminsOfRequest("afa", { orderCode: failedRow.order_code || "", fullName: failedRow.full_name || "" })
        }
        console.log(`[CRON-AFA-APEXPRIME] ❌ ${table} ${row.id}: failed (${chk.message})`)
        synced++
      } else if (!chk.success) {
        console.warn(`[CRON-AFA-APEXPRIME] Status check failed for ${table} ${row.id}:`, chk.message)
        failed++
      } else if (chk.success) {
        // Still pending/processing on Apex Prime's side — log the raw signal
        // so a status-vocabulary mismatch (unrecognized string silently
        // mapped to "processing" by normalizeApexStatus) is at least visible
        // in logs, not entirely silent.
        console.log(`[CRON-AFA-APEXPRIME] ${table} ${row.id}: still ${chk.status} — raw status "${chk.order?.status}" (${chk.message})`)
      }
      // "pending"/"processing" => still waiting on MTN, no-op
    } catch (err) {
      console.error(`[CRON-AFA-APEXPRIME] Error processing ${table} ${row.id}:`, err)
      failed++
    }

    if (i < rows.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  // A row stuck "pending" with no fulfillment_ref for a while means the
  // process was interrupted before saving the reference — but this is
  // ambiguous, not safe: the interruption could have happened either before
  // Apex Prime ever saw the request (nothing submitted, safe to retry) OR
  // after Apex Prime accepted and debited the wallet but before we recorded
  // the reference (already submitted — a retry would double-register and
  // double-charge). We can't tell these apart from here, so release it back
  // to "failed" for a human to check Apex Prime's own records before
  // retrying, rather than asserting it's safe.
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { data: staleRows } = await supabase
    .from(table)
    .select("id")
    .eq("fulfillment_provider", "apexprime")
    .eq("fulfillment_status", "pending")
    .is("fulfillment_ref", null)
    .lt("updated_at", staleThreshold)
    .limit(BATCH_SIZE)

  for (const row of staleRows ?? []) {
    const { data: releasedRows } = await supabase
      .from(table)
      .update({
        fulfillment_status: "failed",
        fulfillment_error: "Submission to Apex Prime was interrupted before we could confirm the outcome — it may or may not have reached Apex Prime. Check Apex Prime's transaction/wallet log for this recipient before retrying, to avoid a possible duplicate registration and charge.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("fulfillment_status", "pending")
      .select(NOTIFY_COLUMNS[table])
    const releasedRow = (releasedRows as any[] | null)?.[0]
    if (table === "afa_orders" && releasedRow) {
      await alertAdminsOfRequest("afa", { orderCode: releasedRow.order_code || "", fullName: releasedRow.full_name || "" })
    }
    console.log(`[CRON-AFA-APEXPRIME] Released stale pending row for manual review (no ref, >10min old — outcome unconfirmed): ${table} ${row.id}`)
    synced++
  }

  return { synced, failed }
}

/**
 * GET /api/cron/sync-afa-status/apexprime
 *
 * Polls pending Apex Prime AFA registrations via the shared /status endpoint
 * (type: "afa") and confirms fulfilled/failed. Apex Prime AFA has no verified
 * webhook payload (unlike bundle/store orders), so this cron is the sole
 * confirmation path, not a fallback for a missed webhook.
 */
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized && errorResponse) return errorResponse

  try {
    console.log("[CRON-AFA-APEXPRIME] Starting status sync...")

    let totalSynced = 0
    let totalFailed = 0
    for (const { table, statusCol } of TABLES) {
      const { synced, failed } = await syncTable(table, statusCol)
      totalSynced += synced
      totalFailed += failed
    }

    return NextResponse.json({ success: true, synced: totalSynced, failed: totalFailed })
  } catch (error) {
    console.error("[CRON-AFA-APEXPRIME] Critical error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
