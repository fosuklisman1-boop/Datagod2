import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { auditLog, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { leaderboardErrorJson } from "@/lib/leaderboard/admin"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_REASON = 200

function db() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

/** Users hidden from every leaderboard (test and staff accounts). Admins are always hidden. */
export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const client = db()
  try {
    const { data, error } = await client.from("leaderboard_exclusions").select("user_id, reason, created_at").order("created_at", { ascending: false })
    if (error) throw error
    const rows = (data ?? []) as { user_id: string; reason: string | null; created_at: string }[]
    const users = new Map<string, { email: string | null; first_name: string | null; last_name: string | null }>()
    if (rows.length) {
      const { data: u, error: uErr } = await client.from("users").select("id, email, first_name, last_name").in("id", rows.map((r) => r.user_id))
      if (uErr) throw uErr
      for (const row of (u ?? []) as { id: string; email: string | null; first_name: string | null; last_name: string | null }[]) users.set(row.id, row)
    }
    return NextResponse.json({
      success: true,
      data: {
        exclusions: rows.map((r) => {
          const u = users.get(r.user_id)
          return { ...r, email: u?.email ?? null, name: [u?.first_name, u?.last_name].filter(Boolean).join(" ") || null }
        }),
      },
    })
  } catch (e) {
    return leaderboardErrorJson(e, "exclusions list")
  }
}

/** POST { email, reason? } hides a user from the leaderboards. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : ""
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, MAX_REASON) : ""
  if (!email || !email.includes("@") || email.length > 254) return NextResponse.json({ error: "Enter the user's email" }, { status: 400 })

  const client = db()
  try {
    // Case-insensitive exact match: escape ilike's wildcards (emails often contain "_").
    const pattern = email.replace(/[\\%_]/g, (c: string) => `\\${c}`)
    const { data: user, error: userError } = await client.from("users").select("id, email").ilike("email", pattern).maybeSingle()
    if (userError) throw userError
    if (!user) return NextResponse.json({ error: "No user with that email" }, { status: 404 })

    const { error } = await client.from("leaderboard_exclusions")
      .upsert({ user_id: user.id, reason: reason || null, created_by: auth.userId }, { onConflict: "user_id" })
    if (error) throw error
    auditLog(client, { adminId: auth.userId, action: "leaderboard_user_excluded", newValue: { user_id: user.id, email: user.email, reason } })
    return NextResponse.json({ success: true })
  } catch (e) {
    return leaderboardErrorJson(e, "exclusion add")
  }
}

/** DELETE ?userId= puts a user back on the leaderboards. */
export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const userId = request.nextUrl.searchParams.get("userId") ?? ""
  if (!UUID.test(userId)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 })

  const client = db()
  try {
    const { data, error } = await client.from("leaderboard_exclusions").delete().eq("user_id", userId).select("user_id")
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: "That user is not excluded" }, { status: 404 })
    auditLog(client, { adminId: auth.userId, action: "leaderboard_user_included", oldValue: { user_id: userId } })
    return NextResponse.json({ success: true })
  } catch (e) {
    return leaderboardErrorJson(e, "exclusion remove")
  }
}
