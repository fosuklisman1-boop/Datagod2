import type { BadgeColor, RoleIcon } from "@/lib/roles/admin/validate"

/** One row of GET /api/admin/roles. */
export interface HubRole {
  id: string
  slug: string
  name: string
  description: string | null
  badge_color: BadgeColor | string | null
  icon: RoleIcon | string | null
  rank: number | null
  is_system: boolean
  archived_at: string | null
  theme: { skin?: "default" | "dealer" } | null
  member_count: number
  priced_count: number
}

/** Never moved, never a swap partner (mirrors the move route). */
export const FIXED_SLUGS: ReadonlySet<string> = new Set(["user", "admin", "sub_agent"])

export interface LadderState {
  /** Live ranked roles, highest rank (most senior) first. */
  ladder: HubRole[]
  /** Live roles with no rank (sub_agent and similar). */
  offLadder: HubRole[]
  archived: HubRole[]
  /** Slugs of the ladder roles that can be moved, in ladder order. */
  movable: string[]
}

export function ladderState(roles: readonly HubRole[]): LadderState {
  const live = roles.filter((r) => !r.archived_at)
  const ladder = live.filter((r) => r.rank != null).sort((a, b) => (b.rank as number) - (a.rank as number))
  const offLadder = live.filter((r) => r.rank == null)
  const archived = roles.filter((r) => r.archived_at)
  // Dealer is immovable and custom roles stay strictly above it (mirrors the move route), so only
  // ranked custom roles above dealer take part in swaps.
  const dealerRank = ladder.find((r) => r.slug === "dealer")?.rank
  const movable = ladder
    .filter((r) => !FIXED_SLUGS.has(r.slug) && r.slug !== "dealer" && dealerRank != null && (r.rank as number) > dealerRank)
    .map((r) => r.slug)
  return { ladder, offLadder, archived, movable }
}
