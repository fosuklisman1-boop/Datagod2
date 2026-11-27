import { describe, it, expect } from "vitest"
import { expireStaleTickets, setTicketStatus } from "./queue-db"

// Minimal chainable fake: records each update's filters and returns `rows` from .select().
function fakeDb(rowsFor: (filters: unknown[][]) => { id: string }[] = () => [{ id: "t1" }]) {
  const updates: { patch: Record<string, unknown>; filters: unknown[][] }[] = []
  const db = {
    from: () => {
      const filters: unknown[][] = []
      let patch: Record<string, unknown> = {}
      let selected = false
      const b: any = {
        update: (p: Record<string, unknown>) => { patch = p; return b },
        eq: (...a: unknown[]) => { filters.push(["eq", ...a]); return b },
        lt: (...a: unknown[]) => { filters.push(["lt", ...a]); return b },
        select: () => { selected = true; return b },
        then: (res: (v: unknown) => unknown) => {
          updates.push({ patch, filters })
          return Promise.resolve(selected ? { data: rowsFor(filters), error: null } : { data: null, error: null }).then(res)
        },
      }
      return b
    },
  }
  return { db: db as any, updates }
}

describe("setTicketStatus is a real compare-and-set", () => {
  it("succeeds only when exactly one row changed", async () => {
    expect(await setTicketStatus(fakeDb(() => [{ id: "t1" }]).db, "t1", "used", "admitted")).toBe(true)
    expect(await setTicketStatus(fakeDb(() => []).db, "t1", "used", "admitted")).toBe(false)
  })
  it("filters on the expected current status", async () => {
    const f = fakeDb()
    await setTicketStatus(f.db, "t1", "admitted", "waiting", { admitted_at: "x" })
    expect(f.updates[0].filters).toContainEqual(["eq", "status", "waiting"])
    expect(f.updates[0].patch).toEqual({ status: "admitted", admitted_at: "x" })
  })
})

describe("expireStaleTickets", () => {
  it("also expires waiting tickets older than the longest allowed wait, however often they check in", async () => {
    const f = fakeDb()
    const now = Date.parse("2026-11-27T12:00:00Z")
    expect(await expireStaleTickets(f.db, 10 * 60_000, now)).toBe(true)
    const byCreated = f.updates.find((u) => u.filters.some((x) => x[0] === "lt" && x[1] === "created_at"))
    expect(byCreated).toBeDefined()
    expect(byCreated!.filters).toContainEqual(["lt", "created_at", "2026-11-27T11:50:00.000Z"])
    expect(byCreated!.filters).toContainEqual(["eq", "status", "waiting"])
  })
})
