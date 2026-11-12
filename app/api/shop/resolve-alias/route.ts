import { NextRequest, NextResponse } from "next/server"
import { sanitizeShopHandle } from "@/lib/shop-handle"
import { resolveShopAlias } from "@/lib/shop-commerce/shop-lookup"

// Resolve a rotated/old shop slug to the shop's CURRENT slug so old storefront
// links can redirect instead of 404ing. Service-role (bypasses grants) — the
// previous_slugs column is private and never exposed to the anon client.
export async function GET(request: NextRequest) {
  const raw = new URL(request.url).searchParams.get("slug") || ""
  if (!sanitizeShopHandle(raw)) {
    return NextResponse.json({ currentSlug: null }, { status: 400 })
  }
  const alias = await resolveShopAlias(raw)
  if (!alias) {
    return NextResponse.json({ currentSlug: null }, { status: 404 })
  }
  return NextResponse.json(
    { currentSlug: alias.shop_slug },
    { headers: { "Cache-Control": "no-store" } }
  )
}
