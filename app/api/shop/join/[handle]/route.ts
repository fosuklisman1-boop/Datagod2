import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { isTurnstileEnabled, verifyTurnstileToken, getRequestIp } from "@/lib/turnstile"
import { targetStatus } from "@/lib/sub-agents/join-eligibility"
import {
  cleanShopName,
  joinExistingUser,
  readOpenJoinEnabled,
  startJoinIntent,
  validateRecruitShopName,
  type TargetShop,
} from "@/lib/sub-agents/join"
import { getWholesalePackages } from "@/lib/sub-agents/wholesale-packages"
import { CustomPriceReadError } from "@/lib/pricing/package-price"

export const dynamic = "force-dynamic"

interface Params {
  params: Promise<{ handle: string }>
}

// Its own query: a missing column (code deployed before migration 0146) means off, not an error.
const readSubAgentOpenJoin = () => readOpenJoinEnabled(supabaseAdmin)

// GET: public join page data. Returns only { status, shop_name, wholesale_packages }; only { status } when closed.
export async function GET(request: NextRequest, { params }: Params) {
  const rl = await applyRateLimit(request, "shop_join_page", 30, 60_000)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": "60" } }
    )
  }
  try {
    const { handle } = await params
    const trimmed = (handle || "").trim()
    if (!trimmed) return NextResponse.json({ status: "closed" })

    const enabled = await readSubAgentOpenJoin()
    if (!enabled) return NextResponse.json({ status: "closed" })

    const { data: shop, error } = await supabaseAdmin
      .from("user_shops")
      .select("id, shop_name, is_active, is_blocked, parent_shop_id")
      .or(shopHandleOrFilter(trimmed))
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error("join page shop lookup failed:", error.code, error.message)
      return NextResponse.json({ error: "Failed to load. Please try again." }, { status: 500 })
    }

    if (!shop || targetStatus(shop, enabled) !== "open") {
      return NextResponse.json({ status: "closed" })
    }

    let wholesale_packages
    try {
      wholesale_packages = await getWholesalePackages(supabaseAdmin, shop.id)
    } catch (e) {
      if (e instanceof CustomPriceReadError) {
        return NextResponse.json({ error: "Prices are unavailable right now. Please try again." }, { status: 503 })
      }
      throw e
    }

    return NextResponse.json({ status: "open", shop_name: shop.shop_name, wholesale_packages })
  } catch (error) {
    console.error("Error loading join page:", (error as Error)?.message)
    return NextResponse.json({ error: "Failed to load. Please try again." }, { status: 500 })
  }
}

const CLOSED_MESSAGE = "This shop isn't taking sub-agents right now."

// POST: join this shop as a sub-agent.
//  - logged out: { first_name, last_name, email, phone, password, shop_name, turnstileToken, website }
//    → { status: "confirm_email" } (shop, code and alert are created when the email link is clicked)
//  - Bearer token: { shop_name, turnstileToken, website } → { status: "joined", target }
export async function POST(request: NextRequest, { params }: Params) {
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // Honeypot: a hidden field real visitors never fill.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    console.warn("[SUB-AGENT-JOIN] honeypot tripped")
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const rl = await applyRateLimit(request, "sub_agent_join", RATE_LIMITS.SIGNUP.maxRequests, RATE_LIMITS.SIGNUP.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.SIGNUP.message },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))) } }
    )
  }

  if (await isTurnstileEnabled()) {
    const ts = await verifyTurnstileToken(body.turnstileToken, getRequestIp(request.headers))
    if (!ts.valid) {
      console.warn("[SUB-AGENT-JOIN] turnstile failed:", ts.reason)
      return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 403 })
    }
  }

  try {
    const { handle } = await params
    const trimmed = (handle || "").trim()
    const enabled = await readSubAgentOpenJoin()
    if (!trimmed || !enabled) {
      return NextResponse.json({ status: "closed", error: CLOSED_MESSAGE }, { status: 403 })
    }

    const { data: shop, error: shopErr } = await supabaseAdmin
      .from("user_shops")
      .select("id, shop_name, tier_level, is_active, is_blocked, parent_shop_id")
      .or(shopHandleOrFilter(trimmed))
      .limit(1)
      .maybeSingle()
    if (shopErr) {
      console.error("[SUB-AGENT-JOIN] shop lookup failed:", shopErr.code, shopErr.message)
      return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
    }
    if (!shop || targetStatus(shop, enabled) !== "open") {
      return NextResponse.json({ status: "closed", error: CLOSED_MESSAGE }, { status: 403 })
    }
    const parent = shop as TargetShop

    const shopName = cleanShopName(body.shop_name)
    const nameError = validateRecruitShopName(shopName)
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 })

    const authHeader = request.headers.get("authorization")
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim()
      const { data: tokenUser, error: tokenErr } = await supabaseAdmin.auth.getUser(token)
      if (tokenErr || !tokenUser?.user?.id) {
        return NextResponse.json({ error: "Your session has expired. Please log in again." }, { status: 401 })
      }
      const outcome = await joinExistingUser(supabaseAdmin, { userId: tokenUser.user.id, parent, shopName })
      return NextResponse.json(outcome.body, { status: outcome.httpStatus })
    }

    // New accounts only: the admin's global sign-up switch applies.
    const { data: settings } = await supabaseAdmin
      .from("app_settings")
      .select("signups_enabled")
      .is("key", null)
      .maybeSingle()
    if (settings && (settings as { signups_enabled?: boolean }).signups_enabled === false) {
      return NextResponse.json(
        { error: "New user registrations are currently disabled by the administrator." },
        { status: 403 }
      )
    }

    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "", {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    // A fixed origin keeps the confirmation link off attacker-chosen Host headers.
    const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin

    const outcome = await startJoinIntent(supabaseAdmin, {
      anon,
      origin,
      parentShopId: parent.id,
      firstName: body.first_name,
      lastName: body.last_name,
      email: body.email,
      phone: body.phone,
      password: body.password,
      shopName,
    })
    return NextResponse.json(outcome.body, { status: outcome.httpStatus })
  } catch (error: any) {
    console.error("[SUB-AGENT-JOIN] error:", error?.code ?? "", error?.message ?? "")
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 })
  }
}
