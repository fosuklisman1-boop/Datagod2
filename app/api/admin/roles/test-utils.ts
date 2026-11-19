// Shared fake Supabase client for the /api/admin/roles route tests.
import { NextRequest } from "next/server"

export type Res = { data?: unknown; error?: unknown; count?: number | null }
export type Fake = {
  tables: Record<string, Res | ((ctx: { filters: unknown[][] }) => Res)>
  rpc: Record<string, Res>
  calls: { rpc: { name: string; args: Record<string, unknown> }[]; from: string[]; chains: Record<string, unknown[][][]> }
  db: { from(t: string): unknown; rpc(n: string, a: Record<string, unknown>): Promise<Res> }
}

export function makeFake(): Fake {
  const f: Fake = {
    tables: {},
    rpc: {},
    calls: { rpc: [], from: [], chains: {} },
    db: {
      from(t: string) {
        f.calls.from.push(t)
        const filters: unknown[][] = []
        ;(f.calls.chains[t] ??= []).push(filters)
        const q: Record<string, unknown> = {}
        for (const m of ["select", "eq", "neq", "in", "or", "is", "not", "order", "limit", "range", "gte", "lt"]) {
          q[m] = (...a: unknown[]) => {
            filters.push([m, ...a])
            return q
          }
        }
        q.then = (ok: (v: Res) => unknown, bad?: (e: unknown) => unknown) => {
          const spec = f.tables[t]
          const res = typeof spec === "function" ? spec({ filters }) : spec ?? { data: [], error: null }
          return Promise.resolve({ error: null, data: null, count: null, ...res }).then(ok, bad)
        }
        return q
      },
      async rpc(name, args) {
        f.calls.rpc.push({ name, args })
        return { error: null, data: null, ...(f.rpc[name] ?? {}) }
      },
    },
  }
  return f
}

export const reqOf = (method: string, body?: unknown, url = "http://localhost/api/admin/roles") =>
  new NextRequest(url, {
    method,
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export const ID = "11111111-1111-4111-8111-111111111111"
export const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
export const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
export const role = (id: string, slug: string, rank: number | null, extra: Record<string, unknown> = {}) => ({
  id, slug, rank, is_system: false, archived_at: null, ...extra,
})
