import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// GET: Get all active admin packages
export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[admin-packages] Missing env vars:", {
        hasUrl: !!supabaseUrl,
        hasKey: !!serviceRoleKey
      })
      return NextResponse.json({
        error: "Server configuration error",
        packages: []
      }, { status: 200 })
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data: packages, error } = await supabase
      .from("packages")
      .select("*")
      .eq("active", true)
      .order("network", { ascending: true })
      .order("price", { ascending: true })

    if (error) {
      console.error("[admin-packages] DB error:", error)
      return NextResponse.json({
        error: error.message,
        packages: []
      }, { status: 200 })
    }

    // Same data for every user — cache at Vercel's edge for 2 minutes.
    // When an admin changes packages, the old cache expires within 120s.
    return NextResponse.json(
      { packages: packages || [] },
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=60" } }
    )

  } catch (error) {
    console.error("Error in admin-packages API:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch packages" },
      { status: 500 }
    )
  }
}
