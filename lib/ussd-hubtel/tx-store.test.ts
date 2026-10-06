// lib/ussd-hubtel/tx-store.test.ts
// Records the PostgREST filter chain so the query-level guards are pinned.
import { describe, it, expect } from "vitest"
import { createSupabaseTxStore } from "./tx-store"

type Call = [string, ...unknown[]]

function recordingClient(result: { data: unknown; error: null }) {
  const calls: Call[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ["select", "update", "eq", "in", "is", "lt", "gt", "order", "limit"]) {
    builder[m] = (...args: unknown[]) => { calls.push([m, ...args]); return builder }
  }
  builder.then = (res: (v: unknown) => unknown) => res(result)
  const client = { from: (t: string) => { calls.push(["from", t]); return builder } }
  return { client: client as never, calls }
}

describe("createSupabaseTxStore", () => {
  it("listIndeterminate filters parked rows AND the re-check caps in the query (no starvation)", async () => {
    const { client, calls } = recordingClient({ data: [], error: null })
    const before = Date.now()
    await createSupabaseTxStore(client).listIndeterminate(5)
    expect(calls).toContainEqual(["eq", "state", "needs_review"])
    expect(calls).toContainEqual(["eq", "callback_status", "not_due"])
    expect(calls).toContainEqual(["is", "paid_at", null])
    expect(calls).toContainEqual(["lt", "status_check_attempts", 12])
    const gt = calls.find(c => c[0] === "gt" && c[1] === "created_at")
    expect(gt).toBeTruthy()
    const cutoff = new Date(String(gt![2])).getTime()
    expect(Math.abs(before - 24 * 60 * 60_000 - cutoff)).toBeLessThan(5_000)
    expect(calls).toContainEqual(["order", "created_at", { ascending: true }])
    expect(calls).toContainEqual(["limit", 5])
  })

  it("claim with a where guard adds callback_status and paid_at IS NULL filters", async () => {
    const { client, calls } = recordingClient({ data: [{ session_id: "S1" }], error: null })
    const won = await createSupabaseTxStore(client).claim("S1", ["needs_review"], { callback_status: "not_due", paid_atIsNull: true })
    expect(won).toBe(true)
    expect(calls).toContainEqual(["in", "state", ["needs_review"]])
    expect(calls).toContainEqual(["eq", "callback_status", "not_due"])
    expect(calls).toContainEqual(["is", "paid_at", null])
  })

  it("claim without a where guard adds no extra filters", async () => {
    const { client, calls } = recordingClient({ data: [{ session_id: "S1" }], error: null })
    await createSupabaseTxStore(client).claim("S1")
    expect(calls.some(c => c[0] === "eq" && c[1] === "callback_status")).toBe(false)
    expect(calls.some(c => c[0] === "is")).toBe(false)
  })
})
