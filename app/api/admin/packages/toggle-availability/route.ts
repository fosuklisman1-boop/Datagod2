import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

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
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check if user is admin
    const { data: userData, error: metaError } = await supabase
      .from("users")
      .select("user_metadata")
      .eq("id", user.id)
      .single()

    if (metaError || userData?.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden - Admin access required" }, { status: 403 })
    }

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
