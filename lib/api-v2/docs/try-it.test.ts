import { describe, it, expect, vi } from "vitest"
import {
  TRY_IT_MAX_DISPLAY,
  checkTestKey,
  pathParamNames,
  buildTryItRequest,
  summariseResponse,
  runTryIt,
} from "./try-it"
import { v2DocsRegistry } from "./registry"

const eps = v2DocsRegistry.flatMap((s) => s.endpoints)
const purchase = eps.find((e) => e.id === "data-purchase")!
const lookup = eps.find((e) => e.path === "/orders/{reference}")!
const KEY = "dg2_test_ab12"

describe("checkTestKey", () => {
  it("accepts the three test prefixes and trims", () => {
    for (const k of ["dg2_test_ab12", "dg2_cs_test_ab12", "dg2_sms_test_ab12"]) expect(checkTestKey(k)).toEqual({ ok: true, key: k })
    expect(checkTestKey("  dg2_test_ab12\n")).toEqual({ ok: true, key: "dg2_test_ab12" })
  })
  it("refuses live keys, empty and invalid", () => {
    for (const k of ["dg2_live_ab12", "dg2_cs_live_ab12", "dg2_sms_live_ab12", "dg_live_abc"]) expect(checkTestKey(k)).toEqual({ ok: false, reason: "live" })
    for (const k of ["", "   "]) expect(checkTestKey(k)).toEqual({ ok: false, reason: "empty" })
    for (const k of ["dg2_test_XYZ", "Bearer dg2_test_ab", "dg2_test_ab12 extra", "dg2_testx_ab12"]) expect(checkTestKey(k)).toEqual({ ok: false, reason: "invalid" })
  })
  it("reason never contains the input", () => {
    for (const k of ["SENTINELxyz", "dg2_live_SENTINEL1", "dg_live_SENTINEL2"]) {
      const r = checkTestKey(k)
      if (r.ok) throw new Error("should refuse")
      expect(["empty", "live", "invalid"]).toContain(r.reason)
      expect(JSON.stringify(r)).not.toContain("SENTINEL")
    }
  })
})

describe("buildTryItRequest", () => {
  it("builds the purchase POST", () => {
    const r = buildTryItRequest(purchase, { key: KEY, pathParams: {}, body: JSON.stringify(purchase.requestExample) })
    if (!r.ok) throw new Error(r.error)
    expect(r.url).toBe("/api/v2/data/purchase")
    expect(r.init.method).toBe("POST")
    expect(r.init.headers).toEqual({ Authorization: KEY, "Content-Type": "application/json" })
    expect(r.init.credentials).toBe("omit")
    expect(r.init.cache).toBe("no-store")
    expect(r.init.redirect).toBe("error")
  })
  it("encodes path params and names missing ones", () => {
    expect(pathParamNames("/orders/{reference}")).toEqual(["reference"])
    const r = buildTryItRequest(lookup, { key: KEY, pathParams: { reference: "A/B?c#d e" }, body: "" })
    if (!r.ok) throw new Error(r.error)
    expect(r.url).toBe("/api/v2/orders/A%2FB%3Fc%23d%20e")
    const missing = buildTryItRequest(lookup, { key: KEY, pathParams: {}, body: "" })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain("reference")
    expect(buildTryItRequest(lookup, { key: KEY, pathParams: { reference: "   " }, body: "" }).ok).toBe(false)
  })
  it("rejects bad JSON, omits body when no example, never sends GET body", () => {
    const bad = buildTryItRequest(purchase, { key: KEY, pathParams: {}, body: "{nope" })
    expect(bad.ok).toBe(false)
    const none = buildTryItRequest({ method: "POST", path: "/x", requestExample: null }, { key: KEY, pathParams: {}, body: '{"a":1}' })
    if (!none.ok) throw new Error(none.error)
    expect(none.init.body).toBeUndefined()
    expect(none.init.headers).toEqual({ Authorization: KEY })
    const get = buildTryItRequest(lookup, { key: KEY, pathParams: { reference: "r1" }, body: '{"a":1}' })
    if (!get.ok) throw new Error(get.error)
    expect(get.init.body).toBeUndefined()
    expect((get.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined()
  })
  it("url stays same-origin and traversal is encoded", () => {
    const r = buildTryItRequest(lookup, { key: KEY, pathParams: { reference: "../admin" }, body: "" })
    if (!r.ok) throw new Error(r.error)
    expect(r.url).toBe("/api/v2/orders/..%2Fadmin")
    expect(r.url.startsWith("http")).toBe(false)
    expect(r.url.startsWith("//")).toBe(false)
    expect(r.url).not.toContain("../")
  })
  it("refuses a non-test key even if called directly", () => {
    expect(buildTryItRequest(purchase, { key: "dg2_live_ab12", pathParams: {}, body: "{}" }).ok).toBe(false)
  })
})

describe("summariseResponse", () => {
  it("pretty prints JSON", () => {
    const r = summariseResponse(200, 5, '{"a":1}', "application/json")
    expect(r.kind).toBe("json")
    expect(r.display).toBe('{\n  "a": 1\n}')
  })
  it("html is text, empty is empty, bad json is text", () => {
    expect(summariseResponse(502, 5, "<html>x</html>", "text/html")).toMatchObject({ kind: "text", display: "<html>x</html>" })
    expect(summariseResponse(204, 5, "", null).kind).toBe("empty")
    expect(summariseResponse(200, 5, "{bad", "application/json").kind).toBe("text")
  })
  it("truncates", () => {
    const r = summariseResponse(200, 5, "x".repeat(TRY_IT_MAX_DISPLAY + 10), "text/plain")
    expect(r.truncated).toBe(true)
    expect(r.display.length).toBeLessThanOrEqual(TRY_IT_MAX_DISPLAY)
  })
})

describe("runTryIt", () => {
  const req = () => {
    const r = buildTryItRequest(purchase, { key: KEY, pathParams: {}, body: JSON.stringify(purchase.requestExample) })
    if (!r.ok) throw new Error(r.error)
    return r
  }
  it("returns status and elapsed from injected clock", async () => {
    const times = [100, 350]
    const f = vi.fn(async () => new Response('{"success":true}', { status: 201, headers: { "content-type": "application/json" } }))
    const r = await runTryIt(req(), f as unknown as typeof fetch, () => times.shift()!)
    expect(r.status).toBe(201)
    expect(r.elapsedMs).toBe(250)
    expect(r.kind).toBe("json")
  })
  it("never throws on rejected fetch or text()", async () => {
    const e = new TypeError("secret dg2_test_ab12 detail")
    const r1 = await runTryIt(req(), (async () => {
      throw e
    }) as unknown as typeof fetch)
    expect(r1).toMatchObject({ status: null, kind: "network-error" })
    expect(r1.display).toContain("TypeError")
    expect(r1.display).not.toContain(KEY)
    const bad = { status: 200, headers: new Headers(), text: () => Promise.reject(new Error("boom")) }
    const r2 = await runTryIt(req(), (async () => bad) as unknown as typeof fetch)
    expect(r2.kind).toBe("network-error")
  })
  it("key only goes to init.headers", async () => {
    const f = vi.fn(
      async (_u: string, init: RequestInit) =>
        new Response(JSON.stringify({ echo: (init.headers as Record<string, string>).Authorization }), { headers: { "content-type": "application/json" } })
    )
    const r = await runTryIt(req(), f as unknown as typeof fetch)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).not.toContain(KEY)
    expect(JSON.stringify(f.mock.calls[0][1]).split(KEY).length).toBe(2)
    expect(r.display).not.toContain(KEY)
  })
})
