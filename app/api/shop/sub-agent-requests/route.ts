import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { applyRateLimit } from "@/lib/rate-limiter"
import { verifyTurnstileToken, getRequestIp, isTurnstileEnabled } from "@/lib/turnstile"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Customer-initiated "become a sub-agent" request. Public/guest-submittable --
// the existing shop_invites flow only ever runs owner-first (owner generates
// a code and shares it); this is the missing other direction. Approval (see
// [id]/route.ts) generates a real shop_invites row via the same accept flow
// the owner-initiated path already uses, rather than a second code path.
export async function POST(request: NextRequest) {
  try {
    const rateLimit = await applyRateLimit(request, "sub_agent_request", 5, 60 * 1000)
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 })
    }

    const body = await request.json()
    const { shopSlug, requesterName, requesterPhone, requesterEmail, message, turnstileToken, website: honeypot } = body

    if (!shopSlug || typeof shopSlug !== "string" || !shopSlug.trim()) {
      return NextResponse.json({ error: "shopSlug is required" }, { status: 400 })
    }

    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      console.warn("[SUB-AGENT-REQUEST] Honeypot tripped")
      return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    }

    if (!requesterName?.trim() || !requesterPhone?.trim()) {
      return NextResponse.json({ error: "Name and phone number are required" }, { status: 400 })
    }

    const { data: shopRow, error: shopErr } = await supabase
      .from("user_shops")
      .select("id, is_active")
      .or(shopHandleOrFilter(shopSlug.trim()))
      .single()
    if (shopErr || !shopRow) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }
    if (!shopRow.is_active) {
      return NextResponse.json({ error: "This shop isn't accepting sub-agent requests right now." }, { status: 400 })
    }

    const turnstileEnabled = await isTurnstileEnabled()
    if (turnstileEnabled) {
      const turnstileResult = await verifyTurnstileToken(turnstileToken, getRequestIp(request.headers))
      if (!turnstileResult.valid) {
        return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
      }
    }

    // One pending request per phone per shop — avoid a repeat-click flood.
    const { data: existing } = await supabase
      .from("sub_agent_requests")
      .select("id")
      .eq("shop_id", shopRow.id)
      .eq("requester_phone", requesterPhone.trim())
      .eq("status", "pending")
      .maybeSingle()
    if (existing) {
      return NextResponse.json({ error: "You already have a pending request with this shop. Please wait for a response." }, { status: 400 })
    }

    const { error: insertErr } = await supabase.from("sub_agent_requests").insert({
      shop_id: shopRow.id,
      requester_name: requesterName.trim(),
      requester_phone: requesterPhone.trim(),
      requester_email: requesterEmail?.trim() || null,
      message: message?.trim() || null,
    })
    if (insertErr) {
      console.error("[SUB-AGENT-REQUEST] Insert failed:", insertErr.message)
      return NextResponse.json({ error: "Could not submit your request. Please try again." }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[SUB-AGENT-REQUEST] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// GET: list this shop owner's pending requests (dashboard).
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()
    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    const { data: requests, error: reqError } = await supabase
      .from("sub_agent_requests")
      .select("*")
      .eq("shop_id", shop.id)
      .order("created_at", { ascending: false })
    if (reqError) throw reqError

    return NextResponse.json({ success: true, requests: requests || [] })
  } catch (error) {
    console.error("[SUB-AGENT-REQUEST] GET error:", error)
    return NextResponse.json({ error: "Failed to load requests. Please try again." }, { status: 500 })
  }
}
