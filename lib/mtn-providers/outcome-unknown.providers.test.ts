import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const fakeSettings = vi.hoisted(() => ({ current: {} as Record<string, any> }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      return {
        select() {
          return {
            eq(_c: string, key: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({ data: fakeSettings.current[key] ? { value: fakeSettings.current[key] } : null, error: null }),
              }
            },
          }
        },
      }
    },
  },
}))

import { ApexPrimeProvider } from "./apexprime-provider"
import { SykesProvider } from "./sykes-provider"
import { DataKazinaProvider } from "./datakazina-provider"
import { EazyGhDataProvider } from "./eazyghdata-provider"
import { CodeCraftMTNProvider } from "./codecraft-provider"
import { BisdelProvider } from "./bisdel-provider"
import { XpressProvider } from "./xpress-provider"

const req = { recipient_phone: "0551234567", network: "MTN" as const, size_gb: 1, client_ref: "ord-1" }

function stubFetch(handler: (url: string, init?: any) => Response | Promise<Response>) {
  const f = vi.fn(async (url: any, init?: any) => handler(String(url), init))
  vi.stubGlobal("fetch", f)
  return f
}

beforeEach(() => {
  fakeSettings.current = {}
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Apex Prime — outcome unknown", () => {
  it("500 HTML on the group-share order POST is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 500 }))
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(r.message).toContain("Check the Apex Prime dashboard before retrying")
  })

  it("network error after the order POST is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => {
      throw new Error("socket hang up")
    })
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(r.message).toContain("returned no response")
  })

  it("explicit JSON rejection stays an ordinary failure", async () => {
    stubFetch(() => new Response(JSON.stringify({ success: false, message: "Insufficient balance" }), { status: 400 }))
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("API_ERROR")
    expect(r.message).toBe("Insufficient balance")
  })

  it("store path: non-JSON /store-products (before the order) is an ordinary failure", async () => {
    fakeSettings.current = { apexprime_mtn_fulfillment_path: { path: "store" } }
    const f = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }))
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("API_ERROR")
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("store path: 500 HTML on /store-order is OUTCOME_UNKNOWN", async () => {
    fakeSettings.current = { apexprime_mtn_fulfillment_path: { path: "store" } }
    stubFetch((url) =>
      url.endsWith("/store-products")
        ? new Response(JSON.stringify({ success: true, data_products: [{ product_id: 14, type: "data", network: "MTN", gb_amount: 1 }] }), { status: 200 })
        : new Response("<html>oops</html>", { status: 500 })
    )
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("success JSON still succeeds", async () => {
    stubFetch(() => new Response(JSON.stringify({ success: true, order_id: 77 }), { status: 200 }))
    const r = await new ApexPrimeProvider().createOrder(req)
    expect(r.success).toBe(true)
    expect(r.order_id).toBe("bundle:77")
  })
})

describe("Sykes — outcome unknown", () => {
  it("non-JSON order reply is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => new Response("Service Unavailable", { status: 200 }))
    const r = await new SykesProvider().createOrder(req)
    expect(r.success).toBe(false)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(r.message).toContain("dashboard before retrying")
  })

  it("fetch throwing after send is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => {
      throw new Error("timeout")
    })
    const r = await new SykesProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("explicit JSON rejection stays ordinary", async () => {
    stubFetch(() => new Response(JSON.stringify({ success: false, message: "bad phone" }), { status: 200 }))
    const r = await new SykesProvider().createOrder(req)
    expect(r.error_type).toBe("API_ERROR")
    expect(r.message).toBe("bad phone")
  })
})

