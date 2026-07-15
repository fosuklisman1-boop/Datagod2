import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Slug rotation for incident response. When a shop is under sustained attack,
// the owner (or an admin) can rotate the public slug. Effects:
//  - Attacker's hardcoded /shop/<old-slug> URL stops working (404 at lookup time)
//  - All __shop_sess cookies bound to the old slug fail signature/slug check
//  - Legit customers must learn the new URL from the merchant's own channels
//
// Accepts an optional `newSlug` in the body; otherwise generates a random one
// of the form: <kebab-prefix>-<8-char-random>.

function generateSlug(prefix?: string): string {
  const cleanPrefix = (prefix || "shop")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
  const chars = "abcdefghjkmnpqrstuvwxyz23456789"
  let suffix = ""
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)]
  return `${cleanPrefix}-${suffix}`
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,59}$/.test(slug) && !slug.includes("--")
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: shopId } = await params

    // Auth: must be the shop owner OR an admin
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 })
    }
    const { data: { user } } = await supabase.auth.getUser(authHeader.slice(7))
    if (!user) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 })
    }

    const { data: shop, error: shopErr } = await supabase
      .from("user_shops")
      .select("id, user_id, shop_slug, shop_name")
      .eq("id", shopId)
      .single()
    if (shopErr || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    let isAdmin = false
    if (shop.user_id !== user.id) {
      const { data: userRow } = await supabase.from("users").select("role").eq("id", user.id).single()
      isAdmin = userRow?.role === "admin"
      if (!isAdmin) {
        return NextResponse.json({ error: "Forbidden: not the shop owner" }, { status: 403 })
      }
    }

    // Optional body: { newSlug?: string }
    let bodyNewSlug: string | undefined
    try {
      const body = await request.json().catch(() => ({}))
      if (typeof body?.newSlug === "string") bodyNewSlug = body.newSlug.trim().toLowerCase()
    } catch { /* ignore body parse errors */ }

    // Validate or auto-generate the new slug
    let newSlug = bodyNewSlug || generateSlug(shop.shop_name || "shop")
    if (!isValidSlug(newSlug)) {
      return NextResponse.json(
        { error: "Invalid slug. Use lowercase letters, digits, single hyphens (3-60 chars)." },
        { status: 400 }
      )
    }

    // Ensure uniqueness; if a collision, append a random suffix and retry once
    const { data: collision } = await supabase
      .from("user_shops")
      .select("id")
      .eq("shop_slug", newSlug)
      .neq("id", shopId)
      .maybeSingle()
    if (collision) {
      if (bodyNewSlug) {
        return NextResponse.json({ error: "That slug is already taken." }, { status: 409 })
      }
      // Auto-generated: regenerate with a stronger suffix
      newSlug = generateSlug(shop.shop_name || "shop") + "-" + Math.random().toString(36).slice(2, 6)
    }

    const { error: updateErr } = await supabase
      .from("user_shops")
      .update({ shop_slug: newSlug })
      .eq("id", shopId)
    if (updateErr) {
      console.error(`[ROTATE-SLUG] DB update failed for shop ${shopId}:`, updateErr)
      return NextResponse.json({ error: "Failed to rotate slug" }, { status: 500 })
    }

    // Record the OLD slug so /shop/<old-slug> can redirect to the new storefront
    // (old customer links keep working — see /api/shop/resolve-alias). Guarded and
    // non-fatal: rotation must still succeed if the previous_slugs column isn't
    // present yet (pre-migration) or the read/write errors.
    try {
      let prior: string[] = []
      const { data: cur } = await supabase
        .from("user_shops")
        .select("previous_slugs")
        .eq("id", shopId)
        .maybeSingle()
      if (Array.isArray((cur as any)?.previous_slugs)) prior = (cur as any).previous_slugs
      // Keep the old slug; drop the new one if it was ever a prior slug (avoids a
      // self-redirect loop where the current slug also maps back to itself).
      const merged = Array.from(new Set([...prior, shop.shop_slug].filter(Boolean))).filter(s => s !== newSlug)
      await supabase.from("user_shops").update({ previous_slugs: merged }).eq("id", shopId)
    } catch (e) {
      console.warn(`[ROTATE-SLUG] previous_slugs record skipped for shop ${shopId}:`, e)
    }

    console.log(`[ROTATE-SLUG] ✓ Shop ${shopId} slug rotated: ${shop.shop_slug} → ${newSlug} (by user ${user.id}${isAdmin ? ", admin" : ""})`)

    return NextResponse.json({
      success: true,
      shopId,
      oldSlug: shop.shop_slug,
      newSlug,
      newUrl: `/shop/${newSlug}`,
    })
  } catch (e) {
    console.error("[ROTATE-SLUG] Unexpected error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
