import { describe, it, expect } from "vitest"
import { WINDOW_MINUTES, MAX_OPEN_SESSIONS, openSessions, nextSlotFreeAt, type SessionLite } from "./window"

const now = new Date("2026-11-11T12:00:00.000Z")
const at = (mins: number) => new Date(now.getTime() + mins * 60000).toISOString()
const s = (id: string, status: string, created: number, expires: number): SessionLite => ({
  id, status, createdAt: at(created), expiresAt: at(expires),
})

describe("constants", () => {
  it("has the agreed values", () => {
    expect(WINDOW_MINUTES).toBe(60)
    expect(MAX_OPEN_SESSIONS).toBe(5)
  })
})

describe("openSessions", () => {
  it("excludes expired, claimed and cancelled, newest first", () => {
    const list = [
      s("old", "pending", -50, 10),
      s("expired", "pending", -90, -30),
      s("claimed", "claimed", -10, 50),
      s("cancelled", "cancelled", -5, 55),
      s("new", "pending", -1, 59),
    ]
    expect(openSessions(list, now).map((x) => x.id)).toEqual(["new", "old"])
  })
  it("treats expiresAt equal to now as expired", () => {
    expect(openSessions([s("a", "pending", -60, 0)], now)).toEqual([])
  })
})

describe("nextSlotFreeAt", () => {
  it("is null with fewer than 5 open", () => {
    const list = [1, 2, 3, 4].map((i) => s(`s${i}`, "pending", -i, 60 - i))
    expect(nextSlotFreeAt(list, now)).toBeNull()
  })
  it("returns the earliest expiry when 5 are open", () => {
    const list = [1, 2, 3, 4, 5].map((i) => s(`s${i}`, "pending", -i, 60 - i * 5))
    expect(nextSlotFreeAt(list, now)).toEqual(new Date(at(35)))
  })
})
