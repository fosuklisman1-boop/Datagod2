import { NextRequest, NextResponse } from "next/server"
import { isCapability, type Capability } from "@/lib/roles/capabilities"
import { loadRoles, ROW_CAP } from "@/lib/roles/repo"
import { __resetRightsCache } from "@/lib/roles/permissions-repo"
import { validateCapabilities, validateReason } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, mapRpcError, readJson, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

const FIXED_RIGHTS = new Set(["admin", "sub_agent"])

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })

    const { data, error } = await db.from("role_permissions").select("capability").eq("role_id", id).limit(ROW_CAP)
    if (error || !Array.isArray(data) || data.length >= ROW_CAP) return serverError()
    const capabilities: Capability[] = []
    for (const row of data as Array<{ capability: unknown }>) {
      if (isCapability(row.capability) && !capabilities.includes(row.capability)) capabilities.push(row.capability)
    }

    const stats = await db.rpc("admin_role_stats")
    if (stats.error || !Array.isArray(stats.data)) return serverError()
    const mine = (stats.data as Array<{ role_id: unknown; member_count: unknown }>).find((s) => String(s.role_id) === id)
    const memberCount = mine ? Number(mine.member_count) : NaN
    if (!Number.isFinite(memberCount)) return serverError()

    return NextResponse.json({ editable: !FIXED_RIGHTS.has(target.slug), capabilities, member_count: memberCount })
  } catch {
    console.error("[ROLES-HUB] permissions read failed")
    return serverError()
  }
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })
    if (FIXED_RIGHTS.has(target.slug)) return NextResponse.json({ error: "This role's rights cannot be edited" }, { status: 403 })

    const body = (await readJson(request)) as { capabilities?: unknown; reason?: unknown } | undefined
    const input = body && typeof body === "object" ? body : {}
    const reason = validateReason(input.reason)
    if (!reason.ok) return badRequest(reason.error)
    const caps = validateCapabilities(input.capabilities)
    if (!caps.ok) return badRequest(caps.error)

    const { error } = await db.rpc("admin_role_set_permissions", {
      p_actor: adminId,
      p_reason: reason.value,
      p_role_id: id,
      p_caps: caps.value,
    })
    if (error) return mapRpcError(error)
    // Per-instance cache (60 s TTL): other server instances pick the change up within 60 s.
    __resetRightsCache()
    return NextResponse.json({ ok: true })
  } catch {
    console.error("[ROLES-HUB] permissions write failed")
    return serverError()
  }
}
