import { describe, it, expect, vi, beforeEach } from "vitest"

type Rec = { table: string; op: "select" | "update"; cols?: string; payload?: any }
const h = vi.hoisted(() => ({
  recs: [] as any[],
  resolve: (_r: any): any => ({ data: null, error: null }),
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () => ({ isAdmin: true, userId: (globalThis as any).__noAdminId ? undefined : "admin-1", errorResponse: null }),
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    getAdminClient: () => ({
      from(table: string) {
        const rec: Rec = { table, op: "select" }
        h.recs.push(rec)
        const run = () => Promise.resolve(h.resolve(rec))
        const b: any = {
          select(cols?: string) { if (rec.cols === undefined) rec.cols = cols; return b },
          update(p: any) { rec.op = "update"; rec.payload = p; return b },
          insert(p: any) { (rec as any).op = "insert"; rec.payload = p; return b },
          eq() { return b },
          is() { return b },
          limit() { return run() },
          maybeSingle() { return run() },
          then(res: any, rej: any) { return run().then(res, rej) },
        }
        return b
      },
    }),
  }
})

import { GET, PUT } from "./route"

const STORED = { enabled: true, allowed_roles: ["dealer", "old_tier"] }
const ROLES = [
  { slug: "user", name: "User" },
  { slug: "dealer", name: "Dealer" },
  { slug: "reseller", name: "Gold Reseller" },
]

interface World {
  auditError?: any
  config?: any
  configError?: any
  roles?: any
  rolesError?: any
  contact?: any
  contactError?: any
  updateError?: any
}
function setWorld(w: World = {}) {
  h.resolve = (r: Rec) => {
    if (r.table === "admin_audit_log") return { data: null, error: w.auditError ?? null }
    if (r.table === "roles") return w.rolesError ? { data: null, error: w.rolesError } : { data: w.roles ?? ROLES, error: null }
    if (r.table !== "api_v2_config") return { data: null, error: null }
    if (r.op === "update") {
      if (w.updateError) return { data: null, error: w.updateError }
      return { data: { enabled: r.payload.enabled ?? STORED.enabled, allowed_roles: r.payload.allowed_roles ?? STORED.allowed_roles }, error: null }
    }
    if (r.cols === "approval_whatsapp") {
      return w.contactError ? { data: null, error: w.contactError } : { data: { approval_whatsapp: w.contact ?? null }, error: null }
    }
    return w.configError ? { data: null, error: w.configError } : { data: w.config ?? STORED, error: null }
  }
}

// The routes return the admin guard's errorResponse (possibly undefined) when not admin; the mock is always admin.
const GETR = async () => (await GET({} as never))!
const put = async (body: unknown) => (await PUT({ json: async () => body } as any))!
const updates = () => h.recs.filter((r) => r.op === "update")
const roleReads = () => h.recs.filter((r) => r.table === "roles")

beforeEach(() => {
  h.recs.length = 0
  setWorld()
})

describe("GET /api/admin/api-v2/config", () => {
  it("returns config, contact and the active roles", async () => {
    setWorld({ contact: "233559919037" })
    const res = await GETR()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...STORED, approval_whatsapp: "233559919037", roles: ROLES })
  })
  it("still returns config and contact, with roles null, when the roles read fails", async () => {
    setWorld({ rolesError: { message: "x" }, contact: "233559919037" })
    const res = await GETR()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...STORED, approval_whatsapp: "233559919037", roles: null })
  })
  it("a missing contact column reads as null and does not fail the page", async () => {
    setWorld({ contactError: { message: "column does not exist" } })
    const body = await (await GETR()).json()
    expect(body.approval_whatsapp).toBeNull()
    expect(body.enabled).toBe(true)
  })
  it("the main config select never includes the contact column", async () => {
    await GETR()
    const main = h.recs.find((r) => r.table === "api_v2_config" && r.cols !== "approval_whatsapp")
    expect(main.cols).toBe("enabled, allowed_roles")
  })
  it("500 when the config itself cannot be read", async () => {
    setWorld({ configError: { message: "x" } })
    expect((await GETR()).status).toBe(500)
  })
})

