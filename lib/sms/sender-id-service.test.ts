import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => {
  type Row = Record<string, any>
  type Filter = { col: string; op: "eq" | "is" | "not-is"; val: unknown }

  const state = {
    table: [] as Row[],
    nextId: 1,
    moolreCreate: { ok: true, message: "ASMQ12" } as { ok: boolean; message?: string },
    mnotifyCreate: { ok: true, message: "Pending" } as { ok: boolean; message?: string },
    moolreStatus: { rawStatus: "ASMQ02", localStatus: "active" } as {
      rawStatus: string
      localStatus: "pending" | "active" | "rejected"
    },
    mnotifyStatus: { rawStatus: "Approved", localStatus: "active" } as {
      rawStatus: string
      localStatus: "pending" | "active" | "rejected"
    },
  }

  const createMoolreSenderId = vi.fn(async (_id: string) => state.moolreCreate)
  const queryMoolreSenderIdStatus = vi.fn(async (_id: string) => state.moolreStatus)
  const createMnotifySenderId = vi.fn(async (_id: string) => state.mnotifyCreate)
  const queryMnotifySenderIdStatus = vi.fn(async (_id: string) => state.mnotifyStatus)

  function matchRow(row: Row, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val
      if (f.op === "is") return (row[f.col] ?? null) === f.val
      return (row[f.col] ?? null) !== f.val // not-is
    })
  }

  // A minimal in-memory stand-in for the chunk of the Supabase query builder
  // this service actually uses: select/eq/is/not/maybeSingle/order, plus a
  // bare await resolving to the filtered list (mirrors supabase-js's
  // thenable query objects).
  function makeSelectBuilder(filters: Filter[] = []): any {
    const builder: any = {
      eq(col: string, val: unknown) {
        return makeSelectBuilder([...filters, { col, op: "eq", val }])
      },
      is(col: string, val: unknown) {
        return makeSelectBuilder([...filters, { col, op: "is", val }])
      },
      not(col: string, _nullOp: string, val: unknown) {
        return makeSelectBuilder([...filters, { col, op: "not-is", val }])
      },
      order() {
        return builder
      },
      maybeSingle() {
        const rows = state.table.filter((r) => matchRow(r, filters))
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null })
      },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        const rows = state.table.filter((r) => matchRow(r, filters)).map((r) => ({ ...r }))
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
      },
    }
    return builder
  }

  function makeUpdateBuilder(patch: Row) {
    return {
      eq(col: string, val: unknown) {
        const matching = state.table.filter((r) => r[col] === val)
        matching.forEach((r) => Object.assign(r, patch))
        const resultRow = matching[0] ? { ...matching[0] } : null
        const promise: any = Promise.resolve({ data: null, error: null })
        promise.select = () => ({
          maybeSingle: () => Promise.resolve({ data: resultRow, error: null }),
        })
        return promise
      },
    }
  }

  const fake = {
    from(_table: string) {
      return {
        select(_cols?: string) {
          return makeSelectBuilder()
        },
        insert(row: Row) {
          return {
            select() {
              return {
                single() {
                  const id = `s${state.nextId++}`
                  const newRow: Row = {
                    id,
                    moolre_status: null,
                    local_status: "pending",
                    moolre_pushed_at: null,
                    mnotify_status: null,
                    mnotify_local_status: "pending",
                    mnotify_pushed_at: null,
                    mnotify_last_polled_at: null,
                    last_polled_at: null,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    sms_account_id: null,
                    ...row,
                  }
                  state.table.push(newRow)
                  return Promise.resolve({ data: { ...newRow }, error: null })
                },
              }
            },
          }
        },
        update(patch: Row) {
          return makeUpdateBuilder(patch)
        },
      }
    },
  }

  return {
    state,
    fake,
    createMoolreSenderId,
    queryMoolreSenderIdStatus,
    createMnotifySenderId,
    queryMnotifySenderIdStatus,
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({
  createMoolreSenderId: h.createMoolreSenderId,
  queryMoolreSenderIdStatus: h.queryMoolreSenderIdStatus,
}))
vi.mock("@/lib/mnotify-sender-id", () => ({
  createMnotifySenderId: h.createMnotifySenderId,
  queryMnotifySenderIdStatus: h.queryMnotifySenderIdStatus,
}))

