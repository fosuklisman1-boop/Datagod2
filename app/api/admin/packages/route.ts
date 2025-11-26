import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(req: NextRequest) {
  try {
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
