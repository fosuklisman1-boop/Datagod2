// lib/ussd-hubtel/router.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "./router"
import type { HubtelRequest, HubtelSession } from "./types"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"

function fakeSupabase(opts: { pkg?: any; txError?: boolean } = {}) {
  const inserts: Record<string, any[]> = {}
  const updates: Array<{ table: string; patch: any }> = []
  const client: any = {
    from(table: string) {
      const b: any = {
        select() { return b }, eq() { return b }, is() { return b }, not() { return b }, in() { return b },
        single: async () => ({ data: table === "packages" ? opts.pkg : null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        insert(rows: any) {
          ;(inserts[table] ??= []).push(...([] as any[]).concat(rows))
          const ib: any = {
            select() { return ib },
            single: async () => ({ data: { id: "11111111-1111-1111-1111-111111111111" }, error: null }),
            then: (res: any) => res({ error: table === "hubtel_transactions" && opts.txError ? { message: "boom" } : null }),
          }
          return ib
        },
        update(patch: any) { updates.push({ table, patch }); return b },
        then: (res: any) => res({ error: null }),
      }
      return b
    },
  }
  return { client, inserts, updates }
}

function makeDeps(over: Partial<RouterDeps> = {}, sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })) {
  const store = new Map<string, HubtelSession>()
  const deps: RouterDeps = {
    supabase: sup.client,
    getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }),
    sessions: {
      get: async id => store.get(id) ?? null,
      set: async (id, s) => { store.set(id, s) },
      del: async id => { store.delete(id) },
    },
    fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 10 }], total: 1 }),
    resolveCaller: async () => ({ effectivePriceTier: "regular" }),
    isDataBlocked: async () => false,
    getPrefixConfig: async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES }),
    pageSize: 5,
    ...over,
  }
  return { deps, store, sup }
}

const req = (over: Partial<HubtelRequest>): HubtelRequest => ({
  Type: "Response", Mobile: "233200585542", SessionId: "S1", ServiceCode: "713",
  Message: "", Operator: "vodafone", Sequence: 2, ClientState: "", Platform: "USSD", ...over,
})

describe("hubtelRouter: entry guards", () => {
  it("releases when the channel is disabled", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("release")
  })
  it("releases in shop mode (not built yet)", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    expect((await hubtelRouter(req({ Type: "Initiation" }), deps)).Type).toBe("release")
  })
  it("Timeout deletes the session", async () => {
    const { deps, store } = makeDeps()
    store.set("S1", { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Type: "Timeout" }), deps)
    expect(r.Type).toBe("release")
    expect(store.has("S1")).toBe(false)
  })
})

describe("hubtelRouter: initiation and recovery", () => {
  it("shows the main menu and stores a MAIN session with E.164 phone", async () => {
    const { deps, store } = makeDeps()
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("1. Buy Data Bundle")
    expect(r.ClientState).toBe("MAIN")
    expect(store.get("S1")).toMatchObject({ step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
  })
  it("releases politely when no service is available to this caller", async () => {
    const { deps } = makeDeps({ isDataBlocked: async () => true })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
  it("Redis miss mid-flow restarts with 'Session expired' and the menu (review focus #2)", async () => {
    const { deps } = makeDeps()
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Session expired.")
    expect(r.Message).toContain("Buy Data Bundle")
  })
})

async function walkTo(step: "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM", deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps) // data
  await hubtelRouter(req({ Message: "1" }), deps) // MTN
  if (step === "SELECT_BUNDLE") return
  await hubtelRouter(req({ Message: "1" }), deps) // first bundle
  if (step === "ENTER_RECIPIENT") return
  await hubtelRouter(req({ Message: "0244123456" }), deps)
}

describe("hubtelRouter: bad input keeps the session (review focus #5)", () => {
  it("re-shows the main menu on an out-of-range digit and on letters", async () => {
    const { deps, store } = makeDeps()
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    for (const bad of ["9", "abc"]) {
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Buy Data Bundle")
      expect(store.get("S1")?.step).toBe("MAIN")
    }
  })
  it("rejects a malformed recipient and stays on ENTER_RECIPIENT with a phone field", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(r.Message).toMatch(/invalid/i)
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
  })
  it("rejects a wrong-network recipient (prefix validation)", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "0200000000" }), deps) // Telecel number for an MTN bundle
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("looks like a Telecel number")
  })
  it("accepts 233… and +233… recipient formats, normalised to local", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "CONFIRM", recipientPhone: "0244123456" })
  })
})

describe("hubtelRouter: confirm → AddToCart", () => {
  it("creates the order + hubtel_transactions and returns AddToCart at our price", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps, store } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Data", Qty: 1, Price: 10 })
    expect(sup.inserts["ussd_orders"][0]).toMatchObject({
      dialing_phone: "+233200585542", recipient_phone: "0244123456", network: "MTN",
      package_id: "pkg-1", amount: 10, order_status: "pending", payment_status: "pending",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "ussd_orders", order_id: "11111111-1111-1111-1111-111111111111",
      expected_amount: 10, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("cancels without creating an order", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("refuses when the price changed since the menu was shown", async () => {
    const sup = fakeSupabase({ pkg: { price: 12, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/price changed/i)
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("marks the order failed and releases if hubtel_transactions cannot be written", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true }, txError: true })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.updates.some(u => u.table === "ussd_orders" && u.patch.order_status === "failed")).toBe(true)
  })
})

describe("hubtelRouter: other platforms", () => {
  const long = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, size: "x".repeat(40), price: 99.99 }))
  async function bundleScreen(platform: "USSD" | "Webstore", sessionId: string) {
    const { deps } = makeDeps({ fetchBundles: async () => ({ bundles: long, total: 5 }) })
    await hubtelRouter(req({ Type: "Initiation", SessionId: sessionId, Platform: platform }), deps)
    await hubtelRouter(req({ Message: "1", SessionId: sessionId, Platform: platform }), deps)
    return hubtelRouter(req({ Message: "1", SessionId: sessionId, Platform: platform }), deps)
  }
  it("truncates the long bundle menu on USSD to 182 chars ending in '...'", async () => {
    const r = await bundleScreen("USSD", "SU")
    expect(r.Message.endsWith("...")).toBe(true)
    expect(r.Message.length).toBe(182)
  })
  it("serves Webstore without truncating the same long menu", async () => {
    const r = await bundleScreen("Webstore", "SW")
    expect(r.Message.endsWith("...")).toBe(false)
    expect(r.Message.length).toBeGreaterThan(182)
  })
})
