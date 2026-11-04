import { describe, it, expect, vi } from "vitest"
import { sendThrottledAlert } from "./alert-throttle"

const T0 = new Date("2026-11-04T10:00:00.000Z")
const HOUR = 60 * 60_000

function fakeSettings() {
  const store = new Map<string, any>()
  const db = {
    from: () => ({
      select: () => ({ eq: (_c: string, key: string) => ({ maybeSingle: async () => ({ data: store.has(key) ? { value: store.get(key) } : null, error: null }) }) }),
      upsert: async (row: { key: string; value: unknown }) => { store.set(row.key, row.value); return { error: null } },
      delete: () => ({ eq: async (_c: string, key: string) => { store.delete(key); return { error: null } } }),
    }),
  }
  return { db: db as any, store }
}
const opts = (key: string, notify: (m: string, t: string) => Promise<void>, at: Date) => ({
  key, type: "some_type", description: "d", windowMs: HOUR, logPrefix: "[T]", notify, now: () => at,
})

describe("sendThrottledAlert", () => {
  it("one send per window for a key; again after the window; the type reaches notify", async () => {
    const { db } = fakeSettings()
    const notify = vi.fn(async () => {})
    await sendThrottledAlert(db, "m", opts("k1", notify, T0))
    await sendThrottledAlert(db, "m", opts("k1", notify, new Date(T0.getTime() + HOUR - 1)))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith("m", "some_type")
    await sendThrottledAlert(db, "m", opts("k1", notify, new Date(T0.getTime() + HOUR)))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("keys throttle independently", async () => {
    const { db } = fakeSettings()
    const notify = vi.fn(async () => {})
    await sendThrottledAlert(db, "m", opts("k1", notify, T0))
    await sendThrottledAlert(db, "m", opts("k2", notify, T0))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("a failed send does not mute the next attempt and never throws", async () => {
    const { db, store } = fakeSettings()
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await sendThrottledAlert(db, "m", opts("k1", async () => { throw new Error("sms down") }, T0))
    expect(store.has("k1")).toBe(false)
    const notify = vi.fn(async () => {})
    await sendThrottledAlert(db, "m", opts("k1", notify, T0))
    expect(notify).toHaveBeenCalledTimes(1)
    err.mockRestore()
  })
})
