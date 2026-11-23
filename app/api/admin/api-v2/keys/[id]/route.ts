import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { planKeyPatch } from "@/lib/api-v2/admin-actions"
import { decide, type RpcClient } from "@/lib/api-v2/approvals"
import { auditApi } from "@/lib/api-v2/admin-audit"
import type { KeyStatus } from "@/lib/api-v2/keys"

const KEY_COLUMNS =
  "id, user_id, key_type, environment, status, name, key_prefix, rate_limits, last_used_at, created_at, approved_at, approved_by, revoked_at, revoked_by, updated_at"

/**
 * PATCH /api/admin/api-v2/keys/[id] - Admin: approve, reject, revoke, set/reset limits.
 * Approve and reject go through the atomic api_v2_* functions (which audit and keep the old key until the new one
 * activates); revoke and limits update the row here and write an api_* audit row.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  // A person must own every key change (the audit row needs them); the cron secret has no user id.
  if (!userId) return NextResponse.json({ error: "Sign in with an admin account to change keys." }, { status: 403 })

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const supabase = getAdminClient()
  const action = (body as { action?: unknown } | null)?.action
  if (action === "approve" || action === "reject") {
    const reason = (body as { reason?: unknown }).reason
    const out = await decide(supabase as RpcClient, {
      kind: "key",
      action,
      id,
      actorId: userId,
      reason: typeof reason === "string" ? reason : undefined,
    })
    return NextResponse.json(out.body, { status: out.status })
  }

  const { data: current, error: loadError } = await supabase
    .from("api_v2_keys")
    .select("id, status, user_id")
    .eq("id", id)
    .maybeSingle()
  if (loadError) {
    console.error("[ADMIN API V2] Load key error:", loadError)
    return NextResponse.json({ error: "Failed to load API key" }, { status: 500 })
  }
  if (!current) return NextResponse.json({ error: "API key not found" }, { status: 404 })

  const fromStatus = current.status as KeyStatus
  const plan = planKeyPatch({ status: fromStatus }, body, new Date())
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: plan.status })

  const update: Record<string, unknown> = { ...plan.update }
  if (userId && "revoked_at" in update) update.revoked_by = userId

  // Filter on the status the plan was computed from so a concurrent change is not overwritten.
  const { data: updated, error: updateError } = await supabase
    .from("api_v2_keys")
    .update(update)
    .eq("id", id)
    .eq("status", fromStatus)
    .select(KEY_COLUMNS)
  if (updateError) {
    console.error("[ADMIN API V2] Update key error:", updateError)
    return NextResponse.json({ error: "Failed to update API key" }, { status: 500 })
  }
  if (!Array.isArray(updated) || updated.length === 0) {
    return NextResponse.json({ error: "Key changed concurrently; reload and retry" }, { status: 409 })
  }

  const audited = await auditApi(supabase, {
    adminId: userId,
    action: action === "revoke" ? "api_key_revoke" : "api_key_limits",
    targetUserId: typeof current.user_id === "string" ? current.user_id : null,
    before: { key_id: id, status: fromStatus },
    after: { key_id: id, action, ...("rate_limits" in update ? { rate_limits: update.rate_limits } : {}) },
  })
  return NextResponse.json(audited ? { key: updated[0] } : { key: updated[0], auditFailed: true })
}
