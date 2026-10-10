import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, any>
const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    files: new Set<string>(),
    seq: 0,
    audit: [] as any[],
    notifs: [] as any[],
    modeCalls: [] as any[],
    modeResult: { ok: true, data: { mode: "business", unpaused: 0, paused: 0, conflicts: [] } } as any,
    uploadError: null as string | null,
    failSelect: false,
    onUpdate: null as null | (() => void),
    removeError: null as string | null,
  }
  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select"
    let payload: Row = {}
    const filters: ((r: Row) => boolean)[] = []
    let ord: { col: string; asc: boolean } | null = null
    let lim: number | null = null
    let returning = false
    const rows = () => (state.tables[table] ??= [])
    function run(): { data: any; error: any } {
      let matched = rows().filter((r) => filters.every((f) => f(r)))
      if (ord) matched = [...matched].sort((a, b) => (a[ord!.col] < b[ord!.col] ? -1 : 1) * (ord!.asc ? 1 : -1))
      if (lim != null) matched = matched.slice(0, lim)
      if (op === "select" && table === "sms_business_profiles" && state.failSelect) return { data: null, error: { message: "db down" } }
      if (op === "select") return { data: matched.map((r) => ({ ...r })), error: null }
      if (op === "insert") {
        const row: Row = { id: `p${++state.seq}`, created_at: `2026-10-10T00:00:${String(state.seq).padStart(2, "0")}Z`, ghana_card_doc_path: null, registration_doc_path: null, docs_purge_after: null, ...payload }
        if (table === "sms_business_profiles" && ["draft", "submitted"].includes(row.status) &&
            rows().some((r) => r.sms_account_id === row.sms_account_id && ["draft", "submitted"].includes(r.status))) {
          return { data: null, error: { code: "23505", message: "duplicate key" } }
        }
        rows().push(row)
        if (table === "notifications") state.notifs.push(row)
        return { data: returning ? [{ ...row }] : null, error: null }
      }
      state.onUpdate?.()
      matched = rows().filter((r) => filters.every((f) => f(r)))
      for (const r of matched) Object.assign(r, payload)
      return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null }
    }
    const api: any = {
      select: () => { if (op !== "select") returning = true; return api },
      update: (p: Row) => { op = "update"; payload = p; return api },
      insert: (p: Row) => { op = "insert"; payload = p; return api },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return api },
      is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return api },
      lt: (c: string, v: any) => { filters.push((r) => r[c] != null && r[c] < v); return api },
      or: (e: string) => {
        filters.push((r) => e.split(",").some((c) => { const [col] = c.split("."); return r[col] != null }))
        return api
      },
      order: (col: string, o?: { ascending?: boolean }) => { ord = { col, asc: o?.ascending !== false }; return api },
      limit: (n: number) => { lim = n; return api },
      maybeSingle: () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }) },
      single: () => { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error ?? (r.data?.[0] ? null : { message: "no row" }) }) },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return api
  }
  const storage = {
    from: () => ({
      upload: (path: string) => {
        if (state.uploadError) return Promise.resolve({ error: { message: state.uploadError } })
        state.files.add(path); return Promise.resolve({ error: null })
      },
      remove: (paths: string[]) => { if (state.removeError) return Promise.resolve({ error: { message: state.removeError } }); paths.forEach((p) => state.files.delete(p)); return Promise.resolve({ error: null }) },
      createSignedUrl: (path: string, secs: number) => Promise.resolve({ data: { signedUrl: `signed://${path}?t=${secs}` } }),
    }),
  }
  return { state, fake: { from: (t: string) => builder(t), storage } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./sender-rules-service", () => ({
  setAccountMode: (...a: any[]) => { h.state.modeCalls.push(a); return Promise.resolve(h.state.modeResult) },
}))
vi.mock("./notify", () => ({ notifyAdminsThrottled: () => Promise.resolve() }))
vi.mock("./moderation-service", () => ({
  writeAuditLog: (...a: any[]) => { h.state.audit.push(a); return Promise.resolve() },
}))

