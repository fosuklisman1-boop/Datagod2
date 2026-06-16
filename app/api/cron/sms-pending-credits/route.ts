import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { queryMoolreSmsBalance } from "@/lib/sms-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const wholesale = await queryMoolreSmsBalance()
  const { data, error } = await supabaseAdmin.rpc("settle_pending_sms_credits", { p_wholesale: wholesale })
  if (error) return NextResponse.json({ error: "settle failed" }, { status: 500 })
  const row = (data as Array<{ credited_count: number; credited_units: number }>)?.[0] ?? { credited_count: 0, credited_units: 0 }
  return NextResponse.json({ wholesale, ...row })
}
