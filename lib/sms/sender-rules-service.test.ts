import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, any>
const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    audit: [] as any[],
    raceActive: null as null | ((row: Row) => void), // runs just before an update, to simulate a concurrent writer
    failWrite: null as null | ((table: string, payload: Row) => string | null), // returns an error message to fail that update
    seq: 0,
  }
  function builder(table: string) {
    let op: "select" | "update" | "insert" = "select"
    let payload: Row = {}
    const filters: ((r: Row) => boolean)[] = []
    let ord: { col: string; asc: boolean } | null = null
    let lim: number | null = null
    let returning = false
    const rows = () => (state.tables[table] ??= [])
    const uniqueViolation = (cand: Row, self?: Row): boolean => {
      if (table !== "sms_sender_ids") return false
      return rows().some((r) => r !== self &&
        ((cand.local_status === "active" && r.local_status === "active" && String(r.sender_id).toUpperCase() === String(cand.sender_id).toUpperCase()) ||
         (r.sms_account_id === cand.sms_account_id && r.sender_id === cand.sender_id)))
    }
    function run(): { data: any; error: any } {
      let matched = rows().filter((r) => filters.every((f) => f(r)))
      if (ord) matched = [...matched].sort((a, b) => (a[ord!.col] < b[ord!.col] ? -1 : 1) * (ord!.asc ? 1 : -1))
      if (lim != null) matched = matched.slice(0, lim)
      if (op === "select") return { data: matched.map((r) => ({ ...r })), error: null }
      if (op === "insert") {
        const row = { id: `new${++state.seq}`, created_at: "2026-10-10T00:00:00Z", ...payload }
        if (uniqueViolation(row)) return { data: null, error: { code: "23505", message: "duplicate key" } }
        rows().push(row)
        return { data: returning ? [{ ...row }] : null, error: null }
      }
      // update
      const injected = state.failWrite?.(table, payload)
      if (injected) return { data: null, error: { message: injected } }
      const out: Row[] = []
      for (const r of matched) {
        state.raceActive?.(r)
        const next = { ...r, ...payload }
        if (uniqueViolation(next, r)) return { data: null, error: { code: "23505", message: "duplicate key" } }
        Object.assign(r, payload)
        out.push({ ...r })
      }
      return { data: returning ? out : null, error: null }
    }
    const api: any = {
      select: () => { if (op !== "select") returning = true; return api },
      update: (p: Row) => { op = "update"; payload = p; return api },
      insert: (p: Row) => { op = "insert"; payload = p; return api },
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return api },
      neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return api },
      in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return api },
      or: (e: string) => {
        // only the shape used by the service: "col.is.null,col.neq.X"
        filters.push((r) => e.split(",").some((c) => {
          const [col, o, ...rest] = c.split("."); const val = rest.join(".")
          return o === "is" ? r[col] == null : o === "neq" ? r[col] != null && r[col] !== val : false
        }))
        return api
      },
      order: (col: string, o?: { ascending?: boolean }) => { ord = { col, asc: o?.ascending !== false }; return api },
      limit: (n: number) => { lim = n; return api },
      maybeSingle: () => { const r = run(); return Promise.resolve({ data: r.error ? null : (r.data?.[0] ?? null), error: r.error }) },
      single: () => { const r = run(); return Promise.resolve({ data: r.error ? null : (r.data?.[0] ?? null), error: r.error ?? (r.data?.[0] ? null : { message: "no row" }) }) },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return api
  }
  return { state, fake: { from: (t: string) => builder(t) } }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./platform-settings", () => ({
  loadSmsSettings: () => Promise.resolve({ protectedSenderNames: ["MTN", "GCB"] }),
}))
vi.mock("./moderation-service", () => ({
  writeAuditLog: (...a: any[]) => { h.state.audit.push(a); return Promise.resolve() },
}))

import {
  planModeChange, senderLimitFor, requestSenderId, approveSenderIdRequest, rejectSenderIdRequest,
  revokeSenderId, setAccountMode, setApiRateLimitOverride,
} from "./sender-rules-service"