import { saveKycDraft, uploadKycDocument, submitKyc, approveKyc, rejectKyc, purgeKycDocuments, getKycForAdmin, getCurrentKyc, toPublicKyc, listKycForAdmin, retryKycModeChange } from "./kyc-service"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8])
const pngFile = (bytes = PNG, type = "image/png") => ({ type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
const profiles = () => (h.state.tables.sms_business_profiles ??= [])
const full = { business_name: "Kings Data", description: "We sell data bundles", whatsapp_number: "0241234567", ghana_card_number: "GHA-123456789-0" }

beforeEach(() => {
  h.state.tables = { sms_accounts: [{ id: "acct1", user_id: "u1" }] }
  h.state.files.clear(); h.state.seq = 0; h.state.audit = []; h.state.notifs = []; h.state.modeCalls = []
  h.state.uploadError = null; h.state.failSelect = false; h.state.onUpdate = null; h.state.removeError = null
  h.state.modeResult = { ok: true, data: { mode: "business", unpaused: 0, paused: 0, conflicts: [] } }
})

describe("saveKycDraft", () => {
  it("creates then updates a single draft, storing only the last 4", async () => {
    const a = await saveKycDraft("acct1", full)
    expect(a.ok).toBe(true)
    await saveKycDraft("acct1", { business_name: "Kings Data Ltd" })
    expect(profiles()).toHaveLength(1)
    expect(profiles()[0]).toMatchObject({ business_name: "Kings Data Ltd", ghana_card_last4: "7890", whatsapp_number: "233241234567", status: "draft" })
    expect(JSON.stringify(profiles())).not.toContain("123456789")
  })
  it("returns field errors without writing", async () => {
    const r = await saveKycDraft("acct1", { business_name: "A" })
    expect(r).toMatchObject({ ok: false, fields: { business_name: expect.any(String) } })
    expect(profiles()).toHaveLength(0)
  })
  it("refuses edits while submitted or approved", async () => {
    profiles().push({ id: "x", sms_account_id: "acct1", status: "submitted", created_at: "2026-01-01" })
    expect((await saveKycDraft("acct1", { business_name: "Ab" })).ok).toBe(false)
    profiles()[0].status = "approved"
    expect((await saveKycDraft("acct1", { business_name: "Ab" })).ok).toBe(false)
  })
  it("after a rejection starts a NEW draft row and keeps history", async () => {
    profiles().push({ id: "old", sms_account_id: "acct1", status: "rejected", business_name: "Old", created_at: "2026-01-01" })
    const r = await saveKycDraft("acct1", { business_name: "New Name" })
    expect(r.ok).toBe(true)
    expect(profiles()).toHaveLength(2)
    expect(profiles().find((p) => p.id === "old")!.status).toBe("rejected")
    expect((await getCurrentKyc("acct1"))!.business_name).toBe("New Name")
  })
  it("never touches another account's profile", async () => {
    profiles().push({ id: "other", sms_account_id: "acct2", status: "draft", business_name: "Other", created_at: "2026-01-01" })
    await saveKycDraft("acct1", { business_name: "Mine" })
    expect(profiles().find((p) => p.id === "other")!.business_name).toBe("Other")
    expect(profiles()).toHaveLength(2)
  })
})

describe("uploadKycDocument", () => {
  it("stores the file under the account prefix and records the path", async () => {
    const r = await uploadKycDocument("acct1", "ghana_card", pngFile())
    expect(r.ok).toBe(true)
    const path = profiles()[0].ghana_card_doc_path as string
    expect(path).toMatch(/^acct1\/ghana_card-[0-9a-f-]{36}\.png$/)
    expect(h.state.files.has(path)).toBe(true)
  })
  it("replacing a document deletes the old file", async () => {
    await uploadKycDocument("acct1", "ghana_card", pngFile())
    const first = profiles()[0].ghana_card_doc_path as string
    await new Promise((r) => setTimeout(r, 3))
    await uploadKycDocument("acct1", "ghana_card", pngFile())
    const second = profiles()[0].ghana_card_doc_path as string
    expect(second).not.toBe(first)
    expect(h.state.files.has(first)).toBe(false)
    expect(h.state.files.has(second)).toBe(true)
  })
  it("rejects bad MIME, oversize, empty and mislabelled content without storing", async () => {
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile(PNG, "image/gif"))).ok).toBe(false)
    expect((await uploadKycDocument("acct1", "ghana_card", { ...pngFile(), size: 5 * 1024 * 1024 })).ok).toBe(false)
    expect((await uploadKycDocument("acct1", "ghana_card", { type: "image/png", size: 0, arrayBuffer: async () => new ArrayBuffer(0) })).ok).toBe(false)
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 1, 1, 1, 1, 1, 1, 1]), "image/png"))).ok).toBe(false)
    // declared size lies: real bytes exceed the cap
    const big = new Uint8Array(4 * 1024 * 1024 + 1); big.set(PNG)
    expect((await uploadKycDocument("acct1", "ghana_card", { type: "image/png", size: 100, arrayBuffer: async () => big.buffer as ArrayBuffer })).ok).toBe(false)
    expect(h.state.files.size).toBe(0)
    expect(profiles()).toHaveLength(0)
  })
  it("surfaces storage failure and leaves the profile unchanged", async () => {
    h.state.uploadError = "boom"
    const r = await uploadKycDocument("acct1", "ghana_card", pngFile())
    expect(r.ok).toBe(false)
    expect(profiles()[0].ghana_card_doc_path).toBeNull()
  })
  it("refuses uploads while under review", async () => {
    profiles().push({ id: "x", sms_account_id: "acct1", status: "submitted", created_at: "2026-01-01" })
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile())).ok).toBe(false)
    expect(h.state.files.size).toBe(0)
  })
})

