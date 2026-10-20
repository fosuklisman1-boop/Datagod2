import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { buildJobSpecs } from "./jobs"
import { planActions, checkBudget, type ExistingJob } from "./plan"

const HOST = "https://www.datagod.store"
const cfg = JSON.parse(readFileSync(join(__dirname, "crons.json"), "utf8"))
const specs = buildJobSpecs(cfg.crons, HOST)

describe("planActions", () => {
  it("empty account -> create all 40", () => {
    const actions = planActions(specs, [], HOST)
    expect(actions).toHaveLength(40)
    expect(actions.every((a) => a.kind === "create")).toBe(true)
  })

  it("adopts the 2 pre-existing www.datagod.store jobs (update) and creates 38", () => {
    const existing: ExistingJob[] = [
      { jobId: 7224390, title: "subs", url: `${HOST}/api/cron/check-subscription-expiry`, enabled: true },
      { jobId: 7227752, title: "subs ex", url: `${HOST}/api/cron/check-subscriptions`, enabled: true },
    ]
    const actions = planActions(specs, existing, HOST)
    expect(actions.filter((a) => a.kind === "create")).toHaveLength(38)
    const updates = actions.filter((a) => a.kind === "update")
    expect(updates.map((a) => a.jobId).sort()).toEqual([7224390, 7227752])
  })

  it("never matches or touches jobs on another host", () => {
    const other: ExistingJob = {
      jobId: 7966501,
      title: "mdata wallet",
      url: "https://www.mdatagh.com/api/cron/verify-pending-payments",
      enabled: true,
    }
    const actions = planActions(specs, [other], HOST)
    expect(actions.some((a) => a.jobId === 7966501)).toBe(false)
    expect(actions.filter((a) => a.kind === "create")).toHaveLength(40)
  })

  it("is idempotent: an account already holding every owned job yields all skip", () => {
    const existing: ExistingJob[] = specs.map((s, i) => ({
      jobId: 1000 + i,
      title: s.title,
      url: s.url,
      enabled: false,
      schedule: s.schedule,
    }))
    const actions = planActions(specs, existing, HOST)
    expect(actions.every((a) => a.kind === "skip")).toBe(true)
  })

  it("updates an owned job whose schedule drifted", () => {
    const s = specs[0]
    const existing: ExistingJob[] = [
      { jobId: 5, title: s.title, url: s.url, enabled: false, schedule: { ...s.schedule, minutes: [3] } },
    ]
    const a = planActions([s], existing, HOST)[0]
    expect(a.kind).toBe("update")
    expect(a.jobId).toBe(5)
  })
})

describe("checkBudget", () => {
  it("refuses when used + needed exceeds the cap", () => {
    expect(checkBudget({ day: "2026-10-20", used: 70 }, "2026-10-20", 15).ok).toBe(false)
  })
  it("allows within the cap and returns updated state", () => {
    const r = checkBudget({ day: "2026-10-20", used: 10 }, "2026-10-20", 5)
    expect(r.ok).toBe(true)
    expect(r.state).toEqual({ day: "2026-10-20", used: 15 })
  })
  it("resets on a new UTC day", () => {
    const r = checkBudget({ day: "2026-10-19", used: 79 }, "2026-10-20", 5)
    expect(r.ok).toBe(true)
    expect(r.state).toEqual({ day: "2026-10-20", used: 5 })
  })
  it("treats missing state as zero used", () => {
    expect(checkBudget(null, "2026-10-20", 1).state).toEqual({ day: "2026-10-20", used: 1 })
  })
})
