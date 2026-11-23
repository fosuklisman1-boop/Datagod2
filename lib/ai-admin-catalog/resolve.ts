import { isSafeAdminPath, ResolvedRequestSchema, type CatalogEntry, type EntryInput, type ResolvedRequest } from "./types"

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

/** String values come back from a query string: try them as-is, then with numbers/booleans restored. */
function queryObjects(query: string): Record<string, unknown>[] | null {
  const raw: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(query)) {
    if (Object.hasOwn(raw, k)) return null // a duplicated key is never produced by resolveRequest
    raw[k] = v
  }
  const typed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === "true") typed[k] = true
    else if (v === "false") typed[k] = false
    else if (v !== "" && /^-?\d+(\.\d+)?$/.test(v)) typed[k] = Number(v)
    else typed[k] = v
  }
  return [raw, typed]
}

/**
 * Re-check of a STORED request against the CURRENT catalog entry (the original input is not kept). True only when the
 * request is a shape resolveRequest could still produce for this entry: same method, safe path, the entry's path
 * template with params matching their declared pattern, query and body valid for the entry's schemas, and no secret
 * field stored in the body (secrets are merged in at send time only).
 */
export function matchesEntry(entry: CatalogEntry, req: ResolvedRequest): boolean {
  const shape = ResolvedRequestSchema.safeParse(req)
  if (!shape.success) return false
  const r = shape.data
  if (r.method !== entry.method) return false

  const tpl = entry.path.split("/")
  const got = r.path.split("/")
  if (tpl.length !== got.length) return false
  const declared = entry.params ?? {}
  for (let i = 0; i < tpl.length; i++) {
    const seg = tpl[i]
    if (seg.startsWith(":") && Object.hasOwn(declared, seg.slice(1))) {
      let value: string
      try {
        value = decodeURIComponent(got[i])
      } catch {
        return false
      }
      const kind = declared[seg.slice(1)]
      if (!(kind === "uuid" ? UUID_RE.test(value) : SLUG_RE.test(value))) return false
      if (encodeURIComponent(value) !== got[i]) return false
    } else if (seg !== got[i]) {
      return false
    }
  }

  if (entry.query) {
    const candidates = queryObjects(r.query)
    if (!candidates || !candidates.some((c) => entry.query!.safeParse(c).success)) return false
  } else if (r.query !== "") {
    return false
  }

  if (entry.body) {
    if (r.body === null) return false
    for (const s of entry.secretFields ?? []) {
      if (Object.prototype.hasOwnProperty.call(r.body, s.name)) return false
    }
    if (!entry.body.safeParse(r.body).success) return false
  } else if (r.body !== null) {
    return false
  }
  return true
}
