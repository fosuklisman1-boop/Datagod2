import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { buildProductsCatalog } from "@/lib/products-catalog"

/**
 * GET /api/v1/products
 * Read-only catalog of purchasable products and current prices.
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_products_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: `Rate limit exceeded. Max ${rateLimitCount} requests/minute.` },
      { status: 429 }
    )
  }

  let catalog
  try {
    catalog = await buildProductsCatalog(user.role)
  } catch (err) {
    console.error("[API v1] Failed to build products catalog:", err)
    const durationMs = Date.now() - start

    logApiRequest({
      userId: user.id,
      apiKeyId: user.api_key_id,
      method: "GET",
      endpoint: "/api/v1/products",
      statusCode: 500,
      request,
      durationMs,
      responsePayload: { error: "Failed to fetch product catalog" },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: "Failed to fetch product catalog" }, { status: 500 })
  }

  const durationMs = Date.now() - start

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "GET",
    endpoint: "/api/v1/products",
    statusCode: 200,
    request,
    durationMs,
    responsePayload: { data_bundles_count: catalog.data_bundles.length },
  }).catch(() => {})

  return NextResponse.json({ success: true, ...catalog })
}
