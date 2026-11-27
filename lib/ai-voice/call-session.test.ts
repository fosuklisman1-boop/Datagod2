import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CallTranscript } from "./transcript"
import {
  CARD_COMMENTARY,
  FAILURE_COMMENTARY,
  createCallSession,
  type ChatRelay,
  type LiveLink,
} from "./call-session"
import { maskForVoice } from "./mask"

function setup(ask: ChatRelay["ask"], opts: { connected?: boolean; timeoutMs?: number } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const link: LiveLink = {
    send: async (ev) => {
      sent.push(ev)
    },
    connected: () => opts.connected ?? true,
  }
  const transcript = new CallTranscript()
  const relay: ChatRelay = { ask: vi.fn(ask) }
  const session = createCallSession({ link, relay, transcript, timeoutMs: opts.timeoutMs })
  return { sent, link, transcript, relay, session }
}

const DELEG = { type: "session.delegation.created", delegation: { id: "del_1", target: "client" } }

describe("createCallSession", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("relays a hand-off: thinking, ask, commentary", async () => {
    const { sent, relay, session, transcript } = setup(async () => ({ text: "All good.", cards: [] }))
    transcript.onEvent({ type: "session.input_transcript.done", event_id: "a", transcript: "hi" })
    await session.onInterfaceEvent(DELEG)
    expect(relay.ask).toHaveBeenCalledWith(transcript.turns())
    expect(sent).toEqual([
      { type: "session.thinking.append", delegation_id: "del_1", content: "Checking..." },
      { type: "session.commentary.append", delegation_id: "del_1", content: maskForVoice("All good.") },
    ])
  })

  it("uses the card commentary and never the relay text", async () => {
    const { sent, session } = setup(async () => ({
      text: "SECRET TEXT",
      cards: [{ id: "c1", summary: "Send 2GB to 0241234567" }],
    }))
    await session.onInterfaceEvent(DELEG)
    const c = sent[1].content as string
    expect(c).toBe(CARD_COMMENTARY + " " + maskForVoice("Send 2GB to 0241234567"))
    expect(c).not.toContain("SECRET")
    expect(c).not.toMatch(/\d{7}/)
  })

  it("masks phone numbers in the answer", async () => {
    const { sent, session } = setup(async () => ({ text: "Sent 2GB to 0241234567", cards: [] }))
    await session.onInterfaceEvent(DELEG)
    const c = sent[1].content as string
    expect(c).toContain("number ending 567")
    expect(c).not.toMatch(/\d{7}/)
  })

  it("falls back to failure commentary on rejection", async () => {
    const { sent, session } = setup(async () => {
      throw new Error("boom")
    })
    await session.onInterfaceEvent(DELEG)
    expect(sent[1]).toMatchObject({ delegation_id: "del_1", content: FAILURE_COMMENTARY })
  })

  it("falls back to failure commentary on timeout", async () => {
    const { sent, session } = setup(() => new Promise(() => {}), { timeoutMs: 1000 })
    const p = session.onInterfaceEvent(DELEG)
    await vi.advanceTimersByTimeAsync(1000)
    await p
    expect(sent[1]).toMatchObject({ content: FAILURE_COMMENTARY })
  })

  it("ignores responses hand-offs and unknown events", async () => {
    const { sent, relay, session } = setup(async () => ({ text: "x", cards: [] }))
    await session.onInterfaceEvent({ type: "session.delegation.created", delegation: { id: "d", target: "responses" } })
    await session.onInterfaceEvent({ type: "session.whatever" })
    expect(sent).toEqual([])
    expect(relay.ask).not.toHaveBeenCalled()
  })

  it("does not throw when link.send throws", async () => {
    const transcript = new CallTranscript()
    const link: LiveLink = {
      send: async () => {
        throw new Error("dropped")
      },
      connected: () => true,
    }
    const session = createCallSession({ link, relay: { ask: async () => ({ text: "x", cards: [] }) }, transcript })
    await expect(session.onInterfaceEvent(DELEG)).resolves.toBeUndefined()
    await expect(session.onCardOutcome({ summary: "s", outcome: "confirmed" })).resolves.toBeUndefined()
  })

  it("sends card outcomes while connected, masked", async () => {
    const { sent, session } = setup(async () => ({ text: "", cards: [] }))
    await session.onCardOutcome({ summary: "Send 2GB to 0241234567", outcome: "confirmed" })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "session.thinking.append",
      delegation_id: null,
      while_speaking: "finish",
    })
    expect(sent[0].content as string).not.toMatch(/\d{7}/)
    expect(sent[0].content as string).toContain("number ending 567")
  })

  it("sends nothing for a card outcome when disconnected", async () => {
    const { sent, session } = setup(async () => ({ text: "", cards: [] }), { connected: false })
    await expect(session.onCardOutcome({ summary: "s", outcome: "cancelled" })).resolves.toBeUndefined()
    expect(sent).toEqual([])
  })
})
