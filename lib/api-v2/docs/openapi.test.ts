import { describe, it, expect } from "vitest"
import { buildOpenApi, inferSchema, schemaForParamType } from "./openapi"
import { V2_BASE_URL, v2DocsRegistry } from "./registry"
import { DOC_PAGES, pageSlugForSection } from "./pages"

type Json = Record<string, any>
const doc = buildOpenApi(v2DocsRegistry, V2_BASE_URL) as unknown as Json
const endpoints = v2DocsRegistry.flatMap((s) => s.endpoints.map((e) => ({ s, e })))
const opFor = (e: { path: string; method: string }): Json => doc.paths[e.path][e.method.toLowerCase()]

describe("buildOpenApi", () => {
  it("has the 3.1.0 header, info and server", () => {
    expect(doc.openapi).toBe("3.1.0")
    expect(doc.info.title).toBeTruthy()
    expect(doc.info.version).toBeTruthy()
    expect(doc.servers[0].url).toBe(V2_BASE_URL)
  })

  it("has one operation per registry endpoint, keyed by path and lowercase method", () => {
    expect(endpoints).toHaveLength(30)
    for (const { e } of endpoints) expect(opFor(e)).toBeTruthy()
    const count = Object.values(doc.paths as Json).reduce((n: number, p: any) => n + Object.keys(p).length, 0)
    expect(count).toBe(30)
  })

  it("uses the endpoint id as a unique operationId, the page title as tag, and carries every note", () => {
    const ids = new Set<string>()
    for (const { s, e } of endpoints) {
      const op = opFor(e)
      expect(op.operationId).toBe(e.id)
      ids.add(op.operationId)
      const slug = pageSlugForSection(s.id)
      expect(op.tags).toEqual([DOC_PAGES.find((p) => p.slug === slug)!.title])
      for (const n of e.notes) expect(op.description).toContain(n)
    }
    expect(ids.size).toBe(30)
  })

  it("derives path params from {x}, GET query params, and POST body", () => {
    for (const { e } of endpoints) {
      const op = opFor(e)
      const names = [...e.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
      const pathParams = (op.parameters ?? []).filter((p: Json) => p.in === "path")
      expect(pathParams.map((p: Json) => p.name).sort()).toEqual([...names].sort())
      for (const p of pathParams) expect(p.required).toBe(true)
      const rest = e.params.filter((p) => !names.includes(p.name))
      if (e.method === "GET") {
        const q = (op.parameters ?? []).filter((p: Json) => p.in === "query")
        expect(q.map((p: Json) => p.name)).toEqual(rest.map((p) => p.name))
        expect(op.requestBody).toBeUndefined()
      } else if (rest.length > 0) {
        const body = op.requestBody.content["application/json"]
        expect(Object.keys(body.schema.properties).sort()).toEqual(rest.map((p) => p.name).sort())
        expect([...(body.schema.required ?? [])].sort()).toEqual(
          rest.filter((p) => p.required).map((p) => p.name).sort(),
        )
        if (e.requestExample) expect(body.example).toEqual(e.requestExample)
      }
    }
  })

  it("documents every distinct error status with its messages as examples", () => {
    for (const { e } of endpoints) {
      const op = opFor(e)
      for (const status of new Set(e.errors.map((x) => x.status))) {
        const res = op.responses[String(status)]
        expect(res, `${e.id} ${status}`).toBeTruthy()
        expect(res.content["application/json"].schema.$ref).toBe("#/components/schemas/Error")
        const blob = JSON.stringify(res.content["application/json"].examples)
        for (const err of e.errors.filter((x) => x.status === status)) {
          expect(blob).toContain(JSON.stringify(err.message).slice(1, -1))
        }
      }
    }
  })

  it("defines the three security schemes and secures every operation", () => {
    const s = doc.components.securitySchemes
    expect(s.ApiKeyAuth).toMatchObject({ type: "apiKey", in: "header", name: "Authorization" })
    expect(s.BearerAuth).toMatchObject({ type: "http", scheme: "bearer" })
    expect(s.XApiKey).toMatchObject({ type: "apiKey", in: "header", name: "X-API-Key" })
    for (const { e } of endpoints) {
      expect(e.keyType).not.toBeNull()
      expect(opFor(e).security.length).toBeGreaterThan(0)
    }
  })

  it("names the key type in the description", () => {
    for (const { e } of endpoints) {
      if (e.keyType === "sms") expect(opFor(e).description).toMatch(/SMS key/)
      if (e.keyType === "standard") expect(opFor(e).description).toMatch(/standard key/i)
      if (e.keyType === "commission") expect(opFor(e).description).toMatch(/commission key/i)
    }
  })

  it("has a 200 success response with the registry example and an inferred schema, plus 201 where notes say so", () => {
    for (const { e } of endpoints) {
      const op = opFor(e)
      const ok = op.responses["200"].content["application/json"]
      expect(ok.example).toEqual(e.successExample)
      expect(ok.schema.type).toBe("object")
      expect(Boolean(op.responses["201"])).toBe(e.notes.some((n) => /HTTP 201/.test(n)))
    }
  })

  it("infers schemas from examples", () => {
    const s = inferSchema({ a: 1, b: ["x"], c: null, d: 1.5, e: true }) as Json
    expect(s.properties.a.type).toBe("integer")
    expect(s.properties.b).toMatchObject({ type: "array", items: { type: "string" } })
    expect(s.properties.c.type).toBe("null")
    expect(s.properties.d.type).toBe("number")
    expect(s.properties.e.type).toBe("boolean")
  })

  it("maps param types and keeps unknown ones as a note in the description", () => {
    expect(schemaForParamType("string[]").schema).toEqual({ type: "array", items: { type: "string" } })
    expect(schemaForParamType("array").schema.type).toBe("array")
    const r = schemaForParamType("Ghana Card")
    expect(r.schema.type).toBe("string")
    expect(r.note).toContain("Ghana Card")
    const base = v2DocsRegistry.flatMap((s) => s.endpoints).find((e) => e.method === "POST" && e.params.length > 0)!
    const custom = buildOpenApi(
      [
        {
          id: "x",
          label: "X",
          group: "data",
          endpoints: [{ ...base, path: "/x", params: [{ name: "idt", type: "Ghana Card", required: true, description: "ID." }] }],
        },
      ],
      V2_BASE_URL,
    ) as unknown as Json
    expect(custom.paths["/x"].post.requestBody.content["application/json"].schema.properties.idt.description).toBe(
      `ID. ${r.note}`,
    )
  })

  it("has no undefined values", () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc)
  })

  it("passes a structural check: refs resolve, path params present, required fields", () => {
    expect(doc.info && doc.paths && doc.openapi).toBeTruthy()
    const resolve = (ref: string) =>
      ref
        .replace(/^#\//, "")
        .split("/")
        .reduce((o: any, k) => o?.[k], doc)
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (n && typeof n === "object") {
        const o = n as Json
        if (typeof o.$ref === "string") expect(resolve(o.$ref), o.$ref).toBeTruthy()
        Object.values(o).forEach(walk)
      }
    }
    walk(doc)
    for (const [path, item] of Object.entries(doc.paths as Json)) {
      for (const op of Object.values(item as Json)) {
        for (const p of ((op as Json).parameters ?? []).filter((x: Json) => x.in === "path")) {
          expect(path).toContain(`{${p.name}}`)
        }
        expect((op as Json).responses).toBeTruthy()
      }
    }
  })
})