describe("DataKazina — outcome unknown", () => {
  it("non-JSON order reply is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => new Response("not json", { status: 200 }))
    const r = await new DataKazinaProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("HTML 500 is OUTCOME_UNKNOWN", async () => {
    stubFetch(() => new Response("<!DOCTYPE html><html>x</html>", { status: 500 }))
    const r = await new DataKazinaProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("fetch throwing is OUTCOME_UNKNOWN and is NOT re-sent", async () => {
    const f = stubFetch(() => {
      throw new Error("ECONNRESET")
    })
    const r = await new DataKazinaProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("explicit JSON rejection stays ordinary", async () => {
    stubFetch(() => new Response(JSON.stringify({ success: false, message: "Insufficient wallet" }), { status: 200 }))
    const r = await new DataKazinaProvider().createOrder(req)
    expect(r.error_type).toBe("API_ERROR")
  })
})

const connErr = (code: string) => {
  const e: any = new Error("fetch failed")
  e.cause = { code }
  return e
}

describe("DataKazina — never-reached classes are ordinary", () => {
  it("ENOTFOUND is an ordinary NETWORK_ERROR (one call)", async () => {
    const f = stubFetch(() => { throw connErr("ENOTFOUND") })
    const r = await new DataKazinaProvider().createOrder(req)
    expect(r.error_type).toBe("NETWORK_ERROR")
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("ECONNRESET stays unknown", async () => {
    stubFetch(() => { throw connErr("ECONNRESET") })
    expect((await new DataKazinaProvider().createOrder(req)).error_type).toBe("OUTCOME_UNKNOWN")
  })
  it("non-JSON 403 is ordinary", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }))
    expect((await new DataKazinaProvider().createOrder(req)).error_type).toBe("API_ERROR")
  })
})

describe("EazyGhData — no resend", () => {
  beforeEach(() => {
    fakeSettings.current = { eazyghdata_packages: { packages: [{ id: "p1", network: "MTN", size_gb: 1 }] } }
  })
  it("throw after send is unknown and fetch is called once", async () => {
    const f = stubFetch(() => { throw connErr("ECONNRESET") })
    const r = await new EazyGhDataProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("non-JSON 200 is unknown, ENOTFOUND is ordinary", async () => {
    stubFetch(() => new Response("oops", { status: 200 }))
    expect((await new EazyGhDataProvider().createOrder(req)).error_type).toBe("OUTCOME_UNKNOWN")
    stubFetch(() => { throw connErr("ENOTFOUND") })
    expect((await new EazyGhDataProvider().createOrder(req)).error_type).toBe("NETWORK_ERROR")
  })
})

describe("CodeCraft — no resend", () => {
  it("throw after send is unknown and fetch is called once", async () => {
    const f = stubFetch(() => { throw connErr("ECONNRESET") })
    const r = await new CodeCraftMTNProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("documented status 500 body is unknown with one call", async () => {
    const f = stubFetch(() => new Response(JSON.stringify({ status: 500, message: "x" }), { status: 200 }))
    expect((await new CodeCraftMTNProvider().createOrder(req)).error_type).toBe("OUTCOME_UNKNOWN")
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe("Bisdel — no resend", () => {
  beforeEach(() => {
    fakeSettings.current = {
      bisdel_packages: { packages: [{ product_id: 5, network: "MTN", category: "c", data_volume: "1GB" }] },
      bisdel_category: { category: "c" },
    }
  })
  it("throw after send is unknown and fetch is called once", async () => {
    const f = stubFetch(() => { throw connErr("ECONNRESET") })
    const r = await new BisdelProvider().createOrder(req)
    expect(r.error_type).toBe("OUTCOME_UNKNOWN")
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("non-JSON 502 unknown; ECONNREFUSED ordinary", async () => {
    stubFetch(() => new Response("<html/>", { status: 502 }))
    expect((await new BisdelProvider().createOrder(req)).error_type).toBe("OUTCOME_UNKNOWN")
    stubFetch(() => { throw connErr("ECONNREFUSED") })
    expect((await new BisdelProvider().createOrder(req)).error_type).toBe("NETWORK_ERROR")
  })
})

describe("Xpress", () => {
  it("2xx JSON without order_id is unknown", async () => {
    stubFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    expect((await new XpressProvider().createOrder(req)).error_type).toBe("OUTCOME_UNKNOWN")
  })
})
