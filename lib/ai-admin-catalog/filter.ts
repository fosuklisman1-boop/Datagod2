import type { CatalogEntry } from "./types"

export const MAX_LOOKUP_BYTES = 8192

const HIDDEN_EXACT = new Set([
  "password",
  "secret",
  "api_key",
  "access_token",
  "refresh_token",
  "service_role_key",
  "webhook_secret",
])

/** Backstop only: resultKeep is the real allowlist. Exact names plus *_api_key / *_secret suffixes. */
export function isHiddenKey(name: string): boolean {
  const n = name.toLowerCase()
  return HIDDEN_EXACT.has(n) || n.endsWith("_api_key") || n.endsWith("_secret")
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function parsePath(path: string): { key: string; each: boolean }[] {
  return path.split(".").map((seg) =>
    seg.endsWith("[]") ? { key: seg.slice(0, -2), each: true } : { key: seg, each: false },
  )
}

function pickPath(src: unknown, segs: { key: string; each: boolean }[]): unknown {
  // returns undefined when nothing selected
  if (segs.length === 0) return src
  if (!isObj(src)) return undefined
  const [head, ...rest] = segs
  if (!Object.prototype.hasOwnProperty.call(src, head.key)) return undefined
  const val = src[head.key]
  if (head.each) {
    if (!Array.isArray(val)) return undefined
    return { [head.key]: val.map((el) => pickPath(el, rest) ?? (rest.length === 0 ? el : {})) }
  }
  const sub = pickPath(val, rest)
  return sub === undefined ? undefined : { [head.key]: sub }
}

function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length)
    return Array.from({ length: len }, (_, i) => (i in a && i in b ? merge(a[i], b[i]) : (a[i] ?? b[i])))
  }
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = { ...a }
    for (const k of Object.keys(b)) out[k] = k in a ? merge(a[k], b[k]) : b[k]
    return out
  }
  return b
}

function keep(body: unknown, paths: string[]): unknown {
  let out: unknown = {}
  for (const p of paths) {
    const picked = pickPath(body, parsePath(p))
    if (picked !== undefined) out = merge(out, picked)
  }
  return out
}

function hide(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(hide)
  if (isObj(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = isHiddenKey(k) ? "[hidden]" : hide(val)
    return out
  }
  return v
}

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "null")

/** Finds the largest array (by serialized size) in the tree, to trim trailing items from. */
function largestArray(v: unknown): unknown[] | null {
  let best: unknown[] | null = null
  let bestSize = -1
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      const s = size(x)
      if (x.length > 0 && s > bestSize) {
        best = x
        bestSize = s
      }
      x.forEach(walk)
    } else if (isObj(x)) Object.values(x).forEach(walk)
  }
  walk(v)
  return best
}

export function filterLookupResult(
  entry: CatalogEntry,
  body: unknown,
): { data: unknown; truncated: boolean } {
  const selected = entry.resultKeep ? keep(body, entry.resultKeep) : body
  const data = hide(selected)
  if (size(data) <= MAX_LOOKUP_BYTES) return { data, truncated: false }

  // Drop trailing array items until it fits (halving first, then one by one).
  for (;;) {
    const arr = largestArray(data)
    if (!arr) return { data: null, truncated: true }
    const drop = Math.max(1, Math.floor(arr.length / 2))
    arr.length = arr.length - drop
    if (size(data) <= MAX_LOOKUP_BYTES) {
      return { data, truncated: true }
    }
  }
}
