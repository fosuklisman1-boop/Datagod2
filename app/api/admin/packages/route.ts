import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Allowed fields for package create/update (prevents mass assignment)
const ALLOWED_PACKAGE_FIELDS = ["name", "network", "size", "price", "dealer_price", "active", "description", "category"]

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  try {
    const { packageData, packageId, isUpdate } = await req.json()

    // Whitelist fields to prevent mass assignment
    const safeData = packageData
      ? Object.fromEntries(Object.entries(packageData).filter(([k]) => ALLOWED_PACKAGE_FIELDS.includes(k)))
      : null

    if (!safeData || Object.keys(safeData).length === 0) {
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
        .update(safeData)
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
        .insert([safeData])
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
