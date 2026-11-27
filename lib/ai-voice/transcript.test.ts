import { describe, expect, it } from "vitest"
import { CallTranscript } from "./transcript"

describe("CallTranscript", () => {
  it("replaces an earlier user turn in place", () => {
    const t = new CallTranscript()
    t.onEvent({ type: "session.input_transcript.done", event_id: "a", transcript: "helo" })
    t.onEvent({ type: "session.input_transcript.done", event_id: "b", transcript: "second" })
    t.onEvent({
      type: "session.input_transcript.done",
      event_id: "c",
      transcript: "hello",
      replaces_event_id: "a",
    })
    expect(t.turns().map((x) => x.content)).toEqual(["hello", "second"])
    expect(t.turns()[0].role).toBe("user")
  })

  it("turns persona deltas into one assistant turn on output_audio.done", () => {
    const t = new CallTranscript()
    t.onEvent({ type: "session.output_transcript.delta", delta: "Hi " })
    t.onEvent({ type: "session.output_transcript.delta", delta: "there" })
    expect(t.turns()).toEqual([])
    t.onEvent({ type: "session.output_audio.done", reason: "completed" })
    expect(t.turns()).toEqual([{ role: "assistant", content: "Hi there" }])
  })

  it("keeps the words received for an interrupted reply", () => {
    const t = new CallTranscript()
    t.onEvent({ type: "session.output_transcript.delta", delta: "Well, I" })
    t.onEvent({ type: "session.output_audio.done", reason: "interrupted" })
    expect(t.turns()).toEqual([{ role: "assistant", content: "Well, I" }])
  })

  it("shows in-progress words in captions only", () => {
    const t = new CallTranscript()
    t.onEvent({ type: "session.output_transcript.delta", delta: "Working" })
    expect(t.turns()).toEqual([])
    expect(t.captions()).toEqual([{ role: "assistant", content: "Working" }])
  })

  it("ignores unknown events and empty replies", () => {
    const t = new CallTranscript()
    t.onEvent({ type: "session.something.else" })
    t.onEvent({ type: "session.output_audio.done", reason: "completed" })
    expect(t.turns()).toEqual([])
  })
})
