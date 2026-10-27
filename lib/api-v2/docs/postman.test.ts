import { describe, it, expect } from "vitest"
import { buildPostmanCollection, buildPostmanEnvironment } from "./postman"
import { V2_BASE_URL, v2DocsRegistry, type V2Endpoint } from "./registry"

interface PmItem {
  name: string
  item?: PmItem[]
  request?: {
    method: string
    header: { key: string; value: string }[]
    url: { raw: string; host: string[]; path: string[]; variable?: { key: string; value: string }[] }
    body?: { mode: string; raw: string; options?: { raw: { language: string } } }
    description: string
  }
  event?: { listen: string; script: { exec: string[] } }[]
}

const collection = buildPostmanCollection(v2DocsRegistry, V2_BASE_URL) as {
  info: { name: string; schema: string; description?: string }
  variable: { key: string; value: string }[]
  item: PmItem[]
}

const allEndpoints = v2DocsRegistry.flatMap((s) => s.endpoints)
const requests = (): { folder: string; item: PmItem }[] =>
  collection.item.flatMap((f) => (f.item ?? []).map((item) => ({ folder: f.name, item })))

const findRequest = (ep: V2Endpoint) => {
  const matches = requests().filter((r) => r.item.name === `${ep.method} ${ep.path}`)
  return matches
}

describe("buildPostmanCollection", () => {
  it("declares a valid v2.1.0 info block", () => {
    expect(collection.info.schema).toBe("https://schema.getpostman.com/json/collection/v2.1.0/collection.json")
    expect(collection.info.name).toMatch(/Datagod/)
    expect(collection.info.description).toBeTruthy()
  })

  it("declares base_url and the three key variables", () => {
    const vars = Object.fromEntries(collection.variable.map((v) => [v.key, v.value]))
    expect(vars.base_url).toBe(V2_BASE_URL)
    for (const k of ["standard_key", "commission_key", "sms_key"]) expect(k in vars).toBe(true)
  })

  it("includes every registry endpoint exactly once (drift test)", () => {
    expect(allEndpoints.length).toBeGreaterThan(20)
    for (const ep of allEndpoints) {
      expect(findRequest(ep), `${ep.method} ${ep.path}`).toHaveLength(1)
    }
    expect(requests()).toHaveLength(allEndpoints.length)
  })

  it("makes one folder per registry section that has endpoints, named after the section", () => {
    const expected = v2DocsRegistry.filter((s) => s.endpoints.length > 0).map((s) => s.label)
    expect(collection.item.map((f) => f.name)).toEqual(expected)
  })

  it("uses {{base_url}} plus the path, with path params as :variables with sample values", () => {
    for (const ep of allEndpoints) {
      const { item } = findRequest(ep)[0]
      const url = item.request!.url
      const colonPath = ep.path.replace(/\{(\w+)\}/g, ":$1")
      expect(url.raw).toBe(`{{base_url}}${colonPath}`)
      expect(url.host).toEqual(["{{base_url}}"])
      expect(url.path.join("/")).toBe(colonPath.replace(/^\//, ""))
      expect(item.request!.method).toBe(ep.method)
      const params = [...ep.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      expect((url.variable ?? []).map((v) => v.key)).toEqual(params)
      for (const v of url.variable ?? []) expect(v.value).toBeTruthy()
    }
    const order = findRequest(allEndpoints.find((e) => e.path === "/orders/{reference}")!)[0].item
    expect(order.request!.url.raw).toBe("{{base_url}}/orders/:reference")
  })

  it("sends Authorization with the variable for the endpoint's key type", () => {
    for (const ep of allEndpoints) {
      const { item } = findRequest(ep)[0]
      const auth = item.request!.header.filter((h) => h.key === "Authorization")
      if (ep.keyType === null) expect(auth).toHaveLength(0)
      else expect(auth).toEqual([{ key: "Authorization", value: `{{${ep.keyType}_key}}`, type: "text" }])
    }
  })

  it("puts the requestExample in a raw JSON body for POST endpoints, and no body otherwise", () => {
    for (const ep of allEndpoints) {
      const { item } = findRequest(ep)[0]
      const body = item.request!.body
      if (ep.method === "POST" && ep.requestExample !== null) {
        expect(body?.mode).toBe("raw")
        expect(body?.options?.raw.language).toBe("json")
        expect(JSON.parse(body!.raw)).toEqual(ep.requestExample)
        expect(item.request!.header.some((h) => h.key === "Content-Type" && h.value === "application/json")).toBe(true)
      } else {
        expect(body).toBeUndefined()
      }
    }
  })

  it("describes each request with its summary, params table and errors", () => {
    for (const ep of allEndpoints) {
      const desc = findRequest(ep)[0].item.request!.description
      expect(desc).toContain(ep.summary)
      for (const p of ep.params) expect(desc).toContain(p.name)
      for (const e of ep.errors) expect(desc).toContain(String(e.status))
    }
  })

  it("adds a test script asserting the JSON envelope on every request", () => {
    for (const ep of allEndpoints) {
      const { item } = findRequest(ep)[0]
      const test = item.event?.find((e) => e.listen === "test")
      expect(test, ep.path).toBeTruthy()
      const script = test!.script.exec.join("\n")
      expect(script).toContain("pm.test")
      expect(script).toContain("success")
      expect(script).toContain("boolean")
    }
  })

  it("contains placeholders only, never a real-looking key", () => {
    const json = JSON.stringify(collection)
    expect(json).not.toMatch(/dg2_(?:cs_|sms_)?(?:test|live)_[0-9a-f]{16,}/)
    expect(json).not.toMatch(/dg_live_/)
  })
})

describe("buildPostmanEnvironment", () => {
  for (const kind of ["sandbox", "live"] as const) {
    it(`${kind} environment has the four variables with placeholder keys`, () => {
      const env = buildPostmanEnvironment(kind) as {
        name: string
        values: { key: string; value: string; enabled: boolean; type?: string }[]
        _postman_variable_scope: string
      }
      expect(env._postman_variable_scope).toBe("environment")
      expect(env.name).toBe(kind === "sandbox" ? "Datagod v2 Sandbox" : "Datagod v2 Live")
      const vars = Object.fromEntries(env.values.map((v) => [v.key, v.value]))
      expect(Object.keys(vars).sort()).toEqual(["base_url", "commission_key", "sms_key", "standard_key"])
      expect(vars.base_url).toBe(V2_BASE_URL)
      const mode = kind === "sandbox" ? "test" : "live"
      expect(vars.standard_key).toBe(`dg2_${mode}_your_api_key`)
      expect(vars.commission_key).toBe(`dg2_cs_${mode}_your_api_key`)
      expect(vars.sms_key).toBe(`dg2_sms_${mode}_your_api_key`)
      for (const v of env.values) expect(v.enabled).toBe(true)
      expect(JSON.stringify(env)).not.toMatch(/[0-9a-f]{32}/)
    })
  }
})
