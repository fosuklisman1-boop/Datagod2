import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Force dynamic rendering - env vars read at runtime, not build time
export const dynamic = "force-dynamic"

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
      }, { status: 200 }) // Return 200 with empty to avoid breaking UI
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
      .eq("is_active", true)
      .order("network", { ascending: true })
      .order("price", { ascending: true })

    if (error) {
      console.error("[admin-packages] DB error:", error)
      return NextResponse.json({ 
        error: error.message,
        packages: [] 
      }, { status: 200 })
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
