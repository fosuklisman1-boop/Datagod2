import { describe, it, expect } from "vitest"
import { hashV2Key } from "./keys"
import {
  createKey,
  getConfig,
  logRequest,
  touchLastUsed,
  findKeyByHash,
  getUserForKey,
  revokeAllV2Keys,
  disableV2,
  hasGrant,
  getApprovalContact,
  listActiveRoles,
} from "./store"

type Op = { table: string; op: string; payload?: any; filters: Array<[string, string, any]> }

function makeFake(opts: {
  insertError?: { code: string } | null
  selectResult?: { data: any; error: any }
  updateError?: any
  updateData?: any
  throwOnAny?: boolean
} = {}) {
  const ops: Op[] = []
  const client = {
    from(table: string) {
      if (opts.throwOnAny) throw new Error("boom")
      const rec: Op = { table, op: "select", filters: [] }
      const result = () => {
        if (rec.op === "insert") {
          return opts.insertError
            ? { data: null, error: opts.insertError }
            : { data: { id: "k1", ...rec.payload }, error: null }
        }
        if (rec.op === "update") return { data: opts.updateData ?? null, error: opts.updateError ?? null, count: 2 }
        return opts.selectResult ?? { data: null, error: null }
      }
      const b: any = {
        select() { if (rec.op === "select") ops.push(rec); return b },
        insert(p: any) { rec.op = "insert"; rec.payload = p; ops.push(rec); return b },
        update(p: any) { rec.op = "update"; rec.payload = p; ops.push(rec); return b },
        eq(c: string, v: any) { rec.filters.push([c, "eq", v]); return b },
        in(c: string, v: any) { rec.filters.push([c, "in", v]); return b },
        neq(c: string, v: any) { rec.filters.push([c, "neq", v]); return b },
        single() { return Promise.resolve(result()) },
        maybeSingle() { return Promise.resolve(result()) },
        then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
      }
      return b
    },
  }
  return { client, ops }
}

describe("getConfig", () => {
  it("fails closed on error", async () => {
    const { client } = makeFake({ selectResult: { data: null, error: { message: "x" } } })
    expect(await getConfig(client)).toEqual({ enabled: false, allowed_roles: [] })
  })
  it("fails closed when client throws", async () => {
    const { client } = makeFake({ throwOnAny: true })
    expect(await getConfig(client)).toEqual({ enabled: false, allowed_roles: [] })
  })
  it("fails closed on missing row", async () => {
    const { client } = makeFake({ selectResult: { data: null, error: null } })
    expect(await getConfig(client)).toEqual({ enabled: false, allowed_roles: [] })
  })
  it("returns the row", async () => {
    const { client } = makeFake({ selectResult: { data: { enabled: true, allowed_roles: ["admin"] }, error: null } })
    expect(await getConfig(client)).toEqual({ enabled: true, allowed_roles: ["admin"] })
  })
})

describe("createKey", () => {
  it("test env: revokes the prior pending/active key before inserting (live keeps its active key, see below)", async () => {
    const { client, ops } = makeFake()
    const r = await createKey(client, { userId: "u1", type: "standard", env: "test", name: "n" })
    expect(r.ok).toBe(true)
    const updIdx = ops.findIndex((o) => o.op === "update")
    const insIdx = ops.findIndex((o) => o.op === "insert")
    expect(updIdx).toBeGreaterThanOrEqual(0)
    expect(updIdx).toBeLessThan(insIdx)
    const upd = ops[updIdx]
    expect(upd.payload.status).toBe("revoked")
    expect(upd.payload.revoked_at).toBeTruthy()
    expect(upd.filters).toContainEqual(["user_id", "eq", "u1"])
    expect(upd.filters).toContainEqual(["key_type", "eq", "standard"])
    expect(upd.filters).toContainEqual(["environment", "eq", "test"])
    expect(upd.filters).toContainEqual(["status", "in", ["pending", "active"]])
  })

  it("returns 409 on unique violation", async () => {
    const { client } = makeFake({ insertError: { code: "23505" } })
    expect(await createKey(client, { userId: "u1", type: "sms", env: "test", name: "n" })).toEqual({ ok: false, status: 409 })
  })

  it("returns 500 on other insert error", async () => {
    const { client } = makeFake({ insertError: { code: "XX000" } })
    expect(await createKey(client, { userId: "u1", type: "sms", env: "test", name: "n" })).toEqual({ ok: false, status: 500 })
  })

  it("stores the hash, returns a row without key_hash, initial status per env", async () => {
    const { client, ops } = makeFake()
    const live = await createKey(client, { userId: "u1", type: "commission", env: "live", name: "n" })
    if (!live.ok) throw new Error("expected ok")
    const ins = ops.find((o) => o.op === "insert")!
    expect(ins.payload.key_hash).toBe(hashV2Key(live.key))
    expect(ins.payload.status).toBe("pending")
    expect(ins.payload.key_prefix).toBe(live.key.slice(0, 16))
    expect("key_hash" in live.row).toBe(false)
    expect(JSON.stringify(live.row)).not.toContain(hashV2Key(live.key))

    const test = await createKey(client, { userId: "u1", type: "standard", env: "test", name: "n" })
    if (!test.ok) throw new Error("expected ok")
    expect(ops.filter((o) => o.op === "insert")[1].payload.status).toBe("active")
  })
})

