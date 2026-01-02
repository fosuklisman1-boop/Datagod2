import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// GET: Get all active admin packages (bypasses RLS)
export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing Supabase environment variables")
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    const { data: packages, error } = await supabase
      .from("packages")
      .select("*")
      .eq("is_active", true)
      .order("network", { ascending: true })
      .order("price", { ascending: true })

    if (error) {
      console.error("Error fetching packages:", error)
      return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
    }

    return NextResponse.json({ packages: packages || [] })

  } catch (error) {
    console.error("Error in admin-packages API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch packages" },
      { status: 500 }
    )
  }
}
