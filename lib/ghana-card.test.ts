import { describe, it, expect } from "vitest"
import { parseGhanaCardNumber, formatGhanaCardInput } from "./ghana-card"

describe("parseGhanaCardNumber", () => {
  it("accepts an already-correct number unchanged", () => {
    expect(parseGhanaCardNumber("GHA-727791722-8")).toBe("GHA-727791722-8")
  })

  it("inserts the missing GHA prefix (real failed order: 727791722-8)", () => {
    expect(parseGhanaCardNumber("727791722-8")).toBe("GHA-727791722-8")
  })

  it("inserts the missing middle dash (real failed order: GHA-7299912867)", () => {
    expect(parseGhanaCardNumber("GHA-7299912867")).toBe("GHA-729991286-7")
  })

  it("is case-insensitive and tolerates spaces", () => {
    expect(parseGhanaCardNumber("gha 727791722 8")).toBe("GHA-727791722-8")
  })

  it("returns null for a missing check digit (real failed order: GHA-731328523, only 9 digits)", () => {
    expect(parseGhanaCardNumber("GHA-731328523")).toBe(null)
  })

  it("returns null for a non-digit character embedded in the number (real failed order: GHA-712T94437-4)", () => {
    expect(parseGhanaCardNumber("GHA-712T94437-4")).toBe(null)
  })

  it("returns null for empty or garbage input", () => {
    expect(parseGhanaCardNumber("")).toBe(null)
    expect(parseGhanaCardNumber("not a card")).toBe(null)
  })
})

describe("formatGhanaCardInput", () => {
  it("anchors the GHA prefix even when the user types digits only", () => {
    expect(formatGhanaCardInput("727791722")).toBe("GHA-727791722")
    expect(formatGhanaCardInput("7277917228")).toBe("GHA-727791722-8")
  })

  it("produces the same result whether or not the user types GHA themselves", () => {
    expect(formatGhanaCardInput("GHA7277917228")).toBe("GHA-727791722-8")
    expect(formatGhanaCardInput("GHA-727791722-8")).toBe("GHA-727791722-8")
  })

  it("handles partial input while typing without throwing", () => {
    expect(formatGhanaCardInput("7")).toBe("GHA-7")
    expect(formatGhanaCardInput("")).toBe("")
  })

  it("ignores extra characters beyond the 10 digits", () => {
    expect(formatGhanaCardInput("72779172281234")).toBe("GHA-727791722-8")
  })
})