const row = (id: string, local_status: string, kyc_free = false) => ({ id, local_status, kyc_free })
const sid = (id: string, sender_id: string, acct: string | null, local_status: string, extra: Row = {}) =>
  ({ id, sender_id, sms_account_id: acct, local_status, kyc_free: false, created_at: `2026-01-0${id.length}T00:00:00Z`, ...extra })
const T = (name: string) => (h.state.tables[name] ??= [])
const find = (id: string) => T("sms_sender_ids").find((r) => r.id === id)!

beforeEach(() => {
  h.state.tables = {
    sms_accounts: [
      { id: "P", mode: "platform", default_sender_id: null, user_id: "uP" },
      { id: "B", mode: "business", default_sender_id: null, user_id: "uB" },
      { id: "O", mode: "business", default_sender_id: null, user_id: "uO" },
    ],
    sms_sender_ids: [],
  }
  h.state.audit = []
  h.state.raceActive = null
  h.state.failWrite = null
})

describe("senderLimitFor", () => {
  it("platform 1, business 200", () => {
    expect(senderLimitFor("platform")).toBe(1)
    expect(senderLimitFor("business")).toBe(200)
  })
})

describe("planModeChange", () => {
  it("→ business unpauses every paused id", () => {
    expect(planModeChange("business", [row("a", "active", true), row("b", "paused"), row("c", "rejected")]))
      .toEqual({ unpause: ["b"], pause: [], markKycFree: null })
  })
  it("→ platform keeps the kyc_free id and pauses the rest", () => {
    expect(planModeChange("platform", [row("a", "active"), row("b", "active", true), row("c", "active")]))
      .toEqual({ unpause: [], pause: ["a", "c"], markKycFree: null })
  })
  it("→ platform without a kyc_free id keeps the oldest active as the free one", () => {
    expect(planModeChange("platform", [row("a", "active"), row("b", "active")]))
      .toEqual({ unpause: [], pause: ["b"], markKycFree: "a" })
  })
  it("→ platform with no active ids changes nothing", () => {
    expect(planModeChange("platform", [row("a", "pending")])).toEqual({ unpause: [], pause: [], markKycFree: null })
  })
})

describe("requestSenderId", () => {
  it("rejects an invalid / protected name", async () => {
    const r = await requestSenderId("B", "MTN Deals")
    expect(r.ok).toBe(false)
    expect(T("sms_sender_ids")).toHaveLength(0)
  })
  it("creates a pending row, normalised; kyc_free only in platform mode", async () => {
    const p = await requestSenderId("P", "acme shop")
    expect(p.ok && p.data).toMatchObject({ sender_id: "ACME SHOP", local_status: "pending", kyc_free: true })
    const b = await requestSenderId("B", "BizOne")
    expect(b.ok && b.data).toMatchObject({ sender_id: "BIZONE", local_status: "pending", kyc_free: false })
  })
  it("is idempotent for an open request of the same name", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    const r = await requestSenderId("B", "acme")
    expect(r.ok && r.data.id).toBe("a")
    expect(T("sms_sender_ids")).toHaveLength(1)
  })
  it("platform mode: second open sender is refused (pending/active/paused count)", async () => {
    T("sms_sender_ids").push(sid("a", "FIRST", "P", "paused"))
    const r = await requestSenderId("P", "SECOND")
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.error).toMatch(/one sender ID/)
  })
  it("platform mode: a rejected/revoked row does not count toward the limit", async () => {
    T("sms_sender_ids").push(sid("a", "OLD", "P", "revoked"))
    expect((await requestSenderId("P", "NEWONE")).ok).toBe(true)
  })
  it("business mode: refuses at 200 open", async () => {
    for (let i = 0; i < 200; i++) T("sms_sender_ids").push(sid(`x${i}`, `N${i}`, "B", "active"))
    const r = await requestSenderId("B", "OVERFLOW")
    expect(!r.ok && r.error).toMatch(/200/)
  })
  it("refuses a name ACTIVE on another account", async () => {
    T("sms_sender_ids").push(sid("a", "TAKEN", "O", "active"))
    const r = await requestSenderId("B", "taken")
    expect(!r.ok && r.error).toMatch(/already in use/)
  })
  it("allows a name merely pending/revoked elsewhere", async () => {
    T("sms_sender_ids").push(sid("a", "SHARED", "O", "pending"), sid("b", "SHARED2", "O", "revoked"))
    expect((await requestSenderId("B", "SHARED")).ok).toBe(true)
    expect((await requestSenderId("B", "SHARED2")).ok).toBe(true)
  })
  it("re-opens a rejected request as pending and clears the reason", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "P", "rejected", { rejection_reason: "nope", revoked_at: "x" }))
    const r = await requestSenderId("P", "Acme")
    expect(r.ok && r.data).toMatchObject({ id: "a", local_status: "pending", kyc_free: true })
    expect(find("a")).toMatchObject({ rejection_reason: null, revoked_at: null })
  })
  it("unknown account", async () => {
    expect(await requestSenderId("ZZ", "ACME")).toEqual({ ok: false, error: "SMS account not found" })
  })
})

