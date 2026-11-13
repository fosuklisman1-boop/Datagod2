// In-memory stand-in for the slice of supabase-js the Text-to-Buy store uses. Test-only.
// Unlike a schema-blind fake, it REFUSES any table, column or RPC argument that migration 0163 does not define, so a typo
// in store.ts fails a test instead of passing silently. Keep the lists below in step with migrations/0163_text_to_buy.sql.

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export const SCHEMA: Record<string, string[]> = {
  ttb_messages: ["id", "line", "sender", "direction", "body", "received_at", "dedupe_key", "read_by", "outcome", "order_link_id", "misread", "created_at", "claimed_at"],
  ttb_conversations: ["line", "sender", "turns", "pending", "last_order", "expires_at", "updated_at"],
  ttb_orders: ["id", "line", "sender", "service", "order_table", "order_id", "state", "size", "recipient", "gift", "amount", "notices", "created_at", "paid_at", "delivered_at", "closed_at"],
  ttb_blocked: ["sender", "reason", "blocked_by", "created_at"],
  ttb_heartbeat: ["line", "last_seen_at"],
  // Not a 0163 table: the existing USSD order table, only the columns the Text-to-Buy lane reads or guards.
  ussd_orders: ["id", "order_status", "payment_status", "amount", "updated_at"],
}

export const RPC_ARGS: Record<string, string[]> = {
  ttb_counts: ["p_line", "p_sender", "p_since"],
  ttb_global_prompts: ["p_since"],
  ttb_overview: ["p_from"],
  ttb_purge: ["p_before"],
  ttb_add_notice: ["p_id", "p_key"],
}

const PRIMARY: Record<string, string[]> = {
  ttb_conversations: ["line", "sender"],
  ttb_heartbeat: ["line"],
  ttb_blocked: ["sender"],
}

type DbError = { code?: string; message: string }

export type FakeTtb = {
  tables: Record<string, Row[]>
  rpcCalls: { name: string; args: Record<string, unknown> }[]
  rpcImpl: (name: string, args: Record<string, unknown>) => { data: unknown; error: DbError | null }
  /** Force the next write/read on this table to fail with this error. */
  failOn: Record<string, DbError | undefined>
  /** Like failOn, but only for inserts (later reads on the table work normally). */
  failInsert: Record<string, DbError | undefined>
}

