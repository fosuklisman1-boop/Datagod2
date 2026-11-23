import { describe, it, expect, vi, afterEach } from "vitest"
import { makeFakeDb } from "@/lib/order-queue/fake-db.test-helper"
import { getFreshVerdicts, saveVerdicts, YES_TTL_MS, NO_TTL_MS } from "./verdicts"

const NOW = new Date("2026-11-22T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const H = 3_600_000
const D = 86_400_000
// Obviously fake test number
const PHONE = "0240000001"

afterEach(() => vi.restoreAllMocks())

describe("TTL constants", () => {
  it("has the agreed values", () => {
    expect(YES_TTL_MS).toBe(30 * D)
    expect(NO_TTL_MS).toBe(D)
  })
})

describe("getFreshVerdicts", () => {
  const dbWith = (rows: any[]) => makeFakeDb({ mtn_supplier_verdicts: rows })

  it("yes is fresh at 29 days and stale at 31 days", async () => {
    const db = dbWith([
      { phone: PHONE, supplier: "a", verdict: "yes", checked_at: ago(29 * D) },
      { phone: PHONE, supplier: "b", verdict: "yes", checked_at: ago(31 * D) },
    ])
    const m = await getFreshVerdicts(db as any, PHONE, ["a", "b"], NOW)
    expect(m.get("a")).toBe("yes")
    expect(m.has("b")).toBe(false)
  })

  it("no is fresh at 23 hours and stale at 25 hours", async () => {
    const db = dbWith([
      { phone: PHONE, supplier: "a", verdict: "no", checked_at: ago(23 * H) },
      { phone: PHONE, supplier: "b", verdict: "no", checked_at: ago(25 * H) },
    ])
    const m = await getFreshVerdicts(db as any, PHONE, ["a", "b"], NOW)
    expect(m.get("a")).toBe("no")
    expect(m.has("b")).toBe(false)
  })

  it("a row stamped more than 5 minutes in the future is stale; within 5 minutes is fresh", async () => {
    const future = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
    const db = dbWith([
      { phone: PHONE, supplier: "a", verdict: "yes", checked_at: future(6 * 60_000) },
      { phone: PHONE, supplier: "b", verdict: "yes", checked_at: future(4 * 60_000) },
    ])
    const m = await getFreshVerdicts(db as any, PHONE, ["a", "b"], NOW)
    expect(m.has("a")).toBe(false)
    expect(m.get("b")).toBe("yes")
  })

  it("normalises the phone before reading and only returns asked suppliers", async () => {
    const db = dbWith([
      { phone: PHONE, supplier: "a", verdict: "yes", checked_at: ago(H) },
      { phone: PHONE, supplier: "z", verdict: "yes", checked_at: ago(H) },
    ])
    const m = await getFreshVerdicts(db as any, "+233240000001", ["a"], NOW)
    expect([...m.keys()]).toEqual(["a"])
  })

  it("returns an empty map on a read error, an invalid phone, or no suppliers", async () => {
    const db = dbWith([{ phone: PHONE, supplier: "a", verdict: "yes", checked_at: ago(H) }])
    expect((await getFreshVerdicts(db as any, "not a phone", ["a"], NOW)).size).toBe(0)
    expect((await getFreshVerdicts(db as any, PHONE, [], NOW)).size).toBe(0)
    db.failSelect = () => ({ message: "boom" })
    expect((await getFreshVerdicts(db as any, PHONE, ["a"], NOW)).size).toBe(0)
  })
})

describe("saveVerdicts", () => {
  function upsertDb(result: { error: { message: string } | null } | "throw") {
    const calls: any[] = []
    const db = {
      from: (t: string) => ({
        upsert: (rows: any, opts: any) => {
          calls.push({ t, rows, opts })
          if (result === "throw") throw new Error(`down for ${PHONE}`)
          return Promise.resolve(result)
        },
      }),
    }
    return { db, calls }
  }

  it("upserts normalised rows on the primary key with the checked_at stamp", async () => {
    const { db, calls } = upsertDb({ error: null })
    await saveVerdicts(db as any, [
      { phone: "+233240000001", supplier: "a", verdict: "yes" },
      { phone: PHONE, supplier: "b", verdict: "no" },
    ], NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0].t).toBe("mtn_supplier_verdicts")
    expect(calls[0].opts).toEqual({ onConflict: "phone,supplier" })
    expect(calls[0].rows).toEqual([
      { phone: PHONE, supplier: "a", verdict: "yes", checked_at: NOW.toISOString() },
      { phone: PHONE, supplier: "b", verdict: "no", checked_at: NOW.toISOString() },
    ])
  })

  it("does nothing for an empty list and skips invalid phones", async () => {
    const { db, calls } = upsertDb({ error: null })
    await saveVerdicts(db as any, [], NOW)
    await saveVerdicts(db as any, [{ phone: "junk", supplier: "a", verdict: "yes" }], NOW)
    expect(calls).toHaveLength(0)
  })

  it("never throws and logs without the phone on error or throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const a = upsertDb({ error: { message: `bad row ${PHONE}` } })
    await expect(saveVerdicts(a.db as any, [{ phone: PHONE, supplier: "a", verdict: "yes" }], NOW)).resolves.toBeUndefined()
    const b = upsertDb("throw")
    await expect(saveVerdicts(b.db as any, [{ phone: PHONE, supplier: "a", verdict: "yes" }], NOW)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    expect(JSON.stringify(spy.mock.calls)).not.toContain("240000001")
  })
})
