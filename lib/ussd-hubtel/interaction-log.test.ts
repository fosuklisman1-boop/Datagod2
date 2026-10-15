import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  getTranscript, logInteraction, purgeOldInteractions, rowsForShop, sessionOutcome, shapeInteractionRow, trackSessionStore,
  __resetInteractionLogWarningsForTests,
} from "./interaction-log"
import { parseListParams } from "./interaction-routes"
import type { HubtelReply, HubtelRequest, HubtelSession } from "./types"

const req = (over: Partial<HubtelRequest> = {}): HubtelRequest => ({
  Type: "Response", Mobile: "233597197674", SessionId: "S1", ServiceCode: "713", Message: "4",
  Operator: "mtn", Sequence: 5, ClientState: "", Platform: "USSD", ...over,
})
const reply = (over: Partial<HubtelReply> = {}): HubtelReply => ({
  SessionId: "S1", Type: "response", Message: "Enter recipient number", Label: "x", DataType: "input", FieldType: "phone", ClientState: "SHOP_DATA_RECIPIENT", ...over,
})
const shopSession: HubtelSession = { mode: "shop", step: "SHOP_DATA_RECIPIENT", dialingPhone: "+233597197674", platform: "USSD", shopId: "shop-1" }

describe("shapeInteractionRow", () => {
  it("records the exchange with the shop from the session", () => {
    const row = shapeInteractionRow(req(), reply(), shopSession, new Date("2026-10-15T21:17:00Z"))
    expect(row).toEqual({
      created_at: "2026-10-15T21:17:00.000Z", session_id: "S1", seq: 5, mobile: "233597197674", platform: "USSD",
      request_type: "Response", input: "4", reply_type: "response", reply: "Enter recipient number",
      step: "SHOP_DATA_RECIPIENT", mode: "shop", shop_id: "shop-1",
    })
  })
  it("no session (main menu / before the code): no shop", () => {
    expect(shapeInteractionRow(req({ Type: "Initiation", Message: "*713#" }), reply(), null, new Date()).shop_id).toBeNull()
  })
  it("caps very long text", () => {
    expect(shapeInteractionRow(req({ Message: "x".repeat(5000) }), reply(), null, new Date()).input?.length).toBe(2000)
  })
})

describe("trackSessionStore", () => {
  it("remembers the session written by the code step, and keeps it after a delete", async () => {
    const store = new Map<string, HubtelSession>()
    const inner = { get: async (id: string) => store.get(id) ?? null, set: async (id: string, s: HubtelSession) => { store.set(id, s) }, del: async (id: string) => { store.delete(id) } }
    const t = trackSessionStore(inner)
    expect(t.latest()).toBeNull()
    await t.store.set("S1", shopSession)
    await t.store.del("S1")
    expect(t.latest()?.shopId).toBe("shop-1")
    expect(store.has("S1")).toBe(false)
  })
})

describe("sessionOutcome", () => {
  it("payment state wins, then timeout / ended / abandoned", () => {
    expect(sessionOutcome({ payment_state: "fulfilled", last_reply_type: "AddToCart", last_request_type: "Response" })).toBe("Paid - delivered")
    expect(sessionOutcome({ payment_state: "awaiting_payment", last_reply_type: "AddToCart", last_request_type: "Response" })).toBe("Awaiting payment")
    expect(sessionOutcome({ payment_state: null, last_reply_type: "release", last_request_type: "Timeout" })).toBe("Timed out")
    expect(sessionOutcome({ payment_state: null, last_reply_type: "release", last_request_type: "Response" })).toBe("Ended")
    expect(sessionOutcome({ payment_state: null, last_reply_type: "response", last_request_type: "Response" })).toBe("Abandoned")
  })
})

describe("parseListParams", () => {
  it("defaults, validates limit and the cursor", () => {
    expect(parseListParams(new URLSearchParams())).toEqual({ limit: 30, before: null })
    expect(parseListParams(new URLSearchParams("limit=101"))).toHaveProperty("error")
    expect(parseListParams(new URLSearchParams("before=yesterday"))).toHaveProperty("error")
    expect(parseListParams(new URLSearchParams({ before: "2026-10-15T21:17:00.123+00:00", limit: "10" }))).toEqual({ limit: 10, before: "2026-10-15T21:17:00.123+00:00" })
  })
})

