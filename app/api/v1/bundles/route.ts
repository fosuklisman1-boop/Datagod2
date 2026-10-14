import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { classifyServiceError } from "@/lib/api-v1-errors"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { getCatalog } from "@/lib/standard-bundles/catalog"
import { buyBundle, isValidIdempotencyKey } from "@/lib/standard-bundles/service"
import { placeSandboxOrder, getSandboxOrder } from "@/lib/sandbox"
import { readApiSurface } from "@/lib/api-v1/surface"
import {
  NOT_AVAILABLE_BODY, buyResultResponse, findSandboxBundle, parseNetwork, parsePostBody,
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

  const respond = (statusCode: number, body: Record<string, unknown>) => {
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "GET", endpoint: "/api/v1/bundles",
      statusCode, request, durationMs: Date.now() - start, requestPayload: { network },
      ...(statusCode >= 400 ? { responsePayload: { error: body.error } } : {}),
    }).catch(() => {})
    return NextResponse.json(body, { status: statusCode })
  }

  if (user.environment === "test") {
    return respond(200, { success: true, network, categories: sandboxCatalog(network), sandbox: true })
  }

  try {
    const { deps } = getBundlesRuntime()
    const surface = await readApiSurface(() => deps.getCashbackConfig())
    if (!surface.open) return respond(403, NOT_AVAILABLE_BODY)

    const result = await getCatalog(deps, network)
    if (!result.ok) {
      return respond(result.status, result.status === 403 ? NOT_AVAILABLE_BODY : { success: false, error: result.error })
    }
    let buyer: "customer" | "dealer" = "customer"
    try { buyer = await deps.getBuyerTier(user.id) } catch { /* standard price */ }
    const categories = priceCatalog(network, result.categories.map(c => ({
      name: c.name, bundles: c.bundles.map(b => ({ token: b.token, display: b.display, amount: b.amount })),
    })), surface.cfg, buyer)

    return respond(200, { success: true, network, categories })
  } catch (e) {
    // The engines return result objects; anything thrown here is unexpected and never leaks its message.
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to load bundles")
    console.error("[V1-BUNDLES] catalog error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
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

  const respond = (statusCode: number, resBody: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const order = resBody.order as { reference?: unknown; status?: unknown } | undefined
    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/bundles",
      statusCode, request, durationMs: Date.now() - start,
      requestPayload: { phone: body.phone },
      responsePayload: statusCode < 400 && order
        ? { reference: order.reference, status: order.status, ...extra }
        : { error: resBody.error, ...extra },
    }).catch(() => {})
    return NextResponse.json(resBody, { status: statusCode })
  }

  if (user.environment === "test") {
    try {
      if (!isValidIdempotencyKey(body.idempotencyKey)) {
        return respond(400, { success: false, error: "Invalid request, please try again" }, { sandbox: true })
      }
      const bundle = findSandboxBundle(body.bundleToken)
      if (!bundle) return respond(409, { success: false, error: "Unknown bundle_token" }, { sandbox: true })
      if (!/^\d{10}$/.test(body.phone)) {
        return respond(400, { success: false, error: "phone must be a 10-digit phone number" }, { sandbox: true })
      }
      const reference = sandboxReference(body.idempotencyKey)
      const placed = await placeSandboxOrder({
        userId: user.id, apiKeyId: user.api_key_id, action: "standard_bundle", reference,
        request: { bundle_token: body.bundleToken, phone: body.phone },
        price: bundle.amount, orderFields: sandboxOrderFields(bundle, body.phone), instant: true,
      })
      if (!placed.success) {
        if (placed.status === 409) {
          // Same idempotency key: hand back the original sandbox order, no second debit (201, like a live replay).
          const prior = await getSandboxOrder(user.id, reference)
          if (prior && prior.action === "standard_bundle") {
            return respond(201, { success: true, order: { ...(prior.response as object), status: prior.status, sandbox: true } }, { sandbox: true })
          }
        }
        return respond(placed.status, { success: false, error: placed.error }, { sandbox: true })
      }
      return respond(201, { success: true, order: { ...placed.order, sandbox: true }, new_balance: placed.newBalance }, { sandbox: true })
    } catch (e) {
      const { status, publicMessage } = classifyServiceError(e, {}, "Failed to purchase bundle")
      console.error("[V1-BUNDLES] sandbox purchase error:", e instanceof Error ? e.message : "error")
      return respond(status, { success: false, error: publicMessage }, { sandbox: true })
    }
  }

  try {
    const { deps, db } = getBundlesRuntime()
    const surface = await readApiSurface(() => deps.getCashbackConfig())
    if (!surface.open) return respond(403, NOT_AVAILABLE_BODY)

    const guard = await checkPhoneVerified(db, user.id)
    if (!guard.allowed) return respond(403, { success: false, error: guard.error })

    const result = await buyBundle(deps, user.id, {
      token: body.bundleToken, phone: body.phone, idempotencyKey: body.idempotencyKey,
      expectedPay: body.expectedPay, channel: "api",
    })
    const { status, body: resBody } = buyResultResponse(result)
    return respond(status, resBody)
  } catch (e) {
    const { status, publicMessage } = classifyServiceError(e, {}, "Failed to purchase bundle")
    console.error("[V1-BUNDLES] purchase error:", e instanceof Error ? e.message : "error")
    return respond(status, { success: false, error: publicMessage })
  }
}
