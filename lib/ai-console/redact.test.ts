import { describe, it, expect } from "vitest"
import { redactTranscriptText, MAX_TRANSCRIPT_CHARS } from "./redact"

describe("redactTranscriptText", () => {
  it("redacts_phones_all_formats", () => {
    for (const p of ["0241234567", "233241234567", "+233241234567", "00233241234567", "024 123 4567", "024-123-4567", "+233 24 123 4567"]) {
      const out = redactTranscriptText(`call me on ${p} please`)
      expect(out, p).toBe("call me on [phone] please")
    }
  })

  it("redacts_phone_groupings", () => {
    for (const p of ["0241 234 567", "+233 241 234 567", "024.123.4567", "(024) 123 4567", "+233 (0)24 123 4567", "024-123-4567", "(0)24 123 4567", "024 1234 567"]) {
      expect(redactTranscriptText(`ring ${p} now`), p).toBe("ring [phone] now")
    }
  })

  it("redacts_otp_after_keyword", () => {
    expect(redactTranscriptText("my pin is 4821")).toBe("my pin is [number]")
    expect(redactTranscriptText("OTP: 123456 please")).toBe("OTP: [number] please")
    expect(redactTranscriptText("the code 9087 failed")).toBe("the code [number] failed")
    expect(redactTranscriptText("password 55512")).toBe("password [number]")
  })

  it("no false positives on prices, dates and order codes", () => {
    expect(redactTranscriptText("It costs GHS 23.50 for 1.5GB")).toBe("It costs GHS 23.50 for 1.5GB")
    expect(redactTranscriptText("placed on 2026-11-21 at 10:30")).toBe("placed on 2026-11-21 at 10:30")
    expect(redactTranscriptText("see ORD-1732456789")).toBe("see ORD-[number]")
    expect(redactTranscriptText("top up GHS 100 and GHS 1,250.00")).toBe("top up GHS 100 and GHS 1,250.00")
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
