// lib/roles/margin-strategy.ts
// Pure rules for what a role change does to a shop's package margins.
//   legacy    the original dealer rules in lib/admin-users/account-ops.ts (raise on dealer, recorded reversal)
//   recompute keep the selling price fixed: move each margin by (oldBase - newBase), clamped at 0
//   none      leave margins alone
export type MarginStrategy = "legacy" | "recompute" | "none"

/** latestRecompute = the user's latest user_role_change audit row has new_value.margin_mode === "recompute". */
export function marginStrategy(
  oldRole: string,
  newRole: string,
  opts: { isCustom: (slug: string) => boolean; latestRecompute: boolean },
): MarginStrategy {
  if (opts.isCustom(oldRole) || opts.isCustom(newRole)) return "recompute"
  if (oldRole === "dealer" && newRole !== "admin" && opts.latestRecompute) return "recompute"
  if (newRole === "dealer" || (oldRole === "dealer" && newRole !== "admin")) return "legacy"
  return "none"
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** New margin keeping the selling price fixed: max(0, round2(margin + oldBase - newBase)); clamped=true when the max applied. */
export function recomputeMargin(margin: number, oldBase: number, newBase: number): { margin: number; clamped: boolean } {
  const raw = round2(margin + oldBase - newBase)
  return raw < 0 ? { margin: 0, clamped: true } : { margin: raw, clamped: false }
}
