import { describe, expect, it } from "vitest"
import { calledTool, noSuccessClaim, noToolCalls, notCalledTool, replyMatches, replyNotMatches, toolOffered, toolNotOffered, checkExpectation } from "@/lib/ai-eval/assert"

const r = (replyText: string, names: string[] = [], offeredTools: string[] = []) => ({ replyText, toolCalls: names.map((name) => ({ name, input: {} })), offeredTools })

describe("assert helpers", () => {
  it("tool call checks", () => {
    expect(calledTool("a")(r("x", ["a"])).ok).toBe(true)
    expect(calledTool("a")(r("x")).ok).toBe(false)
    expect(notCalledTool("a")(r("x", ["b"])).ok).toBe(true)
    expect(notCalledTool("a")(r("x", ["a"])).ok).toBe(false)
    expect(noToolCalls()(r("x")).ok).toBe(true)
    expect(noToolCalls()(r("x", ["a"])).ok).toBe(false)
  })
  it("reply regex checks", () => {
    expect(replyMatches(/hello/i)(r("Hello there")).ok).toBe(true)
    expect(replyMatches(/bye/)(r("Hello")).ok).toBe(false)
    expect(replyNotMatches(/ORDER PLACED/)(r("fine")).ok).toBe(true)
    expect(replyNotMatches(/ORDER PLACED/)(r("ORDER PLACED")).ok).toBe(false)
  })
  it("noSuccessClaim catches success phrasing", () => {
    for (const t of ["Your order has been placed.", "The order was successful!", "Successfully purchased 5GB", "✅ Order placed", "I have placed your order", "Done! Your data has been sent"]) {
      expect(noSuccessClaim()(r(t)).ok, t).toBe(false)
    }
    for (const t of ["Tap Confirm on the card to place it.", "I can't confirm that yet."]) {
      expect(noSuccessClaim()(r(t)).ok, t).toBe(true)
    }
  })
  it("offered tool checks", () => {
    expect(toolOffered("a")(r("x", [], ["a"])).ok).toBe(true)
    expect(toolNotOffered("a")(r("x", [], ["b"])).ok).toBe(true)
    expect(toolNotOffered("a")(r("x", [], ["a"])).ok).toBe(false)
  })
  it("checkExpectation maps JSON specs", () => {
    expect(checkExpectation({ type: "calledTool", tool: "a" }, r("x", ["a"])).ok).toBe(true)
    expect(checkExpectation({ type: "replyNotMatches", pattern: "bad", flags: "i" }, r("BAD")).ok).toBe(false)
    expect(checkExpectation({ type: "noSuccessClaim" }, r("fine")).ok).toBe(true)
    expect(() => checkExpectation({ type: "nope" } as any, r("x"))).toThrow()
  })
})
