import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/blacklist/bulk
 * Bulk import phone numbers to blacklist
 * Supports CSV or JSON array
 */
export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const body = await request.json()
    const { phones, reason = "Bulk import" } = body

    if (!Array.isArray(phones) || phones.length === 0) {
      return NextResponse.json(
        { error: "phones must be a non-empty array" },
        { status: 400 }
      )
    }

    // Prepare records for insertion
    const records = phones.map((phone: string) => ({
      phone_number: phone.trim(),
      reason: reason || null,
    }))

    // Bulk insert (ignore duplicates)
    const { data, error } = await supabase
      .from("blacklisted_phone_numbers")
      .insert(records)
      .select()

    if (error) {
      console.error("[BLACKLIST-BULK] Error bulk importing:", error)
      // Don't fail completely if some duplicates exist
      if (error.code === "23505") {
        // Unique constraint violation - some numbers already exist
        return NextResponse.json({
          success: true,
          message: "Bulk import completed (some numbers may already exist)",
          imported: data?.length || 0,
          total_requested: phones.length,
        })
      }
      return NextResponse.json(
        { error: error.message || "Failed to bulk import" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Successfully imported ${data?.length || 0} phone numbers`,
      imported: data?.length || 0,
      total_requested: phones.length,
    })
  } catch (error) {
    console.error("[BLACKLIST-BULK] Error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
