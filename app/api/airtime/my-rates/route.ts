import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { airtimeFeeRateForDisplay } from "@/lib/airtime-pricing"
import { getDealerRateTier } from "@/lib/sub-agents/dealer-rates"
import { rateSlugFor } from "@/lib/roles/service-rates"

export const dynamic = "force-dynamic"

/**
 * The signed-in user's own airtime fee rates (%) per network (display only; the purchase route re-prices).
 * Rule A (getDealerRateTier) -> role slug -> per-role rate. A roles read failure shows the legacy tier rate.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (!auth?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data: authData, error: authErr } = await db.auth.getUser(auth.slice(7))
  if (authErr || !authData?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = authData.user.id

  try {
    const tierIsDealer = (await getDealerRateTier(db, userId)) === "dealer"
    const { data: me, error: meErr } = await db.from("users").select("role").eq("id", userId).maybeSingle()
    if (meErr) throw meErr
    const slug = await rateSlugFor(db, tierIsDealer, (me as { role?: string } | null)?.role)
    const [mtn, telecel, at] = await Promise.all(
      ["mtn", "telecel", "at"].map((net) => airtimeFeeRateForDisplay(net, slug, tierIsDealer))
    )
    return NextResponse.json({ rates: { mtn, telecel, at } }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    console.error("[airtime/my-rates] rates unavailable:", e instanceof Error ? e.name : typeof e)
    return NextResponse.json({ error: "Failed to load rates" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
