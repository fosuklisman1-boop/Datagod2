import { describe, it, expect } from "vitest"
import { GET as getOpenApi } from "./openapi.json/route"
import { GET as getMarkdown } from "./api.md/route"
import { buildOpenApi } from "@/lib/api-v2/docs/openapi"
import { buildApiMarkdown } from "@/lib/api-v2/docs/api-markdown"

describe("docs routes", () => {
  it("serves openapi.json inline and cacheable", async () => {
    const res = await getOpenApi()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/application\/json/)
    expect(res.headers.get("content-disposition")).not.toMatch(/attachment/)
    expect(res.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi())))
  })

  it("serves api.md as markdown", async () => {
    const res = await getMarkdown()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/)
    expect(res.headers.get("content-disposition")).not.toMatch(/attachment/)
    expect(res.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await res.text()).toBe(buildApiMarkdown())
  })
})
