import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await req.json()

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // Get authorization token from headers
    const authHeader = req.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)

    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Verify user is admin using the token
    const { data: { user: currentUser }, error: userError } = await supabaseAdmin.auth.getUser(token)

    if (userError || !currentUser) {
      return NextResponse.json(
        { error: "Invalid authentication token" },
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: userData } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", currentUser.id)
      .single()

    if (userData?.role !== "admin") {
      return NextResponse.json(
        { error: "User not allowed to perform this action" },
        { status: 403 }
      )
    }

    // Delete user from auth using admin client (service role)
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId)

    if (deleteError) {
      console.error("Error deleting user from auth:", deleteError)
      return NextResponse.json(
        { error: deleteError.message || "Failed to delete user" },
        { status: 400 }
      )
    }

    // Delete user profile and related data
    const { error: profileError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", userId)

    if (profileError) {
      console.error("Error deleting user profile:", profileError)
      // Don't fail the whole operation, user is already deleted from auth
      console.warn("User was deleted from auth but profile deletion failed")
    }

    return NextResponse.json({
      success: true,
      message: "User deleted successfully",
    })
  } catch (error: any) {
    console.error("Error in DELETE /api/admin/remove-user:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
