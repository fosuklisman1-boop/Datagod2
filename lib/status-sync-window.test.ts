import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { RECENT_WINDOW_HOURS, SYNC_WINDOW_DAYS, isDailySweep, isHourlySlot, syncWindowStartIso } from "./status-sync-window"

const at = (iso: string) => new Date(iso)
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

describe("syncWindowStartIso tiers", () => {
  it("is 6 hours back on a normal run", () => {
    const now = at("2026-10-21T12:34:00Z")
    expect(RECENT_WINDOW_HOURS).toBe(6)
    expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 6 * HOUR).toISOString())
  })

  it("is 7 days back during the hourly slot (minutes 0-4)", () => {
    for (const iso of ["2026-10-21T12:00:00Z", "2026-10-21T12:04:59Z"]) {
      const now = at(iso)
      expect(SYNC_WINDOW_DAYS).toBe(7)
      expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 7 * DAY).toISOString())
    }
  })

  it("a */5 cron gets the 6-hour window at :05", () => {
    const now = at("2026-10-21T12:05:00Z")
    expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 6 * HOUR).toISOString())
  })

  it("daily sweep wins over the hourly slot at 03:00", () => {
    expect(new Date(syncWindowStartIso(at("2026-10-21T03:00:00Z"))).getUTCFullYear()).toBeLessThan(2010)
  })
})

describe("isHourlySlot", () => {
  it("is true only for minutes 0-4", () => {
    expect(isHourlySlot(at("2026-10-21T15:00:00Z"))).toBe(true)
    expect(isHourlySlot(at("2026-10-21T15:04:59Z"))).toBe(true)
    expect(isHourlySlot(at("2026-10-21T15:05:00Z"))).toBe(false)
    expect(isHourlySlot(at("2026-10-21T15:59:59Z"))).toBe(false)
  })
})

describe("syncWindowStartIso", () => {
  it("reaches back to the start of time during the daily sweep, so old orders are still checked", () => {
    expect(new Date(syncWindowStartIso(at("2026-10-21T03:00:00Z"))).getUTCFullYear()).toBeLessThan(2010)
    expect(new Date(syncWindowStartIso(at("2026-10-21T03:04:59Z"))).getUTCFullYear()).toBeLessThan(2010)
  })
})

describe("isDailySweep", () => {
  it("is true only for 03:00-03:04 UTC", () => {
    expect(isDailySweep(at("2026-10-21T03:00:00Z"))).toBe(true)
    expect(isDailySweep(at("2026-10-21T03:04:59Z"))).toBe(true)
    expect(isDailySweep(at("2026-10-21T03:05:00Z"))).toBe(false)
    expect(isDailySweep(at("2026-10-21T02:59:59Z"))).toBe(false)
    expect(isDailySweep(at("2026-10-21T15:02:00Z"))).toBe(false)
  })
})

describe("provider status syncs use the window", () => {
  const root = join(__dirname, "../app/api/cron/sync-mtn-status")
  const providers = ["xpress", "spfastit-telecel", "spfastit", "eazyghdata", "datakazina", "codecraft", "apexprime", "agentportalgh", "bisdel", "bundleportal", "kuntanii"]

  it.each(providers)("%s only polls pending/processing rows inside the sync window", (p) => {
    const src = readFileSync(join(root, p, "route.ts"), "utf8")
    expect(src).toContain("syncWindowStartIso")
    expect(src).toMatch(/\.in\("status", \["pending", "processing"\]\)\s*\n\s*\.gte\("created_at", syncWindowStartIso\(\)\)/)
  })

  it("covers every per-provider sync route (a new one must opt in)", () => {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    expect(dirs.sort()).toEqual([...providers].sort())
  })
})
