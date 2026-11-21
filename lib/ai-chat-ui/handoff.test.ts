import { describe, it, expect } from "vitest"
import { buildHandoffMessage, buildHandoffThreadBody } from "./handoff"
import { createThreadSchema } from "@/lib/support-validation"

const m = (role: "user" | "assistant" | "system", content: string) => ({ role, content })
const contact = { phone: "0241234567", whatsapp: "0241234567" }

describe("handoff", () => {
  it("handoff_message_last5_capped_2000", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => m(i % 2 ? "assistant" : "user", `line number ${i}`))
    expect(buildHandoffMessage(msgs).split("\n")).toEqual([
      "AI: line number 5",
      "Me: line number 6",
      "AI: line number 7",
      "Me: line number 8",
      "AI: line number 9",
    ])
    const long = buildHandoffMessage([m("user", "a".repeat(900)), m("assistant", "b".repeat(900)), m("user", "c".repeat(900))])
    expect(long.length).toBeLessThanOrEqual(2000)
    expect(long.startsWith("Me: a")).toBe(true)
    expect(long.split("\n").every((l) => /^(Me|AI): /.test(l))).toBe(true)
  })
  it("handoff_excludes_card_notes_and_system", () => {
    const out = buildHandoffMessage([
      m("system", "secret system"),
      m("user", 'hello <card_results nonce="x">\n[card 1: ok]\n</card_results> there\n[card 9: failed; x]'),
      m("assistant", "ok"),
    ])
    expect(out).not.toMatch(/card|secret|nonce/i)
    expect(out).toContain("Me: hello")
  })
  it("builds a body that satisfies the support schema", () => {
    const body = buildHandoffThreadBody([m("user", "I need <help> & more")], contact)
    expect(body.subject).toBe("From AI chat")
    expect(body.category).toBe("other")
    expect(createThreadSchema.safeParse(body).success).toBe(true)
    expect(createThreadSchema.safeParse(buildHandoffThreadBody([], contact)).success).toBe(true)
  })
})

import { handoffFailureMessage, handoffAvailable } from "./handoff"

describe("handoff outcomes", () => {
  it("handoff_409_message", () => {
    expect(handoffFailureMessage(409)).toBe("You already have 3 open support chats — opening WhatsApp instead.")
  })
  it("handoff_failure_message", () => {
    expect(handoffFailureMessage(500)).toBe("Couldn't open a support chat — opening WhatsApp instead.")
    expect(handoffFailureMessage(undefined)).toBe("Couldn't open a support chat — opening WhatsApp instead.")
  })
  it("handoff_available", () => {
    expect(handoffAvailable({ mode: "whatsapp", whatsapp: "233241234567" })).toBe(true)
    expect(handoffAvailable({ mode: "whatsapp", whatsapp: "" })).toBe(false)
    expect(handoffAvailable({ mode: "thread", hasToken: true, phone: "0241234567" })).toBe(true)
    expect(handoffAvailable({ mode: "thread", hasToken: false, phone: "0241234567", whatsapp: "233241234567" })).toBe(true)
    expect(handoffAvailable({ mode: "thread", hasToken: true, phone: null, whatsapp: null })).toBe(false)
  })
  it("handoff_strips_whole_card_results_block", () => {
    const out = buildHandoffMessage([m("user", 'hi <card_results nonce="n">SECRET ORDER DATA</card_results> bye')])
    expect(out).toBe("Me: hi bye")
  })
})
