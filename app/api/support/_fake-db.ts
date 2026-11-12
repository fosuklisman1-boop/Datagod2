// Test-only helper: a chainable fake of the Supabase query builder that records every call
// and lets the test decide each result. Not imported by any route.
export type FakeCall = {
  table: string
  op: "select" | "insert" | "update" | "delete"
  filters: [string, unknown][]
  payload?: any
  /** Options passed to select(), e.g. { count: "exact", head: true }. */
  selectOpts?: any
  /** Last argument given to limit(). */
  limitN?: number
}
export type FakeResult = { data?: any; error?: { message: string } | null; count?: number | null }

export function makeFakeDb(handler: (call: FakeCall) => FakeResult | undefined) {
  const calls: FakeCall[] = []
  const from = (table: string) => {
    const call: FakeCall = { table, op: "select", filters: [] }
    const run = () => {
      calls.push(call)
      const r = handler(call) ?? {}
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null })
    }
    const b: any = {
      select: (_cols?: string, opts?: any) => { if (opts) call.selectOpts = opts; return b },
      insert: (p: any) => { call.op = "insert"; call.payload = p; return b },
      update: (p: any) => { call.op = "update"; call.payload = p; return b },
      delete: () => { call.op = "delete"; return b },
      eq: (c: string, v: unknown) => { call.filters.push([c, v]); return b },
      in: (c: string, v: unknown) => { call.filters.push([`${c}:in`, v]); return b },
      or: (v: string) => { call.filters.push(["or", v]); return b },
      gte: (c: string, v: unknown) => { call.filters.push([`${c}:gte`, v]); return b },
      is: (c: string, v: unknown) => { call.filters.push([`${c}:is`, v]); return b },
      order: () => b,
      limit: (n: number) => { call.limitN = n; return b },
      maybeSingle: run,
      single: run,
      then: (res: any, rej: any) => run().then(res, rej),
    }
    return b
  }
  return { calls, db: { from } }
}
