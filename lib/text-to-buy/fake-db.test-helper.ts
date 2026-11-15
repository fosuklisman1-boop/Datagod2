// In-memory stand-in for the slice of supabase-js the Text-to-Buy store uses. Test-only.
// Unlike a schema-blind fake, it REFUSES any table, column or RPC argument that the Text-to-Buy migrations do not define, so a
// typo in store.ts fails a test instead of passing silently. Keep the lists below in step with migrations/0177_text_to_buy.sql
// plus its Stage 3a follow-up (0180: ttb_shop_prefs, ttb_notices, the shop_id and credits columns, ttb_notice_once).

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export const SCHEMA: Record<string, string[]> = {
  ttb_messages: ["id", "line", "sender", "direction", "body", "received_at", "dedupe_key", "read_by", "outcome", "order_link_id", "misread", "created_at", "claimed_at", "shop_id", "credits"],
  ttb_conversations: ["line", "sender", "turns", "pending", "last_order", "expires_at", "updated_at"],
  ttb_orders: ["id", "line", "sender", "service", "order_table", "order_id", "state", "size", "recipient", "gift", "amount", "notices", "created_at", "paid_at", "delivered_at", "closed_at", "shop_id"],
  // Migration 0180 (Stage 3a): the shop a sender last used, and the once-a-day notice throttle rows.
  ttb_shop_prefs: ["sender", "shop_code_id", "last_used_at"],
  ttb_notices: ["id", "kind", "sender", "shop_id", "day", "created_at"],
  // Not a 0177 table: the USSD shop order table, only the columns the shop line reads.
  ussd_shop_orders: ["id", "shop_code_id", "shop_id", "dialing_phone", "order_status", "payment_status", "amount", "created_at", "updated_at"],
  // Not a Text-to-Buy table: the shop table, only the name columns the admin overview reads for the paused-shops list.
  user_shops: ["id", "shop_name", "ussd_display_name"],
  // Migration 0180: one credit set-aside per order message. service_role may only SELECT it (rows change through the SQL functions).
  ttb_credit_reserves: ["message_id", "account_id", "shop_id", "held", "used", "released_at", "created_at"],
  // Migration 0181: one row per missed call handled (or skipped) by the call-support SMS. service_role: SELECT and INSERT only.
  ttb_calls: ["id", "line", "sender", "shop_id", "outcome", "created_at"],
  ttb_blocked: ["sender", "reason", "blocked_by", "created_at"],
  ttb_heartbeat: ["line", "last_seen_at"],
  // Not a 0177 table: the existing USSD order table, only the columns the Text-to-Buy lane reads or guards.
  ussd_orders: ["id", "order_status", "payment_status", "amount", "updated_at"],
  // Not 0177 tables: the airtime and results-checker order tables, only the columns the notifier reads.
  airtime_orders: ["id", "status", "payment_status", "total_paid", "airtime_amount", "updated_at"],
  results_checker_orders: ["id", "status", "payment_status", "total_paid", "updated_at"],
  // Not a 0177 table: the shared settings table (migration 0177 seeds the ttb_ keys into it).
  admin_settings: ["key", "value", "description", "updated_by", "updated_at"],
}

export const RPC_ARGS: Record<string, string[]> = {
  ttb_counts: ["p_line", "p_sender", "p_since"],
  ttb_global_prompts: ["p_since"],
  ttb_overview: ["p_from"],
  ttb_purge: ["p_before"],
  ttb_add_notice: ["p_id", "p_key"],
  ttb_notice_once: ["p_kind", "p_sender", "p_shop", "p_day"],
  ttb_release_reserve: ["p_message_id"],
}

const PRIMARY: Record<string, string[]> = {
  ttb_conversations: ["line", "sender"],
  ttb_heartbeat: ["line"],
  ttb_blocked: ["sender"],
  ttb_shop_prefs: ["sender"],
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
  /** Columns a SELECT must not name (simulates a migration not yet applied): naming one fails with Postgres 42703. */
  rejectColumns: Record<string, string[] | undefined>
  /** Credits ttb_release_reserve gave back (one entry per release that refunded something). */
  refunds: { messageId: string; credits: number }[]
  /** Per-message release failure (e.g. only the dead-account reserves raise). */
  failRelease?: (messageId: string) => DbError | null | undefined
}

