import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
    // Verify user is authenticated and is an admin
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
      console.warn(`[PACKAGES] Unauthorized attempt by user ${callerUser.id}. Not an admin.`)
      return NextResponse.json({ error: "Forbidden: Admin access required" }, { status: 403 })
    }

    const { packageData, packageId, isUpdate } = await req.json()

    if (!packageData) {
      return NextResponse.json({ error: "Package data is required" }, { status: 400 })
    }

    // Create admin client with service role
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    if (isUpdate && packageId) {
      // Update package
      const { data, error } = await adminClient
        .from("packages")
        .update(packageData)
        .eq("id", packageId)
        .select()

      if (error) {
        console.error("Error updating package:", error)
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      return NextResponse.json({ success: true, data: data?.[0], message: "Package updated successfully" })
    } else {
      // Create package
      const { data, error } = await adminClient
        .from("packages")
        .insert([packageData])
        .select()

      if (error) {
        console.error("Error creating package:", error)
        return NextResponse.json({ error: error.message }, { status: 400 })
      }

      return NextResponse.json({ success: true, data: data?.[0], message: "Package created successfully" })
    }
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
