import { validateNewRole } from "@/lib/roles/admin/validate"
import type { HubRole } from "./ladder-view"

export interface CreateRoleFormValues {
  slug: string
  name: string
  rank: string
  cloneFrom: string
  reason: string
}

export type CreateRoleBody = { slug: string; name: string; rank: number; clone_from: string | null; reason: string }

/** Default rank for a new role: the highest live rank + 10. */
export function defaultNewRank(roles: readonly HubRole[]): number {
  const ranks = roles.filter((r) => !r.archived_at && r.rank != null).map((r) => r.rank as number)
  return (ranks.length ? Math.max(...ranks) : 0) + 10
}

/** Runs the server validator against the loaded roles (archived included) before POST. */
export function validateCreateRoleForm(
  form: CreateRoleFormValues,
  roles: readonly HubRole[],
): { ok: true; value: CreateRoleBody } | { ok: false; error: string } {
  const rankText = form.rank.trim()
  const rank = /^\d+$/.test(rankText) ? Number(rankText) : NaN
  const res = validateNewRole(
    { slug: form.slug, name: form.name, rank, cloneFrom: form.cloneFrom || null, reason: form.reason },
    roles,
  )
  if (!res.ok) return res
  const v = res.value
  return { ok: true, value: { slug: v.slug, name: v.name, rank: v.rank, clone_from: v.cloneFrom, reason: v.reason } }
}
