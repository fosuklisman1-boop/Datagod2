import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Fetch the active AFA registration price
    const { data, error } = await supabase
      .from("afa_registration_prices")
      .select("*")
      .eq("is_active", true)
      .eq("name", "default")
      .single()

    if (error) {
      console.error("[AFA-PRICE] Error fetching price:", error)
      // Return default fallback price
      return NextResponse.json(
        {
          price: 50.00,
          currency: "GHS",
          name: "default",
        },
        { status: 200 }
      )
    }

    return NextResponse.json(
      {
        price: parseFloat(data.price),
        currency: data.currency,
        name: data.name,
        description: data.description,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[AFA-PRICE] Unexpected error:", error)
    return NextResponse.json(
      {
        price: 50.00,
        currency: "GHS",
        name: "default",
      },
      { status: 200 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    // Verify admin access (checks both user_metadata and users table)
    const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) {
      return errorResponse
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    const body = await request.json()
    const { price, description } = body

    if (!price || price <= 0) {
      return NextResponse.json(
        { error: "Invalid price" },
        { status: 400 }
      )
    }

    // Update the price
    const { data, error } = await supabase
      .from("afa_registration_prices")
      .update({
        price: parseFloat(price),
        description: description || "",
        updated_at: new Date(),
        updated_by: userId,
      })
      .eq("name", "default")
      .select()
      .single()

    if (error) {
      console.error("[AFA-PRICE-UPDATE] Error updating price:", error)
      return NextResponse.json(
        { error: "Failed to update price" },
        { status: 500 }
      )
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          price: parseFloat(data.price),
          currency: data.currency,
          description: data.description,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[AFA-PRICE-UPDATE] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    )
  }
}
