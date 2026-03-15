import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
    // 1. Verify admin access
    const { isAdmin, errorResponse } = await verifyAdminAccess(req)
    if (!isAdmin) return errorResponse

    const { userId, action } = await req.json()

    if (!userId || !["suspend", "unsuspend"].includes(action)) {
      return NextResponse.json(
        { error: "Valid User ID and action (suspend/unsuspend) are required" },
        { status: 400 }
      )
    }

    // Create admin client with service role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const isSuspending = action === "suspend"
    console.log(`[ADMIN-SUSPEND-USER] Admin is attempting to ${action} user ${userId}...`)

    // 2. Update Supabase Auth (Ban or Unban)
    // We use ban_duration to immediately invalidate tokens. 876000h = 100 years.
    const banDuration = isSuspending ? "876000h" : "none"
    const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
      ban_duration: banDuration,
    })

    if (authError) {
      console.error("[ADMIN-SUSPEND-USER] Auth update error:", authError)
      return NextResponse.json({
        error: `Supabase Auth update failed: ${authError.message}`
      }, { status: 400 })
    }

    // 3. Update public.users table status flag for the UI
    const { error: dbError } = await adminClient
      .from("users")
      .update({
        is_suspended: isSuspending,
        updated_at: new Date().toISOString()
      })
      .eq("id", userId)

    if (dbError) {
      console.error("[ADMIN-SUSPEND-USER] Database update error:", dbError)
      // If DB fails but auth succeeds, we are out of sync, but Auth ban is the critical part
      return NextResponse.json({
        error: `Auth suspended, but database update failed: ${dbError.message}`
      }, { status: 500 })
    }

    console.log(`[ADMIN-SUSPEND-USER] Successfully executed ${action} for user ${userId}`)

    return NextResponse.json({
      success: true,
      message: `User successfully ${isSuspending ? "suspended" : "unsuspended"}`,
      action
    })

  } catch (error: any) {
    console.error("[ADMIN-SUSPEND-USER] Fatal error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
