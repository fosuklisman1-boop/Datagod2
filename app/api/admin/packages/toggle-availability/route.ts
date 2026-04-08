import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { packageId, isAvailable } = await request.json()

    if (!packageId || typeof isAvailable !== "boolean") {
      return NextResponse.json(
        { error: "Package ID and availability status are required" },
        { status: 400 }
      )
    }

    // Update package availability
    const { data, error } = await supabase
      .from("packages")
      .update({ is_available: isAvailable })
      .eq("id", packageId)
      .select()
      .single()

    if (error) {
      console.error("Error updating package availability:", error)
      return NextResponse.json(
        { error: "Failed to update package availability" },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      package: data,
      message: `Package ${isAvailable ? "enabled" : "disabled"} successfully`,
    })
  } catch (error) {
    console.error("Error in toggle availability:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
