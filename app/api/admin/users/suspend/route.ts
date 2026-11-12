import { NextRequest, NextResponse } from "next/server"
import { gateAdmin, serviceClient } from "@/lib/admin-users/route-utils"
import { isUuid } from "@/lib/admin-users/drawer-params"
import { setUserSuspended } from "@/lib/admin-users/account-ops"

/**
 * POST /api/admin/users/suspend { userId, action: "suspend" | "unsuspend", reason? }
 * The work (auth ban, users.is_suspended, audit row, SMS / email / push to the user) is
 * lib/admin-users/account-ops.ts setUserSuspended, shared with POST /api/admin/users/bulk.
 */
export async function POST(req: NextRequest) {
  try {
    // Honours every gate error including the rate limit (429). write: false keeps the CRON bypass working here:
    // the AI scheduled tasks and WhatsApp admin bot suspend users through this route. Those calls have no admin
    // id, so they are not audited (admin_audit_log.admin_id is NOT NULL).
    const gate = await gateAdmin(req, { write: false })
    if (!gate.ok) return gate.response

    const { userId, action, reason } = await req.json()
    if (!isUuid(userId) || !["suspend", "unsuspend"].includes(action)) {
      return NextResponse.json({ error: "Valid User ID and action (suspend/unsuspend) are required" }, { status: 400 })
    }

    const isSuspending = action === "suspend"
    console.log(`[ADMIN-SUSPEND-USER] Admin is attempting to ${action} user ${userId}...`)
    const result = await setUserSuspended(serviceClient(), { userId, suspend: isSuspending, reason, adminId: gate.adminId })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    return NextResponse.json({
      success: true,
      message: `User successfully ${isSuspending ? "suspended" : "unsuspended"}`,
      action,
      notifications: result.notifications,
      diagnostics: {
        SMS_ENABLED: process.env.SMS_ENABLED === "true",
        SMS_PROVIDER: process.env.SMS_PROVIDER || "moolre",
        HAS_SENDER_ID: !!(process.env.MOOLRE_SENDER_ID || process.env.MNOTIFY_SENDER_ID || process.env.BREVO_SMS_SENDER),
      },
    })
  } catch (error: any) {
    console.error("[ADMIN-SUSPEND-USER] Fatal error:", error)
    return NextResponse.json({
      error: error.message || "Internal server error",
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    }, { status: 500 })
  }
}
