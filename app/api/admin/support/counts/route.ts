import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, requireSupportAdmin } from "@/lib/support-auth"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function GET(request: NextRequest) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response

  try {
    const db = getSupportDb()
    const [open, unread, legacy] = await Promise.all([
      db.from("support_threads").select("id", { count: "exact", head: true }).eq("status", "open"),
      db.from("support_messages").select("id", { count: "exact", head: true }).eq("sender_role", "user").is("read_by_admin_at", null),
      db.from("complaints").select("id", { count: "exact", head: true }).in("status", ["pending", "in_review"]),
    ])
    if (open.error || unread.error || legacy.error) {
      console.error("[SUPPORT] admin counts failed", { adminId: auth.adminId })
      return fail("Something went wrong. Please try again.", 500)
    }
    return NextResponse.json({
      success: true,
      data: { openThreads: open.count ?? 0, unreadMessages: unread.count ?? 0, legacyPending: legacy.count ?? 0 },
    })
  } catch {
    console.error("[SUPPORT] admin counts threw", { adminId: auth.adminId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
