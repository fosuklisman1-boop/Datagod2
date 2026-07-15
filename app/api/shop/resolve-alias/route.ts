import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sanitizeShopHandle } from "@/lib/shop-handle"

// Resolve a rotated/old shop slug to the shop's CURRENT slug so old storefront
// links can redirect instead of 404ing. Service-role (bypasses grants) — the
// previous_slugs column is private and never exposed to the anon client.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get("slug") || ""
  const slug = sanitizeShopHandle(raw)
  if (!slug) {
    return NextResponse.json({ currentSlug: null }, { status: 400 })
  }

  try {
    // Match a shop that once used this slug and is still active. `.contains`
    // maps to PostgREST's array-contains (previous_slugs @> {slug}). If the
    // column doesn't exist yet (pre-migration), this errors and we fall through
    // to a null result — the caller just shows the normal "not found".
    const { data, error } = await supabase
      .from("user_shops")
      .select("shop_slug")
      .contains("previous_slugs", [slug])
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()

    if (error || !data?.shop_slug || data.shop_slug === slug) {
      return NextResponse.json({ currentSlug: null }, { status: 404 })
    }
    return NextResponse.json(
      { currentSlug: data.shop_slug },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return NextResponse.json({ currentSlug: null }, { status: 404 })
  }
}
