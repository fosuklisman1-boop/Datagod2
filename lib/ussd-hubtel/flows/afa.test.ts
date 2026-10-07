// lib/ussd-hubtel/flows/afa.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAfa, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"
import type { HubtelReply } from "../types"

const MTN_CALLER = "233244123456"

async function toAfa(deps: RouterDeps, mobile = MTN_CALLER) {
  const menu = await hubtelRouter(req({ Type: "Initiation", Mobile: mobile }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "AFA Registration") }), deps)
}
async function send(deps: RouterDeps, inputs: string[]): Promise<HubtelReply> {
  let r: HubtelReply | undefined
  for (const m of inputs) r = await hubtelRouter(req({ Message: m }), deps)
  return r!
}
const DETAILS = ["Kwame Mensah", "GHA1234567890", "Accra", "Greater Accra"]

describe("afa: entry", () => {
  it("MTN caller: asks for the full name (text field)", async () => {
    const { deps, store } = makeDeps()
    const r = await toAfa(deps)
    expect(r.Message).toContain("Enter your full name")
    expect(r.FieldType).toBe("text")
    expect(store.get("S1")).toMatchObject({ step: "AFA_ENTER_NAME", dialingPhone: "+233244123456" })
  })
  it("non-MTN caller is refused before any data entry (review focus #4)", async () => {
    const { deps, store } = makeDeps()
    const r = await toAfa(deps, "233200585542") // Telecel
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("needs an MTN number")
    expect(store.has("S1")).toBe(false)
  })
  it("the MTN-only rule applies even when the prefix-validation toggle is off", async () => {
    const { DEFAULT_NETWORK_PREFIXES } = await import("@/lib/phone-format")
    const { deps, store } = makeDeps({ getPrefixConfig: async () => ({ enabled: false, map: DEFAULT_NETWORK_PREFIXES }) })
    const r = await toAfa(deps, "233200585542")
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("needs an MTN number")
    expect(store.has("S1")).toBe(false)
  })
  it("is hidden when the admin turns AFA off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ welcome: "Welcome to Clingshub", welcomeCustom: false, brandName: "Clingshub", enabled: true, mode: "main", visibility: { data: true, afa: false, airtime: true, resultsChecker: true } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation", Mobile: MTN_CALLER }), deps)
    expect(menu.Message).not.toContain("AFA Registration")
  })
  it("'0' on the name step goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("MAIN")
  })
})

describe("afa: field validation (review focus #4)", () => {
  for (const bad of ["K", "1234", "Kwame@Mensah", "", "-Kwame Mensah", "A".repeat(101)]) {
    it(`rejects name "${bad.slice(0, 20)}"`, async () => {
      const { deps, store } = makeDeps()
      await toAfa(deps)
      await hubtelRouter(req({ Message: bad }), deps)
      expect(store.get("S1")?.step).toBe("AFA_ENTER_NAME")
    })
  }
  it("accepts a name with . ' - and collapses repeated spaces", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Ama   O'Neil-Mensah Jr."])
    expect(store.get("S1")).toMatchObject({ step: "AFA_ENTER_CARD", afaFullName: "Ama O'Neil-Mensah Jr." })
  })
  for (const bad of ["GHA-12345", "123456789", "GHA-12345678X-0", "hello"]) {
    it(`rejects Ghana Card "${bad}" and stays on the card step`, async () => {
      const { deps, store } = makeDeps()
      await toAfa(deps)
      await hubtelRouter(req({ Message: "Kwame Mensah" }), deps)
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Invalid Ghana Card number.")
      expect(store.get("S1")?.step).toBe("AFA_ENTER_CARD")
    })
  }
  it("stores the normalised card number whatever the typed shape", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "gha 123456789 0"])
    expect(store.get("S1")).toMatchObject({ step: "AFA_ENTER_LOCATION", afaGhCard: "GHA-123456789-0" })
  })
  it("an empty location re-prompts", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "GHA1234567890", ""])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_LOCATION")
  })
  it("an empty region re-prompts", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "GHA1234567890", "Accra", ""])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_REGION")
  })
  it("'0' walks back one step at a time", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "GHA1234567890", "Accra"])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_REGION")
    await send(deps, ["0"])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_LOCATION")
    await send(deps, ["0"])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_CARD")
    await send(deps, ["0"])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_NAME")
  })
  it("no configured AFA price: release, never a fallback amount", async () => {
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => null }) })
    await toAfa(deps)
    const r = await send(deps, DETAILS)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("unavailable")
  })
})

