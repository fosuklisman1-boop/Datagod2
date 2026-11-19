import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { validateReason } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, conflict, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const body = (await readJson(request)) as { reason?: unknown } | undefined
    const reason = validateReason(body && typeof body === "object" ? body.reason : undefined)
    if (!reason.ok) return badRequest(reason.error)

    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })

    const { count, error: countError } = await db.from("users").select("id", { count: "exact", head: true }).eq("role", target.slug)
    if (countError || typeof count !== "number") return serverError()
    if (count > 0) return conflict(`Move its ${count} members first.`)

    const { error } = await db.rpc("admin_role_archive", { p_actor: adminId, p_reason: reason.value, p_role_id: id })
    if (error) return mapRpcError(error)
    return NextResponse.json({ ok: true })
  } catch {
    console.error("[ROLES-HUB] archive failed")
    return serverError()
  }
}
