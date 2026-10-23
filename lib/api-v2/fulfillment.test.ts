import { describe, it, expect, vi } from "vitest"
import { dispatchFulfillment, scheduleFulfillment, scheduleFulfillmentBatch, type FulfillmentDeps } from "./fulfillment"

function makeDeps(over: Partial<FulfillmentDeps> = {}) {
  const deps = {
    isMtnAuto: vi.fn(async () => true),
    createMtnOrder: vi.fn(async () => ({ success: true, order_id: 555, message: "ok", provider: "sykes" })),
    saveMtnTracking: vi.fn(async () => {}),
    holdMtnOrder: vi.fn(async () => ({ held: true })),
    markProcessing: vi.fn(async () => {}),
    createNonMtnOrder: vi.fn(async () => ({ success: true, message: "ok", provider: "x" })),
    ...over,
  }
  return deps as FulfillmentDeps & { [K in keyof FulfillmentDeps]: ReturnType<typeof vi.fn> }
}

const base = { orderId: "ord-1", dbNetwork: "MTN", gb: 2, msisdn: "233249990204", local: "0249990204" }

describe("dispatchFulfillment: MTN", () => {
  it("creates the provider order with client_ref = orderId, saves tracking, marks processing on success", async () => {
    const d = makeDeps()
    const r = await dispatchFulfillment(d, base)
    expect(r).toEqual({ attempted: true, outcome: "mtn" })
    expect(d.createMtnOrder).toHaveBeenCalledTimes(1)
    expect(d.createMtnOrder).toHaveBeenCalledWith({
      recipient_phone: "0249990204",
      network: "MTN",
      size_gb: 2,
      client_ref: "ord-1",
    })
    expect(d.saveMtnTracking).toHaveBeenCalledTimes(1)
    const [orderId, mtnOrderId, req, resp, provider] = (d.saveMtnTracking as any).mock.calls[0]
    expect(orderId).toBe("ord-1")
    expect(mtnOrderId).toBe(555)
    expect(req.client_ref).toBe("ord-1")
    expect(resp.success).toBe(true)
    expect(provider).toBe("sykes")
    expect(d.markProcessing).toHaveBeenCalledWith("ord-1")
    expect(d.holdMtnOrder).not.toHaveBeenCalled()
  })

  it("defaults the provider to sykes like v1", async () => {
    const d = makeDeps({ createMtnOrder: vi.fn(async () => ({ success: true, order_id: 9, message: "ok" })) as any })
    await dispatchFulfillment(d, base)
    expect((d.saveMtnTracking as any).mock.calls[0][4]).toBe("sykes")
  })

  it("holds (and neither tracks nor marks processing) when the provider says held", async () => {
    const d = makeDeps({ createMtnOrder: vi.fn(async () => ({ success: false, held: true, message: "held" })) as any })
    const r = await dispatchFulfillment(d, base)
    expect(r.outcome).toBe("mtn")
    expect(d.holdMtnOrder).toHaveBeenCalledWith({ orderId: "ord-1", phone: "0249990204" })
    expect(d.saveMtnTracking).not.toHaveBeenCalled()
    expect(d.markProcessing).not.toHaveBeenCalled()
  })

  it("saves tracking but does not mark processing when the provider order failed", async () => {
    const d = makeDeps({ createMtnOrder: vi.fn(async () => ({ success: false, order_id: 7, message: "no" })) as any })
    await dispatchFulfillment(d, base)
    expect(d.saveMtnTracking).toHaveBeenCalledTimes(1)
    expect(d.markProcessing).not.toHaveBeenCalled()
  })

  it("does nothing when the provider returns neither held nor an order id", async () => {
    const d = makeDeps({ createMtnOrder: vi.fn(async () => ({ success: false, message: "no" })) as any })
    await dispatchFulfillment(d, base)
    expect(d.saveMtnTracking).not.toHaveBeenCalled()
    expect(d.holdMtnOrder).not.toHaveBeenCalled()
    expect(d.markProcessing).not.toHaveBeenCalled()
  })

  it("skips when MTN auto-fulfilment is off", async () => {
    const d = makeDeps({ isMtnAuto: vi.fn(async () => false) })
    const r = await dispatchFulfillment(d, base)
    expect(r).toEqual({ attempted: false, outcome: "skipped" })
    expect(d.createMtnOrder).not.toHaveBeenCalled()
  })
})

