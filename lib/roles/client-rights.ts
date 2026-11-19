// lib/roles/client-rights.ts
// Pure client-side helpers for the /api/user/role response. No React here.
import { isCapability, navVisible, type Capability, type RoleRights } from "./capabilities"
import { menuItems, shopItems } from "../dashboard-nav-items"

export type RoleSkin = "default" | "dealer"
export const EMPTY_RIGHTS: RoleRights = { kind: "set", caps: new Set() }

export type RoleInfo = {
  slug: string
  name: string
  badge_color: string | null
  icon: string | null
  skin: RoleSkin
  rights: RoleRights
}

export type RightsState =
  | { status: "loading"; slug: string | null; rights: RoleRights }
  | { status: "error"; slug: string | null; rights: RoleRights }
  | { status: "ok"; slug: string; rights: RoleRights }

/** Validates the response body; null when it is not the expected shape (treated as an error by callers). */
export function parseRoleResponse(body: unknown): RoleInfo | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (typeof b.slug !== "string" || !b.slug) return null
  let rights: RoleRights
  if (b.rights === "all") rights = { kind: "all" }
  else if (b.rights === "sub_agent") rights = { kind: "sub_agent" }
  else if (Array.isArray(b.rights)) {
    rights = { kind: "set", caps: new Set(b.rights.filter(isCapability) as Capability[]) }
  } else return null
  const theme = b.theme as { skin?: unknown } | undefined
  return {
    slug: b.slug,
    name: typeof b.name === "string" ? b.name : b.slug,
    badge_color: typeof b.badge_color === "string" ? b.badge_color : null,
    icon: typeof b.icon === "string" ? b.icon : null,
    skin: theme?.skin === "dealer" ? "dealer" : "default",
    rights,
  }
}

/** Admin skin is decided by isAdmin; otherwise the role's own skin. */
export function skinFor(isAdmin: boolean, skin: RoleSkin | null): "admin" | RoleSkin {
  return isAdmin ? "admin" : (skin ?? "default")
}

/**
 * True when a /dashboard/* path belongs to a nav item the caller cannot see. Only after rights loaded
 * successfully (never while loading or after an error), and never for admins.
 */
export function shouldRedirectUnavailable(pathname: string, state: RightsState, isAdmin: boolean): boolean {
  if (isAdmin || state.status !== "ok") return false
  if (!pathname.startsWith("/dashboard/") || pathname === "/dashboard/unavailable") return false
  const match = [...menuItems, ...shopItems]
    .filter((i) => i.href !== "/dashboard" && (pathname === i.href || pathname.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]
  if (!match) return false
  return !navVisible(match, state.slug, state.rights)
}
