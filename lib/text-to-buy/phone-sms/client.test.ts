import { describe, it, expect, vi, afterEach } from "vitest"
import crypto from "node:crypto"
import { sendViaPhone } from "./client"
import { parseKey } from "./sm4"

const IV = Buffer.from([3, 5, 6, 9, 6, 9, 5, 9, 3, 5, 6, 9, 6, 9, 5, 9])
const KEY_HEX = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
const KEY = parseKey(KEY_HEX)!
const URL_ = "http://relay.example.test:7001"
const CFG = { url: URL_, keyHex: KEY_HEX }
const PARAMS = { simSlot: 1 as const, to: "0200000902", text: "secret reply text" }

function enc(obj: unknown): string {
  const c = crypto.createCipheriv("sm4-cbc", KEY, IV)
  return Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("hex")
}
const reply = (status: number, body: string) => ({ status, ok: status >= 200 && status < 300, text: async () => body }) as unknown as Response

/** A fetch that never resolves but rejects when aborted, like the real one. */
function hanging(): typeof fetch {
  return ((_u: unknown, init?: RequestInit) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))
    })) as unknown as typeof fetch
}

afterEach(() => vi.restoreAllMocks())

describe("sendViaPhone", () => {
  it("200 + encrypted code 200 -> sent", async () => {
    const f = vi.fn(async () => reply(200, enc({ code: 200, msg: "success", data: "success", timestamp: 1 })))
    expect(await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })).toEqual({ kind: "sent" })
  })

  it("posts hex to /sms/send as application/json", async () => {
    const f = vi.fn(async (..._a: unknown[]) => reply(200, enc({ code: 200 })))
    await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${URL_}/sms/send`)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect(String(init.body)).toMatch(/^[0-9a-f]+$/)
  })

  it("encrypted code 500 -> refused", async () => {
    const f = async () => reply(200, enc({ code: 500, msg: "no" }))
    expect(await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })).toEqual({ kind: "refused" })
  })

  it("HTTP 500 -> refused", async () => {
    const f = async () => reply(500, enc({ code: 200 }))
    expect(await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })).toEqual({ kind: "refused" })
  })

  it("garbage body -> refused", async () => {
    const f = async () => reply(200, "<html>gateway</html>")
    expect(await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })).toEqual({ kind: "refused" })
  })

  it("fetch rejected before any response -> unreachable", async () => {
    const f = async () => { throw new TypeError("fetch failed") }
    expect(await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch })).toEqual({ kind: "unreachable" })
  })

  it("connect timeout (hangs, aborted before headers) -> unreachable", async () => {
    const r = await sendViaPhone(CFG, PARAMS, { fetch: hanging(), connectTimeoutMs: 15, totalTimeoutMs: 1000 })
    expect(r).toEqual({ kind: "unreachable" })
  })

  it("total timeout after the request started -> ambiguous", async () => {
    const r = await sendViaPhone(CFG, PARAMS, { fetch: hanging(), connectTimeoutMs: 1000, totalTimeoutMs: 20 })
    expect(r).toEqual({ kind: "ambiguous" })
  })

  it("headers arrive but the body read stalls past the total timeout -> ambiguous", async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        ok: true,
        text: () => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
      })) as unknown as typeof fetch
    const r = await sendViaPhone(CFG, PARAMS, { fetch: f, connectTimeoutMs: 1000, totalTimeoutMs: 20 })
    expect(r).toEqual({ kind: "ambiguous" })
  })

  it("never writes the url, key, number or text to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const fails = async () => { throw new Error(`boom ${URL_} ${KEY_HEX} ${PARAMS.to} ${PARAMS.text}`) }
    await sendViaPhone(CFG, PARAMS, { fetch: fails as unknown as typeof fetch })
    await sendViaPhone(CFG, PARAMS, { fetch: (async () => reply(200, "junk")) as unknown as typeof fetch })
    await sendViaPhone(CFG, PARAMS, { fetch: hanging(), connectTimeoutMs: 10, totalTimeoutMs: 100 })
    for (const s of spies) {
      for (const call of s.mock.calls) {
        const out = JSON.stringify(call)
        for (const secret of [URL_, KEY_HEX, PARAMS.to, PARAMS.text, "relay.example.test"]) expect(out).not.toContain(secret)
      }
    }
  })
})
