import { describe, it, expect } from "vitest"
import { complaintEligibility, COMPLETED_WAIT_MS, PROCESSING_WAIT_MS } from "./support-eligibility"

const NOW = new Date("2026-11-13T12:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

describe("complaintEligibility", () => {
  it("uses 15 minutes for completed and 3 hours for processing", () => {
    expect(COMPLETED_WAIT_MS).toBe(15 * MIN)
    expect(PROCESSING_WAIT_MS).toBe(3 * HOUR)
  })

  it("completed: refused before 15 minutes, allowed at and after", () => {
    const at = (m: number) => complaintEligibility({ status: "completed", createdAt: ago(5 * HOUR), updatedAt: ago(m * MIN) }, NOW)
    expect(at(14).eligible).toBe(false)
    expect(at(15).eligible).toBe(true)
    expect(at(600).eligible).toBe(true)
  })

  it("completed: falls back to the order time when there is no update time", () => {
    expect(complaintEligibility({ status: "completed", createdAt: ago(20 * MIN), updatedAt: null }, NOW).eligible).toBe(true)
    expect(complaintEligibility({ status: "completed", createdAt: ago(5 * MIN) }, NOW).eligible).toBe(false)
  })

  it("processing: counts from when the order was placed, not from the last status sync", () => {
    const p = (h: number, upd?: string) => complaintEligibility({ status: "processing", createdAt: ago(h * HOUR), updatedAt: upd }, NOW)
    expect(p(2.9).eligible).toBe(false)
    expect(p(3).eligible).toBe(true)
    expect(p(4, ago(1 * MIN)).eligible).toBe(true)
  })

  it("normalises status casing and whitespace", () => {
    expect(complaintEligibility({ status: " Completed ", createdAt: ago(HOUR), updatedAt: ago(HOUR) }, NOW).eligible).toBe(true)
  })

  it("every other status is refused, whatever its age", () => {
    for (const status of ["pending", "failed", "refunded", "reversed", "expired", "held_registration", "", null, undefined]) {
      expect(complaintEligibility({ status, createdAt: ago(100 * HOUR), updatedAt: ago(100 * HOUR) }, NOW).eligible).toBe(false)
    }
  })

  it("missing or unparseable times are refused", () => {
    expect(complaintEligibility({ status: "completed", createdAt: null, updatedAt: null }, NOW).eligible).toBe(false)
    expect(complaintEligibility({ status: "processing", createdAt: "not a date" }, NOW).eligible).toBe(false)
  })

  it("explains why in plain words", () => {
    const early = complaintEligibility({ status: "completed", createdAt: ago(HOUR), updatedAt: ago(5 * MIN) }, NOW)
    expect(early).toEqual({ eligible: false, reason: "You can report this order 15 minutes after it is marked completed." })
    const proc = complaintEligibility({ status: "processing", createdAt: ago(HOUR) }, NOW)
    expect(proc).toEqual({ eligible: false, reason: "You can report this order once it has been processing for 3 hours." })
    const other = complaintEligibility({ status: "pending", createdAt: ago(HOUR) }, NOW)
    expect(other).toEqual({ eligible: false, reason: "Only completed orders, or orders processing for 3 hours, can be reported." })
  })
})
