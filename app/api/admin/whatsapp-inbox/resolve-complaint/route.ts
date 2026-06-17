import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { resolveOpenComplaintsForPhone } from "@/lib/whatsapp-bot/complaints"

export const dynamic = "force-dynamic"

// POST /api/admin/whatsapp-inbox/resolve-complaint  { phone, note? }
//
// Explicitly resolves the customer's OPEN (unclaimed) complaints from the web inbox.
// This is a DELIBERATE action (a button) — unlike sending a reply, which never
// resolves complaints. "claimed" complaints are left untouched: they're being worked
// via the WhatsApp "complaints" flow (adminComplaintRouter) and must be resolved there.
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = (await request.json().catch(() => ({}))) as { phone?: string; note?: string }
  const phone = String(body.phone ?? "").replace(/[^\d]/g, "")
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })

  const note = String(body.note ?? "Resolved from the WhatsApp inbox").slice(0, 2000)
  const resolved = await resolveOpenComplaintsForPhone(phone, userId ? `admin:${userId}` : "admin", note)

  return NextResponse.json({ ok: true, resolved })
}
