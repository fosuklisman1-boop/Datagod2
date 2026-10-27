import { describe, it, expect } from "vitest"
import { GET as getCollection } from "./collection/route"
import { GET as getSandbox } from "./sandbox-environment/route"
import { GET as getLive } from "./live-environment/route"

const cases = [
  { name: "collection", handler: getCollection, file: "datagod-v2.postman_collection.json" },
  { name: "sandbox environment", handler: getSandbox, file: "datagod-v2-sandbox.postman_environment.json" },
  { name: "live environment", handler: getLive, file: "datagod-v2-live.postman_environment.json" },
]

describe("postman download routes", () => {
  for (const c of cases) {
    it(`${c.name} returns JSON as an attachment, cacheable for 5 minutes`, async () => {
      const res = await c.handler()
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toMatch(/application\/json/)
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${c.file}"`)
      expect(res.headers.get("cache-control")).toBe("public, max-age=300")
      const body = await res.json()
      expect(typeof body).toBe("object")
    })
  }

  it("collection body is a v2.1 collection and environments are named", async () => {
    const coll = await (await getCollection()).json()
    expect(coll.info.schema).toContain("v2.1.0")
    expect((await (await getSandbox()).json()).name).toBe("Datagod v2 Sandbox")
    expect((await (await getLive()).json()).name).toBe("Datagod v2 Live")
  })
})
