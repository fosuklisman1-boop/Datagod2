import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
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
