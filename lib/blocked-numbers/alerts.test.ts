import { describe, it, expect, vi } from "vitest"
import { buildDigest, maybeSendSpikeAlert, sendDailyDigest, previousUtcDay, type DigestStats, type SpikeDeps } from "./alerts"
import { DEFAULT_BLOCKED_SETTINGS } from "./settings"

const NOW = new Date("2026-11-16T03:00:00.000Z")
const HOUR = 3_600_000

const STATS: DigestStats = {
  day: "2026-11-15",
  attempts: 1234,
  distinctNumbers: 321,
  topSurfaces: [
    { surface: "storefront", count: 800 },
    { surface: "ussd_hubtel", count: 300 },
  ],
  becameAllowed: 12,
  customersTexted: 9,
  expired: 4,
  unchecked: 2,
  deferred: 0,
}

describe("buildDigest", () => {
  it("has no run of 9 or more digits anywhere (counts only, never phones)", () => {
    const d = buildDigest(STATS)
    for (const s of [d.subject, d.html, d.pushTitle, d.pushBody]) expect(/\d{9,}/.test(s)).toBe(false)
  })

  it("reports every count", () => {
    const d = buildDigest(STATS)
    expect(d.html).toContain("1,234")
    expect(d.html).toContain("321")
    expect(d.html).toContain("storefront")
    expect(d.pushBody).toContain("1,234")
    expect(d.pushBody).toContain("12")
  })

  it("flags unchecked and deferred numbers when there are any", () => {
    const d = buildDigest({ ...STATS, deferred: 5 })
    expect(d.html).toMatch(/deferred/i)
  })
})

describe("previousUtcDay", () => {
  it("returns the previous UTC day window", () => {
    const w = previousUtcDay(NOW)
    expect(w.day).toBe("2026-11-15")
    expect(w.startIso).toBe("2026-11-15T00:00:00.000Z")
    expect(w.endIso).toBe("2026-11-16T00:00:00.000Z")
  })
})

function spikeDeps(over: Partial<SpikeDeps> & { phones?: string[]; lastAt?: string | null } = {}) {
  const phones = over.phones ?? []
  const stamp = vi.fn(async (_iso: string) => {})
  const email = vi.fn(async (_s: string, _h: string) => {})
  const push = vi.fn(async (_p: { title: string; body: string }) => ({}))
  const deps: SpikeDeps = {
    settings: async () => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled: true, spike_threshold_per_hour: 25 }),
    now: () => NOW,
    recentPhones: async () => phones,
    getLastAlertAt: async () => over.lastAt ?? null,
    stampAlert: stamp,
    notifyEmail: email,
    notifyPush: push,
    ...over,
  }
  return { deps, stamp, email, push }
}

const distinct = (n: number) => Array.from({ length: n }, (_, i) => `024${String(i).padStart(7, "0")}`)

describe("maybeSendSpikeAlert", () => {
  it("26 distinct phones over a threshold of 25 with no stamp: sends and stamps", async () => {
    const { deps, stamp, email, push } = spikeDeps({ phones: distinct(26) })
    expect(await maybeSendSpikeAlert(deps)).toBe(true)
    expect(stamp).toHaveBeenCalledTimes(1)
    expect(email).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
    const [subject, html] = email.mock.calls[0]
    expect(/\d{9,}/.test(subject + html)).toBe(false)
  })

  it("exactly the threshold does not send (must exceed)", async () => {
    const { deps, email } = spikeDeps({ phones: distinct(25) })
    expect(await maybeSendSpikeAlert(deps)).toBe(false)
    expect(email).not.toHaveBeenCalled()
  })

  it("a stamp 2 hours old blocks the alert", async () => {
    const { deps, stamp, email } = spikeDeps({ phones: distinct(40), lastAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() })
    expect(await maybeSendSpikeAlert(deps)).toBe(false)
    expect(stamp).not.toHaveBeenCalled()
    expect(email).not.toHaveBeenCalled()
  })

  it("a stamp over 6 hours old allows it", async () => {
    const { deps, email } = spikeDeps({ phones: distinct(40), lastAt: new Date(NOW.getTime() - 7 * HOUR).toISOString() })
    expect(await maybeSendSpikeAlert(deps)).toBe(true)
    expect(email).toHaveBeenCalledTimes(1)
  })

  it("30 attempts of one phone is one distinct number: no send", async () => {
    const { deps, email } = spikeDeps({ phones: Array.from({ length: 30 }, () => "0240000001") })
    expect(await maybeSendSpikeAlert(deps)).toBe(false)
    expect(email).not.toHaveBeenCalled()
  })

  it("does nothing when the feature is off", async () => {
    const { deps, email } = spikeDeps({
      phones: distinct(40),
      settings: async () => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled: false }),
    })
    expect(await maybeSendSpikeAlert(deps)).toBe(false)
    expect(email).not.toHaveBeenCalled()
  })

  it("stamps before notifying and still resolves when a notifier throws", async () => {
    const order: string[] = []
    const { deps } = spikeDeps({
      phones: distinct(30),
      stampAlert: async () => {
        order.push("stamp")
      },
      notifyEmail: async () => {
        order.push("email")
        throw new Error("smtp down")
      },
      notifyPush: async () => {
        order.push("push")
        return {}
      },
    })
    expect(await maybeSendSpikeAlert(deps)).toBe(true)
    expect(order[0]).toBe("stamp")
    expect(order).toContain("push")
  })
})