describe("afa: confirm -> AddToCart", () => {
  it("confirm screen, then AddToCart at the AFA price with NO Paystack fee added", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    const confirm = await send(deps, DETAILS)
    expect(confirm.Message).toContain("Kwame Mensah")
    expect(confirm.Message).toContain("Card: GHA-123456789-0")
    expect(confirm.Message).toContain("GHS 50.00 from 0244123456")
    expect(confirm.Message).toContain("1. Pay now\n2. Cancel")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "AFA Registration", Qty: 1, Price: 50 })
    expect(sup.inserts["ussd_afa_orders"][0]).toEqual({
      dialing_phone: "+233244123456", full_name: "Kwame Mensah", gh_card_number: "GHA-123456789-0",
      location: "Accra", region: "Greater Accra", occupation: "Farmer", amount: 50,
      payment_status: "pending", order_status: "pending",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "ussd_afa_orders", order_id: NEW_ID, expected_amount: 50 })
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toContain("Registration cancelled.")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("any other input re-shows the confirm screen without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const r = await hubtelRouter(req({ Message: "9" }), deps)
    expect(r.Message).toContain("1. Pay now\n2. Cancel")
    expect(store.get("S1")?.step).toBe("AFA_CONFIRM")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("price changed since the confirm screen: release, no order", async () => {
    let price = 50
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => price }) }, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    price = 60
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 60.00")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("price becomes unavailable at confirm: release, no order", async () => {
    let price: number | null = 50
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => price }) }, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    price = null
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("unavailable")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("a NaN price at confirm fails closed (drift check must not pass on NaN)", async () => {
    let price = 50
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => price }) }, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    price = NaN
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("a 100-char name is truncated on the confirm screen only: options never cut by the 182 limit", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    await toAfa(deps)
    const longName = "A".repeat(100)
    const confirm = await send(deps, [longName, "GHA1234567890", "Accra", "Greater Accra"])
    expect(confirm.Message).toContain("2. Cancel")
    expect(confirm.Message.length).toBeLessThanOrEqual(182)
    expect(confirm.Message).toContain("A".repeat(40) + "...")
    expect(confirm.Message).not.toContain("A".repeat(41))
    expect(store.get("S1")?.afaFullName).toBe(longName)
    await hubtelRouter(req({ Message: "1" }), deps)
    expect(sup.inserts["ussd_afa_orders"][0].full_name).toBe(longName)
  })
  it("'2' cancels even when the session lost its AFA fields", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, DETAILS)
    store.set("S1", { ...store.get("S1")!, afaPrice: undefined, afaFullName: undefined })
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toContain("Registration cancelled.")
  })
  it("the name re-prompt states the instruction once", async () => {
    const { deps } = makeDeps()
    await toAfa(deps)
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message.match(/full name/gi)).toHaveLength(1)
    expect(r.Message).toContain("letters")
  })
  it("a session with a lost AFA price/details fails closed at confirm", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const s = store.get("S1")!
    store.set("S1", { ...s, afaPrice: undefined })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
})

describe("afa: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "ussd_afa_orders", order_id: "o-winner", expected_amount: 50, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["ussd_afa_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan AFA order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Item).toEqual({ ItemName: "AFA Registration", Qty: 1, Price: 50 })
    expect(sup.updates.some(u => u.table === "ussd_afa_orders" && u.patch.order_status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})
