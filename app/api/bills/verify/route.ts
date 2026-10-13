import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBillsRuntime } from "@/lib/bills/runtime"
import { verifyBill } from "@/lib/bills/service"
import { authenticate, readJson } from "@/lib/bills/route-auth"

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const rl = await applyRateLimit(request, "bills_verify", 20, 60_000, auth.userId)
    if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    const body = await readJson(request)
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

    const { deps, db } = getBillsRuntime()
    const guard = await checkPhoneVerified(db, auth.userId)
    if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: 403 })

    const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined)
    const result = await verifyBill(deps, auth.userId, String(body.biller ?? ""), {
      phone: s(body.phone), account: s(body.account), email: s(body.email), broadbandAccount: s(body.broadbandAccount),
      addMeter: body.addMeter === true, consent: body.consent === true,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    const { ok: _ok, ...rest } = result
    return NextResponse.json({ success: true, ...rest })
  } catch (e) {
    console.error("[bills] verify error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