describe("PUT /api/admin/api-v2/config", () => {
  it("a changed role set accepts an active custom role", async () => {
    const res = await put({ enabled: true, allowed_roles: ["dealer", "reseller"] })
    expect(res.status).toBe(200)
    expect(updates()[0].payload.allowed_roles).toEqual(["dealer", "reseller"])
  })
  it("a newly added role that is not active is refused with no update", async () => {
    const res = await put({ enabled: true, allowed_roles: ["dealer", "ghost"] })
    expect(res.status).toBe(400)
    expect(updates()).toHaveLength(0)
  })
  it("a newly added archived role is refused (it is not in the active list)", async () => {
    const res = await put({ allowed_roles: ["dealer", "old_tier", "archived_new"] })
    expect(res.status).toBe(400)
    expect(updates()).toHaveLength(0)
  })
  it("a slug already stored may stay even when it is no longer active, when the set changes", async () => {
    const res = await put({ allowed_roles: ["old_tier", "reseller"] })
    expect(res.status).toBe(200)
    expect(updates()[0].payload.allowed_roles).toEqual(["old_tier", "reseller"])
  })
  it("a roles read error on a changed set gives 503 and no update", async () => {
    setWorld({ rolesError: { message: "x" } })
    const res = await put({ enabled: true, allowed_roles: ["dealer", "reseller"] })
    expect(res.status).toBe(503)
    expect(updates()).toHaveLength(0)
  })
  it("an unchanged role list (different order, archived slug inside) saves without reading roles, so API-off always works", async () => {
    setWorld({ rolesError: { message: "x" } })
    const res = await put({ enabled: false, allowed_roles: ["old_tier", "dealer"] })
    expect(res.status).toBe(200)
    expect(roleReads()).toHaveLength(0)
    expect(updates()[0].payload).toMatchObject({ enabled: false, allowed_roles: ["old_tier", "dealer"] })
  })
  it("an enabled-only save reads no roles and leaves the stored contact untouched", async () => {
    const res = await put({ enabled: false })
    expect(res.status).toBe(200)
    expect(roleReads()).toHaveLength(0)
    expect("approval_whatsapp" in updates()[0].payload).toBe(false)
  })
  it("a roles-only save leaves the stored contact untouched", async () => {
    await put({ allowed_roles: ["dealer", "reseller"] })
    expect("approval_whatsapp" in updates()[0].payload).toBe(false)
  })
  it("a contact-only save reads no roles and stores the digits", async () => {
    const res = await put({ approval_whatsapp: "0559919037" })
    expect(res.status).toBe(200)
    expect(roleReads()).toHaveLength(0)
    expect(updates()[0].payload.approval_whatsapp).toBe("233559919037")
    expect((await res.json()).approval_whatsapp).toBe("233559919037")
  })
  it("an explicit empty contact clears it", async () => {
    await put({ approval_whatsapp: "" })
    expect(updates()[0].payload.approval_whatsapp).toBeNull()
  })
  it("a saves that does not involve the contact never selects or returns it (works if the column is missing)", async () => {
    const res = await put({ enabled: true, allowed_roles: ["dealer", "old_tier"] })
    expect("approval_whatsapp" in (await res.json())).toBe(false)
    for (const r of h.recs) expect(String(r.cols ?? "")).not.toContain("approval_whatsapp")
  })
  it("an invalid contact is 400 with no update", async () => {
    const res = await put({ approval_whatsapp: "https://evil.example" })
    expect(res.status).toBe(400)
    expect(updates()).toHaveLength(0)
  })
  it("stored config unreadable while a role list is submitted gives 503 and no update", async () => {
    setWorld({ configError: { message: "x" } })
    const res = await put({ allowed_roles: ["dealer"] })
    expect(res.status).toBe(503)
    expect(updates()).toHaveLength(0)
  })
  it("rejects an empty update with 400", async () => {
    expect((await put({})).status).toBe(400)
  })
  it("rejects invalid JSON with 400", async () => {
    const res = (await PUT({ json: async () => { throw new Error("bad") } } as any))!
    expect(res.status).toBe(400)
  })
})

describe("PUT /api/admin/api-v2/config audit", () => {
  const audits = () => h.recs.filter((r) => r.table === "admin_audit_log" && r.op === "insert")
  it("a save writes one api_config row with the verified admin and never the phone number", async () => {
    const res = await put({ enabled: false, approval_whatsapp: "0559919037" })
    expect(res.status).toBe(200)
    expect(audits()).toHaveLength(1)
    const row = audits()[0].payload
    expect(row).toMatchObject({ admin_id: "admin-1", action: "api_config" })
    expect(row.new_value).toMatchObject({ enabled: false, approval_contact_changed: true })
    expect(JSON.stringify(row)).not.toMatch(/559919037/)
  })
  it("an audit failure keeps the save and reports auditFailed", async () => {
    setWorld({ auditError: { message: "x" } })
    const res = await put({ enabled: false })
    expect(res.status).toBe(200)
    expect((await res.json()).auditFailed).toBe(true)
    expect(updates()).toHaveLength(1)
  })
  it("the cron secret (admin with no user id) cannot change settings or the approval contact: 403, no update", async () => {
    ;(globalThis as any).__noAdminId = true
    try {
      expect((await put({ approval_whatsapp: "0241112222" })).status).toBe(403)
      expect((await put({ enabled: false })).status).toBe(403)
      expect(updates()).toHaveLength(0)
    } finally {
      ;(globalThis as any).__noAdminId = false
    }
  })
  it("a failed save writes no audit row", async () => {
    setWorld({ updateError: { message: "x" } })
    await put({ enabled: false })
    expect(audits()).toHaveLength(0)
  })
})
