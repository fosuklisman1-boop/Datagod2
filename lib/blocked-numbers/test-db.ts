/**
 * Test-only fake of the Supabase query builder. Every chained method returns the same builder and records
 * (method, args); awaiting it calls `handler(table, calls)` for the result. Used by the admin route tests.
 */

export type Call = [method: string, args: unknown[]]
export type FakeResult = { data?: unknown; error?: unknown; count?: number | null }
export type FakeLogEntry = { table: string; calls: Call[] }

const METHODS = [
  "select", "insert", "update", "upsert", "delete", "eq", "neq", "in", "is", "not", "lt", "lte", "gt", "gte",
  "ilike", "or", "order", "range", "limit", "maybeSingle", "single",
]

export function makeFakeDb(handler: (table: string, calls: Call[]) => FakeResult) {
  const log: FakeLogEntry[] = []
  const db = {
    from(table: string) {
      const calls: Call[] = []
      log.push({ table, calls })
      const builder: Record<string, unknown> = {}
      for (const m of METHODS) {
        builder[m] = (...args: unknown[]) => {
          calls.push([m, args])
          return builder
        }
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        try {
          const r = handler(table, calls)
          return Promise.resolve({ data: null, error: null, count: null, ...r }).then(resolve, reject)
        } catch (e) {
          return Promise.reject(e).then(resolve, reject)
        }
      }
      return builder
    },
  }
  return { db, log }
}

export const hasCall = (calls: Call[], method: string, ...args: unknown[]) =>
  calls.some(([m, a]) => m === method && args.every((v, i) => JSON.stringify(a[i]) === JSON.stringify(v)))

export const callArgs = (calls: Call[], method: string): unknown[] | undefined => calls.find(([m]) => m === method)?.[1]
