import { describe, it, expect } from "vitest"
import { runSequentialBatches } from "./send-service"

// Inject a fake per-chunk sender so the batching orchestration is tested without
// the DB. `ok(n)` mimics enqueueSend success for n recipients; `err(code)` a
// returned EnqueueSendError. Small batchSize/maxTotal keep the chunk math easy.
const ok = (n: number): any => ({ ok: true, sendLogId: "x", total: n, segments: 1, creditsReserved: n, invalidSkipped: 0 })
const err = (error: string): any => ({ ok: false, error })
const opts = { batchSize: 2, maxTotal: 10 }
const recips = (n: number) => Array.from({ length: n }, (_, i) => `+23324${String(i).padStart(7, "0")}`)

describe("runSequentialBatches", () => {
  it("sends a single batch", async () => {
    const r = await runSequentialBatches(recips(2), async (c) => ok(c.length), opts)
    expect(r).toMatchObject({ ok: true, batches: 1, totalQueued: 2, partial: false })
  })

  it("fans out into multiple batches and sums totals + credits", async () => {
    const r = await runSequentialBatches(recips(5), async (c) => ok(c.length), opts) // 2 + 2 + 1
    expect(r).toMatchObject({ ok: true, batches: 3, totalQueued: 5, creditsReserved: 5, partial: false })
  })

  it("rejects an empty list", async () => {
    const r = await runSequentialBatches([], async (c) => ok(c.length), opts)
    expect(r).toMatchObject({ ok: false, error: "NO_VALID_RECIPIENTS" })
  })

  it("rejects over the ceiling BEFORE sending anything", async () => {
    let called = false
    const r = await runSequentialBatches(recips(11), async (c) => { called = true; return ok(c.length) }, opts)
    expect(r).toMatchObject({ ok: false, error: "TOO_MANY_RECIPIENTS" })
    expect(called).toBe(false)
  })

  it("returns a hard error if the FIRST batch fails a gate (nothing sent)", async () => {
    const r = await runSequentialBatches(recips(4), async () => err("BLOCKED"), opts)
    expect(r).toMatchObject({ ok: false, error: "BLOCKED" })
  })

  it("returns a PARTIAL success when a LATER batch fails (e.g. credits depleted)", async () => {
    let n = 0
    const r = await runSequentialBatches(recips(5), async (c) => (++n === 1 ? ok(c.length) : err("INSUFFICIENT_CREDITS")), opts)
    expect(r).toMatchObject({ ok: true, partial: true, batches: 1, totalQueued: 2, stoppedReason: "INSUFFICIENT_CREDITS" })
  })

  it("SKIPS an all-invalid middle chunk and keeps delivering the valid ones", async () => {
    let n = 0
    const r = await runSequentialBatches(recips(5), async (c) => (++n === 2 ? err("NO_VALID_RECIPIENTS") : ok(c.length)), opts)
    expect(r).toMatchObject({ ok: true, partial: false, batches: 2, totalQueued: 3 }) // chunk1 (2) + chunk3 (1)
  })

  it("returns NO_VALID_RECIPIENTS when EVERY chunk is invalid", async () => {
    const r = await runSequentialBatches(recips(5), async () => err("NO_VALID_RECIPIENTS"), opts)
    expect(r).toMatchObject({ ok: false, error: "NO_VALID_RECIPIENTS" })
  })

  it("a THROW on a later batch becomes a partial (earlier batches were already charged)", async () => {
    let n = 0
    const r = await runSequentialBatches(recips(5), async (c) => { if (++n === 2) throw new Error("rpc boom"); return ok(c.length) }, opts)
    expect(r).toMatchObject({ ok: true, partial: true, batches: 1, stoppedReason: "SEND_ERROR" })
  })

  it("a THROW on the FIRST batch rethrows (nothing charged → safe retry)", async () => {
    await expect(
      runSequentialBatches(recips(4), async () => { throw new Error("boom") }, opts)
    ).rejects.toThrow("boom")
  })
})
