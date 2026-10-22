import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { parseImageDataUri } from "@/lib/shop-logo-public"

// Serves a shop's logo when it's stored as an embedded base64 image (legacy
// uploads, up to ~8 MB). The storefront now links to this URL instead of copying
// the whole image into every page, so a page weighs KB instead of MB. The image
// is public by design (it's the logo shown on the storefront) and cached at the
// CDN for a day; the ?v= query on the link changes whenever the logo does.
//
// Only active shops, and only JPEG/PNG/WebP/GIF - never SVG (scripts) - with
// nosniff + a sandbox CSP so it can only ever render as an image.

const NOT_FOUND_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" }

const notFound = () => new NextResponse(null, { status: 404, headers: NOT_FOUND_HEADERS })

export async function GET(_request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  const { data } = await supabase
    .from("user_shops")
    .select("logo_url")
    .or(shopHandleOrFilter(slug))
    .eq("is_active", true)
    .single()

  const logo = (data as { logo_url?: string | null } | null)?.logo_url?.trim()
  if (!logo) return notFound()

  const image = parseImageDataUri(logo)
  if (!image) return notFound()

  return new NextResponse(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.length),
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  })
}
