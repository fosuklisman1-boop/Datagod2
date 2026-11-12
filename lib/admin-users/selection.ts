// Row selection on the admin users page, keyed by user id. Pure: returns new Sets.

export function setSelected(s: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(s)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

export function setSelectedMany(s: ReadonlySet<string>, ids: Iterable<string>, on: boolean): Set<string> {
  const next = new Set(s)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** Drop ids that no longer exist (e.g. a deleted user). Returns the same Set when nothing changes. */
export function removeIds<S extends ReadonlySet<string>>(s: S, ids: Iterable<string>): S | Set<string> {
  const gone = [...ids].filter((id) => s.has(id))
  if (gone.length === 0) return s
  return setSelectedMany(s, gone, false)
}
