import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { validateReason } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, conflict, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

// Never moved, and never a swap partner: user is pinned at the bottom, admin on top, sub_agent is off the ladder.
const FIXED = new Set(["user", "admin", "sub_agent"])

/** "up" = towards a higher rank. */
export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const body = (await readJson(request)) as { direction?: unknown; reason?: unknown } | undefined
    if (!body || typeof body !== "object") return badRequest("body must be an object")
    if (body.direction !== "up" && body.direction !== "down") return badRequest('direction must be "up" or "down"')
    const reason = validateReason(body.reason)
    if (!reason.ok) return badRequest(reason.error)

    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })
    if (FIXED.has(target.slug)) return badRequest("That role cannot be moved")
    if (target.archived_at || target.rank == null) return badRequest("Only live ranked roles can be moved")
    const rank = target.rank

    const candidates = roles.filter(
      (r) => r.id !== id && !r.archived_at && r.rank != null && !FIXED.has(r.slug) && (body.direction === "up" ? r.rank > rank : r.rank < rank),
    )
    candidates.sort((a, b) => (body.direction === "up" ? (a.rank as number) - (b.rank as number) : (b.rank as number) - (a.rank as number)))
    const neighbour = candidates[0]
    if (!neighbour) return conflict("Already at the end of the ladder.")

    const { error } = await db.rpc("admin_role_swap_rank", { p_actor: adminId, p_reason: reason.value, p_a: id,
      p_b: neighbour.id,
      p_expected_a: rank,
      p_expected_b: neighbour.rank,
    })
    if (error) return mapRpcError(error)
    return NextResponse.json({ ok: true })
  } catch {
    console.error("[ROLES-HUB] move failed")
    return serverError()
  }
}
