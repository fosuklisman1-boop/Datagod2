import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const queued: Array<() => Promise<void> | void> = []
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void> | void) => {
    queued.push(fn)
  },
}))

import { backgroundCron } from "./cron-background"

const req = (auth?: string) =>
  new NextRequest("https://x.test/api/cron/demo", { headers: auth ? { authorization: auth } : {} })

describe("backgroundCron", () => {
  beforeEach(() => {
    queued.length = 0
    process.env.CRON_SECRET = "s3cret"
  })

  it("rejects an unauthenticated call with 401 and queues no work", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const res = await backgroundCron("demo", handler)(req())
    expect(res.status).toBe(401)
    expect(queued).toHaveLength(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects a wrong secret", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const res = await backgroundCron("demo", handler)(req("Bearer nope"))
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns 202 immediately without running the handler inline", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const res = await backgroundCron("demo", handler)(req("Bearer s3cret"))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ accepted: true })
    expect(handler).not.toHaveBeenCalled()
    expect(queued).toHaveLength(1)
  })

  it("runs the handler with the same request once the queued work executes", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const r = req("Bearer s3cret")
    await backgroundCron("demo", handler)(r)
    await queued[0]()
    expect(handler).toHaveBeenCalledWith(r)
  })

  it("swallows and logs a handler throw so the background task never rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const handler = vi.fn(async () => {
      throw new Error("boom")
    })
    await backgroundCron("demo", handler)(req("Bearer s3cret"))
    await expect(queued[0]()).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it("logs a non-2xx handler response", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const handler = vi.fn(async () => NextResponse.json({ error: "x" }, { status: 500 }))
    await backgroundCron("demo", handler)(req("Bearer s3cret"))
    await queued[0]()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