export function makeFakeTtb(seed: Record<string, Row[]> = {}): { db: FakeTtb; client: never } {
  const db: FakeTtb = {
    tables: Object.fromEntries(Object.keys(SCHEMA).map((t) => [t, []])),
    rpcCalls: [],
    rpcImpl: () => ({ data: null, error: null }),
    failOn: {},
    failInsert: {},
    rejectColumns: {},
    refunds: [],
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
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select"
    let payload: Row | Row[] | null = null
    let onConflict: string[] = []
    let returning = false
    let single: "one" | "maybe" | null = null
    let lim: number | null = null
    let countOnly = false
    let selected: string[] = []
    const orders: { c: string; asc: boolean }[] = []
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
      if (mode === "select") {
        const bad = (db.rejectColumns[table] ?? []).find((c) => selected.includes(c))
        if (bad) return { data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }
      }
      if (mode === "insert") {
        if (db.failInsert[table]) return { data: null, error: db.failInsert[table]! }
        checkRow(payload as Row)
        const row: Row = { ...(payload as Row) }
        if ((table === "ttb_messages" || table === "ttb_orders") && row.id === undefined) row.id = crypto.randomUUID()
        if (table === "ttb_calls") {
          if (row.id === undefined) row.id = crypto.randomUUID()
          if (row.shop_id === undefined) row.shop_id = null
          if (row.created_at === undefined) row.created_at = new Date().toISOString()
        }
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
        const pk = onConflict.length ? onConflict : PRIMARY[table] ?? ["id"]
        for (const k of pk) col(table, k)
        // An array payload is one statement: validate every row first so nothing is written if any is bad.
        const batch = (Array.isArray(payload) ? payload : [payload!]) as Row[]
        for (const p of batch) checkRow(p)
        for (const p of batch) {
          const existing = rows().find((r) => pk.every((k) => r[k] === p[k]))
          if (existing) Object.assign(existing, p)
          else rows().push({ ...p })
        }
        return { data: null, error: null }
      }
      if (mode === "delete") {
        // Migration 0177 grants service_role DELETE on ttb_blocked only (messages and orders are removed by ttb_purge or never).
        if (table !== "ttb_blocked") throw new Error(`fake: service_role has no DELETE on ${table}`)
        const hit = rows().filter((r) => filters.every((f) => f(r)))
        db.tables[table] = rows().filter((r) => !hit.includes(r))
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      if (mode === "update") {
        checkRow(payload as Row)
        const hit = rows().filter((r) => filters.every((f) => f(r)))
        for (const r of hit) Object.assign(r, payload)
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      let out = rows().filter((r) => filters.every((f) => f(r)))
      // select(cols, { count: "exact", head: true }): no rows, only the count of the matching ones.
      if (countOnly) return { data: null, count: out.length, error: null } as { data: unknown; error: DbError | null }
      if (orders.length) {
        out = [...out].sort((a, b) => {
          for (const { c, asc } of orders) {
            const x = String(a[c])
            const y = String(b[c])
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1)
          }
          return 0
        })
      }
      if (lim !== null) out = out.slice(0, lim)
      out = out.map((r) => ({ ...r }))
      if (single === "maybe") return { data: out[0] ?? null, error: null }
      if (single === "one") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "expected one row" } }
      return { data: out, error: null }
    }

    const b = {
      select: (cols = "*", opts?: { count?: string; head?: boolean }) => {
        if (cols !== "*") for (const c of cols.split(",")) col(table, c.trim())
        selected = cols.split(",").map((c) => c.trim())
        if (opts?.head === true && opts.count === "exact") countOnly = true
        if (mode === "insert" || mode === "update" || mode === "delete") returning = true
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
      // Only the shapes store.ts uses: "<col>.is.null", "<col>.lt.<v>", "<col>.eq.<v>" and "and(<term>,<term>)", comma-separated.
      or: (expr: string) => {
        const split = (s: string): string[] => {
          const out: string[] = []
          let depth = 0
          let cur = ""
          for (const ch of s) {
            if (ch === "(") depth++
            if (ch === ")") depth--
            if (ch === "," && depth === 0) {
              out.push(cur)
              cur = ""
            } else cur += ch
          }
          return [...out, cur]
        }
        const term = (p: string): Filter => {
          if (p.startsWith("and(") && p.endsWith(")")) {
            const inner = split(p.slice(4, -1)).map(term)
            return (r) => inner.every((f) => f(r))
          }
          const [c, op, ...rest] = p.split(".")
          const v = rest.join(".")
          col(table, c)
          if (op === "is" && v === "null") return (r) => (r[c] ?? null) === null
          if (op === "lt") return (r) => r[c] != null && String(r[c]) < v
          if (op === "eq") return (r) => r[c] != null && String(r[c]) === v
          throw new Error(`fake: or(${p}) is not supported`)
        }
        const parts = split(expr).map(term)
        filters.push((r) => parts.some((f) => f(r)))
        return b
      },
      // Only the shapes store.ts uses: .not("<array col>", "cs", "{value}") = the array does NOT contain value,
      // and .not("<col>", "is", null) = the column is not null.
      not: (c: string, op: string, v: string | null) => {
        col(table, c)
        if (op === "is" && v === null) {
          filters.push((r) => (r[c] ?? null) !== null)
          return b
        }
        if (op !== "cs" || typeof v !== "string") throw new Error(`fake: not(${op}) is not supported`)
        const wanted = v.replace(/^\{|\}$/g, "")
        filters.push((r) => !(Array.isArray(r[c]) && (r[c] as unknown[]).includes(wanted)))
        return b
      },
      gt: (c: string, v: string) => (col(table, c), filters.push((r) => String(r[c]) > v), b),
      gte: (c: string, v: string) => (col(table, c), filters.push((r) => String(r[c]) >= v), b),
      lt: (c: string, v: string) => (col(table, c), filters.push((r) => String(r[c]) < v), b),
      in: (c: string, vs: unknown[]) => (col(table, c), filters.push((r) => vs.includes(r[c])), b),
      // Chained .order() calls sort by the first column, then the next (as PostgREST does).
      order: (c: string, o?: { ascending?: boolean }) => (col(table, c), orders.push({ c, asc: o?.ascending !== false }), b),
      delete: () => ((mode = "delete"), b),
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
      // ttb_notice_once is faithful too: one row per (kind, sender, coalesce(shop), day); true only when this call created it.
      if (name === "ttb_notice_once") {
        if (db.failOn.ttb_notices) return Promise.resolve({ data: null, error: db.failOn.ttb_notices })
        const nil = "00000000-0000-0000-0000-000000000000"
        const same = (r: Row) => r.kind === args.p_kind && r.sender === args.p_sender && (r.shop_id ?? nil) === (args.p_shop ?? nil) && r.day === args.p_day
        if (db.tables.ttb_notices.some(same)) return Promise.resolve({ data: false, error: null })
        db.tables.ttb_notices.push({ id: crypto.randomUUID(), kind: args.p_kind, sender: args.p_sender, shop_id: args.p_shop ?? null, day: args.p_day, created_at: new Date().toISOString() })
        return Promise.resolve({ data: true, error: null })
      }
      // ttb_release_reserve is faithful: marks released_at only where NULL and refunds held - used, once; 0 on a repeat or unknown.
      // failOn.ttb_release_reserve makes it raise (the real function raises REFUND_FAILED when the account is gone), while
      // reads of ttb_credit_reserves keep working.
      if (name === "ttb_release_reserve") {
        if (db.failOn.ttb_release_reserve) return Promise.resolve({ data: null, error: db.failOn.ttb_release_reserve })
        const per = db.failRelease?.(String(args.p_message_id))
        if (per) return Promise.resolve({ data: null, error: per })
        const row = db.tables.ttb_credit_reserves.find((r) => r.message_id === args.p_message_id)
        if (!row || row.released_at != null) return Promise.resolve({ data: 0, error: null })
        row.released_at = new Date().toISOString()
        const back = Number(row.held) - Number(row.used)
        if (back > 0) db.refunds.push({ messageId: String(args.p_message_id), credits: back })
        return Promise.resolve({ data: back, error: null })
      }
      return Promise.resolve(db.rpcImpl(name, args))
    },
  }
  return { db, client: client as never }
}
