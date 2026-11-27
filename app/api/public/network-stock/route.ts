import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getStockNotices } from "@/lib/network-stock-service"

// Public "which networks are out of stock, and why" for the dashboard buy page. No login: the
// response holds only network names and the admin-written reason (nothing else from
// admin_settings). getStockNotices fails open to {}, so this never errors.
export const dynamic = "force-dynamic"

export async function GET() {
  const notices = await getStockNotices(supabaseAdmin)
  return NextResponse.json(
    { notices },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
  )
}
