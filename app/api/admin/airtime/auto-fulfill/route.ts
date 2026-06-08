// app/api/admin/airtime/auto-fulfill/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendAirtimeViaDigiwapy, isDigiWapyConfigured } from "@/lib/digiwapy-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

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

    const results = await Promise.allSettled(
      orders.map(async (order) => {
        const result = await sendAirtimeViaDigiwapy({
          network: order.network,
          recipient: order.beneficiary_phone,
          amount: order.airtime_amount,
          reference: order.reference_code,
        })
        await supabase
          .from("airtime_orders")
          .update({
            status: result.success ? "processing" : "pending",
            notes: result.success
              ? "Admin retry via Digiwapy"
              : `Digiwapy error: ${result.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id)
        return { orderId: order.id, reference: order.reference_code, ...result }
      })
    )

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
