import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { validateRolePatch } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const v = validateRolePatch(await readJson(request))
    if (!v.ok) return badRequest(v.error)
    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })
    if (target.slug === "admin") return badRequest("The admin role cannot be edited")
    if (target.slug === "sub_agent" && v.value.theme !== undefined) return badRequest("The sub_agent theme cannot be changed")
    const { error } = await db.rpc("admin_role_update", {
      p_actor: adminId,
      p_reason: "basics edit",
      p_role_id: id,
      p_patch: v.value,
    })
    if (error) return mapRpcError(error)
    return NextResponse.json({ ok: true })
  } catch {
    console.error("[ROLES-HUB] update failed")
    return serverError()
  }
}
