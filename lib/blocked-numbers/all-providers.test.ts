import { describe, it, expect } from "vitest"
import { checkAllProviders } from "./all-providers"

type Row = { msisdn: string; allowed: boolean }
const entry = (name: string, batch: (m: string[]) => Promise<Row[]>, configured = true) => ({
  name,
  configured: () => configured,
  check: async () => ({ allowed: true, provider: name }),
  checkBatch: batch,
  checkBatchStrict: batch,
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

  it("excludes unconfigured providers and keeps registry order; uses the strict batch", async () => {
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

  it("an entry without checkBatchStrict is error, never silently allowed from a fail-open checkBatch", async () => {
    const lenient = { name: "len", configured: () => true, check: async () => ({ allowed: true, provider: "len" }), checkBatch: async (m: string[]) => m.map((x) => ({ msisdn: x, allowed: true })) }
    const r = await checkAllProviders(["0241234567"], { registry: [lenient], getSettings: settings(["len"]) })
    expect(r.rows[0].results.len).toBe("error")
    expect(r.rows[0].allowedByCheckout).toBe(false)
  })

  it("chunks of 10 phones, one call per chunk", async () => {
    const sizes: number[] = []
    const phones = Array.from({ length: 25 }, (_, i) => `024${String(1000000 + i)}`)
    await checkAllProviders(phones, {
      registry: [entry("a", async (m) => { sizes.push(m.length); return m.map((x) => ({ msisdn: x, allowed: true })) })],
      getSettings: settings([]),
    })
    expect(sizes.sort()).toEqual([10, 10, 5])
  })

  it("a slow provider past the start deadline keeps finished chunks and errors the rest; no chunk starts after it", async () => {
    let t = 0
    let calls = 0
    const phones = ["0241000001", "0241000002", "0241000003", "0241000004"]
    const r = await checkAllProviders(phones, {
      registry: [entry("a", async (m) => { calls++; t += 25_000; return m.map((x) => ({ msisdn: x, allowed: true })) })],
      getSettings: settings([]),
      now: () => t,
      chunkSize: 1,
      concurrency: 1,
    })
    expect(calls).toBe(2)
    expect(r.rows.map((x) => x.results.a)).toEqual(["allowed", "allowed", "error", "error"])
  })

  it("reports providers that errored for every phone as failedProviders", async () => {
    const r = await checkAllProviders(["0241234567"], {
      registry: [entry("bad", async () => { throw new Error("x") }), entry("ok", async () => [{ msisdn: "0241234567", allowed: false }])],
      getSettings: settings([]),
    })
    expect(r.failedProviders).toEqual(["bad"])
  })
})
