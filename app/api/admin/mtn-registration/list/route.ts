import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const STATUSES = ["pending", "submitted", "registered", "rejected"] as const

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const counts: Record<string, number> = {}
    for (const status of STATUSES) {
      const { count, error } = await supabase
        .from("mtn_number_registry")
        .select("*", { count: "exact", head: true })
        .eq("status", status)
      if (error) throw error
      counts[status] = count ?? 0
    }

    const { data: batches, error: batchErr } = await supabase
      .from("mtn_registration_batches")
      .select("id, batch_time, number_count, status, registered_at, downloaded_by_email")
      .order("batch_time", { ascending: false })
      .limit(20)
    if (batchErr) throw batchErr

    return NextResponse.json({ counts, batches: batches ?? [] })
  } catch (error) {
    console.error("[MTN-REG-LIST] error:", error)
    return NextResponse.json({ error: "Failed to load registration status" }, { status: 500 })
  }
}
