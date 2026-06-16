import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  getSmsAdminDashboard,
  suspendSmsAccount,
  dismissFlag,
  updateSmsSettings,
} from "@/lib/sms/moderation-service"

// GET /api/admin/shop-sms — full dashboard snapshot
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  try {
    const data = await getSmsAdminDashboard()
    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error"
    console.error("[ADMIN-SHOP-SMS-GET]", msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/shop-sms — upsert metered SMS settings
// Body: { sms_activation_fee?: number; sms_welcome_bonus_credits?: number;
//         sms_blocked_keywords?: string[]; sms_allowed_link_domains?: string[];
//         sms_feature_enabled?: boolean }
export async function PATCH(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const result = await updateSmsSettings(body)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }
  return NextResponse.json({ success: true, updated: result.updated })
}

// POST /api/admin/shop-sms — moderation actions
// Body (dismiss): { action: "dismiss_flag"; logId: string }
// Body (suspend): { action: "set_suspended"; accountId: string; suspended: boolean }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { action: string; logId?: string; accountId?: string; suspended?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  if (body.action === "dismiss_flag") {
    const { logId } = body
    if (!logId) return NextResponse.json({ success: false, error: "logId required" }, { status: 400 })

    const result = await dismissFlag(auth.userId!, logId)
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: (result as { error: string }).error },
        { status: (result as { status: 400 | 404 }).status }
      )
    }
    return NextResponse.json({ success: true })
  }

  if (body.action === "set_suspended") {
    const { accountId, suspended } = body
    if (!accountId || typeof suspended !== "boolean") {
      return NextResponse.json(
        { success: false, error: "accountId (string) and suspended (boolean) required" },
        { status: 400 }
      )
    }

    const result = await suspendSmsAccount(auth.userId!, accountId, suspended)
    if (!result.ok) {
      const errMsg = (result as { error: string }).error
      const isNotFound = errMsg.toLowerCase().includes("not found")
      return NextResponse.json({ success: false, error: errMsg }, { status: isNotFound ? 404 : 400 })
    }
    return NextResponse.json({ success: true, newStatus: (result as { newStatus: string }).newStatus })
  }

  return NextResponse.json({ success: false, error: `Unknown action: ${body.action}` }, { status: 400 })
}
