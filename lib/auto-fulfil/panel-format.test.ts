import { describe, it, expect } from "vitest"
import {
  describeLastRun,
  draftToSettings,
  networkSkipNotes,
  RETRY_BUCKETS,
  settingsToDraft,
  type PanelSwitches,
} from "./panel-format"
import { DEFAULT_AUTO_FULFIL_SETTINGS } from "./settings"

const NOW = new Date("2026-11-22T10:00:00.000Z")
const run = (over: Record<string, unknown> = {}) => ({
  startedAt: "2026-11-22T09:57:30.000Z",
  finishedAt: "2026-11-22T09:58:00.000Z",
  queued: 4,
  waiting: 3,
  needsYou: 1,
  error: null,
  ...over,
})

describe("describeLastRun", () => {
  it("says Never run when there is no run", () => {
    expect(describeLastRun(null, NOW)).toBe("Never run")
  })

  it("says Last run failed when the run recorded an error", () => {
    expect(describeLastRun(run({ error: "boom" }), NOW)).toBe("Last run failed")
  })

  it("shows minutes since the run finished and the three counts", () => {
    expect(describeLastRun(run(), NOW)).toBe("Last run 2 min ago · 4 queued · 3 waiting · 1 needs you")
  })

  it("says just now inside the first minute", () => {
    expect(describeLastRun(run({ finishedAt: "2026-11-22T09:59:40.000Z" }), NOW)).toBe(
      "Last run just now · 4 queued · 3 waiting · 1 needs you",
    )
  })

  it("switches to hours and days for older runs", () => {
    expect(describeLastRun(run({ finishedAt: "2026-11-22T07:00:00.000Z" }), NOW)).toMatch(/^Last run 3 h ago · /)
    expect(describeLastRun(run({ finishedAt: "2026-11-20T09:00:00.000Z" }), NOW)).toMatch(/^Last run 2 d ago · /)
  })

  it("says a run without a finish time is still running", () => {
    expect(describeLastRun(run({ finishedAt: null }), NOW)).toBe("Run in progress (started 2 min ago)")
  })

  it("treats missing counts as zero", () => {
    expect(describeLastRun(run({ queued: null, waiting: undefined, needsYou: null }), NOW)).toBe(
      "Last run 2 min ago · 0 queued · 0 waiting · 0 needs you",
    )
  })
})

const allOn: PanelSwitches = { mtn: true, nonMtn: { enabled: true, networks: ["Telecel", "AT - iShare", "AT - BigTime"] } }

describe("networkSkipNotes", () => {
  it("returns nothing when every network is listed and its switch is on", () => {
    expect(networkSkipNotes(DEFAULT_AUTO_FULFIL_SETTINGS, allOn)).toEqual([])
  })

  it("says MTN is skipped when the MTN auto-fulfilment switch is off", () => {
    expect(networkSkipNotes(DEFAULT_AUTO_FULFIL_SETTINGS, { ...allOn, mtn: false })).toEqual([
      "MTN skipped: MTN auto-fulfilment is off",
    ])
  })

  it("says a network is skipped when it is not in the auto-fulfilment networks", () => {
    const settings = { ...DEFAULT_AUTO_FULFIL_SETTINGS, networks: ["MTN", "AT - iShare", "AT - BigTime"] }
    expect(networkSkipNotes(settings, allOn)).toEqual(["Telecel skipped: not in the auto-fulfilment networks"])
  })

  it("says a non-MTN network is off when the non-MTN switch does not cover it", () => {
    const sw: PanelSwitches = { mtn: true, nonMtn: { enabled: true, networks: ["AT - iShare", "AT - BigTime"] } }
    expect(networkSkipNotes(DEFAULT_AUTO_FULFIL_SETTINGS, sw)).toEqual(["Telecel skipped: Telecel auto-fulfilment is off"])
  })

  it("says every non-MTN network is off when the non-MTN switch is off", () => {
    const sw: PanelSwitches = { mtn: true, nonMtn: { enabled: false, networks: [] } }
    expect(networkSkipNotes(DEFAULT_AUTO_FULFIL_SETTINGS, sw)).toEqual([
      "Telecel skipped: Telecel auto-fulfilment is off",
      "AT - iShare skipped: AT - iShare auto-fulfilment is off",
      "AT - BigTime skipped: AT - BigTime auto-fulfilment is off",
    ])
  })

  it("prefers the not-listed reason over the switch reason", () => {
    const settings = { ...DEFAULT_AUTO_FULFIL_SETTINGS, networks: ["Telecel"] }
    expect(networkSkipNotes(settings, { ...allOn, mtn: false })[0]).toBe("MTN skipped: not in the auto-fulfilment networks")
  })
})

describe("settings draft", () => {
  it("round-trips the defaults and keeps the enabled flag it is given", () => {
    const back = draftToSettings(settingsToDraft(DEFAULT_AUTO_FULFIL_SETTINGS), true)
    expect(back).toEqual({ ok: true, value: { ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: true } })
  })

  it("never shares objects with the settings it came from", () => {
    const before = JSON.stringify(DEFAULT_AUTO_FULFIL_SETTINGS)
    const d = settingsToDraft(DEFAULT_AUTO_FULFIL_SETTINGS)
    d.networks.pop()
    d.rules.rate_limited.retry = false
    expect(JSON.stringify(DEFAULT_AUTO_FULFIL_SETTINGS)).toBe(before)
  })

  it("lists all seven retry buckets", () => {
    expect(RETRY_BUCKETS).toHaveLength(7)
  })

  it("rejects an empty or out-of-range box with the server's message", () => {
    const d = settingsToDraft(DEFAULT_AUTO_FULFIL_SETTINGS)
    expect(draftToSettings({ ...d, minAgeMinutes: "" }, false)).toEqual({
      ok: false,
      error: "minAgeMinutes must be a whole number from 10 to 120",
    })
    expect(draftToSettings({ ...d, minAgeMinutes: "5" }, false).ok).toBe(false)
    const rules = { ...d.rules, rejected: { ...d.rules.rejected, maxTries: "1.5" } }
    expect(draftToSettings({ ...d, rules }, false)).toEqual({ ok: false, error: "rule rejected: tries must be 1 to 20" })
  })

  it("rejects an empty network list", () => {
    const d = settingsToDraft(DEFAULT_AUTO_FULFIL_SETTINGS)
    expect(draftToSettings({ ...d, networks: [] }, false).ok).toBe(false)
  })
})
