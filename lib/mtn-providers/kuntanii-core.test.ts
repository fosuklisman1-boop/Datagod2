import { describe, it, expect } from "vitest"
import {
  MAX_ATTEMPTS,
  mapKuntaniiStatus,
  aggregateOrdersStatus,
  classifyKuntaniiError,
  isSizeSupported,
  toLocalGhanaPhone,
  attemptId,
  existingAttemptAction,
  redactPhone,
  sumCost,
  type KuntaniiPlan,
} from "./kuntanii-core"

describe("mapKuntaniiStatus", () => {
  it("maps known statuses case-insensitively", () => {
    expect(mapKuntaniiStatus("pending")).toBe("processing")
    expect(mapKuntaniiStatus("processing")).toBe("processing")
    expect(mapKuntaniiStatus("processed")).toBe("completed")
    expect(mapKuntaniiStatus("cancelled")).toBe("failed")
    expect(mapKuntaniiStatus("not received")).toBe("completed")
    expect(mapKuntaniiStatus("NOT RECEIVED")).toBe("completed")
    expect(mapKuntaniiStatus("  Processed ")).toBe("completed")
  })
  it("defaults unknown to processing", () => {
    expect(mapKuntaniiStatus("weird")).toBe("processing")
    expect(mapKuntaniiStatus(undefined)).toBe("processing")
    expect(mapKuntaniiStatus(null)).toBe("processing")
  })
  it("MAX_ATTEMPTS is 5", () => expect(MAX_ATTEMPTS).toBe(5))
})

describe("aggregateOrdersStatus", () => {
  it("aggregates", () => {
    expect(aggregateOrdersStatus([])).toBe("processing")
    expect(aggregateOrdersStatus([{ status: "processed" }])).toBe("completed")
    expect(aggregateOrdersStatus([{ status: "processed" }, { status: "pending" }])).toBe("processing")
    expect(aggregateOrdersStatus([{ status: "cancelled" }, { status: "processed" }])).toBe("failed")
    expect(aggregateOrdersStatus([{ status: "cancelled" }])).toBe("failed")
  })
})

describe("classifyKuntaniiError", () => {
  const c = classifyKuntaniiError
  it("not eligible", () => {
    expect(c(422, "NO_APPROVED_RECIPIENTS", "normal")).toBe("NOT_ELIGIBLE")
    expect(c(422, "NO_ELIGIBLE_RECIPIENTS", "normal")).toBe("NOT_ELIGIBLE")
  })
  it("validation depends on mode", () => {
    expect(c(422, "VALIDATION_ERROR", "instant")).toBe("INSTANT_UNAVAILABLE")
    expect(c(422, "VALIDATION_ERROR", "normal")).toBe("VALIDATION")
    expect(c(400, "VALIDATION_ERROR", "normal")).toBe("VALIDATION")
  })
  it("account hold", () => {
    expect(c(402, "INSUFFICIENT_CREDIT", "normal")).toBe("ACCOUNT_HOLD")
    expect(c(402, "GOVERNING_ACCOUNT_CREDIT_HOLD", "normal")).toBe("ACCOUNT_HOLD")
    for (const code of [
      "PAYMENT_VERIFICATION_REQUIRED",
      "ACCOUNT_ORDERS_PAUSED",
      "PARENT_ORDERS_PAUSED",
      "ORDERS_PAUSED",
      "PRICING_PROFILE_REQUIRED",
      "FORBIDDEN",
    ]) {
      expect(c(403, code, "normal")).toBe("ACCOUNT_HOLD")
    }
    expect(c(401, "UNAUTHORIZED", "normal")).toBe("ACCOUNT_HOLD")
  })
  it("conflict, retryable, not found, api error", () => {
    expect(c(409, "CONFLICT", "normal")).toBe("CONFLICT")
    expect(c(429, "RATE_LIMITED", "normal")).toBe("RETRYABLE")
    for (const code of ["CREDIT_UNAVAILABLE", "BENEFICIARY_CHECK_UNAVAILABLE", "CREDIT_RELAY_UNAVAILABLE"]) {
      expect(c(503, code, "normal")).toBe("RETRYABLE")
    }
    expect(c(404, "NOT_FOUND", "normal")).toBe("NOT_FOUND")
    expect(c(500, undefined, "normal")).toBe("RETRYABLE")
    expect(c(418, undefined, "normal")).toBe("API_ERROR")
  })
})

describe("isSizeSupported", () => {
  const plans: KuntaniiPlan[] = Array.from({ length: 100 }, (_, i) => ({
    planCode: i + 1,
    displayName: `${i + 1}GB`,
    bundleSizeMb: (i + 1) * 1024,
    unitPriceGhs: 1,
  })).filter((p) => p.planCode !== 11)
  it("checks GB against bundleSizeMb", () => {
    expect(isSizeSupported(plans, 1)).toBe(true)
    expect(isSizeSupported(plans, 12)).toBe(true)
    expect(isSizeSupported(plans, 100)).toBe(true)
    expect(isSizeSupported(plans, 11)).toBe(false)
    expect(isSizeSupported(plans, 0.5)).toBe(false)
    expect(isSizeSupported([], 1)).toBe(false)
  })
})

describe("toLocalGhanaPhone", () => {
  it("normalises", () => {
    expect(toLocalGhanaPhone("0241234567")).toBe("0241234567")
    expect(toLocalGhanaPhone("233241234567")).toBe("0241234567")
    expect(toLocalGhanaPhone("+233 24 123 4567")).toBe("0241234567")
    expect(toLocalGhanaPhone(" 024-123-4567 ")).toBe("0241234567")
  })
  it("rejects bad input", () => {
    expect(toLocalGhanaPhone("12345")).toBeNull()
    expect(toLocalGhanaPhone("0241234567890")).toBeNull()
    expect(toLocalGhanaPhone("")).toBeNull()
  })
})

describe("attemptId", () => {
  it("first attempt is the bare id", () => {
    expect(attemptId("abc", 1)).toBe("abc")
    expect(attemptId("abc", 2)).toBe("abc-r2")
  })
})

describe("existingAttemptAction", () => {
  it("decides next vs resume", () => {
    expect(existingAttemptAction([{ status: "cancelled" }, { status: "cancelled" }])).toBe("next")
    expect(existingAttemptAction([{ status: "pending" }])).toBe("resume")
    expect(existingAttemptAction([{ status: "processed" }])).toBe("resume")
    expect(existingAttemptAction([{ status: "not received" }])).toBe("resume")
    expect(existingAttemptAction([])).toBe("resume")
  })
})

describe("redactPhone", () => {
  it("keeps last 3 digits", () => {
    expect(redactPhone("0241234567")).toBe("*******567")
    expect(redactPhone(undefined)).toBe("")
    expect(redactPhone(null)).toBe("")
  })
})

describe("sumCost", () => {
  it("sums and rounds", () => {
    expect(sumCost([{ totalAmountGhs: 3.85 }, { totalAmountGhs: 7.7 }])).toBe(11.55)
    expect(sumCost([{ totalAmountGhs: 0.1 }, { totalAmountGhs: 0.2 }])).toBe(0.3)
  })
  it("falls back", () => {
    expect(sumCost([], 96)).toBe(96)
    expect(sumCost(undefined)).toBeUndefined()
    expect(sumCost([{ status: "pending" }], 5)).toBe(5)
  })
})
