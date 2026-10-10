import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel",
  hubtelCfg: { clientId: "a", clientSecret: "b" } as unknown,
  simple: vi.fn(),
  personalized: vi.fn(),
  moolre: vi.fn(),
  outOfFunds: vi.fn(() => Promise.resolve()),
}))
vi.mock("./routing", () => ({ getRoutingConfig: () => Promise.resolve({ primary: h.primary, fallbacks: [] }) }))
vi.mock("./providers/hubtel", async (orig) => ({
  ...(await orig<typeof import("./providers/hubtel")>()),
  hubtelConfigFromEnv: () => h.hubtelCfg,
  hubtelSendBatchSimple: h.simple,
  hubtelSendBatchPersonalized: h.personalized,
}))
vi.mock("@/lib/sms-service", () => ({ sendSMSBulkViaMoolre: h.moolre, platformSenderName: () => "PLATFORM" }))
vi.mock("./notify", () => ({ notifyHubtelOutOfFunds: h.outOfFunds }))

import { dispatchCampaign } from "./campaign-dispatch"

const items = (n: number, text = "hi") =>
  Array.from({ length: n }, (_, i) => ({ id: `id${i}`, phone: `+233240${String(i).padStart(6, "0")}`, message: text }))
const accepted = (its: { phone: string }[], batchId = "b1") => ({
  outcome: "accepted", httpStatus: 200, bodyStatus: 0, batchId,
  messages: its.map((x, i) => ({ recipient: x.phone.replace("+", ""), messageId: `m${i}` })),
})

beforeEach(() => {
  h.primary = "hubtel"; h.hubtelCfg = { clientId: "a", clientSecret: "b" }
  h.simple.mockReset(); h.personalized.mockReset(); h.moolre.mockReset(); h.outOfFunds.mockClear()
})