describe("approveSenderIdRequest", () => {
  it("activates, records approver, sets default sender when none, audits", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    const r = await approveSenderIdRequest("admin1", "a")
    expect(r.ok && r.data.local_status).toBe("active")
    expect(find("a")).toMatchObject({ approved_by: "admin1", local_status: "active" })
    expect(T("sms_accounts").find((a) => a.id === "B")!.default_sender_id).toBe("a")
    expect(h.state.audit[0][1]).toBe("sms_sender_approve")
  })
  it("keeps an existing default sender", async () => {
    T("sms_accounts").find((a) => a.id === "B")!.default_sender_id = "old"
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    await approveSenderIdRequest("admin1", "a")
    expect(T("sms_accounts").find((a) => a.id === "B")!.default_sender_id).toBe("old")
  })
  it("platform mode: marks kyc_free true", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "P", "pending"))
    await approveSenderIdRequest("admin1", "a")
    expect(find("a").kyc_free).toBe(true)
  })
  it.each([null, ""])("refuses a missing admin id (%j) and changes nothing", async (adm) => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"), sid("bb", "LIVE", "B", "active"))
    const refused = { ok: false, error: "Admin user required" }
    expect(await approveSenderIdRequest(adm as any, "a")).toEqual(refused)
    expect(await rejectSenderIdRequest(adm as any, "a", "some reason")).toEqual(refused)
    expect(await revokeSenderId(adm as any, "bb")).toEqual(refused)
    expect(await setAccountMode(adm as any, "B", "platform")).toEqual(refused)
    expect(await setApiRateLimitOverride(adm as any, "B", 5)).toEqual(refused)
    expect(find("a").local_status).toBe("pending")
    expect(find("bb").local_status).toBe("active")
    expect(T("sms_accounts").find((x) => x.id === "B")!.mode).toBe("business")
    expect(T("sms_accounts").find((x) => x.id === "B")!.api_rate_limit_override).toBeUndefined()
  })
  it("platform mode: refuses when another sender is already active", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "P", "active"), sid("b", "TWO", "P", "pending"))
    const r = await approveSenderIdRequest("admin1", "b")
    expect(!r.ok && r.error).toMatch(/already has its one sender ID/)
    expect(find("b").local_status).toBe("pending")
  })
  it("refuses a non-pending row", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "rejected"))
    const r = await approveSenderIdRequest("admin1", "a")
    expect(!r.ok && r.error).toMatch(/Only pending/)
  })
  it("refuses when the name is active on another account (friendly check)", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "O", "active"), sid("b", "ACME", "B", "pending"))
    const r = await approveSenderIdRequest("admin1", "b")
    expect(!r.ok && r.error).toMatch(/Another account already uses/)
    expect(find("b").local_status).toBe("pending")
  })
  it("maps a 23505 from the DB backstop (race) to the friendly error", async () => {
    T("sms_sender_ids").push(sid("b", "ACME", "B", "pending"))
    h.state.raceActive = () => { T("sms_sender_ids").push(sid("zz", "ACME", "O", "active")) }
    const r = await approveSenderIdRequest("admin1", "b")
    expect(!r.ok && r.error).toMatch(/Another account already uses/)
    expect(find("b").local_status).toBe("pending")
  })
  it("not found", async () => {
    expect(await approveSenderIdRequest("a", "nope")).toEqual({ ok: false, error: "Sender ID not found" })
  })
})

