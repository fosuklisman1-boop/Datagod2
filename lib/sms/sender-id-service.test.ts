import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    existing: null as Record<string, unknown> | null, // submit idempotency check
    insertPayload: null as Record<string, unknown> | null,
    insertedRow: { id: "s1", sender_id: "DTGOD", local_status: "pending" } as unknown,
    insertError: null as { message: string } | null,
    updatedRow: null as Record<string, unknown> | null, // submit's post-Moolre update
    pendingRows: [] as { id: string; sender_id: string; local_status: string }[],
    updatePatches: [] as Record<string, unknown>[],
    moolreCreate: { ok: true, message: "ASMQ12" } as { ok: boolean; message?: string },
    moolreStatus: { rawStatus: "ASMQ02", localStatus: "active" } as {
      rawStatus: string
      localStatus: "pending" | "active" | "rejected"
    },
  }

  const createMoolreSenderId = vi.fn(async (_id: string) => state.moolreCreate)
  const queryMoolreSenderIdStatus = vi.fn(async (_id: string) => state.moolreStatus)

  const fake = {
    from: (_table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, _val: string) => {
          // pollSenderIds: .select("id, sender_id, local_status").eq("local_status", "pending")
          if (typeof cols === "string" && cols.includes("local_status") && col === "local_status") {
            return Promise.resolve({ data: state.pendingRows, error: null })
          }
          // getBySenderId: .select("*").eq("sender_id", v).[is|eq]("sms_account_id", x).maybeSingle()
          const finalize = { maybeSingle: () => Promise.resolve({ data: state.existing, error: null }) }
          return {
            is: (_c: string, _v: unknown) => finalize,
            eq: (_c: string, _v: string) => finalize,
            maybeSingle: finalize.maybeSingle,
          }
        },
      }),
      insert: (row: Record<string, unknown>) => {
        state.insertPayload = row
        return {
          select: () => ({
            single: () =>
              Promise.resolve({ data: state.insertError ? null : state.insertedRow, error: state.insertError }),
          }),
        }
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, _val: string) => {
          state.updatePatches.push(patch)
          // Thenable so poll's bare-await update works, AND carries .select().maybeSingle()
          // for submit's post-Moolre update.
          const p: Promise<{ data: null; error: null }> & {
            select?: () => { maybeSingle: () => Promise<{ data: unknown; error: null }> }
          } = Promise.resolve({ data: null, error: null })
          p.select = () => ({ maybeSingle: () => Promise.resolve({ data: state.updatedRow, error: null }) })
          return p
        },
      }),
    }),
  }

  return { state, fake, createMoolreSenderId, queryMoolreSenderIdStatus }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  createMoolreSenderId: h.createMoolreSenderId,
  queryMoolreSenderIdStatus: h.queryMoolreSenderIdStatus,
}))

import { submitSenderId, pollSenderIds } from "./sender-id-service"

beforeEach(() => {
  h.state.existing = null
  h.state.insertPayload = null
  h.state.insertedRow = { id: "s1", sender_id: "DTGOD", local_status: "pending" }
  h.state.insertError = null
  h.state.updatedRow = null
  h.state.pendingRows = []
  h.state.updatePatches.length = 0
  h.state.moolreCreate = { ok: true, message: "ASMQ12" }
  h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }
  h.createMoolreSenderId.mockClear()
  h.queryMoolreSenderIdStatus.mockClear()
})