export function makeFakeTtb(seed: Record<string, Row[]> = {}): { db: FakeTtb; client: never } {
  const db: FakeTtb = {
    tables: Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, []])),
    rpcCalls: [],
    rpcImpl: () => ({ data: null, error: null }),
    failOn: {},
    failInsert: {},
  }
  Object.assign(db.tables, seed)

  const col = (table: string, c: string) => {
    if (!SCHEMA[table]) throw new Error(`fake: unknown table ${table}`)
    if (!SCHEMA[table].includes(c)) throw new Error(`fake: unknown column ${table}.${c}`)
    return c
  }

  function builder(table: string) {
    if (!SCHEMA[table]) throw new Error(`fake: unknown table ${table}`)
    const filters: Filter[] = []
    let mode: "select" | "insert" | "upsert" | "update" = "select"
    let payload: Row | null = null
    let onConflict: string[] = []
    let returning = false
    let single: "one" | "maybe" | null = null
    let lim: number | null = null
    let order: { c: string; asc: boolean } | null = null
    const rows = () => db.tables[table]

    const checkRow = (row: Row) => {
      for (const k of Object.keys(row)) col(table, k)
    }

    /** The violated constraint's name (as Postgres puts it in the error message), or null. */
    function conflict(row: Row): string | null {
      const others = rows()
      if (table === "ttb_messages" && row.dedupe_key != null && others.some((r) => r.dedupe_key === row.dedupe_key)) return "ttb_messages_dedupe_key_key"
      if (table === "ttb_orders") {
        if (others.some((r) => r.order_id === row.order_id)) return "ttb_orders_order_id_key"
        const open = (r: Row) => (r.state ?? "awaiting_payment") === "awaiting_payment"
        if (open(row) && others.some((r) => open(r) && r.line === row.line && r.sender === row.sender)) return "ttb_orders_one_open"
      }
      const pk = PRIMARY[table]
      if (pk && others.some((r) => pk.every((k) => r[k] === row[k]))) return `${table}_pkey`
      return null
    }

    const run = (): { data: unknown; error: DbError | null } => {
      const forced = db.failOn[table]
      if (forced) return { data: null, error: forced }
      if (mode === "insert") {
        if (db.failInsert[table]) return { data: null, error: db.failInsert[table]! }
        checkRow(payload!)
        const row: Row = { ...payload! }
        if ((table === "ttb_messages" || table === "ttb_orders") && row.id === undefined) row.id = crypto.randomUUID()
        if (table === "ttb_orders") {
          for (const [k, v] of Object.entries({ state: "awaiting_payment", service: "data", order_table: "ussd_orders", notices: [] })) {
            if (row[k] === undefined) row[k] = v
          }
        }
        const violated = conflict(row)
        if (violated) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${violated}"` } }
        rows().push(row)
        return { data: returning ? { ...row } : null, error: null }
      }
      if (mode === "upsert") {
        checkRow(payload!)
        const pk = onConflict.length ? onConflict : PRIMARY[table] ?? ["id"]
        for (const k of pk) col(table, k)
        const existing = rows().find((r) => pk.every((k) => r[k] === payload![k]))
        if (existing) Object.assign(existing, payload)
        else rows().push({ ...payload! })
        return { data: null, error: null }
      }
      if (mode === "update") {
        checkRow(payload!)
        const hit = rows().filter((r) => filters.every((f) => f(r)))
        for (const r of hit) Object.assign(r, payload)
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      let out = rows().filter((r) => filters.every((f) => f(r)))
      if (order) {
        const { c, asc } = order
        out = [...out].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1))
      }
      if (lim !== null) out = out.slice(0, lim)
      out = out.map((r) => ({ ...r }))
      if (single === "maybe") return { data: out[0] ?? null, error: null }
      if (single === "one") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "expected one row" } }
      return { data: out, error: null }
    }

    const b = {
      select: (cols = "*") => {
        if (cols !== "*") for (const c of cols.split(",")) col(table, c.trim())
        if (mode === "insert" || mode === "update") returning = true
        return b
      },
      insert: (row: Row) => ((mode = "insert"), (payload = row), b),
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        mode = "upsert"
        payload = row
        onConflict = opts?.onConflict ? opts.onConflict.split(",").map((s) => s.trim()) : []
        return b
      },
      update: (patch: Row) => ((mode = "update"), (payload = patch), b),
      eq: (c: string, v: unknown) => (col(table, c), filters.push((r) => r[c] === v), b),
      is: (c: string, v: null) => (col(table, c), filters.push((r) => (r[c] ?? null) === v), b),
      // Only the shape store.ts uses: "<col>.is.null,<col>.lt.<iso>" (either side may be either operator).
      or: (expr: string) => {
        const parts = expr.split(",").map((p) => {
          const [c, op, ...rest] = p.split(".")
          const v = rest.join(".")
          col(table, c)
          if (op === "is" && v === "null") return (r: Row) => (r[c] ?? null) === null
          if (op === "lt") return (r: Row) => r[c] != null && String(r[c]) < v
          throw new Error(`fake: or(${p}) is not supported`)
        })
        filters.push((r) => parts.some((f) => f(r)))
        return b
      },
      // Only the shape store.ts uses: .not("<array col>", "cs", "{value}") = the array does NOT contain value.
      not: (c: string, op: string, v: string) => {
        col(table, c)
        if (op !== "cs") throw new Error(`fake: not(${op}) is not supported`)
        const wanted = v.replace(/^\{|\}$/g, "")
        filters.push((r) => !(Array.isArray(r[c]) && (r[c] as unknown[]).includes(wanted)))
        return b
      },
      gte: (c: string, v: string) => (col(table, c), filters.push((r) => String(r[c]) >= v), b),
      lt: (c: string, v: string) => (col(table, c), filters.push((r) => String(r[c]) < v), b),
      in: (c: string, vs: unknown[]) => (col(table, c), filters.push((r) => vs.includes(r[c])), b),
      order: (c: string, o?: { ascending?: boolean }) => (col(table, c), (order = { c, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((lim = n), b),
      maybeSingle: () => ((single = "maybe"), b),
      single: () => ((single = "one"), b),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }

  const client = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      const allowed = RPC_ARGS[name]
      if (!allowed) throw new Error(`fake: unknown rpc ${name}`)
      for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new Error(`fake: unknown argument ${name}(${k})`)
      for (const k of allowed) if (!(k in args)) throw new Error(`fake: missing argument ${name}(${k})`)
      db.rpcCalls.push({ name, args })
      // ttb_add_notice is implemented faithfully (array_append guarded by NOT (key = ANY(notices))); the others use rpcImpl.
      if (name === "ttb_add_notice") {
        if (db.failOn.ttb_orders) return Promise.resolve({ data: null, error: db.failOn.ttb_orders })
        const row = db.tables.ttb_orders.find((r) => r.id === args.p_id)
        const notices = row && Array.isArray(row.notices) ? (row.notices as unknown[]) : null
        if (!row || !notices || notices.includes(args.p_key)) return Promise.resolve({ data: false, error: null })
        row.notices = [...notices, args.p_key]
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve(db.rpcImpl(name, args))
    },
  }
  return { db, client: client as never }
}
