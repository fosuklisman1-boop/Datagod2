/**
 * Pure helpers for the grouped, collapsible sidebar (components/layout/sidebar.tsx).
 *
 * Open/closed state is a plain `{ [groupId]: boolean }` map. A group the user
 * never touched has no entry and uses its default; the sidebar persists the
 * map per device (localStorage) and force-opens the group holding the current
 * page on every navigation, so the active link is never hidden.
 */

export interface NavGroupDef {
  id: string
  label: string
}

export interface NavSection<T> {
  /** null = ungrouped items shown above the first heading. */
  group: NavGroupDef | null
  items: T[]
}

export type GroupState = Readonly<Record<string, boolean>>

/** Ungrouped first, then groups in `groups` order; empty groups are dropped; item order is kept. */
export function groupNavItems<T extends { group?: string }>(
  items: readonly T[],
  groups: readonly NavGroupDef[]
): NavSection<T>[] {
  const known = new Set(groups.map(g => g.id))
  const ungrouped = items.filter(i => !i.group || !known.has(i.group))
  const sections: NavSection<T>[] = ungrouped.length ? [{ group: null, items: ungrouped }] : []
  for (const g of groups) {
    const inGroup = items.filter(i => i.group === g.id)
    if (inGroup.length) sections.push({ group: g, items: inGroup })
  }
  return sections
}

/** Longest href that equals `pathname` or is a path-boundary prefix of it. */
export function findActiveHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null
  for (const href of hrefs) {
    const hit = pathname === href || pathname.startsWith(href.endsWith("/") ? href : href + "/")
    if (hit && (best === null || href.length > best.length)) best = href
  }
  return best
}

export function findActiveGroupId(
  pathname: string,
  items: readonly { href: string; group?: string }[]
): string | null {
  const href = findActiveHref(pathname, items.map(i => i.href))
  if (href === null) return null
  return items.find(i => i.href === href)?.group ?? null
}

export function isGroupOpen(state: GroupState, id: string, defaultOpen: boolean): boolean {
  return Object.prototype.hasOwnProperty.call(state, id) ? state[id] === true : defaultOpen
}

export function toggleGroup(state: GroupState, id: string, defaultOpen: boolean): GroupState {
  return { ...state, [id]: !isGroupOpen(state, id, defaultOpen) }
}

/** Opens `id`; returns the SAME object when already open (lets React skip a re-render). */
export function openGroup(state: GroupState, id: string | null): GroupState {
  if (id === null || state[id] === true) return state
  return { ...state, [id]: true }
}

/** Parse the persisted map; anything unexpected becomes {} (all defaults). */
export function parseGroupState(raw: string | null): GroupState {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v
    }
    return out
  } catch {
    return {}
  }
}