describe("rejectSenderIdRequest", () => {
  it("requires a reason", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    expect((await rejectSenderIdRequest("admin1", "a", "  ")).ok).toBe(false)
    expect(find("a").local_status).toBe("pending")
  })
  it("rejects a pending row with the reason", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    const r = await rejectSenderIdRequest("admin1", "a", " looks like a bank ")
    expect(r.ok && r.data.local_status).toBe("rejected")
    expect(find("a").rejection_reason).toBe("looks like a bank")
    expect(h.state.audit[0][1]).toBe("sms_sender_reject")
  })
  it("cannot reject an already-active row", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "active"))
    expect((await rejectSenderIdRequest("admin1", "a", "reason")).ok).toBe(false)
    expect(find("a").local_status).toBe("active")
  })
})

describe("revokeSenderId", () => {
  it("revokes active, clears kyc_free and account default", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "P", "active", { kyc_free: true }))
    T("sms_accounts").find((a) => a.id === "P")!.default_sender_id = "a"
    const r = await revokeSenderId("admin1", "a", " fraud ")
    expect(r.ok && r.data.local_status).toBe("revoked")
    expect(find("a")).toMatchObject({ kyc_free: false, rejection_reason: "fraud" })
    expect(find("a").revoked_at).toBeTruthy()
    expect(T("sms_accounts").find((a) => a.id === "P")!.default_sender_id).toBeNull()
  })
  it("can revoke paused; cannot revoke pending", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "B", "paused"), sid("b", "TWO", "B", "pending"))
    expect((await revokeSenderId("admin1", "a")).ok).toBe(true)
    expect((await revokeSenderId("admin1", "b")).ok).toBe(false)
  })
  it("leaves other accounts' defaults alone", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "B", "active"))
    T("sms_accounts").find((a) => a.id === "O")!.default_sender_id = "other"
    await revokeSenderId("admin1", "a")
    expect(T("sms_accounts").find((a) => a.id === "O")!.default_sender_id).toBe("other")
  })
})

describe("setAccountMode", () => {
  it("→ platform pauses extras, keeps oldest as kyc_free, repoints default", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "B", "active"), sid("bb", "TWO", "B", "active"), sid("ccc", "THREE", "B", "active"))
    T("sms_accounts").find((a) => a.id === "B")!.default_sender_id = "bb"
    const r = await setAccountMode("admin1", "B", "platform")
    expect(r).toEqual({ ok: true, data: { mode: "platform", unpaused: 0, paused: 2, conflicts: [] } })
    expect(find("a")).toMatchObject({ local_status: "active", kyc_free: true })
    expect(find("bb").local_status).toBe("paused")
    expect(find("ccc").local_status).toBe("paused")
    const acct = T("sms_accounts").find((a) => a.id === "B")!
    expect(acct.mode).toBe("platform")
    expect(acct.mode_changed_at).toBeTruthy()
    expect(acct.default_sender_id).toBe("a")
    expect(h.state.audit[0][1]).toBe("sms_account_mode")
  })
  it("→ business unpauses paused ids", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "P", "active", { kyc_free: true }), sid("bb", "TWO", "P", "paused"))
    const r = await setAccountMode("admin1", "P", "business")
    expect(r).toEqual({ ok: true, data: { mode: "business", unpaused: 1, paused: 0, conflicts: [] } })
    expect(find("bb").local_status).toBe("active")
  })
  it("→ business: a name now active elsewhere stays paused and is reported", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "P", "active", { kyc_free: true }), sid("bb", "TWO", "P", "paused"), sid("zz", "TWO", "O", "active"))
    const r = await setAccountMode("admin1", "P", "business")
    expect(r).toEqual({ ok: true, data: { mode: "business", unpaused: 0, paused: 0, conflicts: ["TWO"] } })
    expect(find("bb").local_status).toBe("paused")
  })
  it("does not touch other accounts' sender ids", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "B", "active"), sid("b", "TWO", "B", "active"), sid("zz", "OTHER", "O", "active"))
    await setAccountMode("admin1", "B", "platform")
    expect(find("zz").local_status).toBe("active")
  })
})

