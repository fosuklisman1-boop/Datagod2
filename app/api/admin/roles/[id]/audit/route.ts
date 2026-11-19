import { NextRequest, NextResponse } from "next/server"
import { loadRoles } from "@/lib/roles/repo"
import { requireHubAdmin, badRequest, serverError, UUID_RE } from "@/lib/roles/admin/route-helpers"

type Ctx = { params: Promise<{ id: string }> }

const PAGE_SIZE = 50
const MAX_PAGE = 200
const EMAIL_CHUNK = 500
const SLUG_SAFE = /^[a-z0-9_]+$/

type Entry = {
  at: string
  actor_id: string | null
  actor_email: string | null
  action: string
  summary: string
  reason: string | null
  loss_override: boolean
}

type RoleLogRow = {
  actor_id: string | null
  action: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  loss_override: boolean | null
  created_at: string
}
type AdminLogRow = {
  admin_id: string | null
  action: string
  old_value: { role?: unknown } | null
  new_value: { role?: unknown } | null
  created_at: string
}

function summarize(r: RoleLogRow): string {
  const after = r.after
  switch (r.action) {
    case "create":
    case "clone":
      return `${r.action === "clone" ? "Cloned" : "Created"} role${after && typeof after.name === "string" ? ` "${after.name}"` : ""}`
    case "update":
      return `Edited basics${after ? ` (${Object.keys(after).join(", ")})` : ""}`
    case "rank":
      return `Rank ${r.before?.rank ?? "?"} to ${after?.rank ?? "?"}`
    case "archive":
      return "Archived role"
    case "prices":
      return `Changed prices (${Array.isArray(after) ? after.length : 0} packages)`
    case "price_external":
      return "Prices changed outside the hub"
    default:
      return r.action
  }
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const gate = await requireHubAdmin(request)
  if ("response" in gate) return gate.response
  const { db } = gate
  try {
    const { id } = await params
    if (!UUID_RE.test(id)) return badRequest("Invalid role id")
    const rawPage = Number(new URL(request.url).searchParams.get("page") ?? "1")
    const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, MAX_PAGE) : 1

    const roles = await loadRoles(db)
    const target = roles.find((r) => r.id === id)
    if (!target) return NextResponse.json({ error: "Role not found" }, { status: 404 })
    if (!SLUG_SAFE.test(target.slug)) return serverError()

    // Each source is read up to the end of the requested page plus one row (for has_more), then merged.
    const need = page * PAGE_SIZE + 1
    const [roleLog, adminLog] = await Promise.all([
      db
        .from("role_audit_log")
        .select("actor_id, action, before, after, reason, loss_override, created_at")
        .eq("role_id", id)
        .order("created_at", { ascending: false })
        .limit(need),
      db
        .from("admin_audit_log")
        .select("admin_id, action, old_value, new_value, created_at")
        .eq("action", "user_role_change")
        .or(`old_value->>role.eq.${target.slug},new_value->>role.eq.${target.slug}`)
        .order("created_at", { ascending: false })
        .limit(need),
    ])
    if (roleLog.error || !Array.isArray(roleLog.data)) return serverError()
    if (adminLog.error || !Array.isArray(adminLog.data)) return serverError()

    const merged: Omit<Entry, "actor_email">[] = [
      ...(roleLog.data as RoleLogRow[]).map((r) => ({
        at: r.created_at,
        actor_id: r.actor_id,
        action: r.action,
        summary: summarize(r),
        reason: r.reason,
        loss_override: !!r.loss_override,
      })),
      ...(adminLog.data as AdminLogRow[]).map((r) => ({
        at: r.created_at,
        actor_id: r.admin_id,
        action: r.action,
        summary: `Member role changed: ${String(r.old_value?.role ?? "?")} to ${String(r.new_value?.role ?? "?")}`,
        reason: null,
        loss_override: false,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

    const slice = merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    const has_more = merged.length > page * PAGE_SIZE

    const actorIds = [...new Set(slice.map((e) => e.actor_id).filter((x): x is string => !!x))]
    const emails = new Map<string, string | null>()
    for (let i = 0; i < actorIds.length; i += EMAIL_CHUNK) {
      const { data, error } = await db.from("users").select("id, email").in("id", actorIds.slice(i, i + EMAIL_CHUNK))
      if (error || !Array.isArray(data)) return serverError()
      for (const u of data as { id: string; email: string | null }[]) emails.set(u.id, u.email ?? null)
    }

    const entries: Entry[] = slice.map((e) => ({ ...e, actor_email: e.actor_id ? (emails.get(e.actor_id) ?? null) : null }))
    return NextResponse.json({ entries, page, has_more })
  } catch {
    console.error("[ROLES-HUB] audit read failed")
    return serverError()
  }
}
