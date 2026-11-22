import { describe, it, expect } from "vitest"
import { initialConsoleTab, rejectReasonOk } from "./console-tabs"

describe("initialConsoleTab", () => {
  it("opens Approvals while anything is waiting, otherwise Keys", () => {
    expect(initialConsoleTab({ requested: null, waiting: 2 })).toBe("approvals")
    expect(initialConsoleTab({ requested: null, waiting: 0 })).toBe("keys")
  })
  it("a requested tab wins; an unknown value is ignored", () => {
    expect(initialConsoleTab({ requested: "logs", waiting: 2 })).toBe("logs")
    expect(initialConsoleTab({ requested: "approvals", waiting: 0 })).toBe("approvals")
    expect(initialConsoleTab({ requested: "bogus", waiting: 0 })).toBe("keys")
    expect(initialConsoleTab({ requested: "bogus", waiting: 1 })).toBe("approvals")
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
