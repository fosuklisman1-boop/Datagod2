import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { fulfillAirtimeViaHubtel } from "@/lib/airtime-hubtel"
import {
  appendPriorNotes, executeAirtimeHubtelSend, fetchAirtimeLedgerByOrders,
  type AirtimeSendDeps, type AirtimeSendOrder,
} from "@/lib/airtime-hubtel-admin"
import { auditLog, errorJson, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { notifyAdmins } from "@/lib/sms-service"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Admin "Send via Hubtel" for a paid airtime order stuck in pending (never sent, or Hubtel failed it).
 * All eligibility checks live in executeAirtimeHubtelSend; the send itself is the unchanged fulfillAirtimeViaHubtel.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const adminId = auth.userId
  if (!adminId) return NextResponse.json({ error: "A signed-in admin is required to send" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.orderId !== "string" || !UUID.test(body.orderId)) return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  const orderId: string = body.orderId

  try {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const d: AirtimeSendDeps = {
      async getOrder(id) {
        const { data, error } = await db.from("airtime_orders")
          .select("id, reference_code, network, beneficiary_phone, airtime_amount, status, payment_status, notes, updated_at")
          .eq("id", id).maybeSingle()
        if (error) throw error
        if (!data) return null
        return { ...data, airtime_amount: Number(data.airtime_amount) } as AirtimeSendOrder
      },
      async getLedger(id) { return (await fetchAirtimeLedgerByOrders(db, [id])).get(id) ?? [] },
      async send(order) {
        auditLog(db, {
          adminId, action: "airtime_hubtel_send_intent",
          newValue: { orderId: order.id, reference: order.reference_code, priorNotes: order.notes ?? null },
        })
        let rt: ReturnType<typeof getHubtelCsRuntime>
        try {
          rt = getHubtelCsRuntime()
        } catch (e: any) {
          // Nothing was sent. Record why on the order (notes only, still pending) so the "Not sent" message is accurate.
          // The previous notes (e.g. a Digiwapy error) are kept after "| prev:" as evidence.
          console.error(`[AIRTIME-HUBTEL-SEND] Hubtel runtime unavailable for order ${order.id}:`, e?.message ?? e)
          try {
            const { data: cur } = await db.from("airtime_orders").select("notes")
              .eq("id", order.id).eq("status", "pending").maybeSingle()
            await db.from("airtime_orders")
              .update({
                notes: appendPriorNotes("Hubtel: not sent - Hubtel is not configured. Fulfil manually.", cur?.notes),
                updated_at: new Date().toISOString(),
              })
              .eq("id", order.id).eq("status", "pending")
          } catch { /* the executor still reports Not sent */ }
          return false
        }
        // Same wiring as triggerAirtimeFulfillment (lib/airtime-service.ts), except that a notes-only or
        // -> processing write keeps the previous notes after "| prev:" (evidence of earlier provider attempts).
        return fulfillAirtimeViaHubtel(order, {
          purchase: input => rt.client.purchase(input),
          markOrder: async (id, patch, onlyFromStatuses) => {
            let notes = patch.notes
            if (patch.status === undefined || patch.status === "processing") {
              // Best effort: a failed read must never block the state write (the order would stay pending while
              // Hubtel owns it). The intent audit entry also holds the prior notes.
              try {
                let r = db.from("airtime_orders").select("notes").eq("id", id)
                r = onlyFromStatuses ? r.in("status", onlyFromStatuses) : r.neq("status", "completed")
                const { data: cur, error: readError } = await r.maybeSingle()
                if (readError) throw readError
                notes = appendPriorNotes(patch.notes, cur?.notes)
              } catch (e: any) {
                console.warn(`[AIRTIME-HUBTEL-SEND] could not read prior notes for order ${id}:`, e?.message ?? e)
              }
            }
            let q = db.from("airtime_orders")
              .update({ ...patch, notes, updated_at: new Date().toISOString() }).eq("id", id)
            if (onlyFromStatuses) {
              q = q.in("status", onlyFromStatuses)
            } else {
              q = q.neq("status", "completed")
            }
            const { data, error } = await q.select("id")
            if (error) throw error
            if (onlyFromStatuses && (data?.length ?? 0) === 0) {
              console.warn(`[AIRTIME-HUBTEL-SEND] guarded write (${patch.status ?? "notes"}) matched 0 rows for order ${id}`)
            }
            return data?.length ?? 0
          },
          refreshTx: ref => rt.store.getByRef(ref),
          settle: async tx => { await rt.onTransition(tx) },
          alert: async (message, kind) => {
            await notifyAdmins(message, kind === "review" ? "airtime_hubtel_review" : "airtime_manual_needed", order.id, true)
          },
        })
      },
      async alert(message, urgent) {
        // 4th argument is skipEmailFallback: an urgent alert keeps the email fallback.
        await notifyAdmins(message, "airtime_hubtel_review", orderId, !urgent)
      },
    }

    const out = await executeAirtimeHubtelSend(d, orderId)
    auditLog(db, {
      adminId, action: "airtime_hubtel_send",
      newValue: { orderId, ok: out.ok, status: out.orderStatus ?? null, httpStatus: out.status, message: out.message },
    })
    return NextResponse.json({ ok: out.ok, status: out.orderStatus ?? null, message: out.message }, { status: out.status })
  } catch (e) {
    return errorJson(e)
  }
}
