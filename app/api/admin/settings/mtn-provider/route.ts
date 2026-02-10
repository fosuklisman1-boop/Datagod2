/**
 * Admin API - MTN Provider Selection
 * 
 * GET - Fetch current provider selection
 * POST - Update provider selection
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

/**
 * GET /api/admin/settings/mtn-provider
 * Fetch current MTN provider selection
 */
export async function GET(request: NextRequest) {
    try {
        // Verify admin authentication
        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        if (!isAdmin) {
            return errorResponse
        }

        // Fetch provider selection from admin_settings
        const { data, error } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", "mtn_provider_selection")
            .maybeSingle()

        if (error) {
            console.error("[Admin] Error fetching provider setting:", error)
            return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 })
        }

        const provider = data?.value?.provider || "sykes"

        return NextResponse.json({
            provider,
            success: true,
        })
    } catch (error) {
        console.error("[Admin] Error in GET /api/admin/settings/mtn-provider:", error)
        return NextResponse.json({ error: "Server error" }, { status: 500 })
    }
}

/**
 * POST /api/admin/settings/mtn-provider
 * Update MTN provider selection
 */
export async function POST(request: NextRequest) {
    try {
        // Verify admin authentication
        const { isAdmin, errorResponse } = await verifyAdminAccess(request)
        if (!isAdmin) {
            return errorResponse
        }

        const body = await request.json()
        const { provider } = body

        // Validate provider
        if (!["sykes", "datakazina"].includes(provider)) {
            return NextResponse.json(
                { error: "Invalid provider. Must be 'sykes' or 'datakazina'" },
                { status: 400 }
            )
        }

        // Update or insert setting
        const { error } = await supabase
            .from("admin_settings")
            .upsert({
                key: "mtn_provider_selection",
                value: { provider },
                updated_at: new Date().toISOString(),
            })

        if (error) {
            console.error("[Admin] Error updating provider setting:", error)
            return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
        }

        console.log(`[Admin] MTN provider updated to: ${provider}`)

        return NextResponse.json({
            success: true,
            provider,
            message: `MTN provider updated to ${provider}`,
        })
    } catch (error) {
        console.error("[Admin] Error in POST /api/admin/settings/mtn-provider:", error)
        return NextResponse.json({ error: "Server error" }, { status: 500 })
    }
}