describe("createKey failure paths", () => {
  it("returns 500 and inserts nothing when the revoke step fails", async () => {
    const { client, ops } = makeFake({ updateError: { message: "x" } })
    expect(await createKey(client, { userId: "u1", type: "standard", env: "live", name: "n" })).toEqual({
      ok: false,
      status: 500,
    })
    expect(ops.some((o) => o.op === "insert")).toBe(false)
  })
})

describe("logRequest", () => {
  it("writes exactly the allowed columns", async () => {
    const { client, ops } = makeFake()
    await logRequest(client, {
      keyId: "k", userId: "u", method: "POST", endpoint: "/x", statusCode: 200,
      errorCode: 5, ip: "1.2.3.4", durationMs: 12, environment: "live",
    })
    const row = ops.find((o) => o.table === "api_v2_logs")!.payload
    expect(Object.keys(row).sort()).toEqual(
      ["duration_ms", "endpoint", "environment", "error_code", "ip_address", "key_id", "method", "status_code", "user_id"].sort()
    )
    for (const bad of ["key", "key_hash", "body", "payload", "phone"]) expect(bad in row).toBe(false)
  })
  it("never throws", async () => {
    const { client } = makeFake({ throwOnAny: true })
    await expect(
      logRequest(client, { keyId: "k", userId: "u", method: "GET", endpoint: "/x", statusCode: 200, ip: "i", durationMs: 1, environment: "test" })
    ).resolves.toBeUndefined()
  })
})

describe("touchLastUsed", () => {
  it("swallows errors", async () => {
    const { client } = makeFake({ throwOnAny: true })
    await expect(touchLastUsed(client, "k")).resolves.toBeUndefined()
    const f2 = makeFake({ updateError: { message: "x" } })
    await expect(touchLastUsed(f2.client, "k")).resolves.toBeUndefined()
  })
})

