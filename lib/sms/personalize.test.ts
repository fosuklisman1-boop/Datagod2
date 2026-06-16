import { describe, it, expect } from "vitest"
import { MERGE_TOKENS, hasMergeTokens, personalize } from "./personalize"

describe("MERGE_TOKENS", () => {
  it("exports an array of token strings", () => {
    expect(Array.isArray(MERGE_TOKENS)).toBe(true)
    expect(MERGE_TOKENS).toContain("[FirstName]")
    expect(MERGE_TOKENS).toContain("[LastName]")
    expect(MERGE_TOKENS).toContain("[Phone]")
  })
})

describe("hasMergeTokens", () => {
  it("returns true when message contains [FirstName]", () => {
    expect(hasMergeTokens("Hi [FirstName], your bundle is ready.")).toBe(true)
  })

  it("returns true when message contains [Phone]", () => {
    expect(hasMergeTokens("Your number [Phone] is registered.")).toBe(true)
  })

  it("returns false for plain message", () => {
    expect(hasMergeTokens("Hello, your bundle is ready.")).toBe(false)
  })
})

describe("personalize", () => {
  it("replaces [FirstName] with firstName", () => {
    const result = personalize("Hi [FirstName]!", { firstName: "Ama", phone: "0244000000" })
    expect(result).toBe("Hi Ama!")
  })

  it("replaces [LastName] with lastName", () => {
    const result = personalize("Dear [LastName]", { lastName: "Mensah", phone: "0244000000" })
    expect(result).toBe("Dear Mensah")
  })

  it("replaces [Phone] with phone", () => {
    const result = personalize("Your number is [Phone].", { phone: "0244000000" })
    expect(result).toBe("Your number is 0244000000.")
  })

  it("replaces all tokens in one message", () => {
    const result = personalize("[FirstName] [LastName] ([Phone])", {
      firstName: "Ama",
      lastName: "Mensah",
      phone: "0244000000",
    })
    expect(result).toBe("Ama Mensah (0244000000)")
  })

  it("missing firstName leaves token in place (shows [FirstName])", () => {
    const result = personalize("Hi [FirstName]!", { phone: "0244000000" })
    expect(result).toBe("Hi [FirstName]!")
  })

  it("missing lastName leaves token in place", () => {
    const result = personalize("Dear [LastName]", { phone: "0244000000" })
    expect(result).toBe("Dear [LastName]")
  })

  it("replaces multiple occurrences of same token", () => {
    const result = personalize("[FirstName] is great, [FirstName]!", {
      firstName: "Ama",
      phone: "0244000000",
    })
    expect(result).toBe("Ama is great, Ama!")
  })

  it("message with no tokens returned unchanged", () => {
    const msg = "Bundle is ready."
    expect(personalize(msg, { phone: "0244000000" })).toBe(msg)
  })

  // Regression: replacement values are inserted LITERALLY — a name containing a
  // '$' special pattern ($&, $`, $', $$, $n) must not splice message text into
  // the slot. (Function replacers, not string replacers.)
  it("inserts a firstName containing '$`' literally (no replacement-pattern splice)", () => {
    const result = personalize("Hi [FirstName], code 1234", { firstName: "$`", phone: "0244000000" })
    expect(result).toBe("Hi $`, code 1234")
  })

  it("inserts a name containing '$&' literally", () => {
    const result = personalize("Dear [LastName]", { lastName: "A$&B", phone: "0244000000" })
    expect(result).toBe("Dear A$&B")
  })

  it("inserts a phone-slot value containing '$$' literally", () => {
    const result = personalize("[Phone]", { phone: "0$$24" })
    expect(result).toBe("0$$24")
  })
})
