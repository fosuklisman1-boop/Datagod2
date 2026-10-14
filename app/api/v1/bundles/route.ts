import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { getCatalog } from "@/lib/standard-bundles/catalog"
import { buyBundle } from "@/lib/standard-bundles/service"
import { placeSandboxOrder, getSandboxOrder } from "@/lib/sandbox"
import {
  NOT_AVAILABLE_BODY, apiSurfaceOn, buyResultResponse, findSandboxBundle, mapOrder, parseNetwork, parsePostBody,
  priceCatalog, sandboxCatalog, sandboxOrderFields, sandboxReference,
} from "@/lib/api-v1/bundles"

// A request must always die well before the 5-minute stuck-claim threshold.
export const maxDuration = 60
export const dynamic = "force-dynamic"

/** GET /api/v1/bundles?network=MTN|TELECEL|AT */
export async function GET(request: NextRequest) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })

  const limit = user.rate_limit_per_min || 60
  const rl = await applyRateLimit(request, "v1_bundles_get", limit, 60 * 1000, user.id)
  if (!rl.allowed) return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })

  const network = parseNetwork(new URL(request.url).searchParams.get("network"))
  if (!network) return NextResponse.json({ success: false, error: "network must be MTN, TELECEL or AT" }, { status: 400 })

  if (user.environment === "test") {
    return NextResponse.json({ success: true, network, categories: sandboxCatalog(network), sandbox: true })
  }

  try {
    const { deps } = getBundlesRuntime()
    const cfg = await deps.getCashbackConfig()
    if (!apiSurfaceOn(cfg)) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 403 })

    const result = await getCatalog(deps, network)
    if (!result.ok) {
      const body = result.status === 403 ? NOT_AVAILABLE_BODY : { success: false, error: result.error }
      return NextResponse.json(body, { status: result.status })
    }
    let buyer: "customer" | "dealer" = "customer"
    try { buyer = await deps.getBuyerTier(user.id) } catch { /* standard price */ }
    const categories = priceCatalog(network, result.categories.map(c => ({
      name: c.name, bundles: c.bundles.map(b => ({ token: b.token, display: b.display, amount: b.amount })),
    })), cfg, buyer)

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bundles",
      statusCode: 200, request, durationMs: Date.now() - start, requestPayload: { network },
    }).catch(() => {})
    return NextResponse.json({ success: true, network, categories })
  } catch (e) {
    console.error("[V1-BUNDLES] catalog error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ success: false, error: "Failed to load bundles" }, { status: 500 })
  }
}

/** POST /api/v1/bundles  { bundle_token, phone, idempotency_key, expected_pay? } */
export async function POST(request: NextRequest) {
  const start = Date.now()
  const user = await authenticateApiKey(request)
  if (!user) return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })

  const limit = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(limit / 3))
  const rl = await applyRateLimit(request, "v1_bundles_post", postLimit, 60 * 1000, user.id)
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  let raw: any
  try { raw = await request.json() } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const body = parsePostBody(raw)
  if (!body.ok) return NextResponse.json({ success: false, error: body.error }, { status: 400 })

  if (user.environment === "test") {
    const bundle = findSandboxBundle(body.bundleToken)
    if (!bundle) return NextResponse.json({ success: false, error: "Unknown bundle_token" }, { status: 409 })
    if (!/^\d{10}$/.test(body.phone)) {
      return NextResponse.json({ success: false, error: "phone must be a 10-digit phone number" }, { status: 400 })
    }
    const reference = sandboxReference(body.idempotencyKey)
    const placed = await placeSandboxOrder({
      userId: user.id, apiKeyId: user.api_key_id, action: "standard_bundle", reference,
      request: { bundle_token: body.bundleToken, phone: body.phone },
      price: bundle.amount, orderFields: sandboxOrderFields(bundle, body.phone), instant: true,
    })
    if (!placed.success) {
      if (placed.status === 409) {
        // Same idempotency key: hand back the original sandbox order, no second debit.
        const prior = await getSandboxOrder(user.id, reference)
        if (prior) return NextResponse.json({ success: true, order: { ...(prior.response as object), status: prior.status, sandbox: true } })
      }
      return NextResponse.json({ success: false, error: placed.error }, { status: placed.status })
    }
    return NextResponse.json({ success: true, order: { ...placed.order, sandbox: true }, new_balance: placed.newBalance }, { status: 201 })
  }

  try {
    const { deps, db } = getBundlesRuntime()
    const cfg = await deps.getCashbackConfig()
    if (!apiSurfaceOn(cfg)) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 403 })

    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) return NextResponse.json({ success: false, error: guard.error }, { status: 403 })

    const result = await buyBundle(deps, user.id, {
      token: body.bundleToken, phone: body.phone, idempotencyKey: body.idempotencyKey,
      expectedPay: body.expectedPay, channel: "api",
    })
    const { status, body: resBody } = buyResultResponse(result)

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bundles",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { phone: body.phone },
      responsePayload: result.ok ? { reference: mapOrder(result.order).reference, status: result.order.status } : { error: result.error },
    }).catch(() => {})
    return NextResponse.json(resBody, { status })
  } catch (e) {
    console.error("[V1-BUNDLES] purchase error:", e instanceof Error ? e.message : "error")
    return NextResponse.json({ success: false, error: "Failed to purchase bundle" }, { status: 500 })
  }
}
