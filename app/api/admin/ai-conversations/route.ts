import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { audienceLabel, pageRange, parseListQuery, previewText, shortId, totalPages, PAGE_SIZE } from "@/lib/ai-console/review"

export const dynamic = "force-dynamic"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const COLUMNS = "id, context, user_id, shop_id, started_at, last_at, message_count, flagged, flag_reasons, reviewed_at"

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse!

  const parsed = parseListQuery(req.nextUrl.searchParams)
  if (!parsed.ok) return NextResponse.json({ error: "Invalid filters" }, { status: 400 })
  const q = parsed.value

  let query = supabase.from("ai_conversations").select(COLUMNS, { count: "exact" })
  if (q.context) query = query.eq("context", q.context)
  if (q.flagged !== undefined) query = query.eq("flagged", q.flagged)
  if (q.reviewed === true) query = query.not("reviewed_at", "is", null)
  if (q.reviewed === false) query = query.is("reviewed_at", null)
  if (q.from) query = query.gte("last_at", `${q.from}T00:00:00.000Z`)
  if (q.to) query = query.lte("last_at", `${q.to}T23:59:59.999Z`)
  const { from, to } = pageRange(q.page)
  const { data, count, error } = await query.order("last_at", { ascending: false }).range(from, to)
  if (error) return NextResponse.json({ error: "Could not load conversations" }, { status: 500 })

  const rows = (data ?? []) as Array<Record<string, any>>
  const ids = rows.map((r) => r.id as string)
  const preview = new Map<string, string>()
  if (ids.length > 0) {
    const { data: msgs } = await supabase
      .from("ai_conversation_messages")
      .select("conversation_id, text")
      .in("conversation_id", ids)
      .eq("role", "user")
      .order("id", { ascending: true })
      .limit(ids.length * 4)
    for (const m of (msgs ?? []) as Array<{ conversation_id: string; text: string }>) {
      if (!preview.has(m.conversation_id)) preview.set(m.conversation_id, previewText(m.text))
    }
  }

  // Weekly-review numbers (unaffected by the list filters).
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [totalRes, flaggedRes] = await Promise.all([
    supabase.from("ai_conversations").select("id", { count: "exact", head: true }).gte("last_at", weekAgo),
    supabase.from("ai_conversations").select("id", { count: "exact", head: true }).gte("last_at", weekAgo).eq("flagged", true).is("reviewed_at", null),
  ])

  const total = count ?? 0
  return NextResponse.json({
    page: q.page,
    pageSize: PAGE_SIZE,
    total,
    totalPages: totalPages(total),
    summary: { conversations7d: totalRes.count ?? 0, unreviewedFlagged7d: flaggedRes.count ?? 0 },
    conversations: rows.map((r) => ({
      id: r.id,
      context: r.context,
      audience: audienceLabel(r.context, r.user_id ?? null, r.shop_id ?? null),
      user: shortId(r.user_id),
      shop: shortId(r.shop_id),
      started_at: r.started_at,
      last_at: r.last_at,
      message_count: r.message_count,
      flagged: r.flagged,
      flag_reasons: r.flag_reasons ?? [],
      reviewed_at: r.reviewed_at,
      preview: preview.get(r.id) ?? "",
    })),
  })
}
