import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBundlesRuntime, pickOrder } from "@/lib/standard-bundles/runtime"
import { buyBundle } from "@/lib/standard-bundles/service"
import { authenticate, readJson } from "@/lib/bills/route-auth"

// A request must always die well before the 5-minute stuck-claim threshold.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticate(request)
    if ("response" in auth) return auth.response
    const rl = await applyRateLimit(request, "bundles_buy", 10, 60_000, auth.userId)
    if (!rl.allowed) return NextResponse.json({ success: false, error: "Too many requests. Please slow down." }, { status: 429 })
    const body = await readJson(request)
    if (!body) return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })

    const { token, phone, idempotencyKey } = body
    if (typeof token !== "string" || !token || typeof phone !== "string" || !phone || typeof idempotencyKey !== "string" || !idempotencyKey) {
      return NextResponse.json({ success: false, error: "token, phone and idempotencyKey are required" }, { status: 400 })
    }

    const { deps, db } = getBundlesRuntime()
    const guard = await checkPhoneVerified(db, auth.userId)
    if (!guard.allowed) return NextResponse.json({ success: false, error: guard.error }, { status: 403 })

    const result = await buyBundle(deps, auth.userId, { token, phone, idempotencyKey })
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, ...(result.order ? { order: pickOrder(result.order) } : {}) },
        { status: result.status },
      )
    }
    return NextResponse.json({ success: true, order: pickOrder(result.order) })
  } catch (e) {
    console.error("[bundles] buy error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
