import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient, getApprovalContact, listActiveRoles } from "@/lib/api-v2/store"
import { parseConfigUpdate } from "@/lib/api-v2/lifecycle"
import { auditApi } from "@/lib/api-v2/admin-audit"

function shape(data: { enabled?: unknown; allowed_roles?: unknown }) {
  return {
    enabled: data.enabled === true,
    allowed_roles: Array.isArray(data.allowed_roles) ? data.allowed_roles : [],
  }
}

/** Same role set, ignoring order and duplicates. */
function sameRoleSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every((r) => y.has(r))
}

/**
 * GET /api/admin/api-v2/config - Admin: read v2 API config, the approval contact and the active roles.
 * The roles list is null when it could not be loaded; the config and contact still come back.
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from("api_v2_config")
    .select("enabled, allowed_roles")
    .eq("id", true)
    .maybeSingle()
  if (error || !data) {
    console.error("[ADMIN API V2] Config read error:", error)
    return NextResponse.json({ error: "Failed to read API config" }, { status: 500 })
  }
  // Neither of these can fail the page: the contact reads null on any error (even a missing column).
  const [roles, approval_whatsapp] = await Promise.all([listActiveRoles(supabase), getApprovalContact(supabase)])
  return NextResponse.json({
    ...shape(data),
    approval_whatsapp,
    roles: roles === "error" ? null : roles,
  })
}

/** PUT /api/admin/api-v2/config - Admin: update enabled / allowed_roles / approval contact. */
export async function PUT(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const supabase = getAdminClient()

  // Roles are validated, and read, ONLY when the submitted set differs from the stored one. The console
  // always sends the full list, so an unchanged list (even one holding an archived slug) must save without
  // touching `roles`: switching the API off can never depend on that read. Slugs already stored may stay;
  // newly added ones must be active roles.
  let knownRoles: string[] = []
  const requested = (body as { allowed_roles?: unknown } | null)?.allowed_roles
  if (Array.isArray(requested) && requested.every((r) => typeof r === "string")) {
    const { data: storedRow, error: storedError } = await supabase
      .from("api_v2_config")
      .select("enabled, allowed_roles")
      .eq("id", true)
      .maybeSingle()
    if (storedError || !storedRow || !Array.isArray(storedRow.allowed_roles)) {
      console.error("[ADMIN API V2] Config read error before update:", storedError)
      return NextResponse.json({ error: "Could not read the current API config. Please try again." }, { status: 503 })
    }
    const storedRoles = storedRow.allowed_roles as string[]
    knownRoles = storedRoles
    if (!sameRoleSet(requested as string[], storedRoles)) {
      const active = await listActiveRoles(supabase)
      if (active === "error") {
        return NextResponse.json({ error: "Could not check the role list. Please try again." }, { status: 503 })
      }
      knownRoles = [...storedRoles, ...active.map((r) => r.slug)]
    }
  }

  const parsed = parseConfigUpdate(body, knownRoles)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const update: Record<string, unknown> = { ...parsed.value, updated_at: new Date().toISOString() }
  if (userId) update.updated_by = userId

  const { data, error } = await supabase
    .from("api_v2_config")
    .update(update)
    .eq("id", true)
    .select("enabled, allowed_roles")
    .maybeSingle()
  if (error || !data) {
    console.error("[ADMIN API V2] Config update error:", error)
    return NextResponse.json({ error: "Failed to update API config" }, { status: 500 })
  }
  // Audit what changed, never the contact number itself.
  const audited = await auditApi(supabase, {
    adminId: userId,
    action: "api_config",
    after: {
      ...("enabled" in parsed.value ? { enabled: parsed.value.enabled } : {}),
      ...("allowed_roles" in parsed.value ? { allowed_roles: parsed.value.allowed_roles } : {}),
      ...("approval_whatsapp" in parsed.value ? { approval_contact_changed: true } : {}),
    },
  })
  // The contact is echoed only when this save carried it, so every other response is independent of the column.
  const payload: Record<string, unknown> =
    "approval_whatsapp" in parsed.value
      ? { ...shape(data), approval_whatsapp: parsed.value.approval_whatsapp ?? null }
      : shape(data)
  if (!audited) payload.auditFailed = true
  return NextResponse.json(payload)
}
