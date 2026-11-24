import { describe, it, expect } from "vitest"
import { validateAnnouncement, serviceMessageOk, servicePauseCopy, SERVICE_MESSAGE_MAX, toLocalInput, fromLocalInput } from "./console-forms"

const ok = { title: "Maintenance", body: "Short window", severity: "info", startsAt: "2026-12-01T10:00", endsAt: "2026-12-01T12:00" }

describe("validateAnnouncement (mirrors SQL)", () => {
  it("title 1-80, body 1-1000, closed severity, end after start", () => {
    expect(validateAnnouncement(ok)).toEqual([])
    expect(validateAnnouncement({ ...ok, title: "x".repeat(81) })).toContain("Title must be 1 to 80 characters.")
    expect(validateAnnouncement({ ...ok, title: "   " })).toContain("Title must be 1 to 80 characters.")
    expect(validateAnnouncement({ ...ok, body: "x".repeat(1001) })).toContain("Text must be 1 to 1000 characters.")
    expect(validateAnnouncement({ ...ok, severity: "urgent" })).toContain("Choose info, warning or critical.")
    expect(validateAnnouncement({ ...ok, endsAt: "2026-12-01T10:00" })).toContain("The end must be after the start.")
    expect(validateAnnouncement({ ...ok, startsAt: "" })).toContain("Choose a start and an end.")
  })
  it("counts characters, not UTF-16 units (an emoji title of 80 is fine)", () => {
    expect(validateAnnouncement({ ...ok, title: String.fromCodePoint(0x1f600).repeat(80) })).toEqual([])
  })
})

describe("local datetime inputs", () => {
  it("a datetime-local value round-trips to an ISO string with a timezone", () => {
    const iso = fromLocalInput("2026-12-01T10:00")
    expect(iso).toMatch(/Z$/)
    expect(toLocalInput(iso!)).toBe("2026-12-01T10:00")
    expect(fromLocalInput("nope")).toBeNull()
  })
})

describe("service pause", () => {
  it("message limited to 200 characters", () => {
    expect(SERVICE_MESSAGE_MAX).toBe(200)
    expect(serviceMessageOk("x".repeat(200))).toBe(true)
    expect(serviceMessageOk("x".repeat(201))).toBe(false)
    expect(serviceMessageOk("")).toBe(true)
  })
  it("pause copy states exactly what stops", () => {
    expect(servicePauseCopy("Airtime", true).body).toContain("new purchases and sends stop, order lookups keep working")
    expect(servicePauseCopy("Airtime", false).body).toMatch(/message is cleared/i)
  })
})
