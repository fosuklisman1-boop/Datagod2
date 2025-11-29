import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
    // Verify user is authenticated and is already an admin
    const authHeader = req.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized: Missing auth token" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabaseClient = createClient(supabaseUrl, serviceRoleKey)
    const { data: { user: callerUser }, error: callerError } = await supabaseClient.auth.getUser(token)

    if (callerError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // Check if caller is admin
    if (callerUser.user_metadata?.role !== "admin") {
      console.warn(`[SET-ADMIN-BY-EMAIL] Unauthorized attempt by user ${callerUser.id}. Not an admin.`)
      return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    const { email } = await req.json()

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 })
    }

    // Create admin client with service role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Get user by email
    const { data: users, error: getUserError } = await adminClient.auth.admin.listUsers()

    if (getUserError) {
      console.error("Error fetching users:", getUserError)
      return NextResponse.json({ error: getUserError.message }, { status: 400 })
    }

    const user = users.users.find((u) => u.email === email)

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    // Update user metadata to add admin role
    const { data: authData, error: authError } = await adminClient.auth.admin.updateUserById(user.id, {
      user_metadata: { role: "admin" },
    })

    if (authError) {
      console.error("Error updating user metadata:", authError)
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // Also update the users table role column
    const { data: userData, error: userError } = await adminClient
      .from("users")
      .update({ role: "admin" })
      .eq("id", user.id)
      .select()

    if (userError) {
      console.error("Error updating users table:", userError)
      // Don't fail - metadata was already updated
    }

    console.log("[SET-ADMIN-BY-EMAIL] User", email, "has been granted admin role")

    return NextResponse.json({ 
      success: true, 
      message: "Admin role granted",
      user: authData.user,
      updated: userData
    })
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