describe("legacy provider fields on re-open", () => {
  it("clears pushed_at/status fields and resets mnotify_local_status so pollers can never pick the row up", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "revoked", {
      moolre_pushed_at: "2026-01-01", mnotify_pushed_at: "2026-01-01", moolre_status: "ASMQ02", mnotify_status: "Approved", mnotify_local_status: "active",
    }))
    const r = await requestSenderId("B", "acme")
    expect(r.ok && r.data.local_status).toBe("pending")
    expect(find("a")).toMatchObject({
      moolre_pushed_at: null, mnotify_pushed_at: null, moolre_status: null, mnotify_status: null, mnotify_local_status: "pending",
    })
  })
  it("re-opening a revoked name that is now active elsewhere gives the friendly error and changes nothing", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "revoked"), sid("z", "ACME", "O", "active"))
    const r = await requestSenderId("B", "ACME")
    expect(!r.ok && r.error).toMatch(/already in use/)
    expect(find("a").local_status).toBe("revoked")
  })
})

describe("approve when the mode changed since the request", () => {
  it("row requested in business (not kyc_free), account now platform → kyc_free true", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "P", "pending", { kyc_free: false }))
    const r = await approveSenderIdRequest("admin1", "a")
    expect(r.ok && r.data.kyc_free).toBe(true)
    expect(find("a").kyc_free).toBe(true)
  })
})

describe("audit rows", () => {
  it("approve carries name, account, previous status and the owner's user id", async () => {
    T("sms_sender_ids").push(sid("a", "ACME", "B", "pending"))
    await approveSenderIdRequest("admin1", "a")
    const [adminId, action, target, oldV, newV] = h.state.audit[0]
    expect([adminId, action, target]).toEqual(["admin1", "sms_sender_approve", "uB"])
    expect(oldV).toMatchObject({ sender_id: "ACME", sms_account_id: "B", status: "pending" })
    expect(newV).toMatchObject({ sender_id: "ACME", status: "active" })
  })
  it("reject and revoke target the owner and record the previous status", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "B", "pending"), sid("bb", "TWO", "B", "paused"))
    await rejectSenderIdRequest("admin1", "a", "bad name")
    await revokeSenderId("admin1", "bb", "abuse")
    expect(h.state.audit[0].slice(1, 3)).toEqual(["sms_sender_reject", "uB"])
    expect(h.state.audit[0][3]).toMatchObject({ sender_id: "ONE", status: "pending" })
    expect(h.state.audit[1].slice(1, 3)).toEqual(["sms_sender_revoke", "uB"])
    expect(h.state.audit[1][3]).toMatchObject({ sender_id: "TWO", status: "paused" })
  })
  it("mode change targets the owner and records the previous mode", async () => {
    await setAccountMode("admin1", "B", "platform")
    expect(h.state.audit[0].slice(1, 3)).toEqual(["sms_account_mode", "uB"])
    expect(h.state.audit[0][3]).toMatchObject({ mode: "business" })
  })
})

