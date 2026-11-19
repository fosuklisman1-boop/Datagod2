export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

export const capsDirty = (loaded: readonly string[], current: readonly string[]) => !sameSet(loaded, current)

export function toggleCap<T extends string>(current: readonly T[], cap: T, on: boolean): T[] {
  const rest = current.filter((c) => c !== cap)
  return on ? [...rest, cap] : rest
}

/** Confirm text for saving rights. Saving an empty set is allowed but called out. */
export function rightsConfirmText(memberCount: number, capCount: number): string {
  const base = `This changes what ${memberCount} member${memberCount === 1 ? "" : "s"} can do.`
  return capCount === 0 ? `${base} Saving an empty set removes every right from this role.` : base
}
