import { isSafeAdminPath, type CatalogEntry, type EntryInput, type ResolvedRequest } from "./types"

export type ResolveResult =
  | { ok: true; req: ResolvedRequest }
  | { ok: false; code: "bad_input" | "bad_param" | "secret_in_input"; message: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLUG_RE = /^[a-z0-9_-]{1,64}$/

function fail(code: "bad_input" | "bad_param" | "secret_in_input", message: string): ResolveResult {
  return { ok: false, code, message }
}

function serializeQuery(q: Record<string, unknown>): string {
  const sp = new URLSearchParams()
  for (const k of Object.keys(q).sort()) {
    const v = q[k]
    if (v === undefined || v === null) continue
    sp.append(k, String(v))
  }
  return sp.toString()
}

export function resolveRequest(entry: CatalogEntry, input: EntryInput): ResolveResult {
  // 1. path params
  const declared = entry.params ?? {}
  const supplied = input.params ?? {}
  for (const k of Object.keys(supplied)) {
    if (!Object.hasOwn(declared, k)) return fail("bad_param", `Unexpected parameter "${k}".`)
  }
  const values: Record<string, string> = {}
  for (const [name, kind] of Object.entries(declared)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : undefined
    if (typeof value !== "string" || value === "") return fail("bad_param", `Parameter "${name}" is required.`)
    const ok = kind === "uuid" ? UUID_RE.test(value) : SLUG_RE.test(value)
    if (!ok) return fail("bad_param", `Parameter "${name}" is not a valid ${kind}.`)
    values[name] = encodeURIComponent(value)
  }
  // Whole path segments only: ":id" must not match inside ":idx".
  const path = entry.path
    .split("/")
    .map((seg) => (seg.startsWith(":") && Object.hasOwn(values, seg.slice(1)) ? values[seg.slice(1)] : seg))
    .join("/")
  if (!isSafeAdminPath(path)) return fail("bad_param", "Catalog path is not a safe /api/admin/ path.")

  // 2. secrets must never arrive through the model
  const bodyIn = input.body
  for (const s of entry.secretFields ?? []) {
    if (bodyIn && Object.prototype.hasOwnProperty.call(bodyIn, s.name)) {
      return fail("secret_in_input", `Field "${s.name}" must be entered in the secure box, not passed in the input.`)
    }
  }

  // 3. query
  let query = ""
  if (entry.query) {
    const parsed = entry.query.safeParse(input.query ?? {})
    if (!parsed.success) return fail("bad_input", `Invalid query: ${parsed.error.issues[0]?.message ?? "invalid"}`)
    query = serializeQuery(parsed.data as Record<string, unknown>)
  } else if (input.query && Object.keys(input.query).length > 0) {
    return fail("bad_input", "This entry takes no query.")
  }

  // 4. body
  let body: Record<string, unknown> | null = null
  if (entry.body) {
    const parsed = entry.body.safeParse(bodyIn ?? {})
    if (bodyIn === undefined) return fail("bad_input", "A body is required.")
    if (!parsed.success) return fail("bad_input", `Invalid body: ${parsed.error.issues[0]?.message ?? "invalid"}`)
    body = parsed.data as Record<string, unknown>
  } else if (bodyIn !== undefined) {
    return fail("bad_input", "This entry takes no body.")
  }

  return { ok: true, req: { method: entry.method, path, query, body } }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
}

export function sameRequest(a: ResolvedRequest, b: ResolvedRequest): boolean {
  return a.method === b.method && a.path === b.path && a.query === b.query && deepEqual(a.body, b.body)
}
