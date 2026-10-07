// lib/ussd-hubtel/services.test.ts
import { describe, it, expect } from "vitest"
import { getAfaPrice, listMyVouchers } from "./services"

describe("listMyVouchers", () => {
  it("matches every stored phone format, completed only, newest 5", async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const b: any = {}
    for (const m of ["select", "or", "eq", "gte", "order"]) b[m] = (...a: unknown[]) => { calls.push([m, ...a]); return b }
    b.limit = async (n: number) => { calls.push(["limit", n]); return { data: [{ id: "v1" }], error: null } }
    const supabase: any = { from: (t: string) => { calls.push(["from", t]); return b } }
    const rows = await listMyVouchers(supabase, "+233200585542")
    expect(rows).toEqual([{ id: "v1" }])
    const or = String(calls.find(c => c[0] === "or")![1])
    for (const v of ["dialing_phone.eq.+233200585542", "dialing_phone.eq.0200585542", "dialing_phone.eq.233200585542", "customer_phone.eq.0200585542"]) {
      expect(or).toContain(v)
    }
    expect(calls).toContainEqual(["from", "results_checker_orders"])
    expect(calls).toContainEqual(["eq", "status", "completed"])
    expect(calls).toContainEqual(["limit", 5])
  })
  it("returns [] on a query error", async () => {
    const b: any = { select: () => b, or: () => b, eq: () => b, gte: () => b, order: () => b, limit: async () => ({ data: null, error: { message: "x" } }) }
    const supabase: any = { from: () => b }
    const err = console.error
    console.error = () => {}
    expect(await listMyVouchers(supabase, "0200585542")).toEqual([])
    console.error = err
  })
})

describe("getAfaPrice", () => {
  const client = (data: unknown, error: unknown = null) => {
    const calls: unknown[][] = []
    const b: any = { select: () => b, eq: (...a: unknown[]) => { calls.push(a); return b }, maybeSingle: async () => ({ data, error }) }
    return { supabase: { from: () => b } as any, calls }
  }
  it("reads the active 'default' row", async () => {
    const { supabase, calls } = client({ price: "50.00" })
    expect(await getAfaPrice(supabase)).toBe(50)
    expect(calls).toContainEqual(["is_active", true])
    expect(calls).toContainEqual(["name", "default"])
  })
  it("returns null for a missing, zero or unparseable price, and on error", async () => {
    expect(await getAfaPrice(client(null).supabase)).toBeNull()
    expect(await getAfaPrice(client({ price: 0 }).supabase)).toBeNull()
    expect(await getAfaPrice(client({ price: "abc" }).supabase)).toBeNull()
    const err = console.error
    console.error = () => {}
    expect(await getAfaPrice(client(null, { message: "x" }).supabase)).toBeNull()
    console.error = err
  })
})
