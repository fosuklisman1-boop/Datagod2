import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Initialize Supabase with service role key
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET() {
  try {
    console.log("Fetching pending orders from API...")
    
    const { data, error } = await supabase
      .from("orders")
      .select("id, created_at, phone_number, price, status, size, network")
      .eq("status", "pending")
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Supabase error:", error)
      throw new Error(`Failed to fetch pending orders: ${error.message}`)
    }

    console.log(`Found ${data?.length || 0} pending orders`)

    // Map response fields for compatibility with frontend
    const mappedData = data?.map((order: any) => ({
      ...order,
      order_status: order.status,
      package_name: order.size,
      network_name: order.network
    })) || []

    return NextResponse.json({
      success: true,
      data: mappedData,
      count: mappedData.length
    })
  } catch (error) {
    console.error("Error fetching pending orders:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        success: false
      },
      { status: 500 }
    )
  }
}
