import { describe, it, expect } from "vitest"
import { DEFAULT_ASSISTANT_NAME, normaliseAssistantName } from "./assistant-name"

describe("assistant name", () => {
  it("defaults", () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe("DATAGOD AI")
    expect(normaliseAssistantName(undefined)).toBe(DEFAULT_ASSISTANT_NAME)
    expect(normaliseAssistantName(42)).toBe(DEFAULT_ASSISTANT_NAME)
    expect(normaliseAssistantName("A")).toBe(DEFAULT_ASSISTANT_NAME)
    expect(normaliseAssistantName("x".repeat(25))).toBe(DEFAULT_ASSISTANT_NAME)
    expect(normaliseAssistantName("<b>Bot</b>")).toBe(DEFAULT_ASSISTANT_NAME)
  })
  it("accepts and trims valid names", () => {
    expect(normaliseAssistantName("  Kofi-Bot 2 ")).toBe("Kofi-Bot 2")
  })
})
