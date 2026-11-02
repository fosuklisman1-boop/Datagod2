// Navigation stack of the admin user drawer: the user opened from the list, then any sub-agent or parent
// opened from the Shop tab on top. Each entry remembers its own tab, so Back returns to where you were.

export const DRAWER_TABS = ["profile", "orders", "wallet", "shop", "notes", "history"] as const
export type DrawerTab = (typeof DRAWER_TABS)[number]

export interface DrawerEntry {
  userId: string
  tab: DrawerTab
}
export type DrawerStack = readonly DrawerEntry[]

export const openRoot = (userId: string): DrawerStack => [{ userId, tab: "profile" }]

export const current = (s: DrawerStack): DrawerEntry | null => s[s.length - 1] ?? null

/** Open another user on top (Profile tab). Opening the user already shown is a no-op. */
export function push(s: DrawerStack, userId: string): DrawerStack {
  if (current(s)?.userId === userId) return s
  return [...s, { userId, tab: "profile" }]
}

/** Back to the previous user, on the tab it was showing. No-op on the root. */
export const back = (s: DrawerStack): DrawerStack => (s.length > 1 ? s.slice(0, -1) : s)

/** Switch the top entry's tab. */
export function setTab(s: DrawerStack, tab: DrawerTab): DrawerStack {
  const top = current(s)
  if (!top || top.tab === tab) return s
  return [...s.slice(0, -1), { ...top, tab }]
}
