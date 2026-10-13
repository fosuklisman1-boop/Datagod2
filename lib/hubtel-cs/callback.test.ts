import { describe, it, expect, vi } from "vitest"
import {
  buildCallbackUrl, clientIpFromForwardedFor, isAllowedIp, parseCallbackBody, processCallback, signRef, verifySig,
} from "./callback"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, T0 } from "./testing/fixtures"

const SECRET = "s3cret"
const REF = "HCS-airtime_mtn-TESTREF1"

const body = (over: any = {}) => JSON.stringify({
  ResponseCode: "0000",
  Data: { AmountDebited: 0.5, TransactionId: "5b40e2e4", ClientReference: REF, Description: "GHC 0.50 sent", ExternalTransactionId: "2024012416592042208544402", Amount: 0.5, Charges: 0, Meta: { Commission: "0.0198" }, RecipientName: null, ...over.Data },
  ...(over.ResponseCode ? { ResponseCode: over.ResponseCode } : {}),
})

function setup(opts: { state?: any; enforceIp?: boolean; secret?: string } = {}) {
  const store = createMemoryStore()
  store.seed(makeTx({ state: opts.state ?? "pending", client_reference: REF }))
  const onTransition = vi.fn(async () => {})
  const deps = { store, secret: opts.secret ?? SECRET, enforceIp: opts.enforceIp ?? false, onTransition, now: () => T0 }
  const call = (over: Partial<{ ref: string | null; sig: string | null; ip: string | null; rawBody: string }> = {}) =>
    processCallback(deps, { ref: REF, sig: signRef(REF, SECRET), ip: "18.202.122.131", rawBody: body(), ...over })
  return { store, onTransition, call }
}

describe("signing", () => {
  it("round-trips and rejects tampering", () => {
    const sig = signRef(REF, SECRET)
    expect(verifySig(REF, sig, SECRET)).toBe(true)
    expect(verifySig(REF + "x", sig, SECRET)).toBe(false)
    expect(verifySig(REF, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), SECRET)).toBe(false)
    expect(verifySig(REF, "short", SECRET)).toBe(false)
    expect(verifySig(REF, null, SECRET)).toBe(false)
  })
  it("an empty secret never verifies (fail closed)", () => {
    expect(verifySig(REF, signRef(REF, ""), "")).toBe(false)
  })
  it("buildCallbackUrl embeds ref and a verifiable sig", () => {
    const u = new URL(buildCallbackUrl("https://app.example.com", REF, SECRET))
    expect(u.pathname).toBe("/api/hubtel-cs/callback")
    expect(u.searchParams.get("ref")).toBe(REF)
    expect(verifySig(REF, u.searchParams.get("sig"), SECRET)).toBe(true)
  })
})

describe("ip helpers", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(clientIpFromForwardedFor("18.202.122.131, 10.0.0.1")).toBe("18.202.122.131")
    expect(clientIpFromForwardedFor(" 1.2.3.4 ")).toBe("1.2.3.4")
    expect(clientIpFromForwardedFor(null)).toBeNull()
    expect(clientIpFromForwardedFor("")).toBeNull()
  })
  it("allows only Hubtel's callback IP", () => {
    expect(isAllowedIp("18.202.122.131")).toBe(true)
    expect(isAllowedIp("1.2.3.4")).toBe(false)
    expect(isAllowedIp(null)).toBe(false)
  })
})

describe("parseCallbackBody", () => {
  it("normalises the documented shape", () => {
    expect(parseCallbackBody(JSON.parse(body()))).toEqual({
      responseCode: "0000", clientReference: REF, transactionId: "5b40e2e4", externalTransactionId: "2024012416592042208544402",
      description: "GHC 0.50 sent", amountDebited: 0.5, charges: 0, commission: 0.0198,
    })
  })
  it("returns null without a ResponseCode or ClientReference", () => {
    expect(parseCallbackBody({})).toBeNull()
    expect(parseCallbackBody({ ResponseCode: "0000", Data: {} })).toBeNull()
    expect(parseCallbackBody("nope")).toBeNull()
  })
})

describe("processCallback", () => {
  it("401 on a bad signature and nothing changes", async () => {
    const { call, store, onTransition } = setup()
    const out = await call({ sig: "deadbeef" })
    expect(out.status).toBe(401)
    expect((await store.getByRef(REF))!.state).toBe("pending")
    expect(onTransition).not.toHaveBeenCalled()
  })
  it("401 when the server secret is empty", async () => {
    const { call } = setup({ secret: "" })
    expect((await call()).status).toBe(401)
  })
  it("ip enforcement: 403 for a foreign ip, missing ip, passes for Hubtel's", async () => {
    const { call } = setup({ enforceIp: true })
    expect((await call({ ip: "1.2.3.4" })).status).toBe(403)
    expect((await call({ ip: null })).status).toBe(403)
    expect((await call({ ip: "18.202.122.131" })).status).toBe(200)
  })
  it("ip is ignored when enforcement is off", async () => {
    const { call } = setup({ enforceIp: false })
    expect((await call({ ip: "1.2.3.4" })).status).toBe(200)
  })
  it("400 for invalid JSON and for a body/query reference mismatch", async () => {
    const { call } = setup()
    expect((await call({ rawBody: "{not json" })).status).toBe(400)
    expect((await call({ rawBody: body({ Data: { ClientReference: "OTHER" } }) })).status).toBe(400)
  })
  it("0000 settles the row once: fulfilled, commission stored, hook fired", async () => {
    const { call, store, onTransition } = setup()
    const out = await call()
    expect(out.status).toBe(200)
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("fulfilled")
    expect(tx.commission).toBe(0.0198)
    expect(tx.external_transaction_id).toBe("2024012416592042208544402")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a duplicate callback is acknowledged but ignored (hook not re-fired)", async () => {
    const { call, onTransition } = setup()
    await call()
    const again = await call()
    expect(again.status).toBe(200)
    expect(again.body.ignored).toMatch(/already fulfilled/)
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a failure callback marks failed with Hubtel's Description", async () => {
    const { call, store } = setup()
    await call({ rawBody: body({ ResponseCode: "2001", Data: { Description: "The receiving user is not registered in the system" } }) })
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("failed")
    expect(tx.failure_reason).toBe("The receiving user is not registered in the system")
  })
  it("a row resolved by an admin ignores later callbacks", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ state: "failed", client_reference: REF, resolved_at: T0.toISOString() }))
    const out = await processCallback(
      { store, secret: SECRET, enforceIp: false, onTransition: async () => {}, now: () => T0 },
      { ref: REF, sig: signRef(REF, SECRET), ip: null, rawBody: body() }
    )
    expect(out.body.ignored).toBeTruthy()
    expect((await store.getByRef(REF))!.state).toBe("failed")
  })
  it("an unknown reference with a valid signature answers 200 ok:false (stops Hubtel retries)", async () => {
    const store = createMemoryStore()
    const out = await processCallback(
      { store, secret: SECRET, enforceIp: false, onTransition: async () => {}, now: () => T0 },
      { ref: REF, sig: signRef(REF, SECRET), ip: null, rawBody: body() }
    )
    expect(out).toEqual({ status: 200, body: { ok: false, error: "unknown reference" } })
  })
  it("logs authenticated callbacks as events", async () => {
    const { call, store } = setup()
    await call()
    expect(store.events.some(e => e.direction === "callback" && e.client_reference === REF)).toBe(true)
  })
})
