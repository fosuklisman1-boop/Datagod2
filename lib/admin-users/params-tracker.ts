// The users page keeps its filters in the URL, but router.replace() is async: two quick
// changes (a filter click, then the debounced search firing) would each start from the
// URL's old params and the second would undo the first. This tracker remembers the
// params we last asked for, applies each change on top of them, and only re-syncs from
// the URL once our latest push has landed (or when the URL changes with nothing pending,
// e.g. back/forward).

import { listParamsToSearchParams, normaliseDateRange, type UsersListParams } from "./list-params"

const keyOf = (p: UsersListParams) => listParamsToSearchParams(p).toString()

export interface ParamsTracker {
  current(): UsersListParams
  /** Apply a change; resets to page 1 unless keepPage. Returns the params to push to the URL. */
  apply(patch: Partial<UsersListParams>, opts?: { keepPage?: boolean }): UsersListParams
  /** Call whenever the URL's params change. */
  urlChanged(params: UsersListParams): void
}

export function createParamsTracker(initial: UsersListParams): ParamsTracker {
  let latest = initial
  let pending: string | null = null
  return {
    current: () => latest,
    apply(patch, opts) {
      const merged = { ...latest, ...patch }
      if (!opts?.keepPage) merged.page = 1
      latest = normaliseDateRange(merged)
      pending = keyOf(latest)
      return latest
    },
    urlChanged(params) {
      const key = keyOf(params)
      if (pending === null || key === pending) {
        latest = params
        pending = null
      }
    },
  }
}