describe("submitKyc", () => {
  it("lists missing fields, including the Ghana Card document", async () => {
    await saveKycDraft("acct1", { business_name: "Kings Data" })
    const r = await submitKyc("acct1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      for (const f of ["description", "whatsapp_number", "ghana_card_last4", "ghana_card_doc_path"]) expect(r.error).toContain(f)
    }
    expect(profiles()[0].status).toBe("draft")
  })
  it("submits a complete draft", async () => {
    await saveKycDraft("acct1", full)
    await uploadKycDocument("acct1", "ghana_card", pngFile())
    const r = await submitKyc("acct1")
    expect(r.ok).toBe(true)
    expect(profiles()[0]).toMatchObject({ status: "submitted" })
    expect(profiles()[0].submitted_at).toBeTruthy()
  })
  it("errors with no draft", async () => {
    expect((await submitKyc("acct1")).ok).toBe(false)
  })
})

const submitted = () => profiles().push({ id: "s1", sms_account_id: "acct1", status: "submitted", business_name: "Kings", created_at: "2026-01-01" })

describe("approveKyc", () => {
  it("refuses a null admin id and changes nothing", async () => {
    submitted()
    expect(await approveKyc(null, "s1")).toEqual({ ok: false, error: "Admin user required" })
    expect(profiles()[0].status).toBe("submitted")
    expect(h.state.modeCalls).toHaveLength(0)
  })
  it("records the decision then switches the account to business mode", async () => {
    submitted()
    const r = await approveKyc("admin1", "s1")
    expect(r.ok).toBe(true)
    expect(profiles()[0]).toMatchObject({ status: "approved", reviewed_by: "admin1" })
    expect(profiles()[0].docs_purge_after).toBeTruthy()
    expect(h.state.modeCalls).toEqual([["admin1", "acct1", "business"]])
    if (r.ok) expect(r.data.modeChange).toEqual({ ok: true, mode: "business" })
    expect(h.state.audit[0][1]).toBe("sms_kyc_approved")
    await new Promise((res) => setTimeout(res, 5))
    expect(h.state.notifs).toHaveLength(1)
  })
  it("surfaces a failed mode change (decision stands, no success notification)", async () => {
    submitted()
    h.state.modeResult = { ok: false, error: "Failed to set account mode (x). Applied: nothing." }
    const r = await approveKyc("admin1", "s1")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.modeChange).toEqual({ ok: false, error: expect.stringContaining("Failed to set account mode") })
    expect(profiles()[0].status).toBe("approved")
    await new Promise((res) => setTimeout(res, 5))
    expect(h.state.notifs).toHaveLength(0)
  })
  it("cannot approve something that is not submitted", async () => {
    profiles().push({ id: "d", sms_account_id: "acct1", status: "draft", created_at: "2026-01-01" })
    expect((await approveKyc("admin1", "d")).ok).toBe(false)
    expect(h.state.modeCalls).toHaveLength(0)
  })
})

