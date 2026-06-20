/**
 * Admin API — Bisdel Product Catalog
 *
 * GET  — cached products + distinct categories + currently selected category
 * POST — fetch live products from Bisdel /products.php and cache them
 * PUT  — set the single category Bisdel orders are matched within
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BISDEL_API_KEY = process.env.BISDEL_API_KEY!
const BISDEL_API_SECRET = process.env.BISDEL_API_SECRET!
const BISDEL_BASE_URL = process.env.BISDEL_BASE_URL || "https://bisdelgh.com/api/xx1"

export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const [{ data: pkgRow, error }, { data: catRow }] = await Promise.all([
      supabase.from("admin_settings").select("value").eq("key", "bisdel_packages").maybeSingle(),
      supabase.from("admin_settings").select("value").eq("key", "bisdel_category").maybeSingle(),
    ])
    if (error) {
      console.error("[Bisdel-Products] DB error:", error)
      return NextResponse.json({ error: "Failed to fetch cached products" }, { status: 500 })
    }
    const packages = pkgRow?.value?.packages ?? []
    const categories = [...new Set(packages.map((p: any) => p?.category).filter(Boolean))]
    return NextResponse.json({
      success: true,
      packages,
      categories,
      selected_category: catRow?.value?.category ?? null,
      synced_at: pkgRow?.value?.synced_at ?? null,
      count: pkgRow?.value?.count ?? 0,
    })
  } catch (error) {
    console.error("[Bisdel-Products] GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    if (!BISDEL_API_KEY || !BISDEL_API_SECRET) {
      return NextResponse.json({ error: "BISDEL_API_KEY / BISDEL_API_SECRET not configured" }, { status: 500 })
    }

    const response = await fetch(`${BISDEL_BASE_URL}/products.php`, {
      method: "GET",
      headers: { "X-API-Key": BISDEL_API_KEY, "X-API-Secret": BISDEL_API_SECRET },
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error("[Bisdel-Products] API error:", response.status, text.slice(0, 200))
      return NextResponse.json(
        { error: `Bisdel API returned ${response.status}`, details: text.slice(0, 200) },
        { status: 502 }
      )
    }

    const json = await response.json()
    // Bisdel shape: { success, data: { products: [...] } }
    const packageList = json?.data?.products ?? json?.products ?? (Array.isArray(json) ? json : [])

    const value = { packages: packageList, synced_at: new Date().toISOString(), count: packageList.length }
    const { error: upsertError } = await supabase
      .from("admin_settings")
      .upsert({ key: "bisdel_packages", value }, { onConflict: "key" })

    if (upsertError) {
      console.error("[Bisdel-Products] Upsert error:", upsertError)
      return NextResponse.json({ error: "Failed to save products" }, { status: 500 })
    }

    const categories = [...new Set(packageList.map((p: any) => p?.category).filter(Boolean))]
    console.log(`[Bisdel-Products] Synced ${packageList.length} products`)
    return NextResponse.json({ success: true, count: packageList.length, categories, synced_at: value.synced_at })
  } catch (error) {
    console.error("[Bisdel-Products] POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const { category } = await request.json()
    if (!category || typeof category !== "string") {
      return NextResponse.json({ error: "category (string) is required" }, { status: 400 })
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert({ key: "bisdel_category", value: { category }, updated_at: new Date().toISOString() }, { onConflict: "key" })

    if (error) {
      console.error("[Bisdel-Products] Category upsert error:", error)
      return NextResponse.json({ error: "Failed to save category" }, { status: 500 })
    }
    return NextResponse.json({ success: true, category, message: `Bisdel category set to ${category}` })
  } catch (error) {
    console.error("[Bisdel-Products] PUT error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
