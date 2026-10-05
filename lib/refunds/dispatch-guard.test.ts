const rpc = vi.fn()
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }))
import { withDispatchGuard } from "./dispatch-guard"

const blocked = { success: false, message: "refunded" }
beforeEach(() => rpc.mockReset())

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
})
