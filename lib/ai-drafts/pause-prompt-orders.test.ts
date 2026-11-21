import { describe, it, expect, vi } from "vitest"
import { selectPromptOrderTasks, maskPrompt, chunk, planNotifications, runPause, PauseChunkError, type PauseTask } from "./pause-prompt-orders"

const t = (o: Partial<PauseTask>): PauseTask => ({
  id: "t1", user_id: "u1", schedule_type: "daily", prompt: "Buy 1GB data daily",
  is_active: true, context: "dashboard", standing_order: null, ...o,
})

describe("selectPromptOrderTasks", () => {
  it("keeps only active dashboard order prompts without a standing order", () => {
    const rows = [
      t({ id: "a" }),
      t({ id: "b", is_active: false }),
      t({ id: "c", context: "admin" }),
      t({ id: "d", standing_order: { x: 1 } }),
      t({ id: "e", prompt: "my balance please" }),
    ]
    expect(selectPromptOrderTasks(rows).map(r => r.id)).toEqual(["a"])
  })
})

describe("maskPrompt", () => {
  it("masks phone digit runs and emails, then truncates to 60", () => {
    expect(maskPrompt("Buy 1GB for 0241234567 daily")).toBe("Buy 1GB for 024*****67 daily")
    expect(maskPrompt("Buy data for 233241234567")).not.toMatch(/\d{9}/)
    expect(maskPrompt("mail me at a@b.com about data")).not.toContain("a@b.com")
    const long = maskPrompt("Buy data " + "x".repeat(100) + " 0241234567")
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).not.toContain("0241234567")
  })
})

describe("chunk", () => {
  it("splits into groups of at most n", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 100)).toEqual([])
  })
})

describe("planNotifications", () => {
  it("groups by owner with the first task id", () => {
    const plan = planNotifications([t({ id: "a", user_id: "u1" }), t({ id: "b", user_id: "u1" }), t({ id: "c", user_id: "u2" })])
    expect(plan).toEqual([
      { userId: "u1", url: "/dashboard?ai=reapprove&task=a" },
      { userId: "u2", url: "/dashboard?ai=reapprove&task=c" },
    ])
  })
})

describe("runPause", () => {
  const rows = Array.from({ length: 250 }, (_, i) => t({ id: `id${i}`, user_id: `u${i % 3}` }))

  it("dry run changes nothing", async () => {
    const deps = { deactivate: vi.fn(), push: vi.fn() }
    const r = await runPause(rows, false, deps)
    expect(r).toEqual({ matched: 250, paused: 0, notified: 0, pushFailures: 0 })
    expect(deps.deactivate).not.toHaveBeenCalled()
    expect(deps.push).not.toHaveBeenCalled()
  })

  it("apply chunks to <=100 ids and sends one push per owner", async () => {
    const deps = { deactivate: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue({ sent: 1 }) }
    const r = await runPause(rows, true, deps)
    expect(deps.deactivate.mock.calls.map(c => c[0].length)).toEqual([100, 100, 50])
    expect(deps.push).toHaveBeenCalledTimes(3)
    expect(deps.push.mock.calls[0][1]).toEqual({
      title: "Your scheduled order is paused",
      body: "Data orders now need your confirmation. Tap to set it up again.",
      data: { url: "/dashboard?ai=reapprove&task=id0" },
    })
    expect(r).toEqual({ matched: 250, paused: 250, notified: 3, pushFailures: 0 })
  })

  it("counts push failures (throw or zero sent) without aborting", async () => {
    const deps = {
      deactivate: vi.fn().mockResolvedValue(undefined),
      push: vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ sent: 0 }).mockResolvedValue({ sent: 1 }),
    }
    const r = await runPause(rows, true, deps)
    expect(r.paused).toBe(250)
    expect(r.pushFailures).toBe(2)
    expect(r.notified).toBe(1)
  })

  it("only notifies owners of chunks that were paused", async () => {
    const deps = { deactivate: vi.fn().mockRejectedValue(new Error("db")), push: vi.fn() }
    await expect(runPause(rows, true, deps)).rejects.toThrow("db")
    expect(deps.push).not.toHaveBeenCalled()
  })
})

describe("runPause chunk failure", () => {
  it("chunk_failure_notifies_already_paused_owners", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => t({ id: `id${i}`, user_id: `u${i % 3}` }))
    const deactivate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("db"))
    const push = vi.fn().mockResolvedValue({ sent: 1 })
    const err = await runPause(rows, true, { deactivate, push }).catch(e => e)
    expect(err).toBeInstanceOf(PauseChunkError)
    expect(err.pausedIds).toHaveLength(100)
    expect(err.failedIds).toHaveLength(100)
    expect(err.failedIds[0]).toBe("id100")
    // first chunk's three owners were notified before the failure, once each
    expect(push.mock.calls.map(c => c[0]).sort()).toEqual(["u0", "u1", "u2"])
    expect(err.result.notified).toBe(3)
  })

  it("does not notify an owner again in a later chunk", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => t({ id: `id${i}`, user_id: `u${i % 3}` }))
    const push = vi.fn().mockResolvedValue({ sent: 1 })
    await runPause(rows, true, { deactivate: vi.fn().mockResolvedValue(undefined), push })
    expect(push).toHaveBeenCalledTimes(3)
  })
})