describe("submitSenderId", () => {
  it("inserts a pending row and registers the ID with Moolre", async () => {
    const res = await submitSenderId("DTGOD")
    expect(res.ok).toBe(true)
    // Row inserted as pending
    expect(h.state.insertPayload).toMatchObject({ sender_id: "DTGOD", local_status: "pending" })
    // Moolre registration attempted with the sender ID
    expect(h.createMoolreSenderId).toHaveBeenCalledWith("DTGOD")
    expect((res as { data: { moolre: { ok: boolean } } }).data.moolre.ok).toBe(true)
  })

  it("is idempotent: an existing sender ID returns the row WITHOUT re-submitting to Moolre", async () => {
    h.state.existing = { id: "s0", sender_id: "DTGOD", local_status: "active" }
    const res = await submitSenderId("DTGOD")
    expect(res.ok).toBe(true)
    expect((res as { data: { row: { id: string } } }).data.row.id).toBe("s0")
    expect(h.createMoolreSenderId).not.toHaveBeenCalled()
    expect(h.state.insertPayload).toBeNull()
  })

  it("rejects a sender ID longer than 11 characters without inserting", async () => {
    const res = await submitSenderId("TWELVECHARSX")
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/1[–-]11 characters/)
    expect(h.state.insertPayload).toBeNull()
    expect(h.createMoolreSenderId).not.toHaveBeenCalled()
  })

  // Regression: mixed-case input must be canonicalised to upper-case before the
  // existence check, insert, and Moolre call — otherwise idempotency breaks.
  it("upper-cases the sender ID for the insert and the Moolre call", async () => {
    const res = await submitSenderId("  DtGod ")
    expect(res.ok).toBe(true)
    expect(h.state.insertPayload).toMatchObject({ sender_id: "DTGOD", local_status: "pending" })
    expect(h.createMoolreSenderId).toHaveBeenCalledWith("DTGOD")
  })

  it("defaults to admin-global (sms_account_id null) when no account is given", async () => {
    await submitSenderId("DTGOD")
    expect(h.state.insertPayload).toMatchObject({ sms_account_id: null })
  })

  it("stamps the owning account when a tenant requests a sender ID", async () => {
    const res = await submitSenderId("MYSHOP", "acc-123")
    expect(res.ok).toBe(true)
    expect(h.state.insertPayload).toMatchObject({ sender_id: "MYSHOP", sms_account_id: "acc-123" })
  })
})

describe("pollSenderIds", () => {
  it("maps each pending row's Moolre status and reports the transitions", async () => {
    h.state.pendingRows = [{ id: "s1", sender_id: "DTGOD", local_status: "pending" }]
    h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    const data = (res as { data: { polled: number; updated: number; results: { to: string }[] } }).data
    expect(data.polled).toBe(1)
    expect(data.updated).toBe(1)
    expect(data.results[0]).toMatchObject({ senderId: "DTGOD", from: "pending", to: "active" })

    expect(h.queryMoolreSenderIdStatus).toHaveBeenCalledWith("DTGOD")
    // The persisted update carries the mapped local_status + raw Moolre status.
    const lastPatch = h.state.updatePatches[h.state.updatePatches.length - 1]
    expect(lastPatch).toMatchObject({ local_status: "active", moolre_status: "ASMQ02" })
  })

  it("does not count a row as updated when the status is unchanged (still pending)", async () => {
    h.state.pendingRows = [{ id: "s1", sender_id: "DTGOD", local_status: "pending" }]
    h.state.moolreStatus = { rawStatus: "ASMQ05", localStatus: "pending" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect((res as { data: { polled: number; updated: number } }).data.polled).toBe(1)
    expect((res as { data: { updated: number } }).data.updated).toBe(0)
  })

  // Regression: a transient Moolre failure (fail-soft sentinel) must NOT overwrite
  // the last-known-good moolre_status — only last_polled_at/updated_at are touched.
  it("preserves moolre_status on a fail-soft sentinel ('error'), still stamping last_polled_at", async () => {
    h.state.pendingRows = [{ id: "s1", sender_id: "DTGOD", local_status: "pending" }]
    h.state.moolreStatus = { rawStatus: "error", localStatus: "pending" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect((res as { data: { updated: number } }).data.updated).toBe(0)

    const lastPatch = h.state.updatePatches[h.state.updatePatches.length - 1]
    expect(lastPatch).not.toHaveProperty("moolre_status")
    expect(lastPatch).not.toHaveProperty("local_status")
    expect(lastPatch).toHaveProperty("last_polled_at")
  })
})
