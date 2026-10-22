import { describe, it, expect } from "vitest"
import { splitRichText } from "./rich-text"

describe("splitRichText", () => {
  it("returns plain text untouched", () => {
    expect(splitRichText("Read your wallet balance.")).toEqual([{ code: false, text: "Read your wallet balance." }])
  })

  it("chips header names, preferring the longer Bearer form", () => {
    expect(splitRichText("Send Authorization: Bearer <key> or X-API-Key.")).toEqual([
      { code: false, text: "Send " },
      { code: true, text: "Authorization: Bearer <key>" },
      { code: false, text: " or " },
      { code: true, text: "X-API-Key" },
      { code: false, text: "." },
    ])
  })

  it("keeps a trailing full stop or bracket out of a URL chip", () => {
    expect(splitRichText("Base https://www.datagod.store/api/v2.")).toEqual([
      { code: false, text: "Base " },
      { code: true, text: "https://www.datagod.store/api/v2" },
      { code: false, text: "." },
    ])
    expect(splitRichText("(see https://www.datagod.store/api/v2).")).toEqual([
      { code: false, text: "(see " },
      { code: true, text: "https://www.datagod.store/api/v2" },
      { code: false, text: ")." },
    ])
  })

  it("stops a URL at a comma", () => {
    expect(splitRichText("to https://www.datagod.store/api/v2, is")).toEqual([
      { code: false, text: "to " },
      { code: true, text: "https://www.datagod.store/api/v2" },
      { code: false, text: ", is" },
    ])
  })

  it("chips JSON shapes with one level of nesting and key prefixes", () => {
    const parts = splitRichText('Shape { "a": { "b": 1 } } with dg2_test_ keys')
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(['{ "a": { "b": 1 } }', "dg2_test_"])
  })

  it("never drops or duplicates characters", () => {
    const s = "Authorization wins at https://x.example/a). Then { b }."
    expect(splitRichText(s).map((p) => p.text).join("")).toBe(s)
  })
})