import {
  submitSenderId,
  pushSenderId,
  fetchSenderIdStatus,
  rejectSenderId,
  approveSenderId,
  pollSenderIds,
} from "./sender-id-service"

function seedRow(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `s${h.state.nextId++}`,
    sender_id: "DTGOD",
    sms_account_id: null,
    moolre_status: null,
    local_status: "pending",
    moolre_pushed_at: null,
    mnotify_status: null,
    mnotify_local_status: "pending",
    mnotify_pushed_at: null,
    mnotify_last_polled_at: null,
    last_polled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
  h.state.table.push(row)
  return row
}

beforeEach(() => {
  h.state.table.length = 0
  h.state.nextId = 1
  h.state.moolreCreate = { ok: true, message: "ASMQ12" }
  h.state.mnotifyCreate = { ok: true, message: "Pending" }
  h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }
  h.state.mnotifyStatus = { rawStatus: "Approved", localStatus: "active" }
  h.createMoolreSenderId.mockClear()
  h.queryMoolreSenderIdStatus.mockClear()
  h.createMnotifySenderId.mockClear()
  h.queryMnotifySenderIdStatus.mockClear()
})

describe("submitSenderId", () => {
  it("inserts a pending row WITHOUT contacting any provider", async () => {
    const res = await submitSenderId("DTGOD")
    expect(res.ok).toBe(true)
    expect((res as { data: { row: { sender_id: string; local_status: string } } }).data.row).toMatchObject({
      sender_id: "DTGOD",
      local_status: "pending",
    })
    expect(h.createMoolreSenderId).not.toHaveBeenCalled()
    expect(h.createMnotifySenderId).not.toHaveBeenCalled()
  })

  it("is idempotent: an existing sender ID returns the row without re-inserting", async () => {
    seedRow({ id: "s0", sender_id: "DTGOD", local_status: "active" })
    const res = await submitSenderId("DTGOD")
    expect(res.ok).toBe(true)
    expect((res as { data: { row: { id: string } } }).data.row.id).toBe("s0")
    expect(h.state.table.filter((r) => r.sender_id === "DTGOD")).toHaveLength(1)
  })

  it("rejects a sender ID longer than 11 characters without inserting", async () => {
    const res = await submitSenderId("TWELVECHARSX")
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/1[–-]11 characters/)
    expect(h.state.table).toHaveLength(0)
  })

  it("upper-cases the sender ID for the insert", async () => {
    const res = await submitSenderId("  DtGod ")
    expect(res.ok).toBe(true)
    expect((res as { data: { row: { sender_id: string } } }).data.row.sender_id).toBe("DTGOD")
  })

  it("defaults to admin-global (sms_account_id null) when no account is given", async () => {
    await submitSenderId("DTGOD")
    expect(h.state.table[0]).toMatchObject({ sms_account_id: null })
  })

  it("stamps the owning account when a tenant requests a sender ID", async () => {
    const res = await submitSenderId("MYSHOP", "acc-123")
    expect(res.ok).toBe(true)
    expect(h.state.table[0]).toMatchObject({ sender_id: "MYSHOP", sms_account_id: "acc-123" })
  })
})

describe("pushSenderId", () => {
  it("pushes to Moolre: calls createMoolreSenderId and stamps moolre_pushed_at/moolre_status only", async () => {
    const row = seedRow()
    h.state.moolreCreate = { ok: true, message: "ASMQ12" }

    const res = await pushSenderId(row.id, "moolre")
    expect(res.ok).toBe(true)
    expect(h.createMoolreSenderId).toHaveBeenCalledWith("DTGOD")
    expect(h.createMnotifySenderId).not.toHaveBeenCalled()

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.moolre_status).toBe("ASMQ12")
    expect(updated?.moolre_pushed_at).not.toBeNull()
    expect(updated?.mnotify_pushed_at).toBeNull()
  })

  it("pushes to mNotify: calls createMnotifySenderId and stamps mnotify_pushed_at/mnotify_status only", async () => {
    const row = seedRow()
    h.state.mnotifyCreate = { ok: true, message: "Pending" }

    const res = await pushSenderId(row.id, "mnotify")
    expect(res.ok).toBe(true)
    expect(h.createMnotifySenderId).toHaveBeenCalledWith("DTGOD")
    expect(h.createMoolreSenderId).not.toHaveBeenCalled()

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.mnotify_status).toBe("Pending")
    expect(updated?.mnotify_pushed_at).not.toBeNull()
    expect(updated?.moolre_pushed_at).toBeNull()
  })

  it("returns ok:false for an unknown id", async () => {
    const res = await pushSenderId("nope", "moolre")
    expect(res.ok).toBe(false)
  })
})

