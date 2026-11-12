import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { serviceClient } from "@/lib/admin-users/route-utils"
import { ASSIGNABLE_ROLES, changeUserRole, type AssignableRole } from "@/lib/admin-users/account-ops"

// POST: Update a user's role (Admin only). The rules (sub-agents cannot become dealers, the dealer margin
// adjustment, the audit row) live in lib/admin-users/account-ops.ts, shared with POST /api/admin/users/bulk.
// The gate is unchanged: the CRON bypass (AI tools) may still call it; those calls are not audited.
export async function POST(request: NextRequest) {
    const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    try {
        const body = await request.json()
        const { userId, role, newRole } = body
        const targetRole = newRole || role  // Support both 'role' and 'newRole'

        if (!userId || !targetRole) {
            return NextResponse.json({ error: "Missing userId or role" }, { status: 400 })
        }
        if (!(ASSIGNABLE_ROLES as readonly string[]).includes(targetRole)) {
            return NextResponse.json({ error: `Invalid role. Must be one of: ${ASSIGNABLE_ROLES.join(", ")}` }, { status: 400 })
        }

        const result = await changeUserRole(serviceClient(), { userId, role: targetRole as AssignableRole, adminId })
        if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

        return NextResponse.json({
            success: true,
            message: result.changed ? `User role updated to '${targetRole}'` : `User already has role '${targetRole}'`,
            userId,
            newRole: targetRole,
            changed: result.changed,
            ...(result.note ? { note: result.note } : {}),
        })
    } catch (error) {
        console.error("[UPDATE-ROLE] Error:", error)
        return NextResponse.json({ error: "Failed to update user role" }, { status: 500 })
    }
}
