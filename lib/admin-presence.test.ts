import { describe, it, expect, vi } from "vitest"
import { isSupportActive, touchAdminPresence, SUPPORT_ACTIVE_WINDOW_MS } from "./admin-presence"

const NOW = new Date("2026-11-12T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

function selectDb(result: { data: any; error: any }) {
  const calls: any = {}
  const db: any = {
    from: (t: string) => {
      calls.table = t
      return {
        select: () => ({
          gte: (col: string, val: string) => {
            calls.gte = [col, val]
            return { limit: () => Promise.resolve(result) }
          },
        }),
      }
    },
  }
  return { db, calls }
}

describe("isSupportActive", () => {
  it("is true when an admin was seen 2 minutes ago", async () => {
    const { db, calls } = selectDb({ data: [{ admin_id: "a1" }], error: null })
    expect(await isSupportActive(db, NOW)).toBe(true)
    expect(calls.table).toBe("admin_presence")
    expect(calls.gte).toEqual(["last_seen_at", ago(SUPPORT_ACTIVE_WINDOW_MS)])
  })
  it("is false when no row is inside the window", async () => {
    const { db } = selectDb({ data: [], error: null })
    expect(await isSupportActive(db, NOW)).toBe(false)
  })
  it("is false on a query error", async () => {
    const { db } = selectDb({ data: null, error: { message: "x" } })
    expect(await isSupportActive(db, NOW)).toBe(false)
  })
  it("is false when the client throws", async () => {
    const db: any = { from: () => { throw new Error("down") } }
    expect(await isSupportActive(db, NOW)).toBe(false)
  })
  it("window is 3 minutes", () => expect(SUPPORT_ACTIVE_WINDOW_MS).toBe(180_000))
})

describe("touchAdminPresence", () => {
  it("upserts the admin row keyed by admin_id", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const db: any = { from: vi.fn(() => ({ upsert })) }
    await touchAdminPresence(db, "a1")
    expect(db.from).toHaveBeenCalledWith("admin_presence")
    expect(upsert.mock.calls[0][0]).toMatchObject({ admin_id: "a1" })
    expect(typeof upsert.mock.calls[0][0].last_seen_at).toBe("string")
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: "admin_id" })
  })
  it("swallows an upsert error", async () => {
    const db: any = { from: () => ({ upsert: () => Promise.resolve({ error: { message: "x" } }) }) }
    await expect(touchAdminPresence(db, "a1")).resolves.toBeUndefined()
  })
  it("swallows a thrown error", async () => {
    const db: any = { from: () => ({ upsert: () => Promise.reject(new Error("x")) }) }
    await expect(touchAdminPresence(db, "a1")).resolves.toBeUndefined()
  })
})
