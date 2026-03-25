import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // 1. Auth check
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user: adminUser }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !adminUser || adminUser.user_metadata?.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // 2. Fetch batches
    const { data: batches, error: fetchError } = await supabase
      .from("airtime_download_batches")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50)
    
    if (fetchError) {
      console.error("[AIRTIME-BATCHES] Fetch error:", fetchError)
      return NextResponse.json({ error: "Failed to load batches" }, { status: 500 })
    }

    return NextResponse.json({ data: batches })

  } catch (error) {
    console.error("[AIRTIME-BATCHES] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
