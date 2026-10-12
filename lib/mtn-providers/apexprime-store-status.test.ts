import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { ApexPrimeProvider, apexReplyReference, parseTrackingId } from "@/lib/mtn-providers/apexprime-provider"

const REF = "d290f1ee-6c54-4b01-90e6-d701748f0851"
const OTHER = "0b1c2d3e-0000-4000-8000-000000000000"

function replyWith(body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("parseTrackingId: Store ids with our reference", () => {
  it("new format store:<code>:<reference>:<uniquifier>", () => {
    expect(parseTrackingId(`store:420:${REF}:11111111-2222-4333-8444-555555555555`)).toEqual({ kind: "store", rawId: "420", reference: REF })
  })
  it("old format store:<code>:<uniquifier> has no reference", () => {
    expect(parseTrackingId("store:420:11111111-2222-4333-8444-555555555555")).toEqual({ kind: "store", rawId: "420" })
  })
})

describe("apexReplyReference", () => {
  it("finds the reference wherever it is", () => {
    expect(apexReplyReference({ client_reference: REF })).toBe(REF)
    expect(apexReplyReference({ order: { reference: REF } })).toBe(REF)
    expect(apexReplyReference({ data: { client_reference: REF } })).toBe(REF)
    expect(apexReplyReference({ status: "completed" })).toBeUndefined()
  })
})

describe("checkOrderStatus: Store replies are verified against our reference (client_code collisions)", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const id = `store:420:${REF}:11111111-2222-4333-8444-555555555555`

  it("a reply naming our order is trusted, and /status is still asked by client_code", async () => {
    const fetchMock = replyWith({ success: true, status: "completed", message: "Delivered", client_reference: REF })
    const r = await new ApexPrimeProvider().checkOrderStatus(id)
    expect(r).toMatchObject({ success: true, status: "completed" })
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ type: "store", order_id: "420" })
  })
  it("a reply about ANOTHER order sharing the code is ignored (stays processing)", async () => {
    replyWith({ success: true, status: "completed", message: "Sent to NITGHT. Order ID: 16543 | AutoSync: supplier=completed", client_reference: OTHER })
    expect(await new ApexPrimeProvider().checkOrderStatus(id)).toMatchObject({ success: true, status: "processing" })
  })
  it("another order's refund is not a reversal of ours", async () => {
    replyWith({ success: true, status: "refunded", message: "Refunded by Admin", client_reference: OTHER })
    expect((await new ApexPrimeProvider().checkOrderStatus(id)).status).toBe("processing")
  })
  it("a reply that names no reference cannot be verified: stays processing", async () => {
    replyWith({ success: true, status: "completed", message: "Supplier Error: Insufficient balance" })
    expect((await new ApexPrimeProvider().checkOrderStatus(id)).status).toBe("processing")
  })
  it("old rows (no stored reference) are never completed by polling", async () => {
    replyWith({ success: true, status: "completed", message: "Delivered", client_reference: REF })
    expect((await new ApexPrimeProvider().checkOrderStatus("store:420:11111111-2222-4333-8444-555555555555")).status).toBe("processing")
  })
  it("GroupShare (bundle) replies are unaffected", async () => {
    replyWith({ success: true, status: "completed", message: "Delivered" })
    expect((await new ApexPrimeProvider().checkOrderStatus("bundle:10839")).status).toBe("completed")
  })
})
