import { NextRequest, NextResponse } from "next/server"
import { supabase, supabaseAdmin } from "@/lib/supabase"

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await req.json()

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // Get the current user to verify they're an admin
    const { data: { user: currentUser } } = await supabase.auth.getUser()
    const isAdmin = currentUser?.user_metadata?.role === "admin"

    if (!isAdmin) {
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
