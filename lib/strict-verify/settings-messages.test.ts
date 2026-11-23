import { describe, it, expect } from "vitest"
import { strictSaveErrorMessage } from "./settings-messages"

describe("strictSaveErrorMessage", () => {
  it("409 strict_tables_missing asks for the database update first", () => {
    expect(strictSaveErrorMessage(409, "strict_tables_missing")).toBe(
      "Apply the strict-verification database update before turning this on",
    )
  })

  it("other errors pass the server's message through, with a fallback", () => {
    expect(strictSaveErrorMessage(503, "Could not confirm the strict-verification tables; try again")).toBe(
      "Could not confirm the strict-verification tables; try again",
    )
    expect(strictSaveErrorMessage(500, undefined)).toBe("Failed to update")
  })
})
