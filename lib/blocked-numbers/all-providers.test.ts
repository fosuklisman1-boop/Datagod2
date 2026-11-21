import { describe, it, expect } from "vitest"
import { checkAllProviders } from "./all-providers"

type Row = { msisdn: string; allowed: boolean }
const entry = (name: string, batch: (m: string[]) => Promise<Row[]>, configured = true) => ({
  name,
  configured: () => configured,
  check: async () => ({ allowed: true, provider: name }),
  checkBatch: batch,
})
const settings = (providers: string[]) => async () => ({ enabled: true, providers })

describe("checkAllProviders", () => {
  it("matches results by normalised number even when the provider echoes another format", async () => {
    const r = await checkAllProviders(["0241234567"], {
      registry: [entry("a", async () => [{ msisdn: "233241234567", allowed: true }])],
      getSettings: settings(["a"]),
    })
    expect(r.rows[0].results.a).toBe("allowed")
  })

  it("a throw is error for every cell of that provider, never allowed", async () => {
    const r = await checkAllProviders(["0241234567", "0551234567"], {
      registry: [entry("a", async () => { throw new Error("boom") })],
      getSettings: settings(["a"]),
    })
    expect(r.rows.map((x) => x.results.a)).toEqual(["error", "error"])
  })

  it("a phone missing from the provider answer is error", async () => {
    const r = await checkAllProviders(["0241234567", "0551234567"], {
      registry: [entry("a", async () => [{ msisdn: "0241234567", allowed: false }])],
      getSettings: settings(["a"]),
    })
    expect(r.rows[0].results.a).toBe("refused")
    expect(r.rows[1].results.a).toBe("error")
  })

  it("a provider that exceeds the timeout is error for all cells; others still answer", async () => {
    const r = await checkAllProviders(["0241234567"], {
      registry: [
        entry("slow", () => new Promise(() => {})),
        entry("fast", async () => [{ msisdn: "0241234567", allowed: true }]),
      ],
      getSettings: settings(["fast"]),
      timeoutMs: 20,
    })
    expect(r.rows[0].results).toEqual({ slow: "error", fast: "allowed" })
  })

  it("allowed only outside the checkout list never counts as allowedByCheckout", async () => {
    const r = await checkAllProviders(["0241234567"], {
      registry: [
        entry("checkout", async () => [{ msisdn: "0241234567", allowed: false }]),
        entry("other", async () => [{ msisdn: "0241234567", allowed: true }]),
      ],
      getSettings: settings(["checkout"]),
    })
    expect(r.rows[0].allowedByCheckout).toBe(false)
    expect(r.rows[0].allowedOutsideCheckout).toEqual(["other"])
  })

  it("allowed by a checkout provider sets allowedByCheckout", async () => {
    const r = await checkAllProviders(["0241234567"], {
      registry: [
        entry("checkout", async () => [{ msisdn: "0241234567", allowed: true }]),
        entry("other", async () => [{ msisdn: "0241234567", allowed: true }]),
      ],
      getSettings: settings(["checkout"]),
    })
    expect(r.rows[0].allowedByCheckout).toBe(true)
    expect(r.rows[0].allowedOutsideCheckout).toEqual(["other"])
    expect(r.checkoutProviders).toEqual(["checkout"])
  })

  it("excludes unconfigured providers and keeps registry order; prefers strict batch", async () => {
    let strictCalls = 0
    const strict = { ...entry("b", async () => { throw new Error("lenient used") }), checkBatchStrict: async () => { strictCalls++; return [{ msisdn: "0241234567", allowed: true }] } }
    const r = await checkAllProviders(["0241234567"], {
      registry: [entry("a", async () => [], false), strict, entry("c", async () => [{ msisdn: "0241234567", allowed: false }])],
      getSettings: settings(["a", "b"]),
    })
    expect(r.providers).toEqual(["b", "c"])
    expect(r.checkoutProviders).toEqual(["b"])
    expect(strictCalls).toBe(1)
  })
})