function fakeDb(rows: unknown[], err: unknown = null) {
  const inserted: unknown[] = []
  const client = {
    from: () => ({
      insert: async (r: unknown) => { inserted.push(r); return { error: err } },
      delete: () => ({ lt: async () => ({ error: err }) }),
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: rows, error: err }) }) }) }),
    }),
  }
  return { client: client as unknown as SupabaseClient, inserted }
}

describe("getTranscript", () => {
  const rows = [
    { created_at: "a", seq: 1, request_type: "Initiation", input: "*713#", reply_type: "response", reply: "Enter shop code", shop_id: null },
    { created_at: "b", seq: 2, request_type: "Response", input: "4888", reply_type: "response", reply: "Menu", shop_id: "shop-1" },
  ]
  it("admin (no shop) gets every row", async () => {
    const r = await getTranscript(fakeDb(rows).client, "S1", null)
    expect(r.ok && r.rows.length).toBe(2)
  })
  it("owner of the shop used in the session gets it, including the screens before the code", async () => {
    const r = await getTranscript(fakeDb(rows).client, "S1", "shop-1")
    expect(r.ok && r.rows.length).toBe(2)
  })
  it("another shop's owner gets 404", async () => {
    expect(await getTranscript(fakeDb(rows).client, "S1", "shop-2")).toEqual({ ok: false, status: 404, error: "Session not found" })
  })
})

describe("logInteraction / purge", () => {
  it("inserts the row; a missing table warns once and never throws", async () => {
    __resetInteractionLogWarningsForTests()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { client, inserted } = fakeDb([], { code: "42P01", message: "missing" })
    const row = shapeInteractionRow(req(), reply(), null, new Date())
    await expect(logInteraction(client, row)).resolves.toBeUndefined()
    await logInteraction(client, row)
    expect(inserted).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    await expect(purgeOldInteractions(client)).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe("redaction of personal data", () => {
  it("answers on name / Ghana Card / PIN / index / DOB steps are never stored", () => {
    for (const step of ["AFA_ENTER_NAME", "AFA_ENTER_CARD", "RC_CHECK_VOUCHER", "RC_CHECK_INDEX", "RC_CHECK_DOB"] as const) {
      const row = shapeInteractionRow(req({ Message: "GHA-123456789-0" }), reply({ ClientState: "NEXT" }), null, new Date(), step)
      expect(row.input).toBe("[hidden]")
    }
    expect(shapeInteractionRow(req({ Message: "1" }), reply(), null, new Date(), "MAIN").input).toBe("1")
  })
  it("also hidden when the stored session is lost: the echoed ClientState names the step", () => {
    const row = shapeInteractionRow(req({ Message: "GHA-123456789-0", ClientState: "AFA_ENTER_CARD" }), reply({ ClientState: "MAIN" }), null, new Date(), null)
    expect(row.input).toBe("[hidden]")
  })
  it("screens that echo it (confirmations, voucher details) are never stored", () => {
    const row = shapeInteractionRow(req({ Message: "Accra" }), reply({ ClientState: "AFA_CONFIRM", Message: "Kwame Mensah GHA-123456789-0" }), null, new Date(), "AFA_ENTER_LOCATION")
    expect(row.reply).toBe("[hidden]")
    expect(row.input).toBe("Accra")
  })
})

describe("rowsForShop: another shop's screens in the same session never reach this owner", () => {
  const r = (shop_id: string | null, input: string) => ({ created_at: input, seq: null, request_type: "Response", input, reply_type: "response", reply: "x", shop_id })
  it("pre-code rows go to the next shop accepted, trailing rows to the last", () => {
    const rows = [r(null, "dial"), r(null, "1111"), r("A", "A-menu"), r("A", "A-buy"), r(null, "re-dial code"), r("B", "B-menu"), r(null, "timeout")]
    expect(rowsForShop(rows, "A").map(x => x.input)).toEqual(["dial", "1111", "A-menu", "A-buy"])
    expect(rowsForShop(rows, "B").map(x => x.input)).toEqual(["re-dial code", "B-menu", "timeout"])
    expect(rowsForShop(rows, "C")).toEqual([])
  })
})