describe("dispatchFulfillment: non-MTN", () => {
  it.each([
    ["Telecel", "telecel"],
    ["AT - iShare", "at - ishare"],
    ["AT - BigTime", "at - bigtime"],
  ])("%s calls createNonMtnOrder with the lower-cased network and orderType api", async (dbNetwork, key) => {
    const d = makeDeps()
    const r = await dispatchFulfillment(d, { ...base, dbNetwork })
    expect(r).toEqual({ attempted: true, outcome: "non_mtn" })
    expect(d.createNonMtnOrder).toHaveBeenCalledWith({
      phoneNumber: "0249990204",
      sizeGb: 2,
      orderId: "ord-1",
      network: key,
      orderType: "api",
    })
    expect(d.createMtnOrder).not.toHaveBeenCalled()
    expect(d.isMtnAuto).not.toHaveBeenCalled()
  })

  it("skips networks v1 does not auto-fulfil", async () => {
    const d = makeDeps()
    const r = await dispatchFulfillment(d, { ...base, dbNetwork: "Vodafone" })
    expect(r).toEqual({ attempted: false, outcome: "skipped" })
    expect(d.createNonMtnOrder).not.toHaveBeenCalled()
    expect(d.createMtnOrder).not.toHaveBeenCalled()
  })
})

describe("dispatchFulfillment: safety", () => {
  it("never rethrows: MTN provider error", async () => {
    const d = makeDeps({ createMtnOrder: vi.fn(async () => { throw new Error("provider down") }) as any })
    await expect(dispatchFulfillment(d, base)).resolves.toEqual({ attempted: true, outcome: "error" })
  })
  it("never rethrows: non-MTN provider error", async () => {
    const d = makeDeps({ createNonMtnOrder: vi.fn(async () => { throw new Error("x") }) as any })
    await expect(dispatchFulfillment(d, { ...base, dbNetwork: "Telecel" })).resolves.toEqual({ attempted: true, outcome: "error" })
  })
  it("never rethrows: auto flag lookup error", async () => {
    const d = makeDeps({ isMtnAuto: vi.fn(async () => { throw new Error("db") }) as any })
    await expect(dispatchFulfillment(d, base)).resolves.toEqual({ attempted: false, outcome: "error" })
  })
  it("never rethrows: tracking save error", async () => {
    const d = makeDeps({ saveMtnTracking: vi.fn(async () => { throw new Error("db") }) as any })
    await expect(dispatchFulfillment(d, base)).resolves.toMatchObject({ outcome: "error" })
  })
  it("has no hidden state: two calls hit providers twice", async () => {
    const d = makeDeps()
    await dispatchFulfillment(d, base)
    await dispatchFulfillment(d, base)
    expect(d.createMtnOrder).toHaveBeenCalledTimes(2)
  })
})

describe("scheduleFulfillment", () => {
  const target = { orderId: "ord-9", dbNetwork: "Telecel", gb: 1, msisdn: "233249990304", local: "0249990304" }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it("uses after() when available and runs the dispatch inside it", async () => {
    const d = makeDeps()
    let captured: (() => Promise<void>) | undefined
    const afterFn = vi.fn((cb: () => Promise<void>) => { captured = cb })
    expect(scheduleFulfillment(target, afterFn, () => d)).toBeUndefined()
    expect(afterFn).toHaveBeenCalledTimes(1)
    expect(d.createNonMtnOrder).not.toHaveBeenCalled()
    await captured!()
    expect(d.createNonMtnOrder).toHaveBeenCalledTimes(1)
  })

  it("falls back to an inline dispatch when after() throws", async () => {
    const d = makeDeps()
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    scheduleFulfillment(target, () => { throw new Error("outside request scope 0249990304") }, () => d)
    await flush()
    expect(d.createNonMtnOrder).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toMatch(/[0-9]{9,}/)
    expect(logged).not.toContain("outside request scope")
    spy.mockRestore()
  })

  it("a rejecting dispatch causes no unhandled rejection and logs no message", async () => {
    const d = makeDeps({ createNonMtnOrder: vi.fn(async () => { throw new Error("boom 0249990304") }) as any })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    scheduleFulfillment(target, () => { throw new Error("x") }, () => d)
    scheduleFulfillment(target, (cb) => { void cb() }, () => d)
    await flush()
    await flush()
    process.off("unhandledRejection", unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toMatch(/[0-9]{9,}/)
    expect(logged).not.toContain("boom")
    spy.mockRestore()
  })

  it("a throwing deps factory is contained", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    scheduleFulfillment(target, (cb) => { void cb() }, () => { throw new Error("bad") })
    await flush()
    spy.mockRestore()
  })
})

