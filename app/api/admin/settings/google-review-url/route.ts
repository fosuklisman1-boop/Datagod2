import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { parseReviewUrl, validateReviewUrl, REVIEW_URL_SETTING_KEY } from "@/lib/review-prompt"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", REVIEW_URL_SETTING_KEY)
    .maybeSingle()
  if (error) return NextResponse.json({ error: "Failed to load review link" }, { status: 500 })
  return NextResponse.json({ url: parseReviewUrl(data?.value) })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: { url?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const result = validateReviewUrl(body?.url)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: REVIEW_URL_SETTING_KEY, value: JSON.stringify({ url: result.value }) }, { onConflict: "key" })
  if (error) return NextResponse.json({ error: "Failed to save review link" }, { status: 500 })

  console.log(`[google-review-url] Updated: ${result.value ? "set" : "cleared"}`)
  return NextResponse.json({ success: true, url: result.value })
}
