import { describe, expect, it } from "vitest"
import {
  buildReplacementRow, canResend, executeSpecialResend, isSpecialReplacement, replacementRef,
  type ResendSource, type SpecialResendDeps,
} from "./special-resend"

const ORIG_ID = "18d49f71-4b0e-41b2-b854-46ceb88a0453"
const NOW = Date.parse("2026-11-20T20:30:00Z")

const unit = (over: Partial<ResendSource> = {}): ResendSource => ({
  id: ORIG_ID, reference_code: "SB-ABCDEF123456", user_id: "u1", channel: "dashboard", network: "MTN", service_key: "data_mtn",
  beneficiary_phone: "233243002378", bundle_value: "RACT_Data_GHC_3_Others", bundle_display: "406.89MB", bundle_category: "Data",
  amount: 3, paid_amount: 2.96, status: "completed", payment_status: "paid", special_group_id: "g1", special_index: 2,
  bot_surface: null, buyer_phone: null, buyer_name: null, buyer_email: null, shop_id: "shop1",
  cashback_amount: 0.04, shop_share_amount: 0.1, ...over,
})

describe("replacement helpers", () => {
  it("replacementRef is SBR- + the original id's 32 hex, uppercase (one fixed reference per unit)", () => {
    expect(replacementRef(ORIG_ID)).toBe("SBR-18D49F714B0E41B2B85446CEB88A0453")
  })
  it("isSpecialReplacement: only SBR- references (normal ones are SB- + hex, which never contains R)", () => {
    expect(isSpecialReplacement("SBR-18D49F714B0E41B2B85446CEB88A0453")).toBe(true)
    expect(isSpecialReplacement("SB-ABCDEF123456")).toBe(false)
    expect(isSpecialReplacement(null)).toBe(false)
    expect(isSpecialReplacement(undefined)).toBe(false)
  })
  it("canResend: a completed, paid Special unit only; never a replacement itself", () => {
    expect(canResend(unit())).toBe(true)
    for (const status of ["pending", "processing", "failed", "refunding", "refunded"]) expect(canResend(unit({ status }))).toBe(false)
    expect(canResend(unit({ payment_status: "refunded" }))).toBe(false)
    expect(canResend(unit({ special_group_id: null, special_index: null }))).toBe(false)
    expect(canResend(unit({ reference_code: replacementRef(ORIG_ID) }))).toBe(false)
  })
})

describe("buildReplacementRow", () => {
  it("copies who/what/where, is paid but NOT charged (paid_amount null), outside the group, with no shop or cashback fields", () => {
    const r = buildReplacementRow(unit(), "admin-9", NOW)
    expect(r).toEqual({
      reference_code: "SBR-18D49F714B0E41B2B85446CEB88A0453",
      idempotency_key: `resend:${ORIG_ID}`,
      user_id: "u1", channel: "dashboard", network: "MTN", service_key: "data_mtn",
      beneficiary_phone: "233243002378", bundle_value: "RACT_Data_GHC_3_Others", bundle_display: "406.89MB", bundle_category: "Data",
      amount: 3, status: "pending", payment_status: "paid", paid_at: new Date(NOW).toISOString(),
      bot_surface: null, buyer_phone: null, buyer_name: null, buyer_email: null,
      notes: "Replacement for Special unit 2 (order SB-ABCDEF123456), resent by admin admin-9. Not charged; not refundable.",
    })
    // Never copied: money fields, shop link, group membership.
    for (const k of ["paid_amount", "cashback_amount", "shop_share_amount", "shop_id", "special_group_id", "special_index", "id"]) {
      expect(r).not.toHaveProperty(k)
    }
  })
  it("a bot unit keeps its surface and buyer (the bots CHECK needs bot_surface)", () => {
    const r = buildReplacementRow(unit({ channel: "bots", user_id: null, bot_surface: "hubtel_ussd", buyer_phone: "233243002378" }), "a", NOW)
    expect(r).toMatchObject({ channel: "bots", user_id: null, bot_surface: "hubtel_ussd", buyer_phone: "233243002378" })
  })
})

function make(over: Partial<SpecialResendDeps> = {}, src: ResendSource | null = unit()) {
  const calls = { insert: [] as any[], dispatch: [] as any[] }
  const d: SpecialResendDeps = {
    getOrder: async () => src,
    findByReference: async () => null,
    insertReplacement: async (row) => { calls.insert.push(row); return { ok: true, order: { ...row, id: "new-1" } as any } },
    dispatch: async (o) => { calls.dispatch.push(o); return "processing" },
    now: () => NOW,
    ...over,
  }
  return { d, calls }
}

describe("executeSpecialResend", () => {
  it("creates ONE replacement and sends it through the normal dispatch", async () => {
    const m = make()
    const r = await executeSpecialResend(m.d, ORIG_ID, "admin-9")
    expect(r).toEqual({ ok: true, status: 200, orderStatus: "processing", replacementId: "new-1", message: "Resent as SBR-18D49F714B0E41B2B85446CEB88A0453; it is processing" })
    expect(m.calls.insert).toHaveLength(1)
    expect(m.calls.dispatch.map(o => o.id)).toEqual(["new-1"])
  })
  it("unknown order => 404, nothing written", async () => {
    const m = make({}, null)
    expect(await executeSpecialResend(m.d, ORIG_ID, "a")).toMatchObject({ ok: false, status: 404 })
    expect(m.calls.insert).toEqual([])
  })
  it("not a completed Special unit => 409, nothing written", async () => {
    const m = make({}, unit({ status: "failed" }))
    const r = await executeSpecialResend(m.d, ORIG_ID, "a")
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(r.message).toMatch(/completed Special/i)
    expect(m.calls.insert).toEqual([])
  })
  it("already resent once => 409 naming the replacement and its status, nothing written", async () => {
    const m = make({ findByReference: async () => ({ id: "x", status: "failed" }) })
    const r = await executeSpecialResend(m.d, ORIG_ID, "a")
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(r.message).toContain("SBR-18D49F714B0E41B2B85446CEB88A0453")
    expect(r.message).toContain("failed")
    expect(m.calls.insert).toEqual([])
  })
  it("a concurrent resend that won the insert (unique reference) => 409, never a second send", async () => {
    const m = make({ insertReplacement: async () => ({ ok: false, duplicate: true }) })
    const r = await executeSpecialResend(m.d, ORIG_ID, "a")
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(m.calls.dispatch).toEqual([])
  })
  it("a lookup error => 503, nothing written (fail closed)", async () => {
    const m = make({ findByReference: async () => { throw new Error("db") } })
    expect(await executeSpecialResend(m.d, ORIG_ID, "a")).toMatchObject({ ok: false, status: 503 })
    expect(m.calls.insert).toEqual([])
  })
  it("Hubtel failing the replacement is reported, not hidden (Retry stays available on it)", async () => {
    const m = make({ dispatch: async () => "failed" })
    const r = await executeSpecialResend(m.d, ORIG_ID, "a")
    expect(r).toMatchObject({ ok: false, status: 200, orderStatus: "failed" })
    expect(r.message).toMatch(/Retry/)
  })
  it("a replacement not sent (still pending) says to use Dispatch on it", async () => {
    const m = make({ dispatch: async () => "pending" })
    const r = await executeSpecialResend(m.d, ORIG_ID, "a")
    expect(r).toMatchObject({ ok: false, status: 200, orderStatus: "pending" })
    expect(r.message).toMatch(/Dispatch/)
  })
})
