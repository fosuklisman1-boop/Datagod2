import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
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
    const { data, error } = await adminClient.auth.admin.updateUserById(user.id, {
      user_metadata: { role: "admin" },
    })

    if (error) {
      console.error("Error updating user:", error)
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    return NextResponse.json({ 
      success: true, 
      message: "Admin role granted",
      user: data.user 
    })
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
