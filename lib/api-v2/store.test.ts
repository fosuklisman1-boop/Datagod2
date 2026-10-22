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
  it("revokes the prior pending/active key before inserting", async () => {
    const { client, ops } = makeFake()
    const r = await createKey(client, { userId: "u1", type: "standard", env: "live", name: "n" })
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
    expect(upd.filters).toContainEqual(["environment", "eq", "live"])
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
  it("findKeyByHash returns null on miss/error", async () => {
    expect(await findKeyByHash(makeFake().client, "h")).toBeNull()
    expect(await findKeyByHash(makeFake({ throwOnAny: true }).client, "h")).toBeNull()
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
      expect((await getUserForKey(client, "u"))?.suspended).toBe(expected)
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
  it("revokeAllV2Keys revokes pending and active", async () => {
    const { client, ops } = makeFake()
    await revokeAllV2Keys(client)
    const upd = ops.find((o) => o.op === "update")!
    expect(upd.payload.status).toBe("revoked")
    expect(upd.filters).toContainEqual(["status", "in", ["pending", "active"]])
  })
})
