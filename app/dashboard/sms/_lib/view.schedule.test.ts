import { describe, it, expect } from "vitest"
import {
  scheduleBounds, toLocalInputValue, fromLocalInputValue, scheduleError, formatScheduled,
  RECORD_CHIPS, chipStatus, sendOutcomeMessage, sendErrorMessage, isCancelledLog, SCHEDULED_CANCEL_CONFIRM,
} from "./view"

const NOW = new Date("2026-10-12T10:00:00Z")

describe("scheduleBounds", () => {
  it("is now+2min .. now+30d", () => {
    const b = scheduleBounds(NOW)
    expect(b.min.toISOString()).toBe("2026-10-12T10:02:00.000Z")
    expect(b.max.toISOString()).toBe("2026-11-11T10:00:00.000Z")
  })
})

describe("datetime-local conversion (GMT)", () => {
  it("formats a date as a UTC datetime-local value", () => {
    expect(toLocalInputValue(new Date("2026-10-12T15:30:45Z"))).toBe("2026-10-12T15:30")
  })
  it("parses a local-input value as UTC", () => {
    expect(fromLocalInputValue("2026-10-12T15:30")).toBe("2026-10-12T15:30:00.000Z")
  })
  it("returns null for empty/invalid input", () => {
    expect(fromLocalInputValue("")).toBeNull()
    expect(fromLocalInputValue("nope")).toBeNull()
  })
})

describe("scheduleError", () => {
  it("requires a value", () => { expect(scheduleError(null, NOW)).toMatch(/pick/i) })
  it("rejects too soon / too far", () => {
    expect(scheduleError("2026-10-12T10:01:00.000Z", NOW)).toBe("Pick a time at least 2 minutes from now")
    expect(scheduleError("2026-12-12T10:00:00.000Z", NOW)).toBe("You can schedule up to 30 days ahead")
  })
  it("accepts a valid time", () => { expect(scheduleError("2026-10-13T10:00:00.000Z", NOW)).toBeNull() })
})

describe("formatScheduled", () => {
  it("renders day, month, time and GMT", () => {
    expect(formatScheduled("2026-10-12T15:30:00Z")).toBe("12 Oct, 15:30 GMT")
    expect(formatScheduled("2026-01-03T08:05:00Z")).toBe("3 Jan, 08:05 GMT")
  })
  it("is empty for invalid input", () => { expect(formatScheduled("x")).toBe("") })
})

describe("scheduled chip", () => {
  it("is present and maps to the scheduled status", () => {
    expect(RECORD_CHIPS.find((c) => c.key === "scheduled")).toEqual({ key: "scheduled", label: "Scheduled", values: ["scheduled"] })
    expect(chipStatus("scheduled")).toBe("scheduled")
  })
})

describe("messages", () => {
  it("sendOutcomeMessage for a scheduled send", () => {
    expect(sendOutcomeMessage({ scheduled: true, scheduledFor: "2026-10-12T15:30:00Z" })).toEqual({
      tone: "success",
      text: "Scheduled for 12 Oct, 15:30 GMT — credits reserved. You can cancel from Records until then.",
    })
  })
  it("INVALID_SCHEDULE shows the server message", () => {
    expect(sendErrorMessage("INVALID_SCHEDULE", undefined, "Pick a time at least 2 minutes from now")).toBe("Pick a time at least 2 minutes from now")
    expect(sendErrorMessage("INVALID_SCHEDULE")).toMatch(/schedule|time/i)
  })
  it("cancel confirm wording", () => {
    expect(SCHEDULED_CANCEL_CONFIRM).toBe("Cancel this scheduled send? Credits for unsent messages will be refunded.")
  })
  it("isCancelledLog needs failed + cancelled flag", () => {
    expect(isCancelledLog({ status: "failed", cancelled: true })).toBe(true)
    expect(isCancelledLog({ status: "failed" })).toBe(false)
    expect(isCancelledLog({ status: "sent", cancelled: true })).toBe(false)
  })
})
