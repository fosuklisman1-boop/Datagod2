import { describe, it, expect, vi } from "vitest"
import { dispatchFulfillment, type FulfillmentDeps } from "./fulfillment"

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
