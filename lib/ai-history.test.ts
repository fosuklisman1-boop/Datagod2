import { describe, it, expect } from "vitest"
import { normaliseHistory } from "@/lib/ai-history"

const u = (content: string) => ({ role: "user" as const, content })
const a = (content: string) => ({ role: "assistant" as const, content })

describe("normaliseHistory", () => {
  it("normalise_drops_leading_assistant", () => {
    expect(normaliseHistory([a("hello"), a("again"), u("hi")])).toEqual([u("hi")])
  })
  it("normalise_merges_same_role", () => {
    expect(normaliseHistory([u("a"), u("b"), a("c"), a("d"), u("e")])).toEqual([u("a\n\nb"), a("c\n\nd"), u("e")])
  })
  it("normalise_drops_empty", () => {
    expect(normaliseHistory([u("a"), a("  \n"), u(""), u("b")])).toEqual([u("a\n\nb")])
  })
  it("normalise_keeps_latest_user_message", () => {
    expect(normaliseHistory([u("a"), a("b"), u("latest"), a("dangling")])).toEqual([u("a"), a("b"), u("latest")])
  })
  it("returns [] when nothing remains", () => {
    expect(normaliseHistory([])).toEqual([])
    expect(normaliseHistory([a("x")])).toEqual([])
  })
})
