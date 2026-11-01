/**
 * Applies a display price adjustment to every package except those with an admin-set custom price.
 * A custom price is an exact figure and must never be marked up. Order is preserved.
 */
export async function applyAdjustmentsExceptCustom<T extends { id: string | number }>(
  packages: T[],
  customIds: ReadonlyArray<string | number>,
  adjust: (pkgs: T[]) => Promise<T[]>
): Promise<T[]> {
  const custom = new Set(customIds.map(String))
  if (custom.size === 0) return adjust(packages)
  const rest = packages.filter((p) => !custom.has(String(p.id)))
  const adjusted = new Map((await adjust(rest)).map((p) => [String(p.id), p]))
  return packages.map((p) => (custom.has(String(p.id)) ? p : adjusted.get(String(p.id)) ?? p))
}
