import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// GET: Get all active admin packages (bypasses RLS)
export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    console.log("[admin-packages] Starting request")
    console.log("[admin-packages] Supabase URL exists:", !!supabaseUrl)
    console.log("[admin-packages] Service role key exists:", !!serviceRoleKey)

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[admin-packages] Missing Supabase environment variables")
      return NextResponse.json({ error: "Server configuration error" }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey)

    console.log("[admin-packages] Fetching packages from database...")
    const { data: packages, error } = await supabase
      .from("packages")
      .select("*")
      .eq("is_active", true)
      .order("network", { ascending: true })
      .order("price", { ascending: true })

    console.log("[admin-packages] Query result - packages:", packages?.length || 0, "error:", error?.message || "none")

    if (error) {
      console.error("[admin-packages] Error fetching packages:", error)
      return NextResponse.json({ error: "Failed to fetch packages", details: error.message }, { status: 500 })
    }

    console.log("[admin-packages] Returning", packages?.length || 0, "packages")
    return NextResponse.json({ packages: packages || [] })

  } catch (error) {
    console.error("Error in admin-packages API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch packages" },
      { status: 500 }
    )
  }
}
