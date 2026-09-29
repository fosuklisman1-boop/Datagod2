import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Server-side shop management (owner-only writes). Migration 0077 revoked
// INSERT/UPDATE/DELETE on user_shops + shop_packages from the browser
// (`authenticated`) client, so the direct writes in shopService/shopPackageService
// now fail with "permission denied for table ...". This service-role route restores
// them while ENFORCING ownership server-side and whitelisting the editable columns
// (an owner must never set is_active / is_blocked / user_id / parent_shop_id from
// the browser — those are admin/server-controlled). One endpoint, dispatched by
// `action`, mirrors the four operations the My Shop page performs.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// Columns a shop owner may edit on their own shop. Deliberately excludes
// is_active, is_blocked, user_id, parent_shop_id, shop_slug, subdomain.
const EDITABLE_SHOP_FIELDS = new Set([
  "shop_name",
  "description",
  "logo_url",
  "banner_url",
  "airtime_markup_mtn",
  "airtime_markup_telecel",
  "airtime_markup_at",
  "results_checker_markup_wassce",
  "results_checker_markup_bece",
  "results_checker_markup_novdec",
  "results_check_markup",
  "afa_price",
  "custom_color",
  "custom_color_2",
  "section_divider_style",
])

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const DIVIDER_STYLES = new Set([
  "asymmetrical-curve", "angled-divider", "geometric-zigzag", "concave-curve", "animated-wave",
  "layered-waves", "tilt-divider", "organic-blob", "paper-cut", "torn-edge",
  "convex-curve", "slant-transition", "skewed-transition", "glassmorphic-glow", "multi-step-wave",
])

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

// Confirm the authenticated user owns the given shop.
async function assertOwnsShop(shopId: string, userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("user_shops")
    .select("id, user_id")
    .eq("id", shopId)
    .maybeSingle()
  if (error) return "Could not verify shop ownership"
  if (!data || data.user_id !== userId) return "You do not have permission to manage this shop"
  return null
}

// Resolve the shop owning a shop_packages row, then confirm ownership.
async function assertOwnsPackage(shopPackageId: string, userId: string): Promise<string | null> {
  const { data: pkg, error } = await supabaseAdmin
    .from("shop_packages")
    .select("id, shop_id")
    .eq("id", shopPackageId)
    .maybeSingle()
  if (error) return "Could not verify package ownership"
  if (!pkg) return "Package not found"
  return assertOwnsShop(pkg.shop_id, userId)
}

