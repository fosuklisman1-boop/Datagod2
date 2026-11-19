import { describe, it, expect, vi } from "vitest"
import {
  disputeForSupportThread,
  disputeForWhatsAppComplaint,
  forwardWhatsAppComplaint,
  COMPLAINT_REASON_CODE,
  COMPLAINT_DESCRIPTION,
} from "./kuntanii-complaint-dispute"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

// Generic in-memory query fake: eq / in / gte filters, order + limit, maybeSingle or await.
function fakeDb(tables: Record<string, any[]>) {
  return {
    from(table: string) {
      const filters: ((r: any) => boolean)[] = []
      let orderCol: string | null = null
      let asc = true
      let lim = Infinity
      const run = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (orderCol) rows = [...rows].sort((a, b) => (a[orderCol!] < b[orderCol!] ? -1 : 1) * (asc ? 1 : -1))
        return rows.slice(0, lim)
      }
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
        order: (c: string, o?: { ascending?: boolean }) => ((orderCol = c), (asc = o?.ascending !== false), q),
        limit: (n: number) => ((lim = n), q),
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (ok: any, bad: any) => Promise.resolve({ data: run(), error: null }).then(ok, bad),
      }
      return q
    },
  }
}

const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()

const trk = (over: Record<string, unknown>) => ({
  id: "trk-1", provider: "kuntanii", status: "completed", order_type: "bulk", order_id: null, shop_order_id: null,
  api_order_id: null, recipient_phone: "0241112222", created_at: recent, updated_at: recent, ...over,
})

const okFile = () => vi.fn().mockResolvedValue({ ok: true, reportReference: "NR-1" })

describe("disputeForSupportThread", () => {
  it("files a not-received report for an order complaint on a completed Kuntanii order", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ id: "trk-b", order_id: "ord-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "user-1" }, { db, file })
    expect(r).toEqual({ filed: true, reportReference: "NR-1" })
    expect(file).toHaveBeenCalledWith({
      trackingId: "trk-b", raisedBy: "user-1", reasonCode: COMPLAINT_REASON_CODE, description: COMPLAINT_DESCRIPTION,
    })
  })

  it("matches a storefront complaint on shop_order_id", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ id: "trk-s", order_type: "shop", shop_order_id: "so-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", shopOrderId: "so-1", userId: "u" }, { db, file })
    expect(r.filed).toBe(true)
    expect(file.mock.calls[0][0].trackingId).toBe("trk-s")
  })

  it("ignores non-order categories", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ order_id: "ord-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "payment", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "wrong_category" })
    expect(file).not.toHaveBeenCalled()
  })

  it("does nothing when the order was not delivered by Kuntanii", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ provider: "agentportalgh", order_id: "ord-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "not_kuntanii" })
    expect(file).not.toHaveBeenCalled()
  })

  it("does nothing for a Kuntanii attempt that is not completed", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ status: "failed", order_id: "ord-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r.filed).toBe(false)
    expect(file).not.toHaveBeenCalled()
  })

  it("does nothing for an unlinked complaint", async () => {
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", userId: "u" }, { db: fakeDb({}), file })
    expect(r).toEqual({ filed: false, reason: "no_order" })
    expect(file).not.toHaveBeenCalled()
  })

  it("reports already_open when a dispute exists (409)", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ order_id: "ord-1" })] })
    const file = vi.fn().mockResolvedValue({ ok: false, status: 409, error: "A dispute is already open" })
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "already_open" })
  })
})

describe("review fixes", () => {
  const hours = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()

  it("WhatsApp: files nothing when the number's newest order is not a completed Kuntanii one (I1)", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [
        trk({ id: "old-kt", order_type: "ussd", order_id: "a", created_at: hours(72) }),
        trk({ id: "today-agp", provider: "agentportalgh", status: "failed", order_type: "ussd", order_id: "b", created_at: hours(1) }),
      ],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "no_match" })
    expect(file).not.toHaveBeenCalled()
  })

  it("WhatsApp: ignores abandoned attempts when picking the newest order", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [
        trk({ id: "kt", order_type: "ussd", order_id: "a", created_at: hours(3) }),
        trk({ id: "gone", provider: "apexprime", status: "abandoned", order_type: "ussd", order_id: "a", created_at: hours(2) }),
      ],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })

  it("WhatsApp: matches a recipient stored in 233 format (M3)", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ id: "intl", recipient_phone: "233241112222", order_type: "ussd", order_id: "a" })] })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })

  it("never auto-files twice on the same order, even after a closed report (M2)", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ id: "trk-r", order_id: "ord-1" })],
      kuntanii_not_received_reports: [{ id: "rep", tracking_id: "trk-r", dispute_status: "rejected" }],
    })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "already_reported" })
    expect(file).not.toHaveBeenCalled()
  })

  it("website: an order_id only matches bulk tracking rows, never a USSD row with the same id (M1)", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ order_type: "ussd_shop", order_id: "ord-1" })] })
    const file = okFile()
    const r = await disputeForSupportThread({ category: "order", orderId: "ord-1", userId: "u" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "not_kuntanii" })
  })

  it("WhatsApp: the account owner matches on phone_number, and API orders on api_order_id", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ order_type: "api", api_order_id: "api-1", order_id: null })],
      api_orders: [{ id: "api-1", user_id: "dealer" }],
      users: [{ id: "dealer", phone: null, phone_number: "233209998888" }],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233209998888", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })
})

