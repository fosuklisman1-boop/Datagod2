// lib/ussd-hubtel/flows/rc-check.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"
import type { HubtelReply } from "../types"
import { accountRequiredText } from "./rc-check"

const member = { resolveDialer: async () => ({ userId: "u1" }) }

async function toCheck(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
  return hubtelRouter(req({ Message: "3" }), deps)
}
async function send(deps: RouterDeps, inputs: string[]): Promise<HubtelReply> {
  let r: HubtelReply | undefined
  for (const m of inputs) r = await hubtelRouter(req({ Message: m }), deps)
  return r!
}
// WASSCE, School, combo, index, year, DOB, WhatsApp
const COMBO = ["1", "1", "1", "0070202043", "2024", "15/06/2008", "0244123456"]
// WASSCE, Private, (no stock: no mode menu) PIN/serial, index, year, DOB, WhatsApp
const OWN_NO_STOCK = ["1", "2", "012345678912/WGR1900112581", "0070202043", "2024", "15/06/2008", "0244123456"]

describe("check results: entry gates", () => {
  it("option 3 opens the exam board menu for a registered caller", async () => {
    const { deps, store } = makeDeps(member)
    const r = await toCheck(deps)
    expect(r.Message).toContain("1. WASSCE\n2. BECE\n3. NOVDEC")
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_BOARD", userId: "u1" })
  })
  it("disabled service: stays on the RC menu", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled: false, fee: 2 }) }) })
    const r = await toCheck(deps)
    expect(r.Message).toContain("Service not available.")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("caller without an account is told to register (Uzo gate kept)", async () => {
    const { deps } = makeDeps()
    const r = await toCheck(deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("create a Clingshub account")
  })
  it("the account-required message uses the configured brand and fits one USSD screen with a 30-char brand", async () => {
    for (const brandName of ["Ama Data", "B".repeat(15) + " " + "c".repeat(14)]) {
      const { deps } = makeDeps({
        getConfig: async () => ({
          enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
          brandName, welcome: `Welcome to ${brandName}`, welcomeCustom: false,
        }),
      })
      const r = await toCheck(deps)
      expect(r.Type).toBe("release")
      expect(r.Message).toBe(accountRequiredText(brandName))
      expect(r.Message).toContain(`create a ${brandName} account`)
      expect(r.Message).not.toContain("Datagod")
      expect(r.Message.length).toBeLessThanOrEqual(182)
      expect(r.Message.endsWith("this service.")).toBe(true)
    }
  })
  it("a settings read error fails closed: the error propagates (route answers Service unavailable)", async () => {
    const { deps } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => { throw new Error("db down") } }) })
    await expect(toCheck(deps)).rejects.toThrow("db down")
  })
})

describe("check results: combo (voucher + check)", () => {
  it("mode menu shows combo total (unit price + fee) and the check fee", async () => {
    const { deps } = makeDeps(member)
    await toCheck(deps)
    const r = await send(deps, ["1", "1"])
    expect(r.Message).toContain("1. Buy voucher + check\n   GHS 22.00")
    expect(r.Message).toContain("2. I have a voucher\n   GHS 2.00")
  })
  it("full walk: confirm, then AddToCart at the combo total with the request columns", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    const confirm = await send(deps, COMBO)
    expect(confirm.Message).toContain("WASSCE (School)")
    expect(confirm.Message).toContain("Index 0070202043 Year 2024")
    expect(confirm.Message).toContain("Voucher + check")
    expect(confirm.Message).toContain("GHS 22.00 from 0200585542")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 22 })
    const row = sup.inserts["results_check_requests"][0]
    expect(row).toMatchObject({
      phone_number: "0200585542", exam_board: "WASSCE", candidate_type: "school", index_number: "0070202043",
      dob: "15/06/2008", exam_year: 2024, fee: 22, payment_status: "pending_payment", status: "pending",
      channel: "ussd", user_id: "u1", mode: "combo", voucher_pin: null, voucher_serial: null, whatsapp_number: "0244123456",
    })
    expect(row.payment_reference).toMatch(/^RCK-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_check_requests", order_id: NEW_ID, expected_amount: 22 })
  })
  it("combo is not offered for a board that is disabled for voucher sales", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ isBoardEnabled: async () => false }) })
    await toCheck(deps)
    const r = await send(deps, ["1", "1"])
    expect(r.Message).toContain("No vouchers in stock.")
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_VOUCHER", rcCheckMode: "own_voucher" })
  })
  it("combo voucher sold out since the confirm screen: release, no request (review focus #2)", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("sold out")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("board disabled for voucher sales since the confirm screen: release, no request", async () => {
    let enabled = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ isBoardEnabled: async () => enabled }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    enabled = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("sold out")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("stock count turns NaN since the confirm screen: fails closed (release, no request)", async () => {
    let stock: number = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    stock = NaN
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("voucher unit price turns NaN since the confirm screen: fails closed (release, no request)", async () => {
    let unit: number = 20
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ price: async () => ({ unitPrice: unit, totalPaid: unit, bulkApplied: false }) }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    unit = NaN
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("fee changed since the confirm screen: release, no request", async () => {
    let fee = 2
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled: true, fee }) }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    fee = 3
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 23.00")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("fee turns NaN since the confirm screen: fails closed (release, no request)", async () => {
    let fee: number = 2
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled: true, fee }) }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    fee = NaN
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).not.toContain("NaN")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("service disabled since the confirm screen: release, no request", async () => {
    let enabled = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled, fee: 2 }) }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    enabled = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("not available")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("account no longer resolves at confirm: release, no request (registered account required at confirm too)", async () => {
    let registered = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ resolveDialer: async () => (registered ? { userId: "u1" } : {}) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    registered = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("create a Clingshub account")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
})

