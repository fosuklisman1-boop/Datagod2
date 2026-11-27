import { describe, expect, it } from "vitest"
import { callToMessages } from "./call-messages"

const card = (id: string) => ({ id, summary: "s", display: { title: "t" }, expires_at: "2026-01-01T00:00:00Z", warnings: [] as string[] })

describe("callToMessages", () => {
  it("turns captions into ordinary chat messages", () => {
    const out = callToMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], [], 100)
    expect(out).toEqual([
      { role: "user", content: "hi", timestamp: 100 },
      { role: "assistant", content: "hello", timestamp: 100 },
    ])
  })
  it("attaches cards to the last assistant message", () => {
    const out = callToMessages([{ role: "user", content: "buy" }, { role: "assistant", content: "ok" }], [card("d1")], 5)
    expect(out[1].cards).toEqual([{ draftId: "d1", display: { title: "t" }, expires_at: "2026-01-01T00:00:00Z", warnings: [] }])
    expect(out[0].cards).toBeUndefined()
  })
  it("adds a closing assistant message when cards exist but the last turn is the user's", () => {
    const out = callToMessages([{ role: "user", content: "buy" }], [card("d1")], 5)
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ role: "assistant", content: "Please check the details below." })
    expect(out[1].cards).toHaveLength(1)
  })
  it("returns nothing for an empty call", () => {
    expect(callToMessages([], [], 1)).toEqual([])
  })
})
