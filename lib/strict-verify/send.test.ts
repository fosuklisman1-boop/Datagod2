import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/strict-verify/ask", () => ({
  // sykes has no check; anything in `disabled` cannot check.
  canCheck: (s: string, disabled: Set<string>) => s !== "sykes" && !disabled.has(s),
}))

import { strictSend, type StrictSendDeps } from "@/lib/strict-verify/send"
import type { MTNOrderRequest, MTNOrderResponse } from "@/lib/mtn-fulfillment"

const ok = (id = "1"): MTNOrderResponse => ({ success: true, order_id: id, message: "ok" })
const fail = (message = "boom", error_type?: string): MTNOrderResponse => ({ success: false, message, error_type })

function mk(over: Partial<StrictSendDeps> & { answers?: Record<string, "yes" | "no" | "no_answer">; sends?: Record<string, MTNOrderResponse> } = {}) {
  const { answers = {}, sends = {}, ...rest } = over
  const ask = vi.fn(async (s: string) => answers[s] ?? "no_answer")
  const send = vi.fn(async (s: string) => sends[s] ?? ok(s))
  const save = vi.fn(async () => {})
  const fresh = vi.fn(async () => new Map<string, "yes" | "no">())
  const deps = {
    candidates: ["codecraft", "xpress"],
    pinned: false,
    disabled: new Set<string>(),
    fresh,
    ask,
    save,
    send,
    budgetMs: 10_000,
    ...rest,
  } as StrictSendDeps
  return { deps, ask, send, save, fresh }
}
const order: MTNOrderRequest = { recipient_phone: "0551234567", network: "MTN", size_gb: 1 }

