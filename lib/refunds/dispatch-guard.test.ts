const rpc = vi.fn()
const clientState = vi.hoisted(() => ({ throwOnCreate: false }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    if (clientState.throwOnCreate) throw new Error("supabaseUrl is required.")
    return { rpc: (...a: unknown[]) => rpc(...a) }
  },
}))
import { withDispatchGuard } from "./dispatch-guard"

const blocked = { success: false, message: "refunded" }
beforeEach(() => {
  rpc.mockReset()
  clientState.throwOnCreate = false
})

describe("withDispatchGuard", () => {
  it("skips the guard entirely when there is no order id", async () => {
    const run = vi.fn(async () => ({ success: true, message: "ok" }))
    expect(await withDispatchGuard(undefined, run, blocked)).toEqual({ success: true, message: "ok" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("does not run the dispatch when the claim is refused", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null })
    const run = vi.fn()
    expect(await withDispatchGuard("o1", run, blocked)).toBe(blocked)
    expect(run).not.toHaveBeenCalled()
  })

  it("records submitted on success and failed on a clean failure", async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await withDispatchGuard("o1", async () => ({ success: true, message: "" }), blocked)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "submitted" })
    await withDispatchGuard("o1", async () => ({ success: false, message: "" }), blocked)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "failed" })
  })

  it("records unknown and rethrows when the dispatch throws", async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(withDispatchGuard("o1", async () => { throw new Error("boom") }, blocked)).rejects.toThrow("boom")
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "unknown" })
  })

  it.each([
    ["PostgREST missing function", { code: "PGRST202", message: "Could not find the function public.claim_order_dispatch" }],
    ["SQLSTATE 42883", { code: "42883", message: "function claim_order_dispatch(uuid) does not exist" }],
    ["message-only does not exist", { message: "function public.claim_order_dispatch does not exist" }],
    ["unrecognised error", { code: "XX000", message: "something odd" }],
  ])("fails OPEN on %s", async (_n, err) => {
    rpc.mockResolvedValueOnce({ data: null, error: err })
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalled()
  })

  it.each([
    ["statement timeout 57014", { code: "57014", message: "canceling statement due to statement timeout" }],
    ["lock not available 55P03", { code: "55P03", message: "could not obtain lock" }],
    ["message-only canceling statement", { message: "canceling statement due to statement timeout" }],
    ["message-only lock timeout", { message: "canceling statement due to lock timeout" }],
  ])("fails CLOSED on %s", async (_n, err) => {
    rpc.mockResolvedValueOnce({ data: null, error: err })
    const run = vi.fn()
    expect(await withDispatchGuard("o1", run, blocked)).toBe(blocked)
    expect(run).not.toHaveBeenCalled()
  })

  it("fails OPEN on a plain network error (TypeError from fetch)", async () => {
    rpc.mockRejectedValueOnce(new TypeError("fetch failed"))
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "submitted" })
  })

  it("fails OPEN on a TypeError returned as an rpc error object", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "TypeError: fetch failed" } })
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("never lets an outcome-recording failure break the dispatch result", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
    rpc.mockRejectedValueOnce(new Error("network"))
    expect(await withDispatchGuard("o1", async () => ({ success: true, message: "ok" }), blocked)).toEqual({ success: true, message: "ok" })
  })

  it("fails OPEN and still records the outcome when the claim RPC rejects with an unrecognised error", async () => {
    rpc.mockRejectedValueOnce(new Error("weird"))
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "submitted" })
  })

  it("fails CLOSED (blocked, no dispatch) when the claim never resolves within 10s", async () => {
    vi.useFakeTimers()
    try {
      rpc.mockReturnValueOnce(new Promise(() => {}))
      const run = vi.fn(async () => ({ success: true, message: "" }))
      const p = withDispatchGuard("o1", run, blocked)
      await vi.advanceTimersByTimeAsync(9000)
      expect(run).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1500)
      expect(await p).toBe(blocked)
      expect(run).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not hang the result when recording the outcome never resolves", async () => {
    vi.useFakeTimers()
    try {
      rpc.mockResolvedValueOnce({ data: true, error: null })
      rpc.mockReturnValueOnce(new Promise(() => {}))
      const p = withDispatchGuard("o1", async () => ({ success: true, message: "ok" }), blocked)
      await vi.advanceTimersByTimeAsync(10100)
      expect(await p).toEqual({ success: true, message: "ok" })
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails open and runs the dispatch once when the client cannot be created", async () => {
    vi.resetModules()
    clientState.throwOnCreate = true
    const { withDispatchGuard: guard } = await import("./dispatch-guard")
    const run = vi.fn(async () => ({ success: true, message: "ok" }))
    expect(await guard("o1", run, blocked)).toEqual({ success: true, message: "ok" })
    expect(run).toHaveBeenCalledTimes(1)
    expect(rpc).not.toHaveBeenCalled()
  })
})