describe("sendDailyDigest", () => {
  it("builds from loaded stats plus the run's unchecked/deferred and sends email and push", async () => {
    const email = vi.fn(async () => {})
    const push = vi.fn(async () => ({}))
    const loadStats = vi.fn(async () => ({ ...STATS, unchecked: 0, deferred: 0 }))
    const stampDigestDay = vi.fn(async () => {})
    const sent = await sendDailyDigest(
      { unchecked: 3, deferred: 1 },
      { now: () => NOW, loadStats, notifyEmail: email, notifyPush: push, getLastDigestDay: async () => null, stampDigestDay }
    )
    expect(sent).toBe(true)
    expect(stampDigestDay).toHaveBeenCalledWith("2026-11-15", NOW.toISOString())
    expect(loadStats).toHaveBeenCalledWith("2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z")
    const html = (email.mock.calls[0] as unknown as [string, string])[1]
    expect(html).toMatch(/deferred/i)
    expect(push).toHaveBeenCalledTimes(1)
  })
})

describe("daily digest once-per-day guard", () => {
  it("skips when the previous day is already stamped", async () => {
    const email = vi.fn(async () => {})
    const loadStats = vi.fn(async () => STATS)
    const sent = await sendDailyDigest(
      { unchecked: 0, deferred: 0 },
      { now: () => NOW, loadStats, notifyEmail: email, notifyPush: async () => ({}), getLastDigestDay: async () => "2026-11-15", stampDigestDay: async () => {} }
    )
    expect(sent).toBe(false)
    expect(email).not.toHaveBeenCalled()
    expect(loadStats).not.toHaveBeenCalled()
  })

  it("sends when the stamp is an older day, and does not stamp when both channels fail", async () => {
    const stamp = vi.fn(async () => {})
    const sent = await sendDailyDigest(
      { unchecked: 0, deferred: 0 },
      {
        now: () => NOW,
        loadStats: async () => STATS,
        notifyEmail: async () => { throw new Error("x") },
        notifyPush: async () => { throw new Error("y") },
        getLastDigestDay: async () => "2026-11-14",
        stampDigestDay: stamp,
      }
    )
    expect(sent).toBe(false)
    expect(stamp).not.toHaveBeenCalled()
  })
})

describe("readRecentPhones paging", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ phone: `024${String(i).padStart(7, "0")}` }))
  const fakeDb = (all: Array<{ phone: string }>) => {
    const ranges: Array<[number, number]> = []
    return {
      ranges,
      db: {
        from() {
          let r: [number, number] = [0, 0]
          const b: Record<string, unknown> = {}
          for (const m of ["select", "gte", "order"]) b[m] = () => b
          b.range = (a: number, z: number) => { r = [a, z]; ranges.push(r); return b }
          b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: all.slice(r[0], r[1] + 1), error: null }).then(res)
          return b
        },
      },
    }
  }

  it("1300 distinct phones over 2 pages with threshold 1200 fires", async () => {
    const { readRecentPhones } = await import("./alerts")
    const f = fakeDb(mk(1300))
    const { deps, email } = spikeDeps({
      settings: async () => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled: true, spike_threshold_per_hour: 1200 }),
      recentPhones: (since, stop) => readRecentPhones(f.db, since, stop),
    })
    expect(await maybeSendSpikeAlert(deps)).toBe(true)
    expect(f.ranges).toEqual([[0, 999], [1000, 1999]])
    expect(email).toHaveBeenCalledTimes(1)
  })

  it("stops early once the distinct count already exceeds the threshold", async () => {
    const { readRecentPhones } = await import("./alerts")
    const f = fakeDb(mk(5000))
    await readRecentPhones(f.db, "x", 25)
    expect(f.ranges).toHaveLength(1)
  })
})
