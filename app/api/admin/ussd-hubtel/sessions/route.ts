import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listSessionSummaries, sessionOutcome } from "@/lib/ussd-hubtel/interaction-log"
import { parseListParams, UUID_RE } from "@/lib/ussd-hubtel/interaction-routes"

// GET /api/admin/ussd-hubtel/sessions?shopId=<uuid>&limit=30&before=<ISO>&includeShops=1
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })

  const q = request.nextUrl.searchParams
  const params = parseListParams(q)
  if ("error" in params) return NextResponse.json({ error: params.error }, { status: 400 })
  const shopId = q.get("shopId")
  if (shopId !== null && !UUID_RE.test(shopId)) return NextResponse.json({ error: "shopId must be a shop id" }, { status: 400 })

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const r = await listSessionSummaries(supabase, { shopId, before: params.before, limit: params.limit })
  if (!r.ok) return NextResponse.json({ error: r.error, missing: r.missing }, { status: r.missing ? 503 : 500 })

  // Shop names for the rows on this page (and, on request, every shop with a USSD code for the filter).
  const ids = [...new Set(r.sessions.map(s => s.shop_id).filter((x): x is string => !!x))]
  const names: Record<string, string> = {}
  if (ids.length) {
    const { data } = await supabase.from("user_shops").select("id, shop_name").in("id", ids)
    for (const s of (data ?? []) as { id: string; shop_name: string | null }[]) names[s.id] = s.shop_name ?? "Shop"
  }
  let shops: { id: string; name: string; code: string }[] | undefined
  if (q.get("includeShops") === "1") {
    const { data } = await supabase.from("ussd_shop_codes").select("code, shop_id, user_shops(shop_name)").order("code")
    shops = ((data ?? []) as unknown as { code: string; shop_id: string; user_shops: { shop_name: string | null } | null }[])
      .map(c => ({ id: c.shop_id, code: c.code, name: c.user_shops?.shop_name ?? "Shop" }))
  }

  const sessions = r.sessions.map(s => ({ ...s, shop_name: s.shop_id ? names[s.shop_id] ?? "Shop" : null, outcome: sessionOutcome(s) }))
  const nextBefore = sessions.length === params.limit ? sessions[sessions.length - 1].started_at : null
  return NextResponse.json({ sessions, nextBefore, ...(shops ? { shops } : {}) })
}