describe("reads", () => {
  it("findKeyByHash filters by hash and does not select key_hash", async () => {
    const { client, ops } = makeFake({ selectResult: { data: { id: "k" }, error: null } })
    const row = await findKeyByHash(client, "h")
    expect(row).toEqual({ id: "k" })
    expect(ops[0].filters).toContainEqual(["key_hash", "eq", "h"])
  })
  it("findKeyByHash returns null on a genuine miss", async () => {
    expect(await findKeyByHash(makeFake().client, "h")).toBeNull()
  })
  it("findKeyByHash returns \"error\" on a DB error or exception (outage, not a bad key)", async () => {
    expect(await findKeyByHash(makeFake({ throwOnAny: true }).client, "h")).toBe("error")
    expect(
      await findKeyByHash(makeFake({ selectResult: { data: null, error: { message: "x" } } }).client, "h")
    ).toBe("error")
  })
  it("findKeyByHash never returns key_hash even if the client does", async () => {
    const { client } = makeFake({ selectResult: { data: { id: "k", key_hash: "secret" }, error: null } })
    const row = await findKeyByHash(client, "h")
    expect(row).toEqual({ id: "k" })
    expect(JSON.stringify(row)).not.toContain("secret")
  })
  it("getUserForKey returns null on miss", async () => {
    expect(await getUserForKey(makeFake().client, "u")).toBeNull()
  })
  it("getUserForKey returns \"error\" on a DB error or exception", async () => {
    const e = makeFake({ selectResult: { data: null, error: { message: "x" } } })
    expect(await getUserForKey(e.client, "u")).toBe("error")
    expect(await getUserForKey(makeFake({ throwOnAny: true }).client, "u")).toBe("error")
  })
  it("getUserForKey returns the user on a hit, without email, with suspended as a boolean", async () => {
    const { client, ops } = makeFake({
      selectResult: { data: { id: "u", role: "dealer", first_name: "Ama", is_suspended: false }, error: null },
    })
    expect(await getUserForKey(client, "u")).toEqual({ id: "u", role: "dealer", first_name: "Ama", suspended: false })
    expect(ops[0].filters).toContainEqual(["id", "eq", "u"])
  })
  it("getUserForKey selects is_suspended and not email", async () => {
    let selected = ""
    const client = {
      from() {
        const b: any = {
          select(cols: string) { selected = cols; return b },
          eq() { return b },
          maybeSingle() { return Promise.resolve({ data: null, error: null }) },
        }
        return b
      },
    }
    await getUserForKey(client, "u")
    expect(selected).toContain("is_suspended")
    expect(selected).not.toContain("email")
  })
  it("getUserForKey maps is_suspended true/null/undefined to a boolean", async () => {
    const cases: Array<[unknown, boolean]> = [[true, true], [null, false], [undefined, false], [false, false]]
    for (const [raw, expected] of cases) {
      const { client } = makeFake({
        selectResult: { data: { id: "u", role: "dealer", first_name: null, is_suspended: raw }, error: null },
      })
      const owner = await getUserForKey(client, "u")
      expect(typeof owner === "object" && owner ? owner.suspended : undefined).toBe(expected)
    }
  })
  it("revokeAllV2Keys returns the number of revoked rows", async () => {
    const { client } = makeFake({ updateData: [{ id: "a" }, { id: "b" }, { id: "c" }] })
    expect(await revokeAllV2Keys(client)).toBe(3)
  })
  it("revokeAllV2Keys throws when the client reports an error", async () => {
    const { client } = makeFake({ updateError: { message: "x" } })
    await expect(revokeAllV2Keys(client)).rejects.toThrow()
  })
  it("disableV2 sets enabled=false and updated_at on the single config row", async () => {
    const { client, ops } = makeFake()
    await disableV2(client)
    const upd = ops.find((o) => o.op === "update")!
    expect(upd.table).toBe("api_v2_config")
    expect(upd.payload.enabled).toBe(false)
    expect(typeof upd.payload.updated_at).toBe("string")
    expect(upd.filters).toEqual([["id", "eq", true]])
  })
  it("disableV2 throws when the client reports an error", async () => {
    const { client } = makeFake({ updateError: { message: "x" } })
    await expect(disableV2(client)).rejects.toThrow()
  })
  it("revokeAllV2Keys revokes pending and active", async () => {
    const { client, ops } = makeFake()
    await revokeAllV2Keys(client)
    const upd = ops.find((o) => o.op === "update")!
    expect(upd.payload.status).toBe("revoked")
    expect(upd.filters).toContainEqual(["status", "in", ["pending", "active"]])
  })
})

describe("getConfig column safety", () => {
  it("selects exactly enabled, allowed_roles (the request path never reads a newer column)", async () => {
    const cols: string[] = []
    const b: any = {
      select(c: string) { cols.push(c); return b },
      eq() { return b },
      maybeSingle() { return Promise.resolve({ data: { enabled: true, allowed_roles: [] }, error: null }) },
    }
    await getConfig({ from: () => b })
    expect(cols).toEqual(["enabled, allowed_roles"])
  })
})