describe("strictSend", () => {
  beforeEach(() => vi.clearAllMocks())

  it("primary approved: only primary is sent", async () => {
    const t = mk({ answers: { codecraft: "yes", xpress: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(r.success).toBe(true)
    expect(r.provider).toBe("codecraft")
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["codecraft"])
    expect(t.ask).toHaveBeenCalledTimes(1)
  })

  it("primary no, sequence approved: sequence sent, primary never sent", async () => {
    const t = mk({ answers: { codecraft: "no", xpress: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(r.provider).toBe("xpress")
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["xpress"])
    expect(t.save).toHaveBeenCalledTimes(2)
  })

  it("approved send fails (insufficient balance), next approved supplier is used", async () => {
    const t = mk({ answers: { codecraft: "yes", xpress: "yes" }, sends: { codecraft: fail("insufficient balance") } })
    const r = await strictSend(order, t.deps)
    expect(r.success).toBe(true)
    expect(r.provider).toBe("xpress")
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["codecraft", "xpress"])
  })

  it("approved send fails and the other said no: normal failure, not held", async () => {
    const t = mk({ answers: { codecraft: "yes", xpress: "no" }, sends: { codecraft: fail("insufficient balance") } })
    const r = await strictSend(order, t.deps)
    expect(r.success).toBe(false)
    expect(r.held).toBeUndefined()
    expect(r.error_type).not.toBe("STRICT_HOLD")
    expect(r.message).toBe("insufficient balance")
  })

  it("every candidate said no: STRICT_HOLD rejected", async () => {
    const t = mk({ answers: { codecraft: "no", xpress: "no" } })
    const r = await strictSend(order, t.deps)
    expect(r).toMatchObject({ success: false, held: true, error_type: "STRICT_HOLD", strictHoldReason: "rejected" })
    expect(t.send).not.toHaveBeenCalled()
  })

  it("one no_answer: STRICT_HOLD unanswered and not saved", async () => {
    const t = mk({ answers: { codecraft: "no", xpress: "no_answer" } })
    const r = await strictSend(order, t.deps)
    expect(r).toMatchObject({ held: true, error_type: "STRICT_HOLD", strictHoldReason: "unanswered" })
    expect(t.save).toHaveBeenCalledTimes(1)
  })

  it("OUTCOME_UNKNOWN stops the sequence", async () => {
    const t = mk({ answers: { codecraft: "yes", xpress: "yes" }, sends: { codecraft: fail("maybe", "OUTCOME_UNKNOWN") } })
    const r = await strictSend(order, t.deps)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["codecraft"])
  })

  it("pinned approved: sent", async () => {
    const t = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(r.provider).toBe("xpress")
  })

  it("pinned no: SUPPLIER_NOT_APPROVED, nobody else asked or sent", async () => {
    const t = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "no", codecraft: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("SUPPLIER_NOT_APPROVED")
    expect(r.held).toBeUndefined()
    expect(r.message).not.toContain("0551234567")
    expect(t.ask.mock.calls.map((c) => c[0])).toEqual(["xpress"])
    expect(t.send).not.toHaveBeenCalled()
  })

  it("pinned no_answer: SUPPLIER_CHECK_UNAVAILABLE", async () => {
    const t = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "no_answer" } })
    const r = await strictSend(order, t.deps)
    expect(r.error_type).toBe("SUPPLIER_CHECK_UNAVAILABLE")
    expect(t.send).not.toHaveBeenCalled()
  })

  it("pinned disabled or without a check: SUPPLIER_CHECK_UNAVAILABLE, no ask, no send", async () => {
    for (const t of [
      mk({ candidates: ["xpress"], pinned: true, disabled: new Set(["xpress"]) }),
      mk({ candidates: ["sykes"], pinned: true }),
    ]) {
      const r = await strictSend(order, t.deps)
      expect(r.error_type).toBe("SUPPLIER_CHECK_UNAVAILABLE")
      expect(t.ask).not.toHaveBeenCalled()
      expect(t.send).not.toHaveBeenCalled()
    }
  })

  it("pinned supplier with no check at all: says it can't check numbers (not 'right now')", async () => {
    for (const t of [
      mk({ candidates: ["sykes"], pinned: true }),
      mk({ candidates: ["xpress"], pinned: true, disabled: new Set(["xpress"]) }),
    ]) {
      const r = await strictSend(order, t.deps)
      expect(r.error_type).toBe("SUPPLIER_CHECK_UNAVAILABLE")
      expect(r.message).toMatch(/ can't check numbers, so it can't receive MTN orders in strict mode$/)
      expect(r.message).not.toContain("right now")
    }
  })

  it("pinned no_answer keeps the 'couldn't check this number right now' message", async () => {
    const t = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "no_answer" } })
    const r = await strictSend(order, t.deps)
    expect(r.message).toMatch(/ couldn't check this number right now$/)
  })

  it("a throwing send logs the error class only (no message, no phone)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const u = mk({ answers: { codecraft: "yes" } })
      u.send.mockRejectedValueOnce(new TypeError("fetch failed for 0551234567"))
      await strictSend(order, u.deps)
      const logged = spy.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
      expect(logged).toContain("TypeError")
      expect(logged).not.toContain("0551234567")
      expect(logged).not.toContain("fetch failed")
    } finally {
      spy.mockRestore()
    }
  })

  it("pinned approved send fails: that failure is returned, nobody else tried", async () => {
    const t = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "yes" }, sends: { xpress: fail("down") } })
    const r = await strictSend(order, t.deps)
    expect(r.message).toBe("down")
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it("supplier without a check in the sequence is skipped", async () => {
    const t = mk({ candidates: ["sykes", "xpress"], answers: { xpress: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(r.provider).toBe("xpress")
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["xpress"])
    expect(t.ask.mock.calls.map((c) => c[0])).toEqual(["xpress"])
  })

  it("fresh saved yes: no ask call; fresh saved no: skipped without ask", async () => {
    const t = mk({})
    t.fresh.mockResolvedValue(new Map([["codecraft", "no"], ["xpress", "yes"]]) as any)
    const r = await strictSend(order, t.deps)
    expect(r.provider).toBe("xpress")
    expect(t.ask).not.toHaveBeenCalled()
    expect(t.save).not.toHaveBeenCalled()
  })

  it("budget used up: remaining candidates are no_answer", async () => {
    const t = mk({ budgetMs: 0, answers: { codecraft: "yes" } })
    const r = await strictSend(order, t.deps)
    expect(t.ask).not.toHaveBeenCalled()
    expect(r).toMatchObject({ held: true, strictHoldReason: "unanswered" })
  })

  it("a throwing ask never escapes", async () => {
    const t = mk({})
    t.ask.mockRejectedValue(new Error("x"))
    const r = await strictSend(order, t.deps)
    expect(r.strictHoldReason).toBe("unanswered")
  })

  it("a throwing send is OUTCOME_UNKNOWN and stops: nobody else is sent", async () => {
    const u = mk({ answers: { codecraft: "yes", xpress: "yes" } })
    u.send.mockRejectedValueOnce(new Error("net"))
    const r = await strictSend(order, u.deps)
    expect(r).toMatchObject({ success: false, error_type: "OUTCOME_UNKNOWN", provider: "codecraft" })
    expect(r.held).toBeUndefined()
    expect(u.send).toHaveBeenCalledTimes(1)
  })

  it("a throwing pinned send is OUTCOME_UNKNOWN", async () => {
    const u = mk({ candidates: ["xpress"], pinned: true, answers: { xpress: "yes" } })
    u.send.mockRejectedValueOnce(new Error("timeout"))
    const r = await strictSend(order, u.deps)
    expect(r).toMatchObject({ success: false, error_type: "OUTCOME_UNKNOWN", provider: "xpress" })
    expect(u.send).toHaveBeenCalledTimes(1)
  })

  it("unpinned: uncheckable suppliers are skipped and do not make the hold 'unanswered'", async () => {
    for (const t of [
      mk({ candidates: ["codecraft", "sykes"], answers: { codecraft: "no" } }),
      mk({ candidates: ["codecraft", "xpress"], disabled: new Set(["xpress"]), answers: { codecraft: "no" } }),
    ]) {
      const r = await strictSend(order, t.deps)
      expect(r).toMatchObject({ held: true, error_type: "STRICT_HOLD", strictHoldReason: "rejected" })
      expect(t.send).not.toHaveBeenCalled()
      expect(t.ask.mock.calls.map((c) => c[0])).toEqual(["codecraft"])
    }
  })

  it("unpinned: no checkable candidate at all holds as 'rejected'", async () => {
    const t = mk({ candidates: ["sykes", "xpress"], disabled: new Set(["xpress"]) })
    const r = await strictSend(order, t.deps)
    expect(r).toMatchObject({ held: true, error_type: "STRICT_HOLD", strictHoldReason: "rejected" })
    expect(t.ask).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
  })

  it("unpinned: a checkable no_answer still makes the hold 'unanswered' beside an uncheckable one", async () => {
    const t = mk({ candidates: ["sykes", "codecraft"], answers: { codecraft: "no_answer" } })
    const r = await strictSend(order, t.deps)
    expect(r).toMatchObject({ held: true, strictHoldReason: "unanswered" })
  })
})
