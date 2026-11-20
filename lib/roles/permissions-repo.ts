// lib/roles/permissions-repo.ts
// Fail-closed reads of role capabilities. Any read error rejects with RoleReadError; callers refuse (503).
import { isCapability, rightsFor, type Capability, type RoleRights } from "./capabilities"
import type { RoleRow } from "./ladder"
import { loadRoles, RoleReadError } from "./repo"

type ClientLike = { from(table: string): any }

// Below PostgREST's usual max_rows (1000) so a short page really means "last page".
const PAGE_SIZE = 500
const MAX_PAGES = 200

/** Reads every role_permissions row in stable-ordered pages. Any read error rejects; row count alone never does. */
export async function loadRolePermissions(client: ClientLike): Promise<Map<string, Set<Capability>>> {
  const all: Array<{ role_id: unknown; capability: unknown }> = []
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new RoleReadError() // runaway loop guard, not a size limit in practice
    let res: { data: unknown; error: unknown }
    try {
      res = await client
        .from("role_permissions")
        .select("role_id, capability")
        .order("role_id", { ascending: true })
        .order("capability", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)
    } catch {
      throw new RoleReadError()
    }
    if (!res || res.error || !Array.isArray(res.data)) throw new RoleReadError()
    all.push(...(res.data as Array<{ role_id: unknown; capability: unknown }>))
    if (res.data.length < PAGE_SIZE) break
  }
  const out = new Map<string, Set<Capability>>()
  for (const row of all) {
    if (row.role_id == null || !isCapability(row.capability)) continue
    const id = String(row.role_id)
    let set = out.get(id)
    if (!set) out.set(id, (set = new Set()))
    set.add(row.capability)
  }
  return out
}

const TTL_MS = 60_000
let cache: { at: number; roles: RoleRow[]; perms: Map<string, Set<Capability>> } | null = null

export function __resetRightsCache(): void {
  cache = null
}

async function rolesAndPerms(client: ClientLike) {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache
  const [roles, perms] = await Promise.all([loadRoles(client), loadRolePermissions(client)])
  cache = { at: now, roles, perms }
  return cache
}

/** Reads users.role (NULL -> "user"), then rights from the (60 s cached) roles and permissions. */
export async function rightsForUser(
  client: ClientLike,
  userId: string
): Promise<{ slug: string; rights: RoleRights }> {
  let res: { data: any; error: unknown }
  try {
    res = await client.from("users").select("role").eq("id", userId).maybeSingle()
  } catch {
    throw new RoleReadError()
  }
  // No row at all is not "a user with no role": fail closed.
  if (!res || res.error || !res.data) throw new RoleReadError()
  const slug: string = typeof res.data.role === "string" && res.data.role ? res.data.role : "user"
  const { roles, perms } = await rolesAndPerms(client)
  return { slug, rights: rightsFor(slug, roles, perms) }
}