describe("hasGrant", () => {
  it("true when a grant row exists, false when none", async () => {
    expect(await hasGrant(makeFake({ selectResult: { data: { user_id: "u" }, error: null } }).client, "u")).toBe(true)
    expect(await hasGrant(makeFake({ selectResult: { data: null, error: null } }).client, "u")).toBe(false)
  })
  it('"error" on a read error or a throw, never false', async () => {
    expect(await hasGrant(makeFake({ selectResult: { data: null, error: { message: "x" } } }).client, "u")).toBe("error")
    expect(await hasGrant(makeFake({ throwOnAny: true }).client, "u")).toBe("error")
  })
  it("reads the grants table filtered by user", async () => {
    const { client, ops } = makeFake({ selectResult: { data: null, error: null } })
    await hasGrant(client, "u-9")
    expect(ops[0]).toMatchObject({ table: "api_v2_access_grants", filters: [["user_id", "eq", "u-9"]] })
  })
})

describe("getApprovalContact", () => {
  it("returns the stored digits", async () => {
    const { client } = makeFake({ selectResult: { data: { approval_whatsapp: "233559919037" }, error: null } })
    expect(await getApprovalContact(client)).toBe("233559919037")
  })
  it("null when unset, on error (missing column) and on a throw, never throws", async () => {
    expect(await getApprovalContact(makeFake({ selectResult: { data: { approval_whatsapp: null }, error: null } }).client)).toBeNull()
    expect(await getApprovalContact(makeFake({ selectResult: { data: null, error: { message: "column missing" } } }).client)).toBeNull()
    expect(await getApprovalContact(makeFake({ throwOnAny: true }).client)).toBeNull()
  })
})

describe("listActiveRoles", () => {
  const roles = [{ slug: "reseller", name: "Reseller" }, { slug: "user", name: "User" }]
  it("returns slug and name of the rows read", async () => {
    const b: any = { select() { return b }, is() { return b }, limit() { return Promise.resolve({ data: roles, error: null }) } }
    expect(await listActiveRoles({ from: () => b })).toEqual(roles)
  })
  it('"error" on a read error, a throw, or a full page that may be truncated', async () => {
    const mk = (res: any) => { const b: any = { select() { return b }, is() { return b }, limit() { return Promise.resolve(res) } }; return { from: () => b } }
    expect(await listActiveRoles(mk({ data: null, error: { message: "x" } }))).toBe("error")
    expect(await listActiveRoles(mk({ data: new Array(1000).fill({ slug: "a", name: "A" }), error: null }))).toBe("error")
    expect(await listActiveRoles({ from: () => { throw new Error("boom") } })).toBe("error")
  })
})

describe("logRequest error_reason", () => {
  const base = { keyId: "k", userId: "u", method: "POST", endpoint: "/x", statusCode: 403, ip: "i", durationMs: 1, environment: "live" as const }

  it("writes error_reason when one is given", async () => {
    const { client, ops } = makeFake()
    await logRequest(client, { ...base, errorReason: "key_pending" })
    const inserts = ops.filter((o) => o.table === "api_v2_logs" && o.op === "insert")
    expect(inserts).toHaveLength(1)
    expect(inserts[0].payload.error_reason).toBe("key_pending")
  })

  it("omits the column for a null reason, so success logs never need the new column", async () => {
    const { client, ops } = makeFake()
    await logRequest(client, { ...base, statusCode: 200, errorReason: null })
    expect("error_reason" in ops.find((o) => o.op === "insert")!.payload).toBe(false)
  })

  it("retries once without error_reason when the column does not exist yet (before migration 0195)", async () => {
    for (const code of ["PGRST204", "42703"]) {
      const ops: any[] = []
      let calls = 0
      const client: any = {
        from(table: string) {
          return {
            insert(p: any) {
              ops.push({ table, payload: p })
              calls++
              return Promise.resolve({ data: null, error: calls === 1 ? { code } : null })
            },
          }
        },
      }
      await logRequest(client, { ...base, errorReason: "key_pending" })
      expect(ops).toHaveLength(2)
      expect("error_reason" in ops[1].payload).toBe(false)
      expect(ops[1].payload.status_code).toBe(403)
    }
  })

  it("does not retry other insert errors", async () => {
    const { client, ops } = makeFake({ insertError: { code: "23503" } })
    await logRequest(client, { ...base, errorReason: "key_pending" })
    expect(ops.filter((o) => o.op === "insert")).toHaveLength(1)
  })
})