describe("rejectKyc", () => {
  it("requires a reason", async () => {
    submitted()
    expect((await rejectKyc("admin1", "s1", "  no ")).ok).toBe(false)
    expect(profiles()[0].status).toBe("submitted")
  })
  it("refuses a null admin id", async () => {
    submitted()
    expect(await rejectKyc(null, "s1", "blurry photo")).toEqual({ ok: false, error: "Admin user required" })
  })
  it("rejects with reason and a purge date", async () => {
    submitted()
    const r = await rejectKyc("admin1", "s1", "Photo is blurry")
    expect(r.ok).toBe(true)
    expect(profiles()[0]).toMatchObject({ status: "rejected", rejection_reason: "Photo is blurry", reviewed_by: "admin1" })
    expect(profiles()[0].docs_purge_after).toBeTruthy()
    expect(h.state.modeCalls).toHaveLength(0)
  })
})

describe("admin/public views", () => {
  it("signs documents for 5 minutes and never exposes raw paths", async () => {
    profiles().push({ id: "s1", sms_account_id: "acct1", status: "submitted", ghana_card_doc_path: "acct1/g.png", registration_doc_path: null, created_at: "2026-01-01" })
    const v = await getKycForAdmin("admin1", "s1")
    expect(v!.ghana_card_doc_url).toBe("signed://acct1/g.png?t=300")
    expect(v!.registration_doc_url).toBeNull()
    expect(JSON.stringify(v)).not.toContain("ghana_card_doc_path")
  })
  it("toPublicKyc swaps paths for booleans", () => {
    const p: any = toPublicKyc({ id: "1", ghana_card_doc_path: "a/b", registration_doc_path: null } as any)
    expect(p).toMatchObject({ has_ghana_card_doc: true, has_registration_doc: false })
    expect(p.ghana_card_doc_path).toBeUndefined()
  })
})

describe("purgeKycDocuments", () => {
  it("deletes only documents past docs_purge_after", async () => {
    const now = new Date("2026-11-20T00:00:00Z")
    h.state.files.add("a/old.png"); h.state.files.add("b/new.png"); h.state.files.add("c/draft.png")
    profiles().push(
      { id: "old", status: "approved", ghana_card_doc_path: "a/old.png", registration_doc_path: null, docs_purge_after: "2026-11-10T00:00:00Z" },
      { id: "new", status: "rejected", ghana_card_doc_path: "b/new.png", registration_doc_path: null, docs_purge_after: "2026-12-01T00:00:00Z" },
      { id: "draft", status: "draft", ghana_card_doc_path: "c/draft.png", registration_doc_path: null, docs_purge_after: null },
    )
    const r = await purgeKycDocuments(now)
    expect(r).toEqual({ purged: 1, errors: 0 })
    expect([...h.state.files].sort()).toEqual(["b/new.png", "c/draft.png"])
    expect(profiles().find((p) => p.id === "old")!.ghana_card_doc_path).toBeNull()
    expect(profiles().find((p) => p.id === "new")!.ghana_card_doc_path).toBe("b/new.png")
  })
})

