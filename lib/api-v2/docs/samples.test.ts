import { describe, it, expect } from "vitest"
import { buildSamples, shellQuote } from "./samples"
import { V2_BASE_URL, v2DocsRegistry, type V2Endpoint } from "./registry"

const getEndpoint = (): V2Endpoint => {
  const ep = v2DocsRegistry.flatMap((s) => s.endpoints).find((e) => e.path === "/account/role")
  if (!ep) throw new Error("missing endpoint")
  return ep
}

const postEndpoint: V2Endpoint = {
  id: "test-post",
  group: "data",
  method: "POST",
  path: "/data/purchase",
  keyType: "standard",
  rateLimit: "10 requests per minute",
  summary: "Test purchase",
  params: [],
  requestExample: { reference: "ord_123", phone: "0241234567", size_gb: 1 },
  successExample: { ok: true },
  errors: [],
  notes: [],
}

describe("shellQuote", () => {
  it("escapes single quotes", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'")
  })
})

describe("buildSamples", () => {
  it("builds a body-less curl for GET", () => {
    const s = buildSamples(getEndpoint())
    expect(V2_BASE_URL).toBe("https://api.datagod.store/v2")
    expect(s.curl).toContain('-H "Authorization: dg2_live_your_api_key"')
    expect(s.curl).toContain("https://api.datagod.store/v2/account/role")
    expect(s.curl).not.toContain("-d")
    expect(Object.keys(s).sort()).toEqual(["curl", "node", "php", "python"])
  })

  it("includes body and content type in every language for POST", () => {
    const s = buildSamples(postEndpoint)
    for (const lang of ["curl", "node", "php", "python"] as const) {
      expect(s[lang]).toContain('"reference": "ord_123"')
      expect(s[lang]).toContain("Content-Type")
      expect(s[lang]).toContain("https://api.datagod.store/v2/data/purchase")
    }
    expect(s.node).toContain("fetch(")
    expect(s.php).toContain("curl_init")
    expect(s.python).toContain("requests")
  })

  it("escapes hostile key placeholders per language", () => {
    const key = `a"b$c\\d'e`
    const s = buildSamples(getEndpoint(), { keyPlaceholder: key })
    expect(s.curl).toContain(`-H 'Authorization: a"b$c\\d'\\''e'`)
    expect(s.php).toContain(`'Authorization: a"b$c\\\\d\\'e'`)
    expect(s.python).toContain(JSON.stringify(key))
    expect(s.node).toContain(JSON.stringify(key))
  })

  it("honours a custom base url", () => {
    const s = buildSamples(getEndpoint(), { baseUrl: "http://localhost:3000/api/v2" })
    expect(s.curl).toContain("http://localhost:3000/api/v2/account/role")
  })
})
