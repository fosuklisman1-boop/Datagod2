// In-memory stand-in for the slice of supabase-js that the catalogue and the USSD bundle menu read. Test-only.
// Unlike a no-op chain, eq / is / not / in are APPLIED to the seeded rows, so a query that loses or changes a filter
// returns different rows and fails a test. A table that was never seeded throws, so a new read cannot pass silently.

type Row = Record<string, unknown>
type DbError = { message: string }

export type FakeCatalogue = {
  tables: Record<string, Row[]>
  /** Every filter call made, in order, so a test can assert the exact query shape. */
  calls: { table: string; op: string; args: unknown[] }[]
  /** Make every read of this table fail. */
  failOn: Record<string, DbError | undefined>
}

export function makeFakeCatalogue(seed: Record<string, Row[]>): { db: FakeCatalogue; client: any } {
  const db: FakeCatalogue = { tables: { ...seed }, calls: [], failOn: {} }

  function builder(table: string) {
    if (!db.tables[table]) throw new Error(`fake: table ${table} was not seeded`)
    const filters: ((r: Row) => boolean)[] = []
    const orders: { col: string; asc: boolean }[] = []
    let range: [number, number] | null = null
    let limitN: number | null = null
    const log = (op: string, args: unknown[]) => db.calls.push({ table, op, args })

    const run = () => {
      const err = db.failOn[table]
      if (err) return { data: null, error: err, count: null as number | null }
      let rows = db.tables[table].filter((r) => filters.every((f) => f(r)))
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => {
          const x = a[o.col] as any
          const y = b[o.col] as any
          const c = x < y ? -1 : x > y ? 1 : 0
          return o.asc ? c : -c
        })
      }
      const total = rows.length
      if (range) rows = rows.slice(range[0], range[1] + 1)
      if (limitN !== null) rows = rows.slice(0, limitN)
      return { data: rows, error: null, count: total }
    }

    const b: any = {
      select: (cols?: string, opts?: unknown) => { log("select", [cols, opts]); return b },
      eq: (c: string, v: unknown) => { log("eq", [c, v]); filters.push((r) => r[c] === v); return b },
      is: (c: string, v: unknown) => { log("is", [c, v]); filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      not: (c: string, op: string, v: unknown) => {
        log("not", [c, op, v])
        if (op !== "is") throw new Error(`fake: not(${op}) is not supported`)
        filters.push((r) => (v === null ? r[c] != null : r[c] !== v))
        return b
      },
      in: (c: string, vs: unknown[]) => { log("in", [c, vs]); filters.push((r) => vs.includes(r[c])); return b },
      order: (c: string, o?: { ascending?: boolean }) => { log("order", [c, o]); orders.push({ col: c, asc: o?.ascending !== false }); return b },
      range: (from: number, to: number) => { log("range", [from, to]); range = [from, to]; return b },
      limit: (n: number) => { log("limit", [n]); limitN = n; return b },
      single: () => {
        const r = run()
        return Promise.resolve(r.error ? r : { data: r.data![0] ?? null, error: r.data![0] ? null : { message: "no rows" } })
      },
      maybeSingle: () => {
        const r = run()
        return Promise.resolve(r.error ? r : { data: r.data![0] ?? null, error: null })
      },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }

  return { db, client: { from: (t: string) => builder(t) } }
}
