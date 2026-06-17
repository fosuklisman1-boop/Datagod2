import { describe, it, expect, beforeEach, vi } from "vitest"

// Real normalizeGhanaPhone runs (not mocked) — the dedupe/skip logic depends on it,
// so exercising the real normalizer is the point of these tests.
const h = vi.hoisted(() => {
  const state = {
    insertPayload: null as Record<string, unknown> | null,
    insertError: null as { code?: string; message: string } | null,
    insertReturn: { id: "c1" } as unknown,
    upsertPayload: null as Record<string, unknown>[] | null,
    upsertOpts: null as Record<string, unknown> | null,
    upsertReturn: [] as { phone_number: string }[],
    upsertError: null as { message: string } | null,
    // isAdminGlobalGroup() lookup result — default to a global group existing so the
    // ownership gate passes and the normalize/dedupe assertions run as before.
    groupExists: true,
  }

  const fake = {
    from: (_table: string) => ({
      // select(...).eq(...).is(...).maybeSingle() — the isAdminGlobalGroup gate.
      select: (_cols?: string) => ({
        eq: (_c?: string, _v?: unknown) => ({
          is: (_c2?: string, _v2?: unknown) => ({
            maybeSingle: () =>
              Promise.resolve({ data: state.groupExists ? { id: "g1" } : null, error: null }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        state.insertPayload = row
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: state.insertError ? null : state.insertReturn,
                error: state.insertError,
              }),
          }),
        }
      },
      upsert: (rows: Record<string, unknown>[], opts: Record<string, unknown>) => {
        state.upsertPayload = rows
        state.upsertOpts = opts
        return {
          select: (_cols?: string) =>
            Promise.resolve({
              data: state.upsertError ? null : state.upsertReturn,
              error: state.upsertError,
            }),
        }
      },
    }),
  }

  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { addContact, bulkImportContacts } from "./address-book-service"

beforeEach(() => {
  h.state.insertPayload = null
  h.state.insertError = null
  h.state.insertReturn = { id: "c1" }
  h.state.upsertPayload = null
  h.state.upsertOpts = null
  h.state.upsertReturn = []
  h.state.upsertError = null
  h.state.groupExists = true
})

describe("addContact", () => {
  it("normalises the phone to 0XXXXXXXXX before inserting", async () => {
    const res = await addContact("g1", { phone_number: "233241111111" })
    expect(res.ok).toBe(true)
    expect(h.state.insertPayload).toMatchObject({ group_id: "g1", phone_number: "0241111111" })
  })

  it("rejects an invalid Ghana number without inserting", async () => {
    const res = await addContact("g1", { phone_number: "not-a-phone" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/Invalid/i)
    expect(h.state.insertPayload).toBeNull()
  })

  it("maps a unique-violation (23505) to a friendly 'already exists' error", async () => {
    h.state.insertError = { code: "23505", message: "duplicate key" }
    const res = await addContact("g1", { phone_number: "0241111111" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/already exists/i)
  })

  it("refuses to add to a non-admin-global (tenant) group — never inserts", async () => {
    h.state.groupExists = false // isAdminGlobalGroup() finds no NULL-account group
    const res = await addContact("tenant-group", { phone_number: "0241111111" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/not found/i)
    expect(h.state.insertPayload).toBeNull()
  })
})

describe("bulkImportContacts", () => {
  it("normalises, dedupes within the payload, skips invalid, and dedupes against the DB via the unique constraint", async () => {
    // 0241111111 and its 233-prefixed twin collapse to one; 0242222222 is reported
    // as already-in-DB (not returned by the upsert); "bad" is invalid.
    h.state.upsertReturn = [{ phone_number: "0241111111" }]

    const res = await bulkImportContacts("g1", [
      { phone_number: "0241111111" },
      { phone_number: "233241111111" }, // same number, different format → in-payload dup
      { phone_number: "0242222222" }, // valid but "already in DB"
      { phone_number: "bad" }, // invalid
    ])

    expect(res.ok).toBe(true)
    const data = (res as { data: { inserted: number; skipped: number; skippedSamples: { reason: string }[] } }).data
    expect(data.inserted).toBe(1)
    expect(data.skipped).toBe(3) // 1 invalid + 1 in-payload dup + 1 db conflict

    // Dedupe must go through the UNIQUE(group_id, phone_number) constraint.
    expect(h.state.upsertOpts).toMatchObject({ onConflict: "group_id,phone_number", ignoreDuplicates: true })

    // Only the two distinct, valid, normalised numbers were sent to the DB.
    expect(h.state.upsertPayload).toHaveLength(2)
    const phones = (h.state.upsertPayload ?? []).map((r) => r.phone_number).sort()
    expect(phones).toEqual(["0241111111", "0242222222"])

    // Skipped samples carry both reasons.
    const reasons = data.skippedSamples.map((s) => s.reason)
    expect(reasons).toContain("invalid")
    expect(reasons).toContain("duplicate")
  })

  it("returns inserted=0 with no DB call when every row is invalid", async () => {
    const res = await bulkImportContacts("g1", [{ phone_number: "x" }, { phone_number: "" }])
    expect(res.ok).toBe(true)
    expect((res as { data: { inserted: number; skipped: number } }).data.inserted).toBe(0)
    expect((res as { data: { skipped: number } }).data.skipped).toBe(2)
    expect(h.state.upsertPayload).toBeNull() // never touched the DB
  })
})