describe("review fixes", () => {
  const tick = () => new Promise((res) => setTimeout(res, 5))

  it("concurrent uploads of the same kind: one file referenced, loser's file removed", async () => {
    await saveKycDraft("acct1", { business_name: "Kings Data" })
    const [a, b] = await Promise.all([
      uploadKycDocument("acct1", "ghana_card", pngFile()),
      uploadKycDocument("acct1", "ghana_card", pngFile()),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = [a, b].find((r) => !r.ok)!
    expect(loser).toMatchObject({ ok: false, error: "Please try that upload again." })
    expect(h.state.files.size).toBe(1)
    expect(h.state.files.has(profiles()[0].ghana_card_doc_path)).toBe(true)
  })

  it("logs (without the path) when cleaning up the loser's file fails", async () => {
    await saveKycDraft("acct1", { business_name: "Kings Data" })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    let calls = 0
    h.state.onUpdate = () => {
      if (++calls < 2) return // 1st = the empty draft save; 2nd = the upload's compare-and-swap
      profiles()[0].ghana_card_doc_path = "acct1/other.png"; h.state.onUpdate = null; h.state.removeError = "rm failed"
    }
    const r = await uploadKycDocument("acct1", "ghana_card", pngFile())
    expect(r.ok).toBe(false)
    expect(spy).toHaveBeenCalled()
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/acct1\//)
    spy.mockRestore()
  })

  it("upload is rejected while approved", async () => {
    profiles().push({ id: "x", sms_account_id: "acct1", status: "approved", created_at: "2026-01-01" })
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile())).ok).toBe(false)
    expect(h.state.files.size).toBe(0)
  })

  it("accepts JPEG and WebP with real signatures", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile(jpg, "image/jpeg"))).ok).toBe(true)
    expect((await uploadKycDocument("acct1", "registration", pngFile(webp, "image/webp"))).ok).toBe(true)
  })

  it("stale drafts are purged; fresh drafts and submitted rows are untouched", async () => {
    const now = new Date("2026-11-20T00:00:00Z")
    for (const f of ["s/stale.png", "s/fresh.png", "s/sub.png"]) h.state.files.add(f)
    profiles().push(
      { id: "stale", status: "draft", ghana_card_doc_path: "s/stale.png", registration_doc_path: null, updated_at: "2026-10-01T00:00:00Z" },
      { id: "fresh", status: "draft", ghana_card_doc_path: "s/fresh.png", registration_doc_path: null, updated_at: "2026-11-10T00:00:00Z" },
      { id: "sub", status: "submitted", ghana_card_doc_path: "s/sub.png", registration_doc_path: null, updated_at: "2026-09-01T00:00:00Z" },
    )
    expect(await purgeKycDocuments(now)).toEqual({ purged: 1, errors: 0 })
    expect([...h.state.files].sort()).toEqual(["s/fresh.png", "s/sub.png"])
    expect(profiles().find((p) => p.id === "stale")!.ghana_card_doc_path).toBeNull()
  })

  it("purge counts storage failures and logs ids only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    profiles().push({ id: "old", status: "approved", ghana_card_doc_path: "a/old.png", registration_doc_path: null, docs_purge_after: "2026-11-10T00:00:00Z" })
    h.state.removeError = "nope"
    expect(await purgeKycDocuments(new Date("2026-11-20T00:00:00Z"))).toEqual({ purged: 0, errors: 1 })
    expect(JSON.stringify(spy.mock.calls)).not.toContain("a/old.png")
    spy.mockRestore()
  })

  it("purge reports a failed select as an error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.failSelect = true
    const r = await purgeKycDocuments()
    expect(r.errors).toBeGreaterThan(0)
    spy.mockRestore()
  })

  it("a unique violation on the draft insert (concurrent first save) falls back to updating that draft", async () => {
    // our read sees no draft, but another request inserts one before our insert lands
    let injected = false
    h.state.onUpdate = null
    const realFrom = h.fake.from
    h.fake.from = (t: string) => {
      const b = realFrom(t)
      if (t === "sms_business_profiles" && !injected) {
        const origMaybe = b.maybeSingle
        b.maybeSingle = () => {
          const p = origMaybe()
          if (!injected) { injected = true; profiles().push({ id: "race", sms_account_id: "acct1", status: "draft", business_name: "Theirs", created_at: "2026-01-01" }); return Promise.resolve({ data: null, error: null }) }
          return p
        }
      }
      return b
    }
    try {
      const r = await saveKycDraft("acct1", { business_name: "Mine" })
      expect(r.ok).toBe(true)
      expect(profiles()).toHaveLength(1)
      expect(profiles()[0].business_name).toBe("Mine")
    } finally { h.fake.from = realFrom }
  })

  it("submit that loses a race says the application is already under review", async () => {
    await saveKycDraft("acct1", full)
    await uploadKycDocument("acct1", "ghana_card", pngFile())
    h.state.onUpdate = () => { profiles()[0].status = "submitted"; h.state.onUpdate = null }
    expect(await submitKyc("acct1")).toEqual({ ok: false, error: "Your application is already under review." })
  })

  it("getCurrentKyc surfaces DB errors and writers stop instead of inserting", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.state.failSelect = true
    await expect(getCurrentKyc("acct1")).rejects.toThrow()
    expect(await saveKycDraft("acct1", full)).toEqual({ ok: false, error: "Couldn't load your application, try again." })
    expect((await submitKyc("acct1")).ok).toBe(false)
    expect((await uploadKycDocument("acct1", "ghana_card", pngFile())).ok).toBe(false)
    h.state.failSelect = false
    expect(profiles()).toHaveLength(0)
    expect(h.state.files.size).toBe(0)
    spy.mockRestore()
  })

  it("listKycForAdmin output has no document paths", async () => {
    profiles().push({ id: "s1", sms_account_id: "acct1", status: "submitted", ghana_card_doc_path: "acct1/g.png", registration_doc_path: "acct1/r.png", created_at: "2026-01-01" })
    const list = await listKycForAdmin("submitted")
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain("acct1/")
    expect(list[0]).toMatchObject({ has_ghana_card_doc: true, has_registration_doc: true })
  })

  it("audits when an admin opens documents (ids only, no paths/urls)", async () => {
    profiles().push({ id: "s1", sms_account_id: "acct1", status: "submitted", ghana_card_doc_path: "acct1/g.png", registration_doc_path: null, created_at: "2026-01-01" })
    await getKycForAdmin("admin1", "s1")
    await tick()
    const row = h.state.audit.find((a) => a[1] === "sms_kyc_docs_viewed")!
    expect(row[0]).toBe("admin1")
    expect(JSON.stringify(row)).not.toMatch(/signed:|g\.png/)
    expect(JSON.stringify(row)).toContain("s1")
    expect(JSON.stringify(row)).toContain("acct1")
  })

  it("no docs-viewed audit when there are no documents", async () => {
    profiles().push({ id: "s1", sms_account_id: "acct1", status: "submitted", ghana_card_doc_path: null, registration_doc_path: null, created_at: "2026-01-01" })
    await getKycForAdmin("admin1", "s1")
    await tick()
    expect(h.state.audit).toHaveLength(0)
  })
})

