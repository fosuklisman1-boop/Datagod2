import { describe, it, expect, vi, afterEach } from "vitest"
import { dbReservations, memoryReservations } from "./reservations"

const r = { ref: "REF1", kind: "data" as const, orderId: "o1" }

function fakeDb(insertResult: () => any, deleteResult: () => any = () => ({ error: null })) {
  const calls: any[] = []
  return {
    calls,
    from(t: string) {
      return {
        insert(row: any) { calls.push(["insert", t, row]); return Promise.resolve().then(insertResult) },
        delete() { return { eq(col: string, v: string) { calls.push(["delete", t, col, v]); return Promise.resolve().then(deleteResult) } } },
      }
    },
  }
}

describe("dbReservations", () => {
  it("success => reserved, inserting the row", async () => {
    const db = fakeDb(() => ({ error: null }))
    expect(await dbReservations(() => db).reserve(r)).toBe("reserved")
    expect(db.calls[0]).toEqual(["insert", "hubnet_ref_reservations", { ref: "REF1", kind: "data", order_id: "o1" }])
  })
  it("23505 => held", async () => {
    expect(await dbReservations(() => fakeDb(() => ({ error: { code: "23505" } }))).reserve(r)).toBe("held")
  })
  it("other error => error", async () => {
    expect(await dbReservations(() => fakeDb(() => ({ error: { code: "42501" } }))).reserve(r)).toBe("error")
  })
  it("thrown error => error", async () => {
    expect(await dbReservations(() => fakeDb(() => { throw new Error("boom") })).reserve(r)).toBe("error")
  })
  it("null db => error", async () => {
    expect(await dbReservations(() => null).reserve(r)).toBe("error")
  })
  it("getDb throwing => error", async () => {
    expect(await dbReservations(() => { throw new Error("x") }).reserve(r)).toBe("error")
  })
  it("release deletes by ref", async () => {
    const db = fakeDb(() => ({ error: null }))
    await dbReservations(() => db).release("REF1")
    expect(db.calls[0]).toEqual(["delete", "hubnet_ref_reservations", "ref", "REF1"])
  })
  it("release swallows returned errors, thrown errors and a null db", async () => {
    await expect(dbReservations(() => fakeDb(() => ({ error: null }), () => ({ error: { code: "x" } }))).release("R")).resolves.toBeUndefined()
    await expect(dbReservations(() => fakeDb(() => ({ error: null }), () => { throw new Error("boom") })).release("R")).resolves.toBeUndefined()
    await expect(dbReservations(() => null).release("R")).resolves.toBeUndefined()
  })
})

describe("defaultHubnetReservations", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })
  it("fails closed (error) when the service-role env is missing, and release does not throw", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "")
    vi.resetModules()
    const { defaultHubnetReservations } = await import("./reservations")
    const d = defaultHubnetReservations()
    expect(defaultHubnetReservations()).toBe(d)
    expect(await d.reserve(r)).toBe("error")
    await expect(d.release("REF1")).resolves.toBeUndefined()
  })
})

describe("memoryReservations", () => {
  it("second reserve => held; release then reserve => reserved", async () => {
    const m = memoryReservations()
    expect(await m.reserve(r)).toBe("reserved")
    expect(await m.reserve(r)).toBe("held")
    await m.release("REF1")
    expect(await m.reserve(r)).toBe("reserved")
  })
})
