// Test helper (not a test): a tiny fake of the supabase-js client for the admin users route tests.
// Every from() chain is recorded as a FakeQuery and answered by a per-table handler; rpc() and
// auth.admin.getUserById() by their own handlers.

export type Result = { data: unknown; error: { message: string; code?: string; details?: string } | null; count?: number | null }

export interface FakeQuery {
  table: string
  /** "select" unless insert/update/delete was called. */
  kind: "select" | "insert" | "update" | "delete"
  columns: string | null
  count: string | null
  head: boolean
  payload: unknown
  /** Filters and modifiers in call order, e.g. ["eq", "user_id", "u1"], ["range", 0, 19]. */
  ops: unknown[][]
  /** Value of the first eq/in filter on a column. */
  filter(col: string): unknown
  op(name: string): unknown[] | undefined
}

export interface FakeDbOptions {
  tables?: Record<string, (q: FakeQuery) => Result>
  rpc?: (name: string, args: Record<string, unknown>) => Result
  getUserById?: (id: string) => Result
}

export function createFakeDb(opts: FakeDbOptions = {}) {
  const queries: FakeQuery[] = []
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

  const from = (table: string) => {
    const q: FakeQuery = {
      table, kind: "select", columns: null, count: null, head: false, payload: null, ops: [],
      filter: (col) => q.ops.find((o) => (o[0] === "eq" || o[0] === "in") && o[1] === col)?.[2],
      op: (name) => q.ops.find((o) => o[0] === name),
    }
    queries.push(q)
    const run = (): Promise<Result> => {
      const handler = opts.tables?.[table]
      if (!handler) return Promise.reject(new Error(`unexpected table ${table}`))
      return Promise.resolve(handler(q))
    }
    const chain: any = {
      select: (cols?: string, o?: { count?: string; head?: boolean }) => {
        if (q.kind === "select") q.columns = cols ?? "*"
        q.count = o?.count ?? null
        q.head = !!o?.head
        return chain
      },
      insert: (rows: unknown) => { q.kind = "insert"; q.payload = rows; return chain },
      update: (vals: unknown) => { q.kind = "update"; q.payload = vals; return chain },
      delete: () => { q.kind = "delete"; return chain },
      maybeSingle: () => { q.ops.push(["maybeSingle"]); return run() },
      single: () => { q.ops.push(["single"]); return run() },
      then: (res: (r: Result) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej),
    }
    for (const name of ["eq", "neq", "in", "gte", "lte", "gt", "lt", "is", "not", "order", "range", "limit", "ilike", "or"]) {
      chain[name] = (...args: unknown[]) => { q.ops.push([name, ...args]); return chain }
    }
    return chain
  }

  const db = {
    from,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return Promise.resolve(opts.rpc ? opts.rpc(name, args) : { data: null, error: { message: `unexpected rpc ${name}` } })
    },
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve(opts.getUserById ? opts.getUserById(id) : { data: { user: null }, error: { message: "not found" } }),
      },
    },
  }
  return { db, queries, rpcCalls, ofTable: (t: string) => queries.filter((q) => q.table === t) }
}

export type FakeDb = ReturnType<typeof createFakeDb>

/** The admin gate as verifyAdminAccess reports it, for vi.mock("@/lib/admin-auth"). */
export type GateMode = "admin" | "forbidden" | "cron" | "rate_limited"
export function fakeVerify(mode: GateMode) {
  switch (mode) {
    case "admin":
      return { isAdmin: true, userId: "11111111-1111-4111-8111-111111111111", userEmail: "boss@example.com" }
    case "cron":
      return { isAdmin: true }
    case "forbidden":
      return { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }) }
    case "rate_limited":
      return {
        isAdmin: true,
        userId: "11111111-1111-4111-8111-111111111111",
        errorResponse: new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 }),
      }
  }
}
export const ADMIN_ID = "11111111-1111-4111-8111-111111111111"
export const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