describe("fetchSenderIdStatus", () => {
  it("checks Moolre and updates local_status + moolre_status + last_polled_at", async () => {
    const row = seedRow({ moolre_pushed_at: new Date().toISOString() })
    h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }

    const res = await fetchSenderIdStatus(row.id, "moolre")
    expect(res.ok).toBe(true)
    expect(h.queryMoolreSenderIdStatus).toHaveBeenCalledWith("DTGOD")

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated).toMatchObject({ local_status: "active", moolre_status: "ASMQ02" })
    expect(updated?.last_polled_at).not.toBeNull()
  })

  it("checks mNotify and updates mnotify_local_status + mnotify_status + mnotify_last_polled_at", async () => {
    const row = seedRow({ mnotify_pushed_at: new Date().toISOString() })
    h.state.mnotifyStatus = { rawStatus: "Rejected", localStatus: "rejected" }

    const res = await fetchSenderIdStatus(row.id, "mnotify")
    expect(res.ok).toBe(true)
    expect(h.queryMnotifySenderIdStatus).toHaveBeenCalledWith("DTGOD")

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated).toMatchObject({ mnotify_local_status: "rejected", mnotify_status: "Rejected" })
    expect(updated?.mnotify_last_polled_at).not.toBeNull()
  })

  it("preserves last-known status on a fail-soft sentinel, still stamping the polled timestamp", async () => {
    const row = seedRow({ moolre_status: "ASMQ05", local_status: "pending", moolre_pushed_at: new Date().toISOString() })
    h.state.moolreStatus = { rawStatus: "error", localStatus: "pending" }

    const res = await fetchSenderIdStatus(row.id, "moolre")
    expect(res.ok).toBe(true)

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.moolre_status).toBe("ASMQ05")
    expect(updated?.last_polled_at).not.toBeNull()
  })

  it("never writes local_status / mnotify_local_status for a tenant-owned row", async () => {
    const row = seedRow({ sms_account_id: "acct1", moolre_pushed_at: "x", mnotify_pushed_at: "x" })
    await fetchSenderIdStatus(row.id, "moolre")
    await fetchSenderIdStatus(row.id, "mnotify")
    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated).toMatchObject({ local_status: "pending", mnotify_local_status: "pending", moolre_status: "ASMQ02" })
  })
})

describe("pollSenderIds tenant rows", () => {
  it("skips tenant-owned rows on both providers", async () => {
    const t = seedRow({ sender_id: "TENANT", sms_account_id: "acct1", moolre_pushed_at: "x", mnotify_pushed_at: "x" })
    await pollSenderIds()
    expect(h.queryMoolreSenderIdStatus).not.toHaveBeenCalled()
    expect(h.queryMnotifySenderIdStatus).not.toHaveBeenCalled()
    expect(h.state.table.find((r) => r.id === t.id)).toMatchObject({ local_status: "pending", mnotify_local_status: "pending" })
  })
})

