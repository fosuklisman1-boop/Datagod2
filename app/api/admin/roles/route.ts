import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { validateNewRole } from "@/lib/roles/admin/validate"
import { requireHubAdmin, badRequest, mapRpcError, readJson, serverError } from "@/lib/roles/admin/route-helpers"

type StatRow = { role_id: string; member_count: number | string; priced_count: number | string }

export async function GET(request: NextRequest) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db } = gate
  try {
    const [rolesRes, statsRes, pkgRes] = await Promise.all([
      db
        .from("roles")
        .select("id, slug, name, description, badge_color, icon, rank, is_system, archived_at, theme")
        .order("rank", { ascending: true, nullsFirst: false })
        .limit(1000),
      db.rpc("admin_role_stats"),
      db.from("packages").select("id", { count: "exact", head: true }).eq("active", true),
    ])
    if (rolesRes.error || !Array.isArray(rolesRes.data)) return serverError()
    if (statsRes.error || !Array.isArray(statsRes.data)) return serverError()
    if (pkgRes.error || typeof pkgRes.count !== "number") return serverError()
    const stats = new Map<string, StatRow>()
    for (const s of statsRes.data as StatRow[]) stats.set(String(s.role_id), s)
    const roles = (rolesRes.data as Array<Record<string, unknown> & { id: string }>).map((r) => ({
      ...r,
      member_count: Number(stats.get(r.id)?.member_count ?? 0),
      priced_count: Number(stats.get(r.id)?.priced_count ?? 0),
    }))
    return NextResponse.json({ roles, package_total: pkgRes.count })
  } catch {
    console.error("[ROLES-HUB] list failed")
    return serverError()
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db, adminId } = gate
  try {
    const raw = await readJson(request)
    // The documented body key is clone_from; the validator calls it cloneFrom.
    const input =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (() => {
            const { clone_from, ...rest } = raw as Record<string, unknown>
            return { ...rest, cloneFrom: (rest.cloneFrom ?? clone_from) as unknown }
          })()
        : raw
    // Include archived roles: a retired slug stays taken.
    const roles = await loadRoles(db)
    const v = validateNewRole(input, roles)
    if (!v.ok) return badRequest(v.error)
    const cloneId = v.value.cloneFrom ? (roles.find((r) => r.slug === v.value.cloneFrom)?.id ?? null) : null
    const { data, error } = await db.rpc("admin_role_create", {
      p_actor: adminId,
      p_reason: v.value.reason,
      p_slug: v.value.slug,
      p_name: v.value.name,
      p_rank: v.value.rank,
      p_clone_from: cloneId,
    })
    if (error) return mapRpcError(error)
    return NextResponse.json({ id: data }, { status: 201 })
  } catch {
    console.error("[ROLES-HUB] create failed")
    return serverError()
  }
}