describe("check results: own voucher", () => {
  it("no stock: skips the mode menu, validates PIN/serial, AddToCart at the check fee", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0 }) }, sup)
    await toCheck(deps)
    const prompt = await send(deps, ["1", "2"])
    expect(prompt.Message).toContain("No vouchers in stock.")
    const bad = await hubtelRouter(req({ Message: "12345/ABC" }), deps)
    expect(bad.Message).toContain("Invalid PIN or serial.")
    const confirm = await send(deps, OWN_NO_STOCK.slice(2))
    expect(confirm.Message).toContain("PIN 012345678912")
    expect(confirm.Message).toContain("GHS 2.00 from 0200585542")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 2 })
    expect(sup.inserts["results_check_requests"][0]).toMatchObject({
      candidate_type: "private", mode: "own_voucher", fee: 2, voucher_pin: "012345678912", voucher_serial: "WGR1900112581",
    })
  })
  it("BECE: alphanumeric PIN with numeric serial is accepted", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0 }) })
    await toCheck(deps)
    await send(deps, ["2", "1", "5fbr336742d4/252100270719"])
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_INDEX", rcCheckVoucherPin: "5FBR336742D4", rcCheckVoucherSerial: "252100270719" })
  })
  it("a fee with extra decimals is rounded to 2dp before AddToCart and storage", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0, checkSettings: async () => ({ enabled: true, fee: 2.004 }) }) }, sup)
    await toCheck(deps)
    await send(deps, OWN_NO_STOCK)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 2 })
    expect(sup.inserts["results_check_requests"][0]).toMatchObject({ fee: 2 })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ expected_amount: 2 })
  })
  it("own voucher: a '1' after the session is gone (Redis miss) replays the identical AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0 }) }, sup)
    await toCheck(deps)
    await send(deps, OWN_NO_STOCK)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    store.delete("S1")
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Type).toBe("AddToCart")
    expect(second.Item).toEqual(first.Item)
    expect(second.Item?.ItemName).toMatch(/^CH order [a-z0-9]+$/)
    expect(sup.inserts["results_check_requests"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("own voucher does not need stock: a sold-out board still checks at the fee only", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toCheck(deps)
    await send(deps, ["1", "1", "2", "012345678912/WGR1900112581", "0070202043", "2024", "15/06/2008", "0244123456"])
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 2 })
  })
})

describe("check results: field validation keeps the step", () => {
  async function at(step: "index" | "year" | "dob" | "wa", board = "1") {
    const { deps, store } = makeDeps(member)
    await toCheck(deps)
    const path = [board, "1", "1"]
    if (step !== "index") path.push(board === "2" ? "007020204312" : "0070202043")
    if (step === "dob" || step === "wa") path.push("2024")
    if (step === "wa") path.push("15/06/2008")
    await send(deps, path)
    return { deps, store }
  }
  it("WASSCE index must be exactly 10 digits", async () => {
    const { deps, store } = await at("index")
    const r = await hubtelRouter(req({ Message: "007020204312" }), deps)
    expect(r.Message).toContain("Invalid index number.")
    expect(store.get("S1")?.step).toBe("RC_CHECK_INDEX")
  })
  it("BECE index may be 12 digits", async () => {
    const { deps, store } = await at("index", "2")
    await hubtelRouter(req({ Message: "007020204312" }), deps)
    expect(store.get("S1")?.step).toBe("RC_CHECK_YEAR")
  })
  for (const year of ["1979", String(new Date().getFullYear() + 1), "24"]) {
    it(`rejects exam year ${year}`, async () => {
      const { deps, store } = await at("year")
      const r = await hubtelRouter(req({ Message: year }), deps)
      expect(r.Message).toContain("Invalid year.")
      expect(store.get("S1")?.step).toBe("RC_CHECK_YEAR")
    })
  }
  it("rejects an impossible date and accepts dashes", async () => {
    const { deps, store } = await at("dob")
    const r = await hubtelRouter(req({ Message: "31/02/2008" }), deps)
    expect(r.Message).toContain("Invalid date.")
    await hubtelRouter(req({ Message: "15-06-2008" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_WA_NUMBER", rcCheckDob: "15/06/2008" })
  })
  it("WhatsApp number is mandatory, phone-typed, and '0' goes back", async () => {
    const { deps, store } = await at("wa")
    const bad = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(bad.Message).toContain("Invalid number.")
    expect(bad.FieldType).toBe("phone")
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("RC_CHECK_DOB")
  })
})

describe("check results: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "results_check_requests", order_id: "o-winner", expected_amount: 22, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE request + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_check_requests"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan request failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Item).toEqual({ ItemName: expect.stringMatching(/^CH order [a-z0-9]+$/), Qty: 1, Price: 22 })
    expect(sup.updates.some(u => u.table === "results_check_requests" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})
