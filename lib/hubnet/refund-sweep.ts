// Detects Hubnet refunds (Hubnet's refund list) and reconciles our rows.
//
// Runs every 10 minutes over the same recent refunds, so every write and alert must be
// idempotent. Idempotency comes from row state only: a second sweep sees failed / reversed /
// [hubnetRefunded] and does nothing. Never log or alert phone numbers: refs and counts only.
import { parseHubnetRef } from "./core"
import type { HubnetClient } from "./client"
import { applyHubnetStatusChange } from "./sync"
import { flagReversal } from "@/lib/mtn-reversal"

export type HubnetRefundAlert = (type: string, title: string, message: string, actionUrl: string, throttleMs: number) => Promise<void>

export type RefundSweepDeps = {
  apply?: typeof applyHubnetStatusChange
  flag?: typeof flagReversal
}

export type RefundSweepResult = { seen: number; dataFailed: number; dataReversed: number; airtimeFlagged: number; reviewOnly: number }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const REFUNDED_MARKER = "[hubnetRefunded]"

const TRACKING_COLUMNS = "id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, size_gb, provider, external_status"

export async function sweepHubnetRefunds(
  db: any,
  client: Pick<HubnetClient, "listRefunds">,
  alert: HubnetRefundAlert,
  deps: RefundSweepDeps = {},
): Promise<RefundSweepResult> {
  const apply = deps.apply ?? applyHubnetStatusChange
  const flag = deps.flag ?? flagReversal
  const out: RefundSweepResult = { seen: 0, dataFailed: 0, dataReversed: 0, airtimeFlagged: 0, reviewOnly: 0 }

  const items = await client.listRefunds()
  if (!items) return out
  out.seen = items.length

  const refs = new Set<string>()
  for (const item of items) {
    const ref = item?.reference
    if (ref && parseHubnetRef(ref)) refs.add(ref)
    else out.reviewOnly++
  }

  for (const ref of refs) {
    const kind = parseHubnetRef(ref)!.kind
    try {
      if (kind === "data") {
        const { data: rows, error } = await db.from("mtn_fulfillment_tracking").select(TRACKING_COLUMNS)
          .eq("provider", "hubnet").eq("mtn_order_id", ref).limit(5)
        if (error) { console.error(`[HUBNET-REFUND] lookup failed for ${ref}: ${error.message}`); continue }
        for (const row of rows ?? []) {
          if (row.status === "pending" || row.status === "processing") {
            const moved = await apply(db, row, "failed", { status: "refunded", message: "Hubnet refunded this attempt" })
            if (moved) out.dataFailed++
          } else if (row.status === "completed") {
            const res = await flag(db, row, { status: "refunded", message: "Hubnet refunded a completed order" })
            if (res.flagged) {
              out.dataReversed++
              await alert(`hubnet_refund_reversed:${ref}`, "Hubnet refunded a completed order",
                `Hubnet refunded ${ref}, which we had marked completed. It was flagged as reversed; review before re-sending.`,
                "/admin/orders", WEEK_MS)
            }
          }
          // reversed / failed / abandoned: nothing to do
        }
      } else {
        const { data: rows, error } = await db.from("airtime_orders").select("id, status, notes")
          .ilike("notes", `%[hubnetRef:${ref}]%`).limit(5)
        if (error) { console.error(`[HUBNET-REFUND] airtime lookup failed for ${ref}: ${error.message}`); continue }
        for (const row of rows ?? []) {
          const notes = String(row.notes ?? "")
          const prevStatus = String(row.status)
          if (notes.includes(REFUNDED_MARKER)) continue
          const update: Record<string, unknown> = { notes: `${notes} ${REFUNDED_MARKER}`, updated_at: new Date().toISOString() }
          if (row.status === "processing") update.status = "pending"
          const { data: done, error: upErr } = await db.from("airtime_orders").update(update)
            .eq("id", row.id).eq("status", row.status).select("id")
          if (upErr) { console.error(`[HUBNET-REFUND] airtime update failed for ${ref}: ${upErr.message}`); continue }
          if (!done || done.length === 0) continue // moved meanwhile; next sweep re-checks
          out.airtimeFlagged++
          await alert(`airtime_hubnet_refunded:${ref}`, "Hubnet refunded an airtime order",
            `Hubnet refunded airtime ${ref}. ${prevStatus === "processing" ? "Order was set back to pending." : prevStatus === "completed" ? "Order is completed; refund the customer via /admin/refunds if needed." : `Marker recorded; status unchanged (${prevStatus}).`}`,
            "/admin/orders", WEEK_MS)
        }
      }
    } catch (err) {
      console.error(`[HUBNET-REFUND] ${ref} failed:`, err instanceof Error ? err.message : err)
    }
  }

  if (out.reviewOnly > 0) {
    await alert("hubnet_refund_review_only", "Hubnet refunds need review",
      `${out.reviewOnly} Hubnet refund item(s) had no recognisable reference. Check the Hubnet dashboard.`,
      "/admin/orders", DAY_MS)
  }
  return out
}