describe("rejectSenderId / approveSenderId", () => {
  it("rejectSenderId('moolre') sets local_status without touching mnotify_local_status", async () => {
    const row = seedRow()
    const res = await rejectSenderId(row.id, "moolre")
    expect(res.ok).toBe(true)
    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.local_status).toBe("rejected")
    expect(updated?.mnotify_local_status).toBe("pending")
  })

  it("rejectSenderId('mnotify') sets mnotify_local_status without touching local_status", async () => {
    const row = seedRow()
    const res = await rejectSenderId(row.id, "mnotify")
    expect(res.ok).toBe(true)
    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.mnotify_local_status).toBe("rejected")
    expect(updated?.local_status).toBe("pending")
  })

  it("rejectSenderId('both') sets both columns", async () => {
    const row = seedRow()
    await rejectSenderId(row.id, "both")
    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated).toMatchObject({ local_status: "rejected", mnotify_local_status: "rejected" })
  })

  it("approveSenderId('both') sets both columns to active and never calls a provider API", async () => {
    const row = seedRow()
    const res = await approveSenderId(row.id, "both")
    expect(res.ok).toBe(true)
    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated).toMatchObject({ local_status: "active", mnotify_local_status: "active" })
    expect(h.createMoolreSenderId).not.toHaveBeenCalled()
    expect(h.createMnotifySenderId).not.toHaveBeenCalled()
    expect(h.queryMoolreSenderIdStatus).not.toHaveBeenCalled()
    expect(h.queryMnotifySenderIdStatus).not.toHaveBeenCalled()
  })
})

describe("pollSenderIds", () => {
  it("only polls rows pushed to Moolre, skipping pending rows never pushed", async () => {
    seedRow({ sender_id: "PUSHED", moolre_pushed_at: new Date().toISOString() })
    seedRow({ sender_id: "NOTPUSHED", moolre_pushed_at: null })
    h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect(h.queryMoolreSenderIdStatus).toHaveBeenCalledTimes(1)
    expect(h.queryMoolreSenderIdStatus).toHaveBeenCalledWith("PUSHED")
  })

  it("only polls rows pushed to mNotify, skipping pending rows never pushed", async () => {
    seedRow({ sender_id: "PUSHED", mnotify_pushed_at: new Date().toISOString() })
    seedRow({ sender_id: "NOTPUSHED", mnotify_pushed_at: null })
    h.state.mnotifyStatus = { rawStatus: "Approved", localStatus: "active" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect(h.queryMnotifySenderIdStatus).toHaveBeenCalledTimes(1)
    expect(h.queryMnotifySenderIdStatus).toHaveBeenCalledWith("PUSHED")
  })

  it("polls both providers independently and reports combined transitions", async () => {
    seedRow({ sender_id: "MOOLREID", moolre_pushed_at: new Date().toISOString() })
    seedRow({ sender_id: "MNOTIFYID", mnotify_pushed_at: new Date().toISOString() })
    h.state.moolreStatus = { rawStatus: "ASMQ02", localStatus: "active" }
    h.state.mnotifyStatus = { rawStatus: "Rejected", localStatus: "rejected" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    const data = (res as { data: { polled: number; updated: number; results: { senderId: string; to: string }[] } })
      .data
    expect(data.polled).toBe(2)
    expect(data.updated).toBe(2)
    expect(data.results).toEqual(
      expect.arrayContaining([
        { senderId: "MOOLREID", from: "pending", to: "active" },
        { senderId: "MNOTIFYID", from: "pending", to: "rejected" },
      ])
    )
  })

  it("does not count a row as updated when its status is unchanged (still pending)", async () => {
    seedRow({ sender_id: "DTGOD", moolre_pushed_at: new Date().toISOString() })
    h.state.moolreStatus = { rawStatus: "ASMQ05", localStatus: "pending" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect((res as { data: { updated: number } }).data.updated).toBe(0)
  })

  it("preserves moolre_status on a fail-soft sentinel ('error'), still stamping last_polled_at", async () => {
    const row = seedRow({ sender_id: "DTGOD", moolre_pushed_at: new Date().toISOString() })
    h.state.moolreStatus = { rawStatus: "error", localStatus: "pending" }

    const res = await pollSenderIds()
    expect(res.ok).toBe(true)
    expect((res as { data: { updated: number } }).data.updated).toBe(0)

    const updated = h.state.table.find((r) => r.id === row.id)
    expect(updated?.moolre_status).toBeNull()
    expect(updated?.local_status).toBe("pending")
    expect(updated?.last_polled_at).not.toBeNull()
  })
})
