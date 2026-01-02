import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// GET: Get all active admin packages (bypasses RLS)
export async function GET(request: NextRequest) {
  try {
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
