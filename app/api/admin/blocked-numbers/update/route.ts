// Admin row action: mark handled (note required) or re-open. Guarded on the current status so a concurrent
// re-check flip (blocked -> allowed) is never overwritten. No updated_at trigger exists, so it is stamped here.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { getBlockedNumbersSettings } from "@/lib/blocked-numbers/settings"
import { validateUpdateBody } from "@/lib/blocked-numbers/admin-view"

export const dynamic = "force-dynamic"

const DAY_MS = 86_400_000

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => null)
  const v = validateUpdateBody(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const { id, action, note } = v.value

  try {
    const now = new Date()
    const iso = now.toISOString()
    let query
    if (action === "handle") {
      query = supabaseAdmin
        .from("mtn_blocked_numbers")
        .update({ status: "handled", handled_at: iso, handled_by: adminId ?? null, notes: note, updated_at: iso })
        .eq("id", id)
        .in("status", ["blocked", "expired"])
    } else {
      const { retention_days } = await getBlockedNumbersSettings()
      query = supabaseAdmin
        .from("mtn_blocked_numbers")
        .update({
          status: "blocked",
          next_recheck_at: iso,
          expires_at: new Date(now.getTime() + retention_days * DAY_MS).toISOString(),
          updated_at: iso,
        })
        .eq("id", id)
        .in("status", ["handled", "expired"])
    }
    const { data, error } = await query.select("id")
    if (error) throw new Error(`update failed: ${error.code ?? "db"}`)
    if (!data || data.length === 0) {
      return NextResponse.json({ error: "Number not found or not in a state that allows this action" }, { status: 404 })
    }
    console.log(`[BLOCKED-ADMIN] update action=${action}`)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] update failed:", err instanceof Error ? err.message : "UnknownError")
    return NextResponse.json({ error: "Update failed" }, { status: 500 })
  }
}
