import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const afterMock = vi.hoisted(() => vi.fn())
vi.mock("next/server", async (orig) => {
  const actual = await orig<typeof import("next/server")>()
  return { ...actual, after: afterMock }
})

import { POST } from "./route"

const REF = `DG${"1".repeat(22)}`
const TOKEN = "route-test-token"

function req(opts: { t?: string | null; body?: string }) {
  const url = `http://localhost/api/webhooks/mtn/hubnet${opts.t == null ? "" : `?t=${encodeURIComponent(opts.t)}`}`
  const r = new NextRequest(url, { method: "POST", body: opts.body ?? "{}", headers: { "x-test": "1" } })
  const text = vi.spyOn(r, "text")
  return { r, text }
}

describe("hubnet webhook route", () => {
  let logs: string[]
  beforeEach(() => {
    vi.stubEnv("HUBNET_WEBHOOK_TOKEN", TOKEN)
    afterMock.mockReset()
    logs = []
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.join(" ")) })
    }
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const expect200 = async (res: Response) => {
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
  }

  it.each([["missing", null], ["wrong", "nope"]])("%s token: 200, no processing, body unread, no raw log", async (_n, t) => {
    const { r, text } = req({ t, body: JSON.stringify({ reference: REF }) })
    await expect200(await POST(r))
    expect(afterMock).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(logs.some((l) => l.includes("[HUBNET-RAW]"))).toBe(false)
    expect(logs.some((l) => l.includes(TOKEN) || l.includes("nope"))).toBe(false)
  })

  it("oversized body: 200, not processed", async () => {
    const { r } = req({ t: TOKEN, body: JSON.stringify({ reference: REF, pad: "x".repeat(70 * 1024) }) })
    await expect200(await POST(r))
    expect(afterMock).not.toHaveBeenCalled()
  })

  it("content-length over 64KB: 200 without reading the body", async () => {
    const { r, text } = req({ t: TOKEN, body: JSON.stringify({ reference: REF }) })
    const big = new NextRequest(r.url, { method: "POST", body: "{}", headers: { "content-length": String(70 * 1024) } })
    const bigText = vi.spyOn(big, "text")
    await expect200(await POST(big))
    expect(bigText).not.toHaveBeenCalled()
    expect(afterMock).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it("invalid JSON: 200, not processed", async () => {
    const { r } = req({ t: TOKEN, body: "{not json" })
    await expect200(await POST(r))
    expect(afterMock).not.toHaveBeenCalled()
  })

  it("valid ref: after called once and raw log never has the token", async () => {
    const { r } = req({ t: TOKEN, body: JSON.stringify({ reference: REF }) })
    await expect200(await POST(r))
    expect(afterMock).toHaveBeenCalledTimes(1)
    expect(logs.some((l) => l.includes("[HUBNET-RAW]"))).toBe(true)
    expect(logs.some((l) => l.includes(TOKEN))).toBe(false)
  })

  it("no valid ref: 200, not processed", async () => {
    const { r } = req({ t: TOKEN, body: JSON.stringify({ reference: "bogus" }) })
    await expect200(await POST(r))
    expect(afterMock).not.toHaveBeenCalled()
  })

  it("a throw inside the after callback is caught and logged without secrets", async () => {
    const { r } = req({ t: TOKEN, body: JSON.stringify({ reference: REF }) })
    await POST(r)
    const cb = afterMock.mock.calls[0][0] as () => Promise<void>
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    await expect(cb()).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes("[WEBHOOK-HUBNET] processing failed"))).toBe(true)
    expect(logs.some((l) => l.includes(TOKEN))).toBe(false)
  })
})