describe("retryKycModeChange", () => {
  const approved = () => profiles().push({ id: "a1", sms_account_id: "acct1", status: "approved", created_at: "2026-01-01" })
  const tick = () => new Promise((res) => setTimeout(res, 5))
  it("refuses a null admin and non-approved profiles", async () => {
    approved()
    expect(await retryKycModeChange(null, "a1")).toEqual({ ok: false, error: "Admin user required" })
    profiles()[0].status = "submitted"
    expect((await retryKycModeChange("admin1", "a1")).ok).toBe(false)
    expect(h.state.modeCalls).toHaveLength(0)
  })
  it("switches a not-yet-business account and notifies the owner", async () => {
    approved()
    h.state.tables.sms_accounts[0].mode = "platform"
    expect((await retryKycModeChange("admin1", "a1")).ok).toBe(true)
    expect(h.state.modeCalls).toEqual([["admin1", "acct1", "business"]])
    await tick()
    expect(h.state.notifs).toHaveLength(1)
  })
  it("is a no-op when already business", async () => {
    approved()
    h.state.tables.sms_accounts[0].mode = "business"
    expect((await retryKycModeChange("admin1", "a1")).ok).toBe(true)
    expect(h.state.modeCalls).toHaveLength(0)
    await tick()
    expect(h.state.notifs).toHaveLength(0)
  })
  it("surfaces a failing mode change without notifying", async () => {
    approved()
    h.state.tables.sms_accounts[0].mode = "platform"
    h.state.modeResult = { ok: false, error: "still broken" }
    expect(await retryKycModeChange("admin1", "a1")).toEqual({ ok: false, error: "still broken" })
    await tick()
    expect(h.state.notifs).toHaveLength(0)
  })
})
