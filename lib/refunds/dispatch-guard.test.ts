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

  it("fails open when the claim RPC errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "function does not exist" } })
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalled()
  })

  it("never lets an outcome-recording failure break the dispatch result", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
    rpc.mockRejectedValueOnce(new Error("network"))
    expect(await withDispatchGuard("o1", async () => ({ success: true, message: "ok" }), blocked)).toEqual({ success: true, message: "ok" })
  })

  it("fails open and still records the outcome when the claim RPC rejects", async () => {
    rpc.mockRejectedValueOnce(new Error("network"))
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "submitted" })
  })

  it("fails open after the timeout when the claim RPC never resolves", async () => {
    vi.useFakeTimers()
    try {
      rpc.mockReturnValueOnce(new Promise(() => {}))
      rpc.mockResolvedValue({ data: null, error: null })
      const run = vi.fn(async () => ({ success: true, message: "" }))
      const p = withDispatchGuard("o1", run, blocked)
      await vi.advanceTimersByTimeAsync(3100)
      await p
      expect(run).toHaveBeenCalledTimes(1)
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
      await vi.advanceTimersByTimeAsync(3100)
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