describe("forwardWhatsAppComplaint", () => {
  it("maps the stored complaint fields onto the filer", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ id: "trk-f", order_type: "ussd", order_id: "a" })] })
    const file = okFile()
    const r = await forwardWhatsAppComplaint(
      { phone_number: "233241112222", beneficiary_number: "0241112222", category: "data" }, { db, file },
    )
    expect(r).toEqual({ filed: true, reportReference: "NR-1" })
  })
  it("never throws: a failing lookup becomes an error result", async () => {
    const db = { from: () => { throw new Error("db down") } }
    const r = await forwardWhatsAppComplaint({ phone_number: "233241112222", beneficiary_number: "0241112222", category: "data" }, { db })
    expect(r).toEqual({ filed: false, reason: "error" })
  })
})

describe("disputeForWhatsAppComplaint", () => {
  it("files when the complainant is the recipient (any phone format)", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ id: "trk-w", order_type: "ussd", order_id: "u-1" })] })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint(
      { senderPhone: "233241112222", beneficiaryNumber: "024 111 2222", category: "data" }, { db, file },
    )
    expect(r).toEqual({ filed: true, reportReference: "NR-1" })
    expect(file).toHaveBeenCalledWith(expect.objectContaining({ trackingId: "trk-w", raisedBy: null, description: COMPLAINT_DESCRIPTION }))
  })

  it("files when the complainant placed the order (USSD dialing phone)", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ order_type: "ussd_shop", order_id: "us-1" })],
      ussd_shop_orders: [{ id: "us-1", dialing_phone: "233209998888" }],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233209998888", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })

  it("files when the complainant owns the account that placed a bulk order", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ order_type: "bulk", order_id: "o-1" })],
      orders: [{ id: "o-1", user_id: "user-9" }],
      users: [{ id: "user-9", phone: "0209998888", phone_number: null }],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233209998888", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })

  it("files when the complainant is the storefront customer", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ order_type: "shop", shop_order_id: "so-1" })],
      shop_orders: [{ id: "so-1", customer_phone: "0209998888" }],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233209998888", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r.filed).toBe(true)
  })

  it("refuses a stranger naming someone else's number", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [trk({ order_type: "bulk", order_id: "o-1" })],
      orders: [{ id: "o-1", user_id: "user-9" }],
      users: [{ id: "user-9", phone: "0201111111", phone_number: null }],
    })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233209998888", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "not_owner" })
    expect(file).not.toHaveBeenCalled()
  })

  it("picks the newest completed Kuntanii order for that number", async () => {
    const db = fakeDb({
      mtn_fulfillment_tracking: [
        trk({ id: "older", order_type: "ussd", order_id: "a", created_at: new Date(Date.now() - 5 * 3600e3).toISOString() }),
        trk({ id: "newer", order_type: "ussd", order_id: "b", created_at: new Date(Date.now() - 1 * 3600e3).toISOString() }),
      ],
    })
    const file = okFile()
    await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(file.mock.calls[0][0].trackingId).toBe("newer")
  })

  it("ignores orders older than 7 days", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ order_type: "ussd", order_id: "a", created_at: old, updated_at: old })] })
    const file = okFile()
    const r = await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "data" }, { db, file })
    expect(r).toEqual({ filed: false, reason: "no_match" })
  })

  it("ignores non-data categories and unusable numbers", async () => {
    const db = fakeDb({ mtn_fulfillment_tracking: [trk({ order_type: "ussd", order_id: "a" })] })
    const file = okFile()
    expect(await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: "0241112222", category: "airtime" }, { db, file }))
      .toEqual({ filed: false, reason: "wrong_category" })
    expect(await disputeForWhatsAppComplaint({ senderPhone: "233241112222", beneficiaryNumber: null, category: "data" }, { db, file }))
      .toEqual({ filed: false, reason: "no_match" })
    expect(file).not.toHaveBeenCalled()
  })
})
