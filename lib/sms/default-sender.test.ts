import { describe, it, expect } from "vitest"
import { loadDefaultSender } from "./default-sender"

function fake(result: { data: unknown }) {
  const calls: [string, unknown[]][] = []
  const c: any = {}
  for (const m of ["select", "eq", "order", "limit"]) c[m] = (...a: unknown[]) => { calls.push([m, a]); return c }
  c.maybeSingle = () => Promise.resolve(result)
  return { db: { from: () => c }, calls }
}

describe("loadDefaultSender", () => {
  it("picks the oldest active own sender", async () => {
    const { db, calls } = fake({ data: { sender_id: "SHOP" } })
    expect(await loadDefaultSender(db, "a1")).toBe("SHOP")
    expect(calls).toContainEqual(["eq", ["local_status", "active"]])
    expect(calls).toContainEqual(["order", ["created_at", { ascending: true }]])
  })
  it("returns null when none", async () => {
    expect(await loadDefaultSender(fake({ data: null }).db, "a1")).toBeNull()
  })
})
