import { NextRequest, NextResponse, after } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBundlesRuntime, pickOrder } from "@/lib/standard-bundles/runtime"
import { buyBundle } from "@/lib/standard-bundles/service"
import { buySpecial } from "@/lib/standard-bundles/special-service"
import { buildSpecialDeps } from "@/lib/standard-bundles/special-runtime"
import { isSpecialTokenSigned } from "@/lib/standard-bundles/token"
import { authenticate, readJson } from "@/lib/bills/route-auth"

// 300s: room for the Special dispatch loop, which stops itself after a 240s budget (special-service.ts). A normal
// buy only gains headroom.
export const maxDuration = 300

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

    const ep = body.expectedPay
    const expectedPay = typeof ep === "number" && Number.isFinite(ep) ? ep
      : typeof ep === "string" && /^\d+(\.\d+)?$/.test(ep.trim()) ? Number(ep.trim()) : undefined

    // Special Bundles: a token carrying the special MAC goes to buySpecial (which verifies it in full, freshness
    // included, after its replay lookup). Every other token takes the normal path below, unchanged.
    if (isSpecialTokenSigned(token, deps.secret)) {
      const s = await buySpecial(buildSpecialDeps(deps, db, after), auth.userId, { token, phone, idempotencyKey, expectedPay })
      if (!s.ok) {
        return NextResponse.json({ success: false, error: s.error, ...(s.quote ? { quote: s.quote } : {}) }, { status: s.status })
      }
      return NextResponse.json({ success: true, order: pickOrder(s.order), special: s.special })
    }

    const result = await buyBundle(deps, auth.userId, { token, phone, idempotencyKey, expectedPay })
    if (!result.ok) {
      return NextResponse.json(
        {
          success: false, error: result.error,
          ...(result.order ? { order: pickOrder(result.order) } : {}),
          ...(result.quote ? { quote: result.quote } : {}),
        },
        { status: result.status },
      )
    }
    return NextResponse.json({ success: true, order: pickOrder(result.order) })
  } catch (e) {
    console.error("[bundles] buy error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
