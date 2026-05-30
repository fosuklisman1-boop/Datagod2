import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { data, error } = await supabase
      .from("phone_verification_sessions")
      .select("id, file_name, total_count, verified_count, invalid_count, status, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(100)

    if (error) throw error
    return NextResponse.json(data ?? [])
  } catch (error) {
    console.error("[PHONE-VERIFY-SESSIONS]", error)
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 })
  }
}
