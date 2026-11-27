import { describe, expect, it, vi } from "vitest"
import { createChatRelay, summariseCard } from "./chat-relay"

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

describe("createChatRelay", () => {
  it("posts messages/context/shopSlug with the bearer header and parses the stream", async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        { type: "text", content: "Hello " },
        { type: "text", content: "there." },
        { type: "done" },
      ]),
    )
    const relay = createChatRelay({
      context: "storefront",
      shopSlug: "demo",
      authHeader: async () => "Bearer abc",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const res = await relay.ask([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "price?" },
    ])
    expect(res).toEqual({ text: "Hello there.", cards: [], prefilled: false })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/ai/chat")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc")
    expect(JSON.parse(init.body as string)).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "price?" },
      ],
      context: "storefront",
      shopSlug: "demo",
      channel: "voice",
    })
  })

  it("I6: forwards checkout_prefill and action_buttons to the widget callbacks, as the text widget gets them", async () => {
    const data = { id: "pkg1", network: "MTN", name: "5GB", price: 20 }
    const buttons = [{ label: "Buy now", href: "/x" }]
    const fetchImpl = vi.fn(async () =>
      sse([
        { type: "text", content: "Filled." },
        { type: "checkout_prefill", data },
        { type: "action_buttons", buttons },
        { type: "done" },
      ]),
    )
    const prefills: unknown[] = []
    const btns: unknown[] = []
    const relay = createChatRelay({
      context: "storefront",
      shopSlug: "demo",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onCheckoutPrefill: (d) => prefills.push(d),
      onActionButtons: (b) => btns.push(b),
    })
    const res = await relay.ask([{ role: "user", content: "buy 5gb" }])
    expect(prefills).toEqual([data])
    expect(btns).toEqual([buttons])
    expect(res.prefilled).toBe(true)
  })

  it("I6: an errored prefill result (no package) is not reported as a prefill", async () => {
    const fetchImpl = vi.fn(async () => sse([{ type: "checkout_prefill", data: { error: "not found" } }, { type: "done" }]))
    const prefills: unknown[] = []
    const relay = createChatRelay({ context: "storefront", fetchImpl: fetchImpl as unknown as typeof fetch, onCheckoutPrefill: (d) => prefills.push(d) })
    const res = await relay.ask([{ role: "user", content: "x" }])
    expect(prefills).toEqual([])
    expect(res.prefilled).toBe(false)
  })

  it("omits Authorization and shopSlug when absent; keeps only the last 10 turns", async () => {
    const fetchImpl = vi.fn(async () => sse([{ type: "text", content: "ok" }, { type: "done" }]))
    const relay = createChatRelay({ context: "home", fetchImpl: fetchImpl as unknown as typeof fetch })
    const turns = Array.from({ length: 14 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }))
    await relay.ask(turns)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body.shopSlug).toBeUndefined()
    expect(body.messages).toHaveLength(10)
    expect(body.messages[0].content).toBe("m4")
  })

  it("collects draft cards with a one-line summary and reports them via onCards", async () => {
    const display = { title: "Buy 5GB MTN", lines: [{ label: "Amount", value: "GHS 20.00" }] }
    const fetchImpl = vi.fn(async () =>
      sse([
        { type: "text", content: "Please check." },
        { type: "draft_card", draft_id: "d1", display, expires_at: "2026-01-01T00:00:00Z", warnings: ["w"] },
        { type: "done" },
      ]),
    )
    const seen: unknown[] = []
    const relay = createChatRelay({ context: "dashboard", fetchImpl: fetchImpl as unknown as typeof fetch, onCards: (c) => seen.push(...c) })
    const res = await relay.ask([{ role: "user", content: "buy" }])
    expect(res.cards).toEqual([{ id: "d1", summary: "Buy 5GB MTN. Amount GHS 20.00" }])
    expect(seen).toEqual([{ id: "d1", summary: "Buy 5GB MTN. Amount GHS 20.00", display, expires_at: "2026-01-01T00:00:00Z", warnings: ["w"] }])
  })

  it("rejects on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }))
    const relay = createChatRelay({ context: "home", fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(relay.ask([{ role: "user", content: "x" }])).rejects.toThrow()
  })

  it("rejects when the stream carries an error event", async () => {
    const fetchImpl = vi.fn(async () => sse([{ type: "error", content: "bad" }, { type: "done" }]))
    const relay = createChatRelay({ context: "home", fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(relay.ask([{ role: "user", content: "x" }])).rejects.toThrow()
  })
})

describe("summariseCard", () => {
  it("falls back to a generic line", () => {
    expect(summariseCard(undefined)).toBe("Confirm action")
  })
})