describe("createKey approval behaviour", () => {
  /** Records calls; `inserts` queues insert results; `active` answers the active-key probe. */
  function slotFake(o: { inserts?: Array<{ error?: any }>; active?: boolean } = {}) {
    const calls: any[] = []
    const inserts = [...(o.inserts ?? [{}])]
    const client = {
      from(table: string) {
        const rec: any = { table, op: "select", filters: [] as any[] }
        calls.push(rec)
        const result = () => {
          if (rec.op === "insert") {
            const r = inserts.shift() ?? {}
            return r.error
              ? { data: null, error: r.error }
              : { data: { id: "k-new", ...rec.payload, created_at: "t", last_used_at: null, rate_limits: null }, error: null }
          }
          if (rec.op === "update") return { data: null, error: null }
          return { data: o.active ? [{ id: "k-old" }] : [], error: null }
        }
        const b: any = {
          select(c: string) { if (rec.op === "select") rec.cols = c; else rec.returning = c; return b },
          insert(p: any) { rec.op = "insert"; rec.payload = p; return b },
          update(p: any) { rec.op = "update"; rec.payload = p; return b },
          eq(c: string, v: any) { rec.filters.push(["eq", c, v]); return b },
          in(c: string, v: any) { rec.filters.push(["in", c, v]); return b },
          limit() { return b },
          single() { return Promise.resolve(result()) },
          then(res: any, rej: any) { return Promise.resolve(result()).then(res, rej) },
        }
        return b
      },
    }
    return { client, calls }
  }
  const revokeStatusFilters = (calls: any[]) =>
    calls.filter((c) => c.op === "update").map((c) => c.filters.find((f: any) => f[1] === "status"))
  const CODE_DUP = { error: { code: "23505", message: 'duplicate key value violates unique constraint "api_v2_keys_request_code_key"' } }
  const SLOT_DUP = { error: { code: "23505", message: 'duplicate key value violates unique constraint "api_v2_keys_one_pending_per_slot"' } }

  it("live: revokes only a pending key, so the active key keeps working, and reports the active key", async () => {
    const { client, calls } = slotFake({ active: true })
    const r = await createKey(client, { userId: "u1", type: "standard", env: "live" })
    expect(r.ok).toBe(true)
    expect(revokeStatusFilters(calls)).toEqual([["eq", "status", "pending"]])
    expect(r.ok && r.hadActive).toBe(true)
  })

  it("test: revokes pending and active, as before", async () => {
    const { client, calls } = slotFake()
    const r = await createKey(client, { userId: "u1", type: "standard", env: "test" })
    expect(revokeStatusFilters(calls)).toEqual([["in", "status", ["pending", "active"]]])
    expect(r.ok && r.hadActive).toBe(false)
  })

  it("live keys get a request code; test keys do not", async () => {
    const live = slotFake()
    const r = await createKey(live.client, { userId: "u1", type: "standard", env: "live" }, () => "API-BBBBBB")
    expect(live.calls.find((c) => c.op === "insert").payload.request_code).toBe("API-BBBBBB")
    expect(r.ok && r.row.request_code).toBe("API-BBBBBB")
    const t = slotFake()
    await createKey(t.client, { userId: "u1", type: "standard", env: "test" })
    expect("request_code" in t.calls.find((c) => c.op === "insert").payload).toBe(false)
  })

  it("retries a request_code collision (max 3 attempts), then 500", async () => {
    expect((await createKey(slotFake({ inserts: [CODE_DUP, {}] }).client, { userId: "u1", type: "standard", env: "live" })).ok).toBe(true)
    expect(await createKey(slotFake({ inserts: [CODE_DUP, CODE_DUP, CODE_DUP] }).client, { userId: "u1", type: "standard", env: "live" })).toEqual({
      ok: false,
      status: 500,
    })
  })

  it("a slot collision is 409 at once and never revokes the active key", async () => {
    const { client, calls } = slotFake({ inserts: [SLOT_DUP], active: true })
    expect(await createKey(client, { userId: "u1", type: "standard", env: "live" })).toEqual({ ok: false, status: 409 })
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(1)
    expect(revokeStatusFilters(calls)).toEqual([["eq", "status", "pending"]])
  })
})
