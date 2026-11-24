import { describe, it, expect } from "vitest"
import { initialConsoleTab, rejectReasonOk, CONSOLE_TABS, trendBars } from "./console-tabs"

describe("initialConsoleTab", () => {
  it("opens Approvals while anything is waiting, otherwise Overview", () => {
    expect(initialConsoleTab({ requested: null, waiting: 2 })).toBe("approvals")
    expect(initialConsoleTab({ requested: null, waiting: 0 })).toBe("overview")
  })
  it("old links approvals, keys, logs still valid; unknown value ignored; new tabs linkable", () => {
    expect(initialConsoleTab({ requested: "logs", waiting: 2 })).toBe("logs")
    expect(initialConsoleTab({ requested: "keys", waiting: 2 })).toBe("keys")
    expect(initialConsoleTab({ requested: "approvals", waiting: 0 })).toBe("approvals")
    expect(initialConsoleTab({ requested: "bogus", waiting: 0 })).toBe("overview")
    expect(initialConsoleTab({ requested: "bogus", waiting: 1 })).toBe("approvals")
    for (const t of ["developers", "services", "announcements", "report", "legacy"]) {
      expect(initialConsoleTab({ requested: t, waiting: 3 })).toBe(t)
    }
  })
})

describe("CONSOLE_TABS", () => {
  it("nine tabs in the specified order; Legacy label contains ends 30 Nov 2026", () => {
    expect(CONSOLE_TABS.map((t) => t.id)).toEqual(["overview", "approvals", "developers", "keys", "logs", "services", "announcements", "report", "legacy"])
    expect(CONSOLE_TABS.find((t) => t.id === "legacy")!.label).toContain("ends 30 Nov 2026")
    expect(CONSOLE_TABS.find((t) => t.id === "services")!.label).toBe("Services and status")
  })
})

describe("trendBars", () => {
  it("empty list -> []; scales to height; failed share never exceeds total", () => {
    expect(trendBars([], 100)).toEqual([])
    const bars = trendBars(
      [
        { day: "2026-11-01", requests: 50, failed: 5 },
        { day: "2026-11-02", requests: 100, failed: 200 },
        { day: "2026-11-03", requests: 0, failed: 0 },
      ],
      80,
    )
    expect(bars.map((b) => b.h)).toEqual([40, 80, 0])
    expect(bars[0].failedH).toBe(4)
    expect(bars[1].failedH).toBe(80)
    expect(bars.every((b) => b.failedH <= b.h)).toBe(true)
    expect(bars.map((b) => b.x)).toEqual([0, 1, 2])
    expect(bars[0].label).toBe("2026-11-01: 50 requests, 5 failed")
  })
})

describe("rejectReasonOk", () => {
  it("needs 3-200 characters after trimming", () => {
    expect(rejectReasonOk("  ab  ")).toBe(false)
    expect(rejectReasonOk("abc")).toBe(true)
    expect(rejectReasonOk(" " + "x".repeat(200) + " ")).toBe(true)
    expect(rejectReasonOk("x".repeat(201))).toBe(false)
    expect(rejectReasonOk("")).toBe(false)
  })
})
