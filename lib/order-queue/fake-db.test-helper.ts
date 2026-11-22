// In-memory stand-in for the slice of the supabase-js query builder that
// load-snapshots.ts and enqueue.ts use. Test-only (no real database).
//
// Supports: from(t).select(cols).in/eq/order/range (awaitable), update(v).eq/in/select (awaitable),
// insert(row) (awaitable). fulfillment_queue enforces the 0191 partial unique index (23505).

type Row = Record<string, any>
type Filter = { op: "in" | "eq"; col: string; val: any }

export type Call = {
  table: string
  kind: "select" | "update" | "insert"
  cols?: string
  filters: Filter[]
  values?: Row
  range?: [number, number]
}

export type FakeDb = {
  tables: Record<string, Row[]>
  calls: Call[]
  /** Return an error object to make one insert fail (checked before the unique index). */
  failInsert?: (table: string, row: Row) => { code?: string; message: string } | null
  /** Return an error object to make one update fail. */
  failUpdate?: (table: string, values: Row) => { message: string } | null
  /** Return an error object to make a select fail. */
  failSelect?: (table: string) => { message: string } | null
  /** Runs before each update is applied (lets a test change a row "concurrently"). */
  beforeUpdate?: (table: string, values: Row, filters: Filter[]) => void
  from: (table: string) => any
}

const LIVE = ["pending", "processing"]

function matches(row: Row, filters: Filter[]) {
  return filters.every((f) => (f.op === "eq" ? row[f.col] === f.val : (f.val as any[]).includes(row[f.col])))
}

export function makeFakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables,
    calls: [],
    from(table: string) {
      const rows = () => (db.tables[table] ??= [])
      return {
        select(cols: string) {
          const call: Call = { table, kind: "select", cols, filters: [] }
          db.calls.push(call)
          let orderCol: string | null = null
          const q: any = {
            in(col: string, val: any[]) {
              call.filters.push({ op: "in", col, val })
              return q
            },
            eq(col: string, val: any) {
              call.filters.push({ op: "eq", col, val })
              return q
            },
            order(col: string) {
              orderCol = col
              return q
            },
            range(a: number, b: number) {
              call.range = [a, b]
              return q
            },
            then(ok: any, bad: any) {
              const err = db.failSelect?.(table)
              if (err) return Promise.resolve({ data: null, error: err }).then(ok, bad)
              let out = rows().filter((r) => matches(r, call.filters))
              if (orderCol) {
                const c = orderCol
                out = [...out].sort((x, y) => String(x[c]).localeCompare(String(y[c])))
              }
              if (call.range) out = out.slice(call.range[0], call.range[1] + 1)
              const picked = out.map((r) => {
                const o: Row = {}
                for (const k of cols.split(",").map((s) => s.trim())) o[k] = r[k] ?? null
                return o
              })
              return Promise.resolve({ data: picked, error: null }).then(ok, bad)
            },
          }
          return q
        },
        update(values: Row) {
          const call: Call = { table, kind: "update", values, filters: [] }
          db.calls.push(call)
          let wantRows = false
          const q: any = {
            in(col: string, val: any[]) {
              call.filters.push({ op: "in", col, val })
              return q
            },
            eq(col: string, val: any) {
              call.filters.push({ op: "eq", col, val })
              return q
            },
            select() {
              wantRows = true
              return q
            },
            then(ok: any, bad: any) {
              db.beforeUpdate?.(table, values, call.filters)
              const err = db.failUpdate?.(table, values)
              if (err) return Promise.resolve({ data: null, error: err }).then(ok, bad)
              const hit = rows().filter((r) => matches(r, call.filters))
              for (const r of hit) Object.assign(r, values)
              return Promise.resolve({ data: wantRows ? hit.map((r) => ({ id: r.id })) : null, error: null }).then(ok, bad)
            },
          }
          return q
        },
        insert(row: Row) {
          const call: Call = { table, kind: "insert", values: row, filters: [] }
          db.calls.push(call)
          const run = () => {
            const err = db.failInsert?.(table, row)
            if (err) return { data: null, error: err }
            if (
              table === "fulfillment_queue" &&
              LIVE.includes(row.status ?? "pending") &&
              rows().some((r) => r.order_id === row.order_id && LIVE.includes(r.status ?? "pending"))
            ) {
              return {
                data: null,
                error: { code: "23505", message: 'duplicate key value violates unique constraint "fulfillment_queue_one_live_per_order"' },
              }
            }
            rows().push({ status: "pending", ...row })
            return { data: null, error: null }
          }
          return { then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad) }
        },
      }
    },
  }
  return db
}
