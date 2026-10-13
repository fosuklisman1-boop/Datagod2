import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { isRegisteredNavHref, sanitizeNavClicks } from "@/lib/nav-new"

/**
 * Sidebar "NEW" tag click counts for the CURRENT user (see lib/nav-new.ts).
 *   GET  -> { success, data: { clicks: { [href]: 0..2 } } }   (registry hrefs only)
 *   POST { href } -> { success, data: { href, clicks } }      (atomic, capped at 2)
 * Identity comes only from the Bearer token; table user_nav_clicks is service-role only.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function resolveUser(request: NextRequest) {
  const authHeader = request.headers.get("Authorization")
  if (!authHeader?.startsWith("Bearer ")) return null
  const supabase = serviceClient()
  const { data: { user }, error } = await supabase.auth.getUser(authHeader.slice(7))
  if (error || !user) return null
  return { supabase, userId: user.id }
}

const unauthorized = () => NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })

export async function GET(request: NextRequest) {
  const auth = await resolveUser(request)
  if (!auth) return unauthorized()

  const { data, error } = await auth.supabase
    .from("user_nav_clicks")
    .select("href, clicks")
    .eq("user_id", auth.userId)
  if (error) {
    console.error("[/api/user/nav-new] read failed:", error.message, (error as { code?: string }).code)
    return NextResponse.json({ success: false, error: "read_failed" }, { status: 500 })
  }

  const raw: Record<string, unknown> = {}
  for (const row of (data ?? []) as Array<{ href: string; clicks: number }>) raw[row.href] = row.clicks
  return NextResponse.json({ success: true, data: { clicks: sanitizeNavClicks(raw) } })
}

export async function POST(request: NextRequest) {
  const auth = await resolveUser(request)
  if (!auth) return unauthorized()

  const rate = await applyRateLimit(request, "user_nav_new_click", 60, 60 * 1000, auth.userId)
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 })
  }
  const href = (body as { href?: unknown } | null)?.href
  if (!isRegisteredNavHref(href)) {
    return NextResponse.json({ success: false, error: "Unknown nav item" }, { status: 400 })
  }

  const { data, error } = await auth.supabase.rpc("nav_click", { p_user_id: auth.userId, p_href: href })
  if (error) {
    console.error("[/api/user/nav-new] nav_click failed:", error.message)
    return NextResponse.json({ success: false, error: "write_failed" }, { status: 500 })
  }
  const clicks = typeof data === "number" ? data : Number(data)
  return NextResponse.json({ success: true, data: { href, clicks: Number.isFinite(clicks) ? clicks : 0 } })
}
