// Generic, pure menu-numbering engine shared by every USSD/WhatsApp menu that
// can have individual items hidden (admin toggle, per-caller whitelist, etc).
//
// The correctness rule this module exists to enforce: a menu's rendered text
// and its digit→action dispatch must be derived from the SAME ordered,
// filtered list, built once per request. Never hand-write a second
// switch/case that re-derives "what's at position N" — if it needs to know,
// it asks resolveMenuItems()'s output, never recomputes independently. With
// up to 2^N combinations of hidden items, a hand-synced second mapping WILL
// drift out of sync with the rendered numbering eventually — and this menu
// routes real money-spending flows.

export interface MenuItemDef<TKey extends string> {
  key: TKey
  label: string
}

export interface ResolvedMenuItem<TKey extends string> {
  key: TKey
  digit: number
  label: string
}

/**
 * Filters `items` down to the visible ones (per `visible[item.key]`) and
 * assigns sequential digits 1..N in the SAME order they were given. This is
 * the one place menu numbering happens — render and input-parsing must both
 * call this with the same `items`/`visible` and use its output, never
 * hand-number.
 */
export function resolveMenuItems<TKey extends string>(
  items: MenuItemDef<TKey>[],
  visible: Record<TKey, boolean>
): ResolvedMenuItem<TKey>[] {
  return items
    .filter((item) => visible[item.key] !== false)
    .map((item, i) => ({ key: item.key, digit: i + 1, label: item.label }))
}

/** Renders `header\n1. Label\n2. Label\n...\n<footer>` from a resolved list. */
export function renderMenuText<TKey extends string>(
  header: string,
  resolved: ResolvedMenuItem<TKey>[],
  footer = '0. Back'
): string {
  const lines = resolved.map((r) => `${r.digit}. ${r.label}`)
  return `${header}\n${lines.join('\n')}\n${footer}`
}

/**
 * Looks up which key a raw digit-string input resolves to, or null if it
 * doesn't match any currently-visible item (caller decides what null means —
 * usually "show the menu again" or "invalid option"). "0" is never a menu
 * item here — every menu's 0. Back/0. Exit is handled by the caller
 * separately, not through this list.
 */
export function keyForDigit<TKey extends string>(
  resolved: ResolvedMenuItem<TKey>[],
  rawInput: string
): TKey | null {
  const n = parseInt(rawInput.trim(), 10)
  if (!Number.isInteger(n)) return null
  const match = resolved.find((r) => r.digit === n)
  return match ? match.key : null
}