export async function POST(request: NextRequest) {
  // 1) Authenticate the caller from their session token.
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // 2) Parse input.
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const action = body?.action

  // 3) Dispatch.
  if (action === "update_shop") {
    const { shopId, updates } = body || {}
    if (!shopId || !updates || typeof updates !== "object") {
      return NextResponse.json({ error: "Missing shopId or updates" }, { status: 400 })
    }
    const ownErr = await assertOwnsShop(shopId, user.id)
    if (ownErr) return NextResponse.json({ error: ownErr }, { status: ownErr.includes("permission") ? 403 : 500 })

    // Keep only whitelisted fields; reject negative/non-finite markups.
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_SHOP_FIELDS.has(key)) continue
      if (key.includes("markup")) {
        if (!isFiniteNumber(value) || value < 0) {
          return NextResponse.json({ error: `Invalid value for ${key}` }, { status: 400 })
        }
      }
      // afa_price: null/undefined turns AFA off for the storefront (see
      // app/shop/[slug]/afa/page.tsx); a set value must be a non-negative number.
      if (key === "afa_price" && value !== null && !(isFiniteNumber(value) && value >= 0)) {
        return NextResponse.json({ error: "Invalid value for afa_price" }, { status: 400 })
      }
      // custom_color / custom_color_2 / section_divider_style: null clears back
      // to the platform default; a set value must match the real hex/style-id format.
      if (key === "custom_color" && value !== null && !(typeof value === "string" && HEX_COLOR_RE.test(value))) {
        return NextResponse.json({ error: "custom_color must be a 6-digit hex code, e.g. #2563eb" }, { status: 400 })
      }
      if (key === "custom_color_2" && value !== null && !(typeof value === "string" && HEX_COLOR_RE.test(value))) {
        return NextResponse.json({ error: "custom_color_2 must be a 6-digit hex code, e.g. #2563eb" }, { status: 400 })
      }
      if (key === "section_divider_style" && value !== null && !(typeof value === "string" && DIVIDER_STYLES.has(value))) {
        return NextResponse.json({ error: "Invalid section_divider_style" }, { status: 400 })
      }
      clean[key] = value
    }
    if (Object.keys(clean).length === 0) {
      return NextResponse.json({ error: "No editable fields provided" }, { status: 400 })
    }
    clean.updated_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from("user_shops")
      .update(clean)
      .eq("id", shopId)
      .select()
      .single()
    if (error) {
      console.error("[SHOP-MANAGE] update_shop failed:", error.message)
      return NextResponse.json({ error: "Failed to update shop" }, { status: 500 })
    }
    return NextResponse.json({ success: true, shop: data })
  }

  if (action === "add_package") {
    const { shopId, packageId, profitMargin, customName } = body || {}
    if (!shopId || !packageId || !isFiniteNumber(profitMargin) || profitMargin < 0) {
      return NextResponse.json({ error: "Missing or invalid package fields" }, { status: 400 })
    }
    const ownErr = await assertOwnsShop(shopId, user.id)
    if (ownErr) return NextResponse.json({ error: ownErr }, { status: ownErr.includes("permission") ? 403 : 500 })

    const { data, error } = await supabaseAdmin
      .from("shop_packages")
      .insert([{
        shop_id: shopId,
        package_id: packageId,
        profit_margin: profitMargin,
        custom_name: typeof customName === "string" ? customName : null,
        is_available: true,
      }])
      .select()
      .single()
    if (error) {
      console.error("[SHOP-MANAGE] add_package failed:", error.message)
      return NextResponse.json({ error: "Failed to add package" }, { status: 500 })
    }
    return NextResponse.json({ success: true, package: data })
  }

  if (action === "update_package_margin") {
    const { shopPackageId, profitMargin } = body || {}
    if (!shopPackageId || !isFiniteNumber(profitMargin) || profitMargin < 0) {
      return NextResponse.json({ error: "Missing or invalid margin fields" }, { status: 400 })
    }
    const ownErr = await assertOwnsPackage(shopPackageId, user.id)
    if (ownErr) return NextResponse.json({ error: ownErr }, { status: ownErr.includes("permission") ? 403 : 500 })

    const { data, error } = await supabaseAdmin
      .from("shop_packages")
      .update({ profit_margin: profitMargin, updated_at: new Date().toISOString() })
      .eq("id", shopPackageId)
      .select()
      .single()
    if (error) {
      console.error("[SHOP-MANAGE] update_package_margin failed:", error.message)
      return NextResponse.json({ error: "Failed to update package" }, { status: 500 })
    }
    return NextResponse.json({ success: true, package: data })
  }

  if (action === "toggle_package") {
    const { shopPackageId, isAvailable } = body || {}
    if (!shopPackageId || typeof isAvailable !== "boolean") {
      return NextResponse.json({ error: "Missing or invalid toggle fields" }, { status: 400 })
    }
    const ownErr = await assertOwnsPackage(shopPackageId, user.id)
    if (ownErr) return NextResponse.json({ error: ownErr }, { status: ownErr.includes("permission") ? 403 : 500 })

    const { data, error } = await supabaseAdmin
      .from("shop_packages")
      .update({ is_available: isAvailable, updated_at: new Date().toISOString() })
      .eq("id", shopPackageId)
      .select()
      .single()
    if (error) {
      console.error("[SHOP-MANAGE] toggle_package failed:", error.message)
      return NextResponse.json({ error: "Failed to update availability" }, { status: 500 })
    }
    return NextResponse.json({ success: true, package: data })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
