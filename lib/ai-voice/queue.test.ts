import { describe, it, expect } from "vitest"
import { ADMIT_HOLD_MS, QUEUE_STALE_MS, etaSeconds, freeSlotCount, ownsTicket, waitingPosition } from "./queue"
import { readOpenByKey } from "./slots"

describe("queue constants", () => {
  it("a waiting ticket goes stale after 20 s, an admitted one after 30 s", () => {
    expect(QUEUE_STALE_MS).toBe(20_000)
    expect(ADMIT_HOLD_MS).toBe(30_000)
  })
})

describe("etaSeconds", () => {
  it("rounds the position up to whole rounds of slots, each as long as the call (capped at 3 minutes)", () => {
    expect(etaSeconds(1, 1, 300)).toBe(180)
    expect(etaSeconds(2, 1, 300)).toBe(360)
    expect(etaSeconds(3, 2, 300)).toBe(360) // ceil(3/2) = 2 rounds
    expect(etaSeconds(2, 2, 300)).toBe(180)
  })
  it("uses a call shorter than 3 minutes as is", () => {
    expect(etaSeconds(1, 1, 120)).toBe(120)
    expect(etaSeconds(4, 2, 90)).toBe(180)
  })
  it("treats zero slots as one", () => {
    expect(etaSeconds(2, 0, 300)).toBe(360)
  })
})

describe("ticket helpers", () => {
  const t = (id: string, status: "waiting" | "admitted", extra: Record<string, unknown> = {}) =>
    ({ id, status, user_id: null, device_hash: null, created_at: "2026-01-01T00:00:00Z", ...extra }) as any
  it("ownsTicket matches a signed-in caller by user id and a visitor by device hash, never across", () => {
    expect(ownsTicket(t("a", "waiting", { user_id: "u1" }), { userId: "u1", deviceHash: "d1" })).toBe(true)
    expect(ownsTicket(t("a", "waiting", { user_id: "u2" }), { userId: "u1", deviceHash: "d1" })).toBe(false)
    expect(ownsTicket(t("a", "waiting", { device_hash: "d1" }), { userId: "u1", deviceHash: "d1" })).toBe(false)
    expect(ownsTicket(t("a", "waiting", { device_hash: "d1" }), { deviceHash: "d1" })).toBe(true)
    expect(ownsTicket(t("a", "waiting", { device_hash: "d2" }), { deviceHash: "d1" })).toBe(false)
    expect(ownsTicket(t("a", "waiting", { device_hash: "d1" }), { deviceHash: null })).toBe(false)
  })
  it("waitingPosition is 1-based among waiting tickets in order, admitted ones are not in the line", () => {
    const list = [t("x", "admitted"), t("a", "waiting"), t("b", "waiting"), t("c", "waiting")]
    expect(waitingPosition(list, "a")).toBe(1)
    expect(waitingPosition(list, "c")).toBe(3)
    expect(waitingPosition(list, "x")).toBe(0)
    expect(waitingPosition(list, "nope")).toBe(0)
  })
})

describe("freeSlotCount", () => {
  const keys = [{ index: 1, key: "a" }, { index: 2, key: "b" }, { index: 3, key: "c" }]
  it("sums the free calls over every account when multiple accounts are on", () => {
    expect(freeSlotCount(keys, 2, { 1: 1, 2: 2 }, true)).toBe(1 + 0 + 2)
  })
  it("never counts below zero for an over-full account", () => {
    expect(freeSlotCount(keys, 1, { 1: 5 }, true)).toBe(2)
  })
  it("counts account 1 only when multiple accounts are off", () => {
    expect(freeSlotCount(keys, 2, { 1: 1, 2: 0 }, false)).toBe(1)
  })
  it("is 0 with no keys, or with account 1 missing while off", () => {
    expect(freeSlotCount([], 1, {}, true)).toBe(0)
    expect(freeSlotCount([{ index: 2, key: "b" }], 1, {}, false)).toBe(0)
  })
})

describe("readOpenByKey", () => {
  function fakeDb(result: { data: unknown; error: unknown }) {
    const ops: unknown[][] = []
    const q: any = {}
    for (const m of ["select", "is", "gt"]) q[m] = (...a: unknown[]) => { ops.push([m, ...a]); return q }
    q.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res)
    return { db: { from: (t: string) => { ops.push(["from", t]); return q } } as any, ops }
  }
  it("counts open calls per Nuance account and ignores rows with no account", async () => {
    const { db, ops } = fakeDb({ data: [{ nuance_key: 1 }, { nuance_key: 1 }, { nuance_key: 3 }, { nuance_key: null }, {}], error: null })
    expect(await readOpenByKey(db, "2026-01-01T00:00:00.000Z")).toEqual({ 1: 2, 3: 1 })
    expect(ops).toContainEqual(["from", "ai_voice_calls"])
    expect(ops).toContainEqual(["select", "nuance_key"])
    expect(ops).toContainEqual(["is", "ended_at", null])
    expect(ops).toContainEqual(["gt", "created_at", "2026-01-01T00:00:00.000Z"])
  })
  it("returns null when the read fails", async () => {
    const { db } = fakeDb({ data: null, error: { message: "x" } })
    expect(await readOpenByKey(db, "2026-01-01T00:00:00.000Z")).toBeNull()
  })
})
