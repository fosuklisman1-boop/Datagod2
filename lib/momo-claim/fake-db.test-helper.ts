// In-memory stand-in for the slice of supabase-js the SMS ingest uses. Test-only.
// Supports: select/insert/upsert(ignoreDuplicates)/update, eq/neq/in/gt/like, order, limit, maybeSingle, rpc.

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export type FakeDb = {
  tables: Record<string, Row[]>
  rpcCalls: { name: string; args: Record<string, unknown> }[]
  rpcImpl: (name: string, args: Record<string, unknown>, db: FakeDb) => { data: unknown; error: unknown }
  failInsert: boolean
  failSelect: Set<string>
  failUpdate: boolean
}

function likeToRegex(p: string): RegExp {
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")
  return new RegExp(`^${esc}$`)
}

export function makeFakeDb(seed: Record<string, Row[]> = {}): { db: FakeDb; client: never } {
  const db: FakeDb = {
    tables: { momo_transactions: [], wallet_topup_sessions: [], ...seed },
    rpcCalls: [],
    rpcImpl: () => ({ data: "no_session", error: null }),
    failInsert: false,
    failSelect: new Set(),
    failUpdate: false,
  }

  function builder(table: string) {
    const filters: Filter[] = []
    let mode: "select" | "insert" | "upsert" | "update" = "select"
    let payload: Row | null = null
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let returning = false
    let orderBy: { col: string; asc: boolean } | null = null
    let lim: number | null = null
    let single = false

    const rows = () => (db.tables[table] ??= [])

    const run = (): { data: unknown; error: unknown } => {
      if (mode === "insert" || mode === "upsert") {
        if (db.failInsert) return { data: null, error: { message: "insert failed" } }
        const row = { ...payload! }
        if (mode === "upsert") {
          const key = upsertOpts.onConflict ?? "id"
          if (rows().some((r) => r[key] === row[key])) {
            if (upsertOpts.ignoreDuplicates) return { data: returning ? [] : null, error: null }
            return { data: null, error: { message: "dup" } }
          }
        } else if (rows().some((r) => r.transaction_id === row.transaction_id && row.transaction_id !== undefined)) {
          return { data: null, error: { message: "duplicate key" } }
        }
        if (!("flag_reasons" in row) && table === "momo_transactions") row.flag_reasons = []
        rows().push(row)
        return { data: returning ? [row] : null, error: null }
      }
      if (mode === "update") {
        if (db.failUpdate) return { data: null, error: { message: "update failed" } }
        for (const r of rows()) if (filters.every((f) => f(r))) Object.assign(r, payload)
        return { data: null, error: null }
      }
      if (db.failSelect.has(table)) return { data: null, error: { message: "select failed" } }
      let out = rows().filter((r) => filters.every((f) => f(r)))
      if (orderBy) {
        const { col, asc } = orderBy
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1))
      }
      if (lim !== null) out = out.slice(0, lim)
      out = out.map((r) => ({ ...r }))
      if (single) return { data: out[0] ?? null, error: null }
      return { data: out, error: null }
    }

    const b = {
      select: () => {
        if (mode === "insert" || mode === "upsert") returning = true
        return b
      },
      insert: (row: Row) => {
        mode = "insert"
        payload = row
        return b
      },
      upsert: (row: Row, opts: typeof upsertOpts) => {
        mode = "upsert"
        payload = row
        upsertOpts = opts ?? {}
        return b
      },
      update: (patch: Row) => {
        mode = "update"
        payload = patch
        return b
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      gt: (c: string, v: string) => (filters.push((r) => String(r[c]) > v), b),
      like: (c: string, p: string) => (filters.push((r) => likeToRegex(p).test(String(r[c]))), b),
      order: (col: string, o?: { ascending?: boolean }) => ((orderBy = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((lim = n), b),
      maybeSingle: () => ((single = true), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args })
      return Promise.resolve(db.rpcImpl(name, args, db))
    },
  }
  return { db, client: client as never }
}
