import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

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
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    // Verify user is admin
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)

    if (userError || !user) {
      return NextResponse.json(
        { error: "Invalid token" },
        { status: 401 }
      )
    }

    // Check if user is admin
    const { data: userData, error: roleError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .single()

    if (roleError || userData?.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      )
    }

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
        updated_by: user.id,
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
