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
const up = async () => true

function enc(obj: unknown): string {
  const c = crypto.createCipheriv("sm4-cbc", KEY, IV)
  return Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]).toString("hex")
}
const reply = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: status === 204 ? 200 : status, headers }) as Response
const send = (f: unknown, extra: Record<string, unknown> = {}) =>
  sendViaPhone(CFG, PARAMS, { fetch: f as typeof fetch, connect: up, ...extra })

function hanging(): typeof fetch {
  return ((_u: unknown, init?: RequestInit) =>
    new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))
    })) as unknown as typeof fetch
}
const failing = (code: string, viaCause = true) => async () => {
  const e = new TypeError("fetch failed")
  if (viaCause) (e as unknown as { cause: unknown }).cause = Object.assign(new Error("x"), { code })
  else (e as unknown as { code: string }).code = code
  throw e
}

afterEach(() => vi.restoreAllMocks())

describe("sendViaPhone", () => {
  it("200 + encrypted code 200 -> sent", async () => {
    expect(await send(async () => reply(200, enc({ code: 200, msg: "success", data: "success", timestamp: 1 })))).toEqual({ kind: "sent" })
  })

  it("posts hex to /sms/send as application/json with redirect manual", async () => {
    const f = vi.fn(async (..._a: unknown[]) => reply(200, enc({ code: 200 })))
    await send(f)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${URL_}/sms/send`)
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("manual")
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
    expect(String(init.body)).toMatch(/^[0-9a-f]+$/)
  })

  it("encrypted code 500 -> refused", async () => {
    expect(await send(async () => reply(200, enc({ code: 500, msg: "no" })))).toMatchObject({ kind: "refused" })
  })

  it("HTTP 500 -> refused", async () => {
    expect(await send(async () => reply(500, enc({ code: 200 })))).toMatchObject({ kind: "refused" })
  })

  it("a 3xx redirect -> refused", async () => {
    expect(await send(async () => reply(307, "", { location: "http://elsewhere.test/" }))).toMatchObject({ kind: "refused" })
    const opaque = { status: 0, type: "opaqueredirect", text: async () => "" }
    expect(await send(async () => opaque)).toMatchObject({ kind: "refused" })
  })

  it("garbage body -> refused", async () => {
    expect(await send(async () => reply(200, "<html>gateway</html>"))).toMatchObject({ kind: "refused" })
  })

  it("probe false -> unreachable and fetch never called", async () => {
    const f = vi.fn()
    const r = await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch, connect: async () => false })
    expect(r).toMatchObject({ kind: "unreachable" })
    expect(f).not.toHaveBeenCalled()
  })

  it("probe is given the host, port and connect timeout", async () => {
    const connect = vi.fn(async (..._a: unknown[]) => true)
    await sendViaPhone(CFG, PARAMS, { fetch: (async () => reply(200, enc({ code: 200 }))) as unknown as typeof fetch, connect, connectTimeoutMs: 123 })
    expect(connect).toHaveBeenCalledWith("relay.example.test", 7001, 123)
  })

  it("rejection with a connect-phase error code (on cause or directly) -> unreachable", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(await send(failing(code))).toMatchObject({ kind: "unreachable" })
      expect(await send(failing(code, false))).toMatchObject({ kind: "unreachable" })
    }
  })

  it("a reset or closed connection before any response -> unreachable (nothing was sent)", async () => {
    for (const code of ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
      expect(await send(failing(code))).toMatchObject({ kind: "unreachable" })
      expect(await send(failing(code, false))).toMatchObject({ kind: "unreachable" })
    }
    expect(await send(async () => { throw new TypeError("other side closed") })).toMatchObject({ kind: "unreachable" })
    expect(await send(async () => { throw new TypeError("terminated") })).toMatchObject({ kind: "unreachable" })
  })

  it("any other unknown rejection stays ambiguous", async () => {
    expect(await send(async () => { throw new Error("weird") })).toMatchObject({ kind: "ambiguous" })
  })

  it("the total budget covers the probe and the fetch together", async () => {
    let fetchBudget = 0
    const connect = async (_h: string, _p: number, timeoutMs: number) => {
      expect(timeoutMs).toBeLessThanOrEqual(5000)
      await new Promise((r) => setTimeout(r, 300))
      return true
    }
    const f = ((_u: unknown, init?: RequestInit) => {
      fetchBudget = Date.now()
      return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))
    }) as unknown as typeof fetch
    const t0 = Date.now()
    const r = await sendViaPhone(CFG, PARAMS, { fetch: f, connect, connectTimeoutMs: 5000, totalTimeoutMs: 600 })
    const total = Date.now() - t0
    expect(r).toMatchObject({ kind: "ambiguous" })
    expect(fetchBudget).toBeGreaterThan(0)
    // The probe took ~300 ms of the 600 ms budget, so the whole call ends near 600 ms. A budget that restarted for the fetch
    // would end near 900 ms; the generous 800 ms ceiling keeps this stable under a loaded test run.
    expect(total).toBeLessThan(800)
  })

  it("the probe limit is the smaller of connectTimeoutMs and the remaining budget", async () => {
    const connect = vi.fn(async (..._a: unknown[]) => true)
    await sendViaPhone(CFG, PARAMS, { fetch: (async () => reply(200, enc({ code: 200 }))) as unknown as typeof fetch, connect, connectTimeoutMs: 3000, totalTimeoutMs: 500 })
    expect(connect.mock.calls[0][2]).toBe(500)
  })

  it("a probe that uses the whole budget -> unreachable without calling fetch", async () => {
    const f = vi.fn()
    const connect = async () => { await new Promise((r) => setTimeout(r, 40)); return true }
    const r = await sendViaPhone(CFG, PARAMS, { fetch: f as unknown as typeof fetch, connect, totalTimeoutMs: 30 })
    expect(r).toMatchObject({ kind: "unreachable" })
    expect(f).not.toHaveBeenCalled()
  })

  it("hangs past the total timeout -> ambiguous (no separate early abort)", async () => {
    const t0 = Date.now()
    const r = await send(hanging(), { connectTimeoutMs: 5, totalTimeoutMs: 60 })
    expect(r).toMatchObject({ kind: "ambiguous" })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50)
  })

  it("a slow answer inside the total budget is still sent", async () => {
    const f = async () => {
      await new Promise((r) => setTimeout(r, 40))
      return reply(200, enc({ code: 200 }))
    }
    expect(await send(f, { connectTimeoutMs: 5, totalTimeoutMs: 500 })).toEqual({ kind: "sent" })
  })

  it("headers arrive but the body read stalls past the total timeout -> ambiguous", async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(c) {
            init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")))
          },
        }),
      })) as unknown as typeof fetch
    expect(await send(f, { totalTimeoutMs: 30 })).toMatchObject({ kind: "ambiguous" })
  })

  it("a declared content-length over 4096 -> refused without reading", async () => {
    const text = vi.fn(async () => enc({ code: 200 }))
    const r = await send(async () => ({ status: 200, headers: new Headers({ "content-length": "5000" }), body: null, text }))
    expect(r).toMatchObject({ kind: "refused" })
    expect(text).not.toHaveBeenCalled()
  })

  it("a 100 KB streamed body -> refused without reading it all", async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024
        c.enqueue(new Uint8Array(1024).fill(97))
        if (pulled >= 100 * 1024) c.close()
      },
    })
    const r = await send(async () => ({ status: 200, headers: new Headers(), body: stream }))
    expect(r).toMatchObject({ kind: "refused" })
    expect(pulled).toBeLessThan(100 * 1024)
  })

  it("reads a normal streamed body, and falls back to text() when body is null", async () => {
    const hex = enc({ code: 200 })
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(hex)); c.close() } })
    expect(await send(async () => ({ status: 200, headers: new Headers(), body: stream }))).toEqual({ kind: "sent" })
    expect(await send(async () => ({ status: 200, headers: new Headers(), body: null, text: async () => hex }))).toEqual({ kind: "sent" })
  })

  it("every non-sent result carries a fixed-vocabulary detail", async () => {
    const VOCAB = ["probe_failed", "probe_timeout", "connect_error", "reset", "timeout", "http_status", "redirect", "bad_body", "code_not_200", "other"]
    const got = async (f: unknown, extra: Record<string, unknown> = {}) => (await send(f, extra)) as { kind: string; detail?: string }
    const cases: [{ kind: string; detail?: string }, string, string][] = [
      [await sendViaPhone(CFG, PARAMS, { fetch: vi.fn() as unknown as typeof fetch, connect: async () => false }), "unreachable", "probe_failed"],
      [await got(failing("ECONNREFUSED")), "unreachable", "connect_error"],
      [await got(failing("ETIMEDOUT")), "unreachable", "connect_error"],
      [await got(failing("EAI_AGAIN")), "unreachable", "connect_error"],
      [await got(failing("ECONNABORTED")), "unreachable", "connect_error"],
      [await got(failing("ECONNRESET")), "unreachable", "reset"],
      [await got(hanging(), { totalTimeoutMs: 20 }), "ambiguous", "timeout"],
      [await got(async () => { throw new Error("weird") }), "ambiguous", "other"],
      [await got(async () => reply(500, "x")), "refused", "http_status"],
      [await got(async () => reply(307, "")), "refused", "redirect"],
      [await got(async () => reply(200, "junk")), "refused", "bad_body"],
      [await got(async () => reply(200, enc({ code: 500 }))), "refused", "code_not_200"],
    ]
    for (const [r, kind, detail] of cases) {
      expect(r).toEqual({ kind, detail })
      expect(VOCAB).toContain(r.detail)
    }
  })

  it("never writes the url, key, number or text to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    await send(async () => { throw new Error(`boom ${URL_} ${KEY_HEX} ${PARAMS.to} ${PARAMS.text}`) })
    await send(async () => reply(200, "junk"))
    await send(hanging(), { totalTimeoutMs: 20 })
    for (const s of spies) {
      for (const call of s.mock.calls) {
        const out = JSON.stringify(call)
        for (const secret of [URL_, KEY_HEX, PARAMS.to, PARAMS.text, "relay.example.test"]) expect(out).not.toContain(secret)
      }
    }
  })
})
