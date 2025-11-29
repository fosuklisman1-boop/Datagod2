import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

export async function POST(request: NextRequest) {
  try {
    const { userId, newPassword } = await request.json()

    // Validate input
    if (!userId || !newPassword) {
      return NextResponse.json(
        { error: "Missing userId or newPassword" },
        { status: 400 }
      )
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      )
    }

    // Get auth token from header
    const authHeader = request.headers.get("authorization")
    if (!authHeader) {
      return NextResponse.json(
        { error: "Missing authorization header" },
        { status: 401 }
      )
    }

    const token = authHeader.replace("Bearer ", "")

    // Get current user from JWT
    const { data: { user: currentUser }, error: authError } =
      await supabase.auth.getUser(token)

    if (authError || !currentUser) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Check if current user is admin (dual-check: JWT metadata OR users table)
    let isAdmin = false

    // Check JWT metadata
    if (currentUser.user_metadata?.role === "admin") {
      isAdmin = true
    }

    // Fallback: check users table
    if (!isAdmin) {
      const { data: userData } = await supabase
        .from("users")
        .select("role")
        .eq("id", currentUser.id)
        .single()

      if (userData?.role === "admin") {
        isAdmin = true
      }
    }

    if (!isAdmin) {
      return NextResponse.json(
        { error: "Only admins can change user passwords" },
        { status: 403 }
      )
    }

    // Use admin API to update user password
    const { data: adminAuthClient } = await supabase.auth.admin.updateUserById(
      userId,
      {
        password: newPassword,
      }
    )

    if (!adminAuthClient) {
      return NextResponse.json(
        { error: "Failed to update user password" },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        success: true,
        message: "Password updated successfully",
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("Error changing user password:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
