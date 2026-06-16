import { describe, it, expect } from "vitest"
import { buildContactList } from "./recipients"
import type { Contact } from "./recipients"

// ---------------------------------------------------------------------------
// buildContactList is the pure transform layer (normalize → filter-null →
// dedupe → drop opted_out).  It takes pre-fetched rows so it is fully
// unit-testable without Supabase.
// ---------------------------------------------------------------------------

// Suppress unused import warning — Contact is exported for callers
const _: Contact = { phone: "0200000000" }
void _

describe("buildContactList", () => {
  const raw = (
    phone: string,
    opts: { firstName?: string; lastName?: string; optedOut?: boolean } = {}
  ) => ({
    phone_number: phone,
    first_name: opts.firstName ?? null,
    last_name: opts.lastName ?? null,
    opted_out: opts.optedOut ?? false,
  })

  it("normalises Ghanaian numbers to 0XXXXXXXXX form", () => {
    const result = buildContactList([raw("233241234567")])
    expect(result.contacts[0].phone).toBe("0241234567")
  })

  it("filters out un-parseable numbers into skipped", () => {
    const result = buildContactList([raw("not-a-number")])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe("invalid_phone")
  })

  it("dedupes by normalised phone (keeps first occurrence)", () => {
    const result = buildContactList([raw("0241234567"), raw("233241234567")])
    expect(result.contacts).toHaveLength(1)
    expect(result.contacts[0].phone).toBe("0241234567")
  })

  it("drops opted-out contacts", () => {
    const result = buildContactList([raw("0241234567", { optedOut: true })])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped[0].reason).toBe("opted_out")
  })

  it("preserves first_name and last_name", () => {
    const result = buildContactList([raw("0241234567", { firstName: "Ama", lastName: "Mensah" })])
    const c = result.contacts[0]
    expect(c.firstName).toBe("Ama")
    expect(c.lastName).toBe("Mensah")
  })

  it("handles an empty input without error", () => {
    const result = buildContactList([])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it("processes mixed valid, invalid, and opted-out in one pass", () => {
    const result = buildContactList([
      raw("0241234567"),
      raw("bad"),
      raw("0209999999", { optedOut: true }),
      raw("0241234567"), // duplicate
    ])
    expect(result.contacts).toHaveLength(1)
    expect(result.skipped).toHaveLength(3) // bad + opted_out + duplicate
  })
})
