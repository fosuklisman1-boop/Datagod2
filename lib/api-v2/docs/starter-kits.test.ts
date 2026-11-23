import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { STARTER_KITS, getStarterKit, starterKitResponse } from "./starter-kits"
import { v2DocsRegistry, V2_BASE_URL, type V2Endpoint } from "./registry"
import { GET as getKit } from "@/app/developers/starter-kits/[kit]/route"

const endpoints: V2Endpoint[] = v2DocsRegistry.flatMap((s) => s.endpoints)
const byId = (id: string) => {
  const e = endpoints.find((x) => x.id === id)
  if (!e) throw new Error("missing endpoint " + id)
  return e
}
const balance = byId("wallet-balance")
const purchase = byId("data-purchase")
const lookup = byId("order-lookup")

function errorMessages(): string[] {
  return v2DocsRegistry
    .filter((s) => s.group === "data" || s.group === "commission")
    .flatMap((s) => s.endpoints)
    .flatMap((e) => e.errors.map((er) => er.message))
}

describe("starter kits sync with the registry", () => {
  it("has a php and a node kit", () => {
    expect(STARTER_KITS.map((k) => k.id)).toEqual(["php", "node"])
    expect(getStarterKit("php")?.filename).toBe("datagod-starter.php")
    expect(getStarterKit("node")?.filename).toBe("datagod-starter.mjs")
    expect(getStarterKit("ruby")).toBeNull()
  })

  for (const kit of STARTER_KITS) {
    describe(kit.id, () => {
      it("uses the registry base url and paths", () => {
        expect(kit.source).toContain(V2_BASE_URL)
        expect(kit.source).toContain(balance.path)
        expect(kit.source).toContain(purchase.path)
        expect(lookup.path.startsWith("/orders/")).toBe(true)
        expect(kit.source).toContain("/orders/")
      })

      it("sends every purchase body field by its wire name", () => {
        for (const key of Object.keys(purchase.requestExample as object)) {
          expect(kit.source).toContain(key)
        }
        expect(Object.keys(purchase.requestExample as object).sort()).toEqual(
          ["network", "recipient", "reference", "volume_gb"],
        )
      })

      it("handles the 409 codes and keeps the key out of the source", () => {
        const msgs = errorMessages()
        for (const code of ["REFERENCE_REUSED", "OUTCOME_UNKNOWN", "REQUEST_IN_PROGRESS"]) {
          expect(msgs.some((m) => m.startsWith(code + ":"))).toBe(true)
          expect(kit.source).toContain(code)
        }
        expect(kit.source).toContain("DATAGOD_API_KEY")
        expect(kit.source).not.toMatch(/dg2_[0-9a-f]{6,}/i)
      })

      it("knows the terminal order statuses from the registry", () => {
        const intro = v2DocsRegistry.find((s) => s.id === "order-statuses")?.intro ?? ""
        for (const status of ["completed", "failed", "refunded"]) {
          expect(intro).toContain(status)
          expect(kit.source).toContain(status)
        }
      })

      it("lists the sandbox failure numbers in the header comment", () => {
        for (const n of ["0240000404", "0200000404", "0270000404", "0000404", "0000202"]) {
          expect(kit.source).toContain(n)
        }
      })
    })
  }
})

