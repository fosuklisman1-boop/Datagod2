// app/api/admin/airtime/auto-fulfill/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendAirtimeViaDigiwapy, isDigiWapyConfigured } from "@/lib/digiwapy-provider"
import { fetchAirtimeLedgerByOrders, hasLiveHubtelAttempt } from "@/lib/airtime-hubtel-admin"
import type { LedgerFact } from "@/lib/bills/admin"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  if (!isDigiWapyConfigured()) {
    return NextResponse.json(
      { error: "Digiwapy not configured. Set DIGIWAPY_API_KEY and DIGIWAPY_PARTNER_CODE." },
      { status: 503 }
    )
  }

  try {
    const body = await request.json()
    const ids: string[] = body.orderIds ?? (body.orderId ? [body.orderId] : [])
    if (ids.length === 0) {
      return NextResponse.json({ error: "Provide orderId or orderIds" }, { status: 400 })
    }

    const { data: orders, error } = await supabase
      .from("airtime_orders")
      .select("id, reference_code, network, beneficiary_phone, airtime_amount, status")
      .in("id", ids)
      .eq("status", "pending")

    if (error) throw error
    if (!orders || orders.length === 0) {
      return NextResponse.json(
        { error: "No pending orders found for the given IDs" },
        { status: 404 }
      )
    }

    // Never send to Digiwapy an order Hubtel has (or may have) taken: any non-failed Hubtel ledger row is skipped.
    // Fail closed: an unreadable ledger sends nothing.
    let ledger: Map<string, LedgerFact[]>
    try {
      ledger = await fetchAirtimeLedgerByOrders(supabase, orders.map((o) => o.id))
    } catch (e: any) {
      console.error("[AUTO-FULFILL] Hubtel ledger read failed; sending nothing:", e?.message ?? e)
      return NextResponse.json({ error: "Could not read the Hubtel ledger; try again" }, { status: 503 })
    }
    const skipped = orders
      .filter((o) => hasLiveHubtelAttempt(ledger.get(o.id) ?? []))
      .map((o) => ({
        orderId: o.id,
        reference: o.reference_code,
        success: false,
        message: "A Hubtel transaction exists for this order; resolve it in Hubtel Commission",
      }))
    const skippedIds = new Set(skipped.map((s) => s.orderId))
    const toSend = orders.filter((o) => !skippedIds.has(o.id))

    const sendResults = await Promise.allSettled(
      toSend.map(async (order) => {
        const result = await sendAirtimeViaDigiwapy({
          network: order.network,
          recipient: order.beneficiary_phone,
          amount: order.airtime_amount,
          reference: order.reference_code,
          freshAttempt: true,
        })
        const successNote = result.digiwapyRef
          ? `Admin retry via Digiwapy [dgwRef:${result.digiwapyRef}]`
          : "Admin retry via Digiwapy"
        await supabase
          .from("airtime_orders")
          .update({
            status: result.success ? "processing" : "pending",
            notes: result.success ? successNote : `Digiwapy error: ${result.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id)
          .eq("status", "pending")
        return { orderId: order.id, reference: order.reference_code, ...result }
      })
    )
    const results: PromiseSettledResult<any>[] = [
      ...sendResults,
      ...skipped.map((s): PromiseFulfilledResult<any> => ({ status: "fulfilled", value: s })),
    ]

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<any>).value?.success
    ).length

    return NextResponse.json({
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results: results.map((r) =>
        r.status === "fulfilled"
          ? (r as PromiseFulfilledResult<any>).value
          : { success: false, message: String((r as PromiseRejectedResult).reason) }
      ),
    })
  } catch (err: any) {
    console.error("[AUTO-FULFILL]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