describe("setAccountMode failure handling", () => {
  const three = () => T("sms_sender_ids").push(sid("a", "ONE", "B", "active"), sid("bb", "TWO", "B", "active"), sid("ccc", "THREE", "B", "active"))
  const acct = () => T("sms_accounts").find((a) => a.id === "B")!

  it("unknown account", async () => {
    expect(await setAccountMode("admin1", "ZZ", "platform")).toEqual({ ok: false, error: "SMS account not found" })
  })
  it("→ platform: failing to mark the free id aborts before anything else; mode unchanged", async () => {
    three()
    h.state.failWrite = (_t, p) => (p.kyc_free === true ? "boom" : null)
    const r = await setAccountMode("admin1", "B", "platform")
    expect(!r.ok && r.error).toMatch(/mark the free sender ID \(boom\).*Applied: nothing.*Mode is business/)
    expect(acct().mode).toBe("business")
    expect(find("bb").local_status).toBe("active")
    expect(h.state.audit[0][4]).toMatchObject({ failure: expect.stringContaining("boom"), modeApplied: false })
  })
  it("→ platform: failing to pause aborts; mode unchanged", async () => {
    three()
    h.state.failWrite = (_t, p) => (p.local_status === "paused" ? "pause-fail" : null)
    const r = await setAccountMode("admin1", "B", "platform")
    expect(!r.ok && r.error).toMatch(/pause extra sender IDs \(pause-fail\).*free sender ID marked.*Mode is business/)
    expect(acct().mode).toBe("business")
  })
  it("→ platform: failing to repoint the default leaves extras paused and mode unchanged (safe direction)", async () => {
    three()
    acct().default_sender_id = "bb"
    h.state.failWrite = (t, p) => (t === "sms_accounts" && "default_sender_id" in p ? "def-fail" : null)
    const r = await setAccountMode("admin1", "B", "platform")
    expect(!r.ok && r.error).toMatch(/repoint the default sender ID \(def-fail\).*2 sender ID\(s\) paused.*Mode is business/)
    expect(find("bb").local_status).toBe("paused")
    expect(acct().mode).toBe("business")
  })
  it("→ platform: failing to set the mode reports the paused ids and still audits", async () => {
    three()
    h.state.failWrite = (t, p) => (t === "sms_accounts" && "mode" in p ? "mode-fail" : null)
    const r = await setAccountMode("admin1", "B", "platform")
    expect(!r.ok && r.error).toMatch(/set account mode \(mode-fail\).*2 sender ID\(s\) paused.*Mode is business/)
    expect(find("bb").local_status).toBe("paused")
    expect(acct().mode).toBe("business")
    expect(h.state.audit[0][4]).toMatchObject({ paused: 2, modeApplied: false })
  })
  it("→ platform: success sets mode last and counts paused from returned rows", async () => {
    three()
    const r = await setAccountMode("admin1", "B", "platform")
    expect(r).toEqual({ ok: true, data: { mode: "platform", unpaused: 0, paused: 2, conflicts: [] } })
  })
  it("→ business: failing to set the mode aborts before any unpause", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "P", "active", { kyc_free: true }), sid("bb", "TWO", "P", "paused"))
    h.state.failWrite = (t, p) => (t === "sms_accounts" && "mode" in p ? "mode-fail" : null)
    const r = await setAccountMode("admin1", "P", "business")
    expect(!r.ok && r.error).toMatch(/set account mode \(mode-fail\).*Applied: nothing.*Mode is platform/)
    expect(find("bb").local_status).toBe("paused")
  })
  it("→ business: a non-conflict unpause failure is reported with what was applied", async () => {
    T("sms_sender_ids").push(sid("a", "ONE", "P", "active", { kyc_free: true }), sid("bb", "TWO", "P", "paused"))
    h.state.failWrite = (t, p) => (t === "sms_sender_ids" && p.local_status === "active" ? "unpause-fail" : null)
    const r = await setAccountMode("admin1", "P", "business")
    expect(!r.ok && r.error).toMatch(/unpause a sender ID \(unpause-fail\).*mode set to business.*Mode is business/)
    expect(find("bb").local_status).toBe("paused")
    expect(h.state.audit[0][4]).toMatchObject({ modeApplied: true, failure: expect.stringContaining("unpause-fail") })
  })
})

describe("setApiRateLimitOverride", () => {
  it.each([0, -1, 10001, 1.5, NaN])("rejects %s", async (v) => {
    expect((await setApiRateLimitOverride("admin1", "B", v)).ok).toBe(false)
    expect(T("sms_accounts").find((a) => a.id === "B")!.api_rate_limit_override).toBeUndefined()
  })
  it("accepts 1, 10000 and null", async () => {
    for (const v of [1, 10000, null]) {
      expect(await setApiRateLimitOverride("admin1", "B", v)).toEqual({ ok: true, data: { api_rate_limit_override: v } })
      expect(T("sms_accounts").find((a) => a.id === "B")!.api_rate_limit_override).toBe(v)
    }
    expect(h.state.audit).toHaveLength(3)
  })
})
