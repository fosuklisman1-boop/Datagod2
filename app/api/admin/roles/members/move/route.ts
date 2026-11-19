import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { validateMove } from "@/lib/roles/admin/validate"
import { changeUserRole } from "@/lib/admin-users/account-ops"
import { requireHubAdmin, badRequest, readJson, serverError } from "@/lib/roles/admin/route-helpers"

const ID_CHUNK = 500

type MoveResult = { user_id: string; status: "moved" | "skipped" | "error"; reason?: string; note?: string }

/**
 * Bulk move: { user_ids, to_role, reason }. Validation (target role, 1-200 ids, reason) happens before anyone is
 * processed. Admin accounts and unknown ids are skipped here; the hub never changes an admin. Users are processed
 * one at a time, in input order, through changeUserRole (the same code as the single-user route).
 */
export async function POST(request: NextRequest) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const raw = (await readJson(request)) as { user_ids?: unknown; to_role?: unknown; reason?: unknown } | undefined
    if (!raw || typeof raw !== "object") return badRequest("body must be an object")
    const roles = await loadRoles(db)
    const parsed = validateMove({ userIds: raw.user_ids, toRole: raw.to_role, reason: raw.reason }, roles)
    if (!parsed.ok) return badRequest(parsed.error)
    const { userIds, toRole, reason } = parsed.value

    // One up-front read of every user's current role (chunked). Fail closed: if it fails, nobody is processed.
    const current = new Map<string, string | null>()
    for (let i = 0; i < userIds.length; i += ID_CHUNK) {
      const { data, error } = await db.from("users").select("id, role").in("id", userIds.slice(i, i + ID_CHUNK))
      if (error || !Array.isArray(data)) {
        console.error("[ROLES-HUB] move: role read failed")
        return serverError()
      }
      for (const row of data as { id: string; role: string | null }[]) current.set(row.id, row.role)
    }

    const results: MoveResult[] = []
    for (const userId of userIds) {
      if (!current.has(userId)) {
        results.push({ user_id: userId, status: "skipped", reason: "User not found" })
        continue
      }
      if (current.get(userId) === "admin") {
        results.push({ user_id: userId, status: "skipped", reason: "Admin accounts can't be moved here." })
        continue
      }
      try {
        const r = await changeUserRole(db, { userId, role: toRole, adminId, reason, protectAdmin: true })
        if (!r.ok) results.push({ user_id: userId, status: "skipped", reason: r.error })
        else if (!r.changed) results.push({ user_id: userId, status: "skipped", reason: "already in role" })
        else results.push(r.note ? { user_id: userId, status: "moved", note: r.note } : { user_id: userId, status: "moved" })
      } catch {
        console.error(`[ROLES-HUB] move failed for user ${userId}`)
        results.push({ user_id: userId, status: "error", reason: "Something went wrong" })
      }
    }
    return NextResponse.json({ results })
  } catch {
    console.error("[ROLES-HUB] bulk move failed")
    return serverError()
  }
}
