import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyRecipientsForOrder } from "@/lib/mtn-providers/customer-verification"
import { supabaseAdmin } from "@/lib/supabase"
import { PREVIEW_SURFACES, type BlockContext, type BlockSurface } from "@/lib/blocked-numbers/types"

const MAX_PHONES = 100

const SLUG_TTL_MS = 5 * 60 * 1000
const SLUG_MEMO_MAX = 500
const slugMemo = new Map<string, { shopId: string | null; at: number }>()

/** Resolves a public shop slug to user_shops.id; null when unknown. Never throws (fails open). */
async function resolveShopId(slug: unknown): Promise<string | null> {
  if (typeof slug !== "string") return null
  const clean = slug.trim().toLowerCase()
  // Slugs are lowercase alphanumerics and dashes; anything else can't match and must not reach the filter.
  if (!/^[a-z0-9-]{1,64}$/.test(clean)) return null
  const hit = slugMemo.get(clean)
  if (hit && Date.now() - hit.at < SLUG_TTL_MS) return hit.shopId
  try {
    const { data, error } = await supabaseAdmin
      .from("user_shops")
      .select("id")
      .or(`shop_slug.eq.${clean},subdomain.eq.${clean}`)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    if (error) return null
    const shopId = typeof data?.id === "string" ? data.id : null
    if (slugMemo.size >= SLUG_MEMO_MAX) slugMemo.clear()
    slugMemo.set(clean, { shopId, at: Date.now() })
    return shopId
  } catch (err) {
    console.error("[VERIFY-PHONE-LIVE] shop slug lookup failed:", err instanceof Error ? err.name : "UnknownError")
    return null
  }
}

export async function POST(request: NextRequest) {
  const rateLimit = await applyRateLimit(
    request,
    "verify_phone_live",
    RATE_LIMITS.VERIFY_PHONE_LIVE.maxRequests,
    RATE_LIMITS.VERIFY_PHONE_LIVE.windowMs
  )
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.VERIFY_PHONE_LIVE.message },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": RATE_LIMITS.VERIFY_PHONE_LIVE.maxRequests.toString(),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": new Date(rateLimit.resetAt).toISOString(),
        },
      }
    )
  }

  let phones: unknown
  let surface: unknown
  let shopSlug: unknown
  try {
    const body = await request.json()
    phones = body?.phones
    surface = body?.surface
    shopSlug = body?.shop_slug
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(phones) || phones.length === 0 || !phones.every(p => typeof p === "string")) {
    return NextResponse.json({ error: "'phones' must be a non-empty array of strings" }, { status: 400 })
  }
  if (phones.length > MAX_PHONES) {
    return NextResponse.json({ error: `'phones' cannot exceed ${MAX_PHONES} entries` }, { status: 400 })
  }

  try {
    // Only a positive reject reads as unverified; an unchecked number
    // (provider outage/timeout) is shown as verified, matching the order gate.
    // Record blocks only for the known preview surfaces; the purchaser phone is never read from the body.
    let context: BlockContext | undefined
    if (typeof surface === "string" && (PREVIEW_SURFACES as readonly string[]).includes(surface)) {
      context = { surface: surface as BlockSurface, shopId: await resolveShopId(shopSlug) }
    }
    const { verdicts, blocking } = await verifyRecipientsForOrder(phones, context ? { context } : {})
    const results = phones.map(phone => ({ phone, verified: verdicts.get(phone) !== false }))
    return NextResponse.json({ results, blocking })
  } catch (error) {
    // Fail open — a broken verification check must never block checkout.
    console.error("[VERIFY-PHONE-LIVE] Error, failing open:", error)
    return NextResponse.json({ results: phones.map(phone => ({ phone, verified: true })), blocking: false })
  }
}
