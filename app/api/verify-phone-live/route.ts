import { NextRequest, NextResponse, after } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { verifyRecipientsForOrder } from "@/lib/mtn-providers/customer-verification"
import { getNoticeMode, webCustomerNotice, dealerNotice } from "@/lib/blocked-numbers/notice"
import { supabaseAdmin } from "@/lib/supabase"
import { PREVIEW_SURFACES, type BlockContext, type BlockSurface } from "@/lib/blocked-numbers/types"

const MAX_PHONES = 100

const SLUG_TTL_MS = 5 * 60 * 1000
const SLUG_MEMO_MAX = 500
const slugMemo = new Map<string, { shopId: string | null; at: number }>()

function bearerToken(request: NextRequest): string | null {
  const m = /^Bearer\s+(\S{1,4096})$/i.exec(request.headers.get("authorization") ?? "")
  return m ? m[1] : null
}

/** Verified user id for a Supabase access token; null when invalid. Never throws. */
async function resolveUserId(token: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token)
    if (error) return null
    return typeof data?.user?.id === "string" ? data.user.id : null
  } catch (err) {
    console.error("[VERIFY-PHONE-LIVE] session lookup failed:", err instanceof Error ? err.name : "UnknownError")
    return null
  }
}

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

/**
 * The refusal sentence the client shows in place of its default text: only when the gate blocks and some number is
 * unverified, and only for the three preview surfaces. Never throws (any failure is no notice).
 */
async function blockedNotice(surface: unknown, blocking: boolean, results: { verified: boolean }[]): Promise<string | null> {
  if (!blocking || !results.some(r => !r.verified)) return null
  try {
    const mode = await getNoticeMode()
    // Off: clients keep their own unchanged text.
    if (mode === "off") return null
    if (surface === "storefront_preview") return webCustomerNotice(mode)
    if (surface === "dashboard_preview" || surface === "dashboard_bulk_preview") return dealerNotice(mode)
    return null
  } catch {
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
    // The context is built lazily (only when a number was blocked) and the recording runs after the response.
    let context: (() => Promise<BlockContext | null>) | undefined
    if (typeof surface === "string" && (PREVIEW_SURFACES as readonly string[]).includes(surface)) {
      const s = surface as BlockSurface
      if (s === "storefront_preview") {
        context = async () => ({ surface: s, shopId: await resolveShopId(shopSlug) })
      } else {
        // Dealer previews are attributed only to a verified session; no valid token means nothing is recorded.
        const token = bearerToken(request)
        if (token) {
          context = async () => {
            const userId = await resolveUserId(token)
            return userId ? { surface: s, userId } : null
          }
        }
      }
    }
    const { verdicts, blocking } = await verifyRecipientsForOrder(
      phones,
      // Unauthenticated endpoint: never start background strict supplier asks from here.
      context ? { context, defer: (task) => after(() => task()), strictBackground: false } : { strictBackground: false }
    )
    const results = phones.map(phone => ({ phone, verified: verdicts.get(phone) !== false }))
    return NextResponse.json({ results, blocking, notice: await blockedNotice(surface, blocking, results) })
  } catch (error) {
    // Fail open — a broken verification check must never block checkout.
    console.error("[VERIFY-PHONE-LIVE] Error, failing open:", error)
    return NextResponse.json({ results: phones.map(phone => ({ phone, verified: true })), blocking: false, notice: null })
  }
}