describe("node kit run", () => {
  const dir = mkdtempSync(join(tmpdir(), "datagod-kit-"))
  const file = join(dir, "datagod-starter.mjs")
  writeFileSync(file, getStarterKit("node")!.source)
  const load = (): Promise<any> =>
    import(/* @vite-ignore */ pathToFileURL(file).href + "?t=" + Math.random())

  const ORDER = { reference: "R1", network: "MTN", volume_gb: 1, recipient: "0244000001", price: 4.5, status: "pending" }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const ok = (status: number, order: object) => json(status, { success: true, data: { order } })
  const err = (status: number, message: string) => json(status, { success: false, error: { code: status, message } })

  let calls: { url: string; init: any }[]
  const realFetch = globalThis.fetch
  const realKey = process.env.DATAGOD_API_KEY

  function mockFetch(handler: (url: string, init: any, n: number) => Response | Promise<Response>) {
    calls = []
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init })
      return handler(String(url), init, calls.length)
    }) as any
  }
  const posts = () => calls.filter((c) => c.init?.method === "POST")
  const params = { network: "MTN", volumeGb: 1, recipient: "0244000001", reference: "R1" }
  const fast = { timeoutMs: 2000, intervalMs: 1 }

  beforeEach(() => {
    process.env.DATAGOD_API_KEY = "test-env-key"
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.DATAGOD_API_KEY
    else process.env.DATAGOD_API_KEY = realKey
  })

  it("201 purchase returns the order with one fetch, the env key and the 4 body fields", async () => {
    const kit = await load()
    mockFetch(() => ok(201, { ...ORDER, status: "completed" }))
    const order = await kit.buyDataSafely(params, fast)
    expect(order.status).toBe("completed")
    expect(calls).toHaveLength(1)
    expect(calls[0].init.headers.Authorization).toContain("test-env-key")
    expect(JSON.parse(calls[0].init.body)).toEqual({
      network: "MTN",
      volume_gb: 1,
      recipient: "0244000001",
      reference: "R1",
    })
  })

  it("409 REFERENCE_REUSED throws after one fetch", async () => {
    const kit = await load()
    mockFetch(() => err(409, "REFERENCE_REUSED: reference already used for a different order"))
    await expect(kit.buyDataSafely(params, fast)).rejects.toThrow(/REFERENCE_REUSED/)
    expect(calls).toHaveLength(1)
  })

  it("402 throws a top up message", async () => {
    const kit = await load()
    mockFetch(() => err(402, "INSUFFICIENT_BALANCE: wallet balance is too low; required 4.50"))
    await expect(kit.buyDataSafely(params, fast)).rejects.toThrow(/top up/)
    expect(calls).toHaveLength(1)
  })

  for (const code of ["OUTCOME_UNKNOWN", "REQUEST_IN_PROGRESS"]) {
    it("409 " + code + " never posts again and polls the same reference", async () => {
      const kit = await load()
      mockFetch((_u, init, n) => {
        if (init.method === "POST") return err(409, code + ": not confirmed yet")
        return n < 4 ? ok(200, ORDER) : ok(200, { ...ORDER, status: "completed" })
      })
      const order = await kit.buyDataSafely(params, fast)
      expect(order.status).toBe("completed")
      expect(posts()).toHaveLength(1)
      expect(calls.slice(1).every((c) => c.url.endsWith("/orders/R1"))).toBe(true)
      expect(calls.length).toBeGreaterThan(2)
    })
  }

  it("a network error on POST polls the same reference with no second POST", async () => {
    const kit = await load()
    mockFetch((_u, init) => {
      if (init.method === "POST") throw new TypeError("fetch failed")
      return ok(200, { ...ORDER, status: "failed" })
    })
    const order = await kit.buyDataSafely(params, fast)
    expect(order.status).toBe("failed")
    expect(posts()).toHaveLength(1)
  })

  it("pollOrder times out when no terminal status arrives", async () => {
    const kit = await load()
    mockFetch(() => ok(200, ORDER))
    await expect(kit.pollOrder("R1", { timeoutMs: 30, intervalMs: 5 })).rejects.toThrow(/Timed out/)
  })

  it("encodes the reference in the GET path", async () => {
    const kit = await load()
    mockFetch(() => ok(200, { ...ORDER, status: "completed" }))
    await kit.pollOrder("a/b?c", fast)
    expect(calls[0].url).toBe(V2_BASE_URL + "/orders/" + encodeURIComponent("a/b?c"))
    expect(calls[0].url).not.toContain("a/b?c")
  })

  it("throws before any fetch when DATAGOD_API_KEY is missing", async () => {
    const kit = await load()
    delete process.env.DATAGOD_API_KEY
    mockFetch(() => ok(200, ORDER))
    await expect(kit.getBalance()).rejects.toThrow(/DATAGOD_API_KEY/)
    await expect(kit.buyDataSafely(params, fast)).rejects.toThrow(/DATAGOD_API_KEY/)
    expect(calls).toHaveLength(0)
  })

  it("getBalance reads /wallet/balance", async () => {
    const kit = await load()
    mockFetch(() => json(200, { success: true, data: { balance: 5, currency: "GHS" } }))
    expect((await kit.getBalance()).balance).toBe(5)
    expect(calls[0].url).toBe(V2_BASE_URL + "/wallet/balance")
  })
})

describe("php kit", () => {
  const source = getStarterKit("php")!.source
  const probe = spawnSync("php", ["-v"], { encoding: "utf8" })
  const hasPhp = !probe.error && probe.status === 0

  it.skipIf(!hasPhp)("passes php -l", () => {
    const dir = mkdtempSync(join(tmpdir(), "datagod-kit-php-"))
    const file = join(dir, "datagod-starter.php")
    writeFileSync(file, source)
    const res = spawnSync("php", ["-l", file], { encoding: "utf8" })
    expect(res.status).toBe(0)
  })

  it("uses curl, a request timeout and json_decode", () => {
    expect(source).toContain("curl_init")
    expect(source).toContain("CURLOPT_TIMEOUT")
    expect(source).toContain("json_decode")
  })
})

describe("starterKitResponse and route", () => {
  it("serves node as an attachment", async () => {
    const res = starterKitResponse("node")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="datagod-starter.mjs"')
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await res.text()).toBe(getStarterKit("node")!.source)
  })

  it("returns a 404 json for an unknown kit", async () => {
    const res = starterKitResponse("ruby")
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error.code).toBe(404)
    expect(typeof body.error.message).toBe("string")
  })

  it("route serves php and 404s on unknown", async () => {
    const res = await getKit(new Request("http://x/developers/starter-kits/php"), { params: Promise.resolve({ kit: "php" }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toContain("datagod-starter.php")
    const bad = await getKit(new Request("http://x/developers/starter-kits/ruby"), { params: Promise.resolve({ kit: "ruby" }) })
    expect(bad.status).toBe(404)
  })
})
