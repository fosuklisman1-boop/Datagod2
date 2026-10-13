import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { payBill } from "@/lib/bills/service"
import { authenticate, readJson } from "@/lib/bills/route-auth"

// A request must always die well before the 5-minute stuck-claim threshold.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const rl = await applyRateLimit(request, "bills_pay", 10, 60_000, auth.userId)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const body = await readJson(request)
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

    const token = body.token
    const amount = typeof body.amount === "number" ? body.amount
      : typeof body.amount === "string" && /^\d+(\.\d+)?$/.test(body.amount.trim()) ? Number(body.amount.trim()) : NaN
    if (typeof token !== "string" || !token || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "token and a numeric amount are required" }, { status: 400 })
    }

    const { deps, db } = getBillsRuntime()
    const guard = await checkPhoneVerified(db, auth.userId)
    if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: 403 })

    const ep = body.expectedPay
    const expectedPay = typeof ep === "number" && Number.isFinite(ep) ? ep
      : typeof ep === "string" && /^\d+(\.\d+)?$/.test(ep.trim()) ? Number(ep.trim()) : undefined

    const result = await payBill(deps, auth.userId, token, amount, expectedPay)
    if (!result.ok) {
      return NextResponse.json({
        error: result.error,
        ...(result.order ? { reference: result.order.reference_code } : {}),
        ...(result.quote ? { quote: result.quote } : {}),
      }, { status: result.status })
    }
    const o = result.order
    return NextResponse.json({
      success: true,
      order: {
        id: o.id, reference_code: o.reference_code, biller: o.biller, amount: o.amount, status: o.status, payment_status: o.payment_status,
        faceAmount: o.amount, paidAmount: o.paid_amount ?? o.amount, cashback: o.cashback_amount ?? 0,
      },
    })
  } catch (e) {
    console.error("[bills] pay error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