describe("scheduleFulfillmentBatch (bulk: one after() callback, bounded concurrency)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const targets = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      orderId: `ord-${i}`,
      dbNetwork: "Telecel",
      gb: 1,
      msisdn: `2332499905${String(i).padStart(2, "0")}`,
      local: `02499905${String(i).padStart(2, "0")}`,
    }))

  /** Deps whose provider call stays open until the test releases it. */
  function gatedDeps() {
    let inFlight = 0
    let maxInFlight = 0
    const releases: Array<() => void> = []
    const started: string[] = []
    const d = makeDeps({
      createNonMtnOrder: vi.fn(async (req: any) => {
        started.push(req.orderId)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => releases.push(resolve))
        inFlight--
        return { success: true }
      }) as any,
    })
    return { d, releases, started, stats: () => ({ inFlight, maxInFlight }) }
  }

  it("registers ONE after() callback, runs at most 4 at a time, and dispatches all 10", async () => {
    const g = gatedDeps()
    let captured: (() => Promise<void>) | undefined
    const afterFn = vi.fn((cb: () => Promise<void>) => { captured = cb })
    expect(scheduleFulfillmentBatch(targets(10), { concurrency: 4 }, afterFn, () => g.d)).toBeUndefined()
    expect(afterFn).toHaveBeenCalledTimes(1)
    expect(g.started).toEqual([])

    const done = captured!()
    await flush()
    expect(g.stats().inFlight).toBe(4)
    // Release one at a time: the pool refills to 4 and never exceeds it.
    while (g.started.length < 10 || g.stats().inFlight > 0) {
      const next = g.releases.shift()
      if (!next) break
      next()
      await flush()
      expect(g.stats().inFlight).toBeLessThanOrEqual(4)
    }
    await done
    expect(g.stats().maxInFlight).toBe(4)
    expect(g.d.createNonMtnOrder).toHaveBeenCalledTimes(10)
    expect([...g.started].sort()).toEqual(targets(10).map((t) => t.orderId).sort())
  })

  it("a failing target does not stop the rest; nothing rejects; logs carry no number or message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const calls: string[] = []
    const d = makeDeps({
      createNonMtnOrder: vi.fn(async (req: any) => {
        calls.push(req.orderId)
        if (req.orderId === "ord-1") throw new Error("boom 0249990501")
        return { success: true }
      }) as any,
    })
    let captured: (() => Promise<void>) | undefined
    scheduleFulfillmentBatch(targets(5), { concurrency: 4 }, (cb) => { captured = cb }, () => d)
    await expect(captured!()).resolves.toBeUndefined()
    expect(calls.sort()).toEqual(["ord-0", "ord-1", "ord-2", "ord-3", "ord-4"])
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toMatch(/[0-9]{9,}/)
    expect(logged).not.toContain("boom")
    spy.mockRestore()
  })

  it("a throwing deps factory fails every target without throwing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    let captured: (() => Promise<void>) | undefined
    scheduleFulfillmentBatch(targets(3), { concurrency: 4 }, (cb) => { captured = cb }, () => { throw new Error("bad") })
    await expect(captured!()).resolves.toBeUndefined()
    spy.mockRestore()
  })

  it("an empty list does nothing (no after() registration)", () => {
    const afterFn = vi.fn()
    const factory = vi.fn(() => makeDeps())
    scheduleFulfillmentBatch([], { concurrency: 4 }, afterFn, factory)
    expect(afterFn).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
  })

  it("falls back to an inline (still bounded) dispatch when after() throws, with no unhandled rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    const d = makeDeps()
    scheduleFulfillmentBatch(targets(6), { concurrency: 4 }, () => { throw new Error("outside request scope 0249990501") }, () => d)
    for (let i = 0; i < 5; i++) await flush()
    process.off("unhandledRejection", unhandled)
    expect(d.createNonMtnOrder).toHaveBeenCalledTimes(6)
    expect(unhandled).not.toHaveBeenCalled()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toMatch(/[0-9]{9,}/)
    expect(logged).not.toContain("outside request scope")
    spy.mockRestore()
  })

  it("concurrency below 1 is treated as 1", async () => {
    const g = gatedDeps()
    let captured: (() => Promise<void>) | undefined
    scheduleFulfillmentBatch(targets(3), { concurrency: 0 }, (cb) => { captured = cb }, () => g.d)
    const done = captured!()
    await flush()
    expect(g.stats().inFlight).toBe(1)
    while (g.releases.length) {
      g.releases.shift()!()
      await flush()
    }
    await done
    expect(g.stats().maxInFlight).toBe(1)
    expect(g.d.createNonMtnOrder).toHaveBeenCalledTimes(3)
  })
})
