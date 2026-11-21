import { describe, it, expect } from "vitest"
import { redactTranscriptText, MAX_TRANSCRIPT_CHARS } from "./redact"

describe("redactTranscriptText", () => {
  it("redacts_phones_all_formats", () => {
    for (const p of ["0241234567", "233241234567", "+233241234567", "00233241234567", "024 123 4567", "024-123-4567", "+233 24 123 4567"]) {
      const out = redactTranscriptText(`call me on ${p} please`)
      expect(out, p).toBe("call me on [phone] please")
    }
  })

  it("redacts_emails", () => {
    expect(redactTranscriptText("mail ama.k+x@example.co.uk now")).toBe("mail [email] now")
  })

  it("redacts_long_digit_runs_keeps_prefix", () => {
    expect(redactTranscriptText("order ORD-1732456789 is late")).toBe("order ORD-[number] is late")
    expect(redactTranscriptText("card 4111111111111111 acct 123456")).toBe("card [number] acct [number]")
    expect(redactTranscriptText("I paid GHS 12345 for 5 bundles")).toBe("I paid GHS 12345 for 5 bundles")
  })

  it("strips_card_notes_and_data_fences", () => {
    const t = [
      "hello",
      '<card_results nonce="abc123">card 1 done</card_results>',
      "[card 11111111-1111-1111-1111-111111111111: succeeded]",
      "<data>secret tool output</data>",
      "bye",
    ].join("\n")
    const out = redactTranscriptText(t)
    expect(out).not.toMatch(/card_results|abc123|\[card|secret|<data>/)
    expect(out).toContain("hello")
    expect(out).toContain("bye")
  })

  it("strips an unterminated fence to the end", () => {
    expect(redactTranscriptText("hi <data>leak leak")).toBe("hi")
  })

  it("caps at 4000 chars", () => {
    expect(redactTranscriptText("a".repeat(9000)).length).toBe(MAX_TRANSCRIPT_CHARS)
    expect(MAX_TRANSCRIPT_CHARS).toBe(4000)
  })
})