describe("dispatchCampaign", () => {
  it("hubtel primary: one simple batch per 100, ids mapped", async () => {
    h.simple.mockImplementation(async (_c: unknown, m: { recipients: string[] }) => accepted(m.recipients.map((r) => ({ phone: r }))))
    const r = await dispatchCampaign(items(150), null)
    expect(h.simple).toHaveBeenCalledTimes(2)
    expect(h.simple.mock.calls[0][1].from).toBe("PLATFORM")
    expect(r.provider).toBe("hubtel")
    expect(r.sent).toHaveLength(150)
    expect(r.sent[0]).toEqual({ id: "id0", mid: "m0", bid: "b1" })
  })
  it("differing texts use the personalized endpoint", async () => {
    h.personalized.mockResolvedValue(accepted([]))
    await dispatchCampaign([{ id: "a", phone: "+233240000001", message: "Hi A" }, { id: "b", phone: "+233240000002", message: "Hi B" }], "KINGS")
    expect(h.personalized).toHaveBeenCalledOnce()
    expect(h.personalized.mock.calls[0][1].from).toBe("KINGS")
  })
  it("platform sender: rejected chunk falls back to Moolre", async () => {
    h.simple.mockResolvedValue({ outcome: "rejected", httpStatus: 400, bodyStatus: 4, messages: [] })
    h.moolre.mockResolvedValue({ ok: true })
    const r = await dispatchCampaign(items(3), null)
    expect(h.moolre).toHaveBeenCalledOnce()
    expect(r.fallbackSent.map((s) => s.id)).toEqual(["id0", "id1", "id2"])
  })
  it("platform sender: retryable chunk falls back to Moolre", async () => {
    h.simple.mockResolvedValue({ outcome: "retryable", httpStatus: 503, bodyStatus: null, messages: [] })
    h.moolre.mockResolvedValue({ ok: true })
    const r = await dispatchCampaign(items(2), null)
    expect(r.fallbackSent).toHaveLength(2)
  })
  it("custom sender: rejected chunk stays pending (no Moolre)", async () => {
    h.simple.mockResolvedValue({ outcome: "retryable", httpStatus: 502, bodyStatus: null, messages: [] })
    const r = await dispatchCampaign(items(3), "KINGS")
    expect(h.moolre).not.toHaveBeenCalled()
    expect(r.sent).toEqual([])
    expect(r.fallbackSent).toEqual([])
  })
  it("out of funds stops further chunks and alerts", async () => {
    h.simple.mockResolvedValue({ outcome: "out_of_funds", httpStatus: 402, bodyStatus: null, messages: [] })
    const r = await dispatchCampaign(items(250), null)
    expect(h.simple).toHaveBeenCalledOnce()
    expect(r.outOfFunds).toBe(true)
    expect(h.outOfFunds).toHaveBeenCalled()
    expect(h.moolre).not.toHaveBeenCalled()
  })
  it("hubtel not primary → today's Moolre bulk", async () => {
    h.primary = "moolre"
    h.moolre.mockResolvedValue({ ok: true })
    const r = await dispatchCampaign(items(3), "KINGS")
    expect(h.simple).not.toHaveBeenCalled()
    expect(r.provider).toBe("moolre")
    expect(r.sent.map((s) => s.id)).toEqual(["id0", "id1", "id2"])
  })
  it("unknown outcome on a platform-sender chunk: counted sent (no ids), callback flagged unconfirmed, Moolre NOT called", async () => {
    h.simple.mockResolvedValue({ outcome: "unknown", httpStatus: 0, bodyStatus: null, messages: [] })
    const cb = vi.fn(() => Promise.resolve())
    const r = await dispatchCampaign(items(3), null, cb)
    expect(cb).toHaveBeenCalledWith("hubtel", expect.any(Array), { unconfirmed: true })
    expect(h.moolre).not.toHaveBeenCalled()
    expect(r.sent).toEqual([
      { id: "id0", mid: null, bid: null },
      { id: "id1", mid: null, bid: null },
      { id: "id2", mid: null, bid: null },
    ])
    expect(r.fallbackSent).toEqual([])
  })
  it("onChunkSent is awaited once per placed chunk with the right provider", async () => {
    h.simple
      .mockImplementationOnce(async (_c: unknown, m: { recipients: string[] }) => accepted(m.recipients.map((x) => ({ phone: x }))))
      .mockResolvedValueOnce({ outcome: "rejected", httpStatus: 400, bodyStatus: 4, messages: [] })
      .mockResolvedValueOnce({ outcome: "unknown", httpStatus: 0, bodyStatus: null, messages: [] })
    h.moolre.mockResolvedValue({ ok: true })
    const cb = vi.fn(() => Promise.resolve())
    await dispatchCampaign(items(250), null, cb)
    expect(cb).toHaveBeenCalledTimes(3)
    expect(cb.mock.calls.map((c: unknown[]) => c[0])).toEqual(["hubtel", "moolre", "hubtel"])
    expect((cb.mock.calls[0] as unknown[])[1]).toHaveLength(100)
    expect(cb.mock.calls.map((c: unknown[]) => (c[2] as { unconfirmed: boolean }).unconfirmed)).toEqual([false, false, true])
  })
  it("onChunkSent errors are swallowed; dispatch continues", async () => {
    h.simple.mockImplementation(async (_c: unknown, m: { recipients: string[] }) => accepted(m.recipients.map((x) => ({ phone: x }))))
    const cb = vi.fn(() => Promise.reject(new Error("db down")))
    const r = await dispatchCampaign(items(150), null, cb)
    expect(cb).toHaveBeenCalledTimes(2)
    expect(r.sent).toHaveLength(150)
  })
  it("moolre-primary path also calls onChunkSent with 'moolre'", async () => {
    h.primary = "moolre"
    h.moolre.mockResolvedValue({ ok: true })
    const cb = vi.fn(() => Promise.resolve())
    await dispatchCampaign(items(3), null, cb)
    expect(cb).toHaveBeenCalledOnce()
    expect((cb.mock.calls[0] as unknown[])[0]).toBe("moolre")
  })
  it("recipients Hubtel cannot address are not sent to Hubtel and stay pending", async () => {
    h.simple.mockImplementation(async (_c: unknown, m: { recipients: string[] }) => accepted(m.recipients.map((x) => ({ phone: x }))))
    const r = await dispatchCampaign(
      [{ id: "ok", phone: "+233240000001", message: "hi" }, { id: "bad", phone: "+233700000001", message: "hi" }],
      "KINGS",
    )
    expect(h.simple.mock.calls[0][1].recipients).toEqual(["+233240000001"])
    expect(r.sent.map((s) => s.id)).toEqual(["ok"])
  })
  it("deadline already passed (hubtel): no provider call, nothing placed", async () => {
    const cb = vi.fn(() => Promise.resolve())
    const r = await dispatchCampaign(items(150), null, cb, Date.now() - 1)
    expect(h.simple).not.toHaveBeenCalled()
    expect(h.moolre).not.toHaveBeenCalled()
    expect(r.sent).toEqual([])
    expect(cb).not.toHaveBeenCalled()
  })
  it("deadline already passed (moolre primary): no provider call", async () => {
    h.primary = "moolre"
    const r = await dispatchCampaign(items(3), null, undefined, Date.now() - 1)
    expect(h.moolre).not.toHaveBeenCalled()
    expect(r.sent).toEqual([])
  })
  it("a Moolre throw on fallback leaves rows pending", async () => {
    h.simple.mockResolvedValue({ outcome: "rejected", httpStatus: 400, bodyStatus: 4, messages: [] })
    h.moolre.mockRejectedValue(new Error("boom"))
    const r = await dispatchCampaign(items(2), null)
    expect(r.fallbackSent).toEqual([])
  })
})
