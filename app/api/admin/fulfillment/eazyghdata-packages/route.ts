/**
 * Admin API — EazyGhData Package Sync
 *
 * GET  — returns cached packages from admin_settings
 * POST — fetches live packages from EazyGhData and stores them
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const EAZYGHDATA_API_KEY = process.env.EAZYGHDATA_API_KEY!
const EAZYGHDATA_BASE_URL = process.env.EAZYGHDATA_BASE_URL || "https://eazyghdata.com"

/**
 * GET /api/admin/fulfillment/eazyghdata-packages
 * Returns the currently cached EazyGhData packages.
 */
export async function GET(request: NextRequest) {
    try {
        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        if (!isAdmin) return errorResponse

        const { data, error } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "eazyghdata_packages")
            .maybeSingle()

        if (error) {
            console.error("[EazyGhData-Packages] DB error:", error)
            return NextResponse.json({ error: "Failed to fetch cached packages" }, { status: 500 })
        }

        return NextResponse.json({
            success: true,
            packages: data?.value?.packages ?? [],
            synced_at: data?.value?.synced_at ?? null,
            count: data?.value?.count ?? 0,
        })
    } catch (error) {
        console.error("[EazyGhData-Packages] GET error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}

/**
 * POST /api/admin/fulfillment/eazyghdata-packages
 * Fetches the live package list from EazyGhData and stores it in admin_settings.
 */
export async function POST(request: NextRequest) {
    try {
        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        if (!isAdmin) return errorResponse

        if (!EAZYGHDATA_API_KEY || EAZYGHDATA_API_KEY === "sk_...") {
            return NextResponse.json({ error: "EAZYGHDATA_API_KEY is not configured" }, { status: 500 })
        }

        const response = await fetch(`${EAZYGHDATA_BASE_URL}/api/agent/v1/packages`, {
            method: "GET",
            headers: { "X-API-Key": EAZYGHDATA_API_KEY },
            signal: AbortSignal.timeout(30000),
        })

        if (!response.ok) {
            const text = await response.text()
            console.error("[EazyGhData-Packages] API error:", response.status, text.slice(0, 200))
            return NextResponse.json(
                { error: `EazyGhData API returned ${response.status}`, details: text.slice(0, 200) },
                { status: 502 }
            )
        }

        const packages = await response.json()
        const packageList = Array.isArray(packages) ? packages : packages.packages ?? packages.data ?? []

        const value = {
            packages: packageList,
            synced_at: new Date().toISOString(),
            count: packageList.length,
        }

        const { error: upsertError } = await supabase
            .from("admin_settings")
            .upsert({ key: "eazyghdata_packages", value }, { onConflict: "key" })

        if (upsertError) {
            console.error("[EazyGhData-Packages] Upsert error:", upsertError)
            return NextResponse.json({ error: "Failed to save packages" }, { status: 500 })
        }

        console.log(`[EazyGhData-Packages] Synced ${packageList.length} packages`)

        return NextResponse.json({
            success: true,
            count: packageList.length,
            synced_at: value.synced_at,
            packages: packageList,
        })
    } catch (error) {
        console.error("[EazyGhData-Packages] POST error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
