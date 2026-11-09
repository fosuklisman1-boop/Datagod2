import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHash } from "node:crypto"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

const notifyOwnerOfRecruit = vi.fn(async () => {})
const provisionShopCode = vi.fn(async () => ({ id: "code-1", activation_fee_paid: false }))

vi.mock("./notify-owner", () => ({
  notifyOwnerOfRecruit: (...a: unknown[]) => (notifyOwnerOfRecruit as any)(...a),
}))
vi.mock("@/lib/ussd-shop/provision-code", () => ({
  provisionShopCode: (...a: unknown[]) => (provisionShopCode as any)(...a),
}))

import {
  normalizePhone,
  validateRecruitShopName,
  startJoinIntent,
  finalizeJoinIntent,
  joinExistingUser,
  JOIN_SETUP_TARGET,
  JOIN_CLOSED_TARGET,
  LOGIN_TO_CONTINUE,
} from "./join"

// ---------------------------------------------------------------------------
// In-memory fake of the service-role client: enough of the PostgREST builder
// for this module (select/insert/update/delete, eq/neq/is/in/gte, maybeSingle).
// ---------------------------------------------------------------------------

type Row = Record<string, any>
type Op = { table: string; op: string; payload?: any; filters: [string, string, any][] }

const UNIQUE: Record<string, string[]> = {
  users: ["id"],
  user_shops: ["id", "user_id", "shop_slug"],
  sub_agent_join_intents: ["user_id", "otp_verification_id"],
  wallets: ["user_id"],
}

function memDb(
  seed: Record<string, Row[]> = {},
  opts: { fail?: (o: Op) => { code: string; message: string } | null } = {}
) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const log: Op[] = []
  const authUpdates: { id: string; attrs: any }[] = []
  let seq = 0

  const matches = (row: Row, filters: Op["filters"]) =>
    filters.every(([kind, col, val]) => {
      const v = row[col]
      switch (kind) {
        case "eq": return v === val
        case "neq": return v !== val
        case "is": return val === null ? v === null || v === undefined : v === val
        case "in": return (val as any[]).includes(v)
        case "gte": return v >= val
        default: return true
      }
    })

  function run(o: Op, returning: boolean): { data: any; error: any } {
    log.push(o)
    const injected = opts.fail?.(o)
    if (injected) return { data: null, error: injected }
    const rows = (tables[o.table] ||= [])
    if (o.op === "select") return { data: rows.filter((r) => matches(r, o.filters)).map((r) => ({ ...r })), error: null }
    if (o.op === "insert") {
      const list = Array.isArray(o.payload) ? o.payload : [o.payload]
      const out: Row[] = []
      for (const p of list) {
        const row = { ...p }
        if (o.table !== "sub_agent_join_intents" && o.table !== "users" && row.id === undefined) row.id = `${o.table}-${++seq}`
        // Column defaults from migration 0146.
        if (o.table === "sub_agent_join_intents") {
          row.created_at ??= new Date().toISOString()
          row.consumed_at ??= null
        }
        for (const key of UNIQUE[o.table] || []) {
          if (row[key] != null && rows.some((r) => r[key] === row[key])) {
            return { data: null, error: { code: "23505", message: `duplicate ${key}` } }
          }
        }
        rows.push(row)
        out.push({ ...row })
      }
      return { data: returning ? out : null, error: null }
    }
    if (o.op === "update") {
      const hit = rows.filter((r) => matches(r, o.filters))
      hit.forEach((r) => Object.assign(r, o.payload))
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
    }
    if (o.op === "delete") {
      const keep = rows.filter((r) => !matches(r, o.filters))
      const gone = rows.length - keep.length
      tables[o.table] = keep
      return { data: null, error: null, count: gone } as any
    }
    return { data: null, error: null }
  }

  const db: any = {
    tables,
    log,
    authUpdates,
    auth: {
      admin: {
        async updateUserById(id: string, attrs: any) {
          authUpdates.push({ id, attrs })
          return { data: { user: { id } }, error: null }
        },
      },
    },
    from(table: string) {
      const o: Op = { table, op: "select", filters: [] }
      let returning = false
      let limitN: number | null = null
      const exec = () => {
        const r = run(o, returning || o.op === "select")
        if (o.op === "select" && Array.isArray(r.data) && limitN !== null) r.data = r.data.slice(0, limitN)
        return r
      }
      const b: any = {
        select() { if (o.op === "select") return b; returning = true; return b },
        insert(p: any) { o.op = "insert"; o.payload = p; return b },
        update(p: any) { o.op = "update"; o.payload = p; return b },
        delete() { o.op = "delete"; return b },
        eq(c: string, v: any) { o.filters.push(["eq", c, v]); return b },
        neq(c: string, v: any) { o.filters.push(["neq", c, v]); return b },
        is(c: string, v: any) { o.filters.push(["is", c, v]); return b },
        in(c: string, v: any[]) { o.filters.push(["in", c, v]); return b },
        gte(c: string, v: any) { o.filters.push(["gte", c, v]); return b },
        order() { return b },
        limit(n: number) { limitN = n; return b },
        async maybeSingle() {
          const r = exec()
          if (r.error) return r
          const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data
          return { data: d, error: null }
        },
        async single() {
          const r = exec()
          if (r.error) return r
          const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data
          return d ? { data: d, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } }
        },
        then(resolve: any, reject: any) {
          try { return Promise.resolve(exec()).then(resolve, reject) } catch (e) { return reject(e) }
        },
      }
      return b
    },
  }
  return db
}

const writes = (db: any, table?: string) =>
  db.log.filter((o: Op) => o.op !== "select" && (!table || o.table === table))

const PARENT = {
  id: "parent-shop",
  user_id: "owner-1",
  shop_name: "Kofi Data Hub",
  shop_slug: "kofi",
  tier_level: 1,
  is_active: true,
  is_blocked: false,
  parent_shop_id: null,
}
const SETTINGS = { key: null, sub_agent_open_join_enabled: true }
const MIN = 60 * 1000

function anonClient(result: { data?: any; error?: any } = {}) {
  const signUp = vi.fn(async (_args: any) => ({
    data: result.data ?? { user: { id: "new-user", identities: [{ id: "i1" }], created_at: new Date().toISOString() }, session: null },
    error: result.error ?? null,
  }))
  return { auth: { signUp }, signUp }
}

const newJoiner = (over: Partial<Record<string, string>> = {}) => ({
  parentShopId: PARENT.id,
  firstName: "Ama",
  lastName: "Mensah",
  email: "ama@example.com",
  phone: "0241234567",
  password: "s3cret-pass",
  shopName: "Ama Data",
  origin: "https://datagod.store",
  ...over,
})

beforeEach(() => {
  notifyOwnerOfRecruit.mockClear()
  provisionShopCode.mockClear()
})

// ---------------------------------------------------------------------------

describe("normalizePhone", () => {
  it("treats 0241234567 and 241234567 as one number (Review Focus 3)", () => {
    expect(normalizePhone("0241234567")).toBe("0241234567")
    expect(normalizePhone("241234567")).toBe(normalizePhone("0241234567"))
  })
  it("accepts the +233 form and stray spacing", () => {
    expect(normalizePhone("+233 24 123 4567")).toBe("0241234567")
    expect(normalizePhone("233241234567")).toBe("0241234567")
  })
})

describe("validateRecruitShopName", () => {
  it("accepts ordinary names with basic punctuation", () => {
    expect(validateRecruitShopName("Ama's Data & More")).toBeNull()
    expect(validateRecruitShopName("St. Mary-Ann Shop")).toBeNull()
    expect(validateRecruitShopName("Shop 24")).toBeNull()
  })
  it("refuses too short and too long", () => {
    expect(validateRecruitShopName("ab")).toMatch(/3 to 40/)
    expect(validateRecruitShopName("a".repeat(41))).toMatch(/3 to 40/)
  })
  it("refuses URLs and domains", () => {
    expect(validateRecruitShopName("http://evil.example")).toBeTruthy()
    expect(validateRecruitShopName("www dot shop www.x")).toBeTruthy()
    expect(validateRecruitShopName("cheapdata.com")).toBeTruthy()
    expect(validateRecruitShopName("Visit bit.ly now")).toBeTruthy()
  })
  it("refuses runs of 7 or more digits", () => {
    expect(validateRecruitShopName("Call 0241234567")).toBeTruthy()
    expect(validateRecruitShopName("Shop 1234567")).toBeTruthy()
    expect(validateRecruitShopName("Shop 123456")).toBeNull()
  })
  it("refuses other characters", () => {
    expect(validateRecruitShopName("<b>Shop</b>")).toBeTruthy()
    expect(validateRecruitShopName("Shop @ home")).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------

function otpRow(phone: string, over: Row = {}) {
  return { id: "otp-1", phone, purpose: "signup", used: true, created_at: new Date(Date.now() - 5 * MIN).toISOString(), ...over }
}

describe("startJoinIntent (logged out)", () => {
  it("without a phone OTP proof responds 400 and never calls sign-up", async () => {
    const db = memDb({ phone_otp_verifications: [] })
    const anon = anonClient()
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.httpStatus).toBe(400)
    expect(anon.signUp).not.toHaveBeenCalled()
    expect(writes(db)).toHaveLength(0)
  })

  it("an expired, unused or other-purpose proof does not count", async () => {
    for (const row of [
      otpRow("0241234567", { created_at: new Date(Date.now() - 31 * MIN).toISOString() }),
      otpRow("0241234567", { used: false }),
      otpRow("0241234567", { purpose: "withdrawal" }),
    ]) {
      const db = memDb({ phone_otp_verifications: [row] })
      const anon = anonClient()
      const r = await startJoinIntent(db, { ...newJoiner(), anon })
      expect(r.httpStatus).toBe(400)
      expect(anon.signUp).not.toHaveBeenCalled()
    }
  })

  it("queries the proof with purpose=signup, used=true and a 30-minute window", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    await startJoinIntent(db, { ...newJoiner(), anon: anonClient() })
    const q = db.log.find((o: Op) => o.table === "phone_otp_verifications")
    expect(q.filters).toEqual(expect.arrayContaining([["eq", "purpose", "signup"], ["eq", "used", true]]))
    const gte = q.filters.find((f: any) => f[0] === "gte" && f[1] === "created_at")
    const age = Date.now() - new Date(gte[2]).getTime()
    expect(age).toBeGreaterThan(29 * MIN)
    expect(age).toBeLessThan(31 * MIN)
  })

  it("a proof stored in the other phone form still counts", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("241234567")] })
    const anon = anonClient()
    const r = await startJoinIntent(db, { ...newJoiner({ phone: "0241234567" }), anon })
    expect(r).toEqual({ httpStatus: 200, body: { status: "confirm_email" } })
  })

  it("signs up with the anon client, redirect to /auth/callback, then stores the intent server-side", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient()
    const r = await startJoinIntent(db, { ...newJoiner({ phone: "241234567" }), anon })
    expect(r).toEqual({ httpStatus: 200, body: { status: "confirm_email" } })
    const args = anon.signUp.mock.calls[0][0]
    expect(args.email).toBe("ama@example.com")
    const redirect = new URL(args.options.emailRedirectTo)
    expect(redirect.origin + redirect.pathname).toBe("https://datagod.store/auth/callback")
    const nonce = redirect.searchParams.get("join")!
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    // Only the hash is stored.
    expect(JSON.stringify(db.tables.sub_agent_join_intents)).not.toContain(nonce)
    expect(db.tables.sub_agent_join_intents[0].nonce_hash).toBe(sha256(nonce))
    expect(db.tables.sub_agent_join_intents[0].otp_verification_id).toBe("otp-1")
    // Never put phone/role/parent in user_metadata: the intent is the source of truth.
    expect(JSON.stringify(args.options.data ?? {})).not.toMatch(/phone|role|parent|shop/)
    expect(db.tables.sub_agent_join_intents).toEqual([
      expect.objectContaining({
        user_id: "new-user",
        parent_shop_id: PARENT.id,
        shop_name: "Ama Data",
        first_name: "Ama",
        last_name: "Mensah",
        phone: "0241234567",
      }),
    ])
    expect(db.tables.user_shops ?? []).toHaveLength(0)
  })

  it("refuses a phone already registered in either form (Review Focus 3)", async () => {
    for (const [stored, typed] of [["241234567", "0241234567"], ["0241234567", "241234567"]]) {
      const db = memDb({
        phone_otp_verifications: [otpRow(typed)],
        users: [{ id: "someone", role: "user", phone_number: stored }],
      })
      const anon = anonClient()
      const r = await startJoinIntent(db, { ...newJoiner({ phone: typed }), anon })
      expect(r.httpStatus).toBe(409)
      expect(r.body).toEqual({ error: LOGIN_TO_CONTINUE, status: "login_required" })
      expect(anon.signUp).not.toHaveBeenCalled()
      expect(writes(db)).toHaveLength(0)
    }
  })

  it("sign-up returning a user with empty identities (already registered) says log in, no intent", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient({ data: { user: { id: "existing", identities: [] }, session: null } })
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.httpStatus).toBe(409)
    expect(r.body).toEqual({ error: LOGIN_TO_CONTINUE, status: "login_required" })
    expect(db.tables.sub_agent_join_intents ?? []).toHaveLength(0)
  })

  it("a sign-up 'already registered' error also says log in, no intent", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient({ error: { code: "user_already_exists", message: "User already registered", status: 422 } })
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.httpStatus).toBe(409)
    expect(r.body.error).toBe(LOGIN_TO_CONTINUE)
    expect(db.tables.sub_agent_join_intents ?? []).toHaveLength(0)
  })

  it("other sign-up errors do not mention the email", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient({ error: { code: "unexpected_failure", message: "boom", status: 500 } })
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.httpStatus).toBe(400)
    expect(r.body.error).not.toMatch(/ama@example\.com|registered/i)
  })

  it("a double submit keeps one intent and still answers confirm_email (Review Focus 1)", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient()
    const a = await startJoinIntent(db, { ...newJoiner(), anon })
    const b = await startJoinIntent(db, { ...newJoiner({ shopName: "Other Name" }), anon })
    expect(a.body).toEqual({ status: "confirm_email" })
    expect(b.body).toEqual({ status: "confirm_email" })
    expect(db.tables.sub_agent_join_intents).toHaveLength(1)
    expect(db.tables.sub_agent_join_intents[0].shop_name).toBe("Ama Data")
    // The latest confirmation email carries the nonce that now matches.
    const latest = new URL(anon.signUp.mock.calls[1][0].options.emailRedirectTo).searchParams.get("join")!
    expect(db.tables.sub_agent_join_intents[0].nonce_hash).toBe(sha256(latest))
  })

  it("one OTP proof cannot back a second intent for another account", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    await startJoinIntent(db, { ...newJoiner(), anon: anonClient() })
    const other = anonClient({ data: { user: { id: "second-user", identities: [{ id: "i" }], created_at: new Date().toISOString() }, session: null } })
    const r = await startJoinIntent(db, { ...newJoiner({ email: "kofi@example.com" }), anon: other })
    expect(r.httpStatus).toBe(400)
    expect(r.body.error).toMatch(/verify your phone/i)
    expect(db.tables.sub_agent_join_intents).toHaveLength(1)
    expect(db.tables.sub_agent_join_intents[0].user_id).toBe("new-user")
  })

  it("a missing or unparseable created_at counts as not fresh", async () => {
    for (const created_at of [undefined, "not-a-date"]) {
      const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
      const anon = anonClient({ data: { user: { id: "victim", identities: [{ id: "i" }], created_at }, session: null } })
      const r = await startJoinIntent(db, { ...newJoiner(), anon })
      expect(r.httpStatus).toBe(409)
      expect(db.tables.sub_agent_join_intents ?? []).toHaveLength(0)
    }
  })

  it("non-string fields get 400 without sign-up", async () => {
    for (const field of ["firstName", "lastName", "email", "phone", "password", "shopName"]) {
      const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
      const anon = anonClient()
      const r = await startJoinIntent(db, { ...newJoiner(), [field]: { toString: () => "Ama Data" }, anon } as any)
      expect(r.httpStatus, field).toBe(400)
      expect(anon.signUp).not.toHaveBeenCalled()
    }
  })

  it("never attaches an intent to an older unconfirmed account someone else created", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const old = new Date(Date.now() - 60 * MIN).toISOString()
    const anon = anonClient({ data: { user: { id: "victim", identities: [{ id: "i" }], created_at: old }, session: null } })
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.httpStatus).toBe(409)
    expect(r.body.error).toBe(LOGIN_TO_CONTINUE)
    expect(db.tables.sub_agent_join_intents ?? []).toHaveLength(0)
  })

  it("an older account that already has its own intent (resubmit later) still gets confirm_email", async () => {
    const db = memDb({
      phone_otp_verifications: [otpRow("0241234567")],
      sub_agent_join_intents: [{ user_id: "new-user", parent_shop_id: PARENT.id, shop_name: "Ama Data", phone: "0241234567", consumed_at: null }],
    })
    const old = new Date(Date.now() - 60 * MIN).toISOString()
    const anon = anonClient({ data: { user: { id: "new-user", identities: [{ id: "i" }], created_at: old }, session: null } })
    const r = await startJoinIntent(db, { ...newJoiner(), anon })
    expect(r.body).toEqual({ status: "confirm_email" })
    expect(db.tables.sub_agent_join_intents).toHaveLength(1)
  })

  it("refuses an invalid shop name before anything else", async () => {
    const db = memDb({ phone_otp_verifications: [otpRow("0241234567")] })
    const anon = anonClient()
    const r = await startJoinIntent(db, { ...newJoiner({ shopName: "cheapdata.com" }), anon })
    expect(r.httpStatus).toBe(400)
    expect(anon.signUp).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

function intentRow(over: Row = {}) {
  return {
    user_id: "new-user",
    parent_shop_id: PARENT.id,
    shop_name: "Ama Data",
    first_name: "Ama",
    last_name: "Mensah",
    phone: "0241234567",
    nonce_hash: sha256(NONCE),
    created_at: new Date().toISOString(),
    consumed_at: null,
    ...over,
  }
}

const NONCE = "good-nonce-from-the-confirmation-link"
/** What /auth/confirm (type signup) passes for a genuine join confirmation. */
const OK = { email: "ama@example.com", nonce: NONCE, identities: ["email"] }

function finalizeDb(over: { parent?: Row; settings?: Row; users?: Row[]; intent?: Row | null } = {}) {
  return memDb({
    app_settings: [over.settings ?? SETTINGS],
    user_shops: [{ ...PARENT, ...(over.parent ?? {}) }],
    sub_agent_join_intents: over.intent === null ? [] : [intentRow(over.intent ?? {})],
    // handle_new_user trigger row: role user, no phone
    users: over.users ?? [{ id: "new-user", email: "ama@example.com", role: "user", phone_number: null }],
    wallets: [],
  })
}

const recruitShops = (db: any) => db.tables.user_shops.filter((s: Row) => s.user_id === "new-user")

describe("finalizeJoinIntent", () => {
  it("returns null when there is no intent", async () => {
    const db = finalizeDb({ intent: null })
    expect(await finalizeJoinIntent(db, "new-user", OK)).toBeNull()
    expect(writes(db)).toHaveLength(0)
  })

  it("returns null (normal signup continues) when the intents table cannot be read", async () => {
    const db = memDb({}, { fail: (o) => (o.table === "sub_agent_join_intents" ? { code: "42P01", message: "missing" } : null) })
    expect(await finalizeJoinIntent(db, "new-user", OK)).toBeNull()
  })

  it("no nonce, wrong nonce, expired intent or a non-email identity: null, nothing written", async () => {
    const cases: [string, any, Row?][] = [
      ["no nonce (e.g. OAuth callback, magic link)", { email: OK.email, identities: ["email"] }],
      ["empty nonce", { ...OK, nonce: "" }],
      ["wrong nonce", { ...OK, nonce: "attacker-guess" }],
      ["extra google identity", { ...OK, identities: ["email", "google"] }],
      ["identities unknown", { email: OK.email, nonce: NONCE }],
      ["expired intent", OK, { created_at: new Date(Date.now() - 25 * 60 * MIN).toISOString() }],
    ]
    for (const [label, opts, intentOver] of cases) {
      const db = finalizeDb({ intent: intentOver ?? {} })
      expect(await finalizeJoinIntent(db, "new-user", opts), label).toBeNull()
      expect(writes(db), label).toHaveLength(0)
      expect(recruitShops(db), label).toHaveLength(0)
    }
    expect(provisionShopCode).not.toHaveBeenCalled()
    expect(notifyOwnerOfRecruit).not.toHaveBeenCalled()
  })

  it("end to end: the nonce from the sign-up's redirect finalizes the join", async () => {
    const db = memDb({
      phone_otp_verifications: [otpRow("0241234567")],
      app_settings: [SETTINGS],
      user_shops: [{ ...PARENT }],
      users: [{ id: "new-user", email: "ama@example.com", role: "user", phone_number: null }],
      wallets: [],
    })
    const anon = anonClient()
    await startJoinIntent(db, { ...newJoiner(), anon })
    const nonce = new URL(anon.signUp.mock.calls[0][0].options.emailRedirectTo).searchParams.get("join")!
    expect(await finalizeJoinIntent(db, "new-user", { ...OK, nonce: "x" + nonce })).toBeNull()
    expect(await finalizeJoinIntent(db, "new-user", { ...OK, nonce })).toEqual({ target: JOIN_SETUP_TARGET })
    expect(recruitShops(db)).toHaveLength(1)
  })

  it("an intent consumed over an hour ago no longer takes over redirects", async () => {
    const db = finalizeDb({ intent: { consumed_at: new Date(Date.now() - 61 * MIN).toISOString() } })
    db.tables.user_shops.push({ id: "s", user_id: "new-user", shop_slug: "s", joined_via: "storefront", parent_shop_id: PARENT.id })
    expect(await finalizeJoinIntent(db, "new-user", OK)).toBeNull()
    const recent = finalizeDb({ intent: { consumed_at: new Date(Date.now() - 5 * MIN).toISOString() } })
    recent.tables.user_shops.push({ id: "s", user_id: "new-user", shop_slug: "s", joined_via: "storefront", parent_shop_id: PARENT.id })
    expect(await finalizeJoinIntent(recent, "new-user", OK)).toEqual({ target: JOIN_SETUP_TARGET })
  })

  it("creates the shop, code and alert once; a second finalize returns the same target (Review Focus 1)", async () => {
    const db = finalizeDb()
    const first = await finalizeJoinIntent(db, "new-user", OK)
    const second = await finalizeJoinIntent(db, "new-user", OK)
    expect(first).toEqual({ target: JOIN_SETUP_TARGET })
    expect(second).toEqual({ target: JOIN_SETUP_TARGET })
    expect(recruitShops(db)).toHaveLength(1)
    expect(provisionShopCode).toHaveBeenCalledTimes(1)
    expect(notifyOwnerOfRecruit).toHaveBeenCalledTimes(1)
    expect(notifyOwnerOfRecruit).toHaveBeenCalledWith(db, PARENT.id, "Ama Data")

    const shop = recruitShops(db)[0]
    expect(shop).toMatchObject({
      parent_shop_id: PARENT.id,
      tier_level: 2,
      is_active: false,
      joined_via: "storefront",
      dealer_rates_enabled: false,
      shop_name: "Ama Data",
    })
    const user = db.tables.users.find((u: Row) => u.id === "new-user")
    expect(user).toMatchObject({ role: "sub_agent", first_name: "Ama", last_name: "Mensah", phone_number: "0241234567", phone_verified: true })
    expect(db.tables.wallets).toHaveLength(1)
    expect(db.tables.sub_agent_join_intents[0].consumed_at).toBeTruthy()
    expect(db.authUpdates).toEqual([{ id: "new-user", attrs: { user_metadata: { role: "sub_agent" } } }])
  })

  it("writes the users row as sub_agent when no trigger row exists", async () => {
    const db = finalizeDb({ users: [] })
    const r = await finalizeJoinIntent(db, "new-user", OK)
    expect(r).toEqual({ target: JOIN_SETUP_TARGET })
    expect(db.tables.users).toEqual([
      expect.objectContaining({ id: "new-user", email: "ama@example.com", role: "sub_agent", phone_number: "0241234567" }),
    ])
  })

  it("target blocked before confirmation: no shop, intent consumed, account stays user (Review Focus 2)", async () => {
    const db = finalizeDb({ parent: { is_blocked: true } })
    const r = await finalizeJoinIntent(db, "new-user", OK)
    expect(r).toEqual({ target: JOIN_CLOSED_TARGET })
    expect(recruitShops(db)).toHaveLength(0)
    expect(db.tables.sub_agent_join_intents[0].consumed_at).toBeTruthy()
    expect(db.tables.users.find((u: Row) => u.id === "new-user").role).toBe("user")
    expect(provisionShopCode).not.toHaveBeenCalled()
    expect(notifyOwnerOfRecruit).not.toHaveBeenCalled()
    expect(db.authUpdates).toHaveLength(0)
    // Second click: same closed target, still nothing created.
    expect(await finalizeJoinIntent(db, "new-user", OK)).toEqual({ target: JOIN_CLOSED_TARGET })
    expect(recruitShops(db)).toHaveLength(0)
  })

  it("target inactive or open join switched off: closed", async () => {
    for (const db of [finalizeDb({ parent: { is_active: false } }), finalizeDb({ settings: { key: null, sub_agent_open_join_enabled: false } })]) {
      expect(await finalizeJoinIntent(db, "new-user", OK)).toEqual({ target: JOIN_CLOSED_TARGET })
      expect(recruitShops(db)).toHaveLength(0)
      expect(db.tables.users.find((u: Row) => u.id === "new-user").role).toBe("user")
    }
  })

  it("phone taken by another account in the meantime: no shop, phone not copied", async () => {
    const db = finalizeDb({
      users: [
        { id: "new-user", email: "ama@example.com", role: "user", phone_number: null },
        { id: "other", role: "user", phone_number: "241234567" },
      ],
    })
    expect(await finalizeJoinIntent(db, "new-user", OK)).toEqual({ target: JOIN_CLOSED_TARGET })
    expect(recruitShops(db)).toHaveLength(0)
    const u = db.tables.users.find((x: Row) => x.id === "new-user")
    expect(u.role).toBe("user")
    expect(u.phone_number).toBeNull()
  })

  it("releases the claim when a write fails, so a retry can finish", async () => {
    let failWallet = true
    const base = finalizeDb()
    const db = memDb(base.tables, {
      fail: (o) => (o.table === "wallets" && o.op === "insert" && failWallet ? { code: "XX000", message: "boom" } : null),
    })
    await expect(finalizeJoinIntent(db, "new-user", OK)).rejects.toBeTruthy()
    expect(db.tables.sub_agent_join_intents[0].consumed_at).toBeNull()
    failWallet = false
    expect(await finalizeJoinIntent(db, "new-user", OK)).toEqual({ target: JOIN_SETUP_TARGET })
    expect(recruitShops(db)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

function upgradeDb(user: Row, extra: { shops?: Row[]; fail?: (o: Op) => any } = {}) {
  return memDb(
    {
      users: [user],
      user_shops: [{ ...PARENT }, ...(extra.shops ?? [])],
      wallets: [{ id: "w1", user_id: user.id, balance: 55.5, total_credited: 100, total_spent: 44.5 }],
    },
    { fail: extra.fail }
  )
}

describe("joinExistingUser (logged in)", () => {
  for (const role of ["dealer", "admin"]) {
    it(`a ${role} gets 403 with no writes`, async () => {
      const db = upgradeDb({ id: "u1", role })
      const r = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
      expect(r.httpStatus).toBe(403)
      expect(writes(db)).toHaveLength(0)
      expect(db.authUpdates).toHaveLength(0)
    })
  }

  it("a shop owner gets 403 with no writes", async () => {
    const db = upgradeDb({ id: "u1", role: "user" }, { shops: [{ id: "own", user_id: "u1", shop_slug: "own", parent_shop_id: null, joined_via: null }] })
    const r = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    expect(r.httpStatus).toBe(403)
    expect(writes(db)).toHaveLength(0)
  })

  it("a user becomes sub_agent with dealer rates off; wallet untouched; no phone code needed", async () => {
    const db = upgradeDb({ id: "u1", role: "user", phone_number: "0201111111" })
    const walletBefore = JSON.stringify(db.tables.wallets)
    const r = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    expect(r).toEqual({ httpStatus: 200, body: { status: "joined", target: JOIN_SETUP_TARGET } })
    expect(db.tables.users[0].role).toBe("sub_agent")
    const shop = db.tables.user_shops.find((s: Row) => s.user_id === "u1")
    expect(shop).toMatchObject({ dealer_rates_enabled: false, joined_via: "storefront", is_active: false, parent_shop_id: PARENT.id })
    expect(JSON.stringify(db.tables.wallets)).toBe(walletBefore)
    expect(writes(db, "wallets")).toHaveLength(0)
    expect(db.log.some((o: Op) => o.table === "phone_otp_verifications")).toBe(false)
    expect(db.authUpdates).toEqual([{ id: "u1", attrs: { user_metadata: { role: "sub_agent" } } }])
    expect(provisionShopCode).toHaveBeenCalledTimes(1)
    expect(notifyOwnerOfRecruit).toHaveBeenCalledTimes(1)
  })

  it("the role update is conditional on role='user'", async () => {
    const db = upgradeDb({ id: "u1", role: "user" })
    await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    const upd = db.log.find((o: Op) => o.table === "users" && o.op === "update")
    expect(upd.payload.role).toBe("sub_agent")
    expect(upd.filters).toEqual(expect.arrayContaining([["eq", "id", "u1"], ["eq", "role", "user"]]))
  })

  it("if the role update fails, the just-created shop is deleted", async () => {
    const db = upgradeDb({ id: "u1", role: "user" }, {
      fail: (o) => (o.table === "users" && o.op === "update" ? { code: "XX000", message: "boom" } : null),
    })
    const r = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    expect(r.httpStatus).toBeGreaterThanOrEqual(400)
    expect(db.tables.user_shops.find((s: Row) => s.user_id === "u1")).toBeUndefined()
    expect(provisionShopCode).not.toHaveBeenCalled()
    expect(notifyOwnerOfRecruit).not.toHaveBeenCalled()
    expect(db.authUpdates).toHaveLength(0)
  })

  it("if the role changed underneath (update matches no row), the shop is deleted too", async () => {
    const db = upgradeDb({ id: "u1", role: "user" })
    const realFrom = db.from.bind(db)
    // Simulate an admin promoting the user to dealer between our read and the conditional update.
    let reads = 0
    db.from = (t: string) => {
      const b = realFrom(t)
      if (t === "users") {
        const realUpdate = b.update
        b.update = (p: any) => { db.tables.users[0].role = "dealer"; return realUpdate(p) }
        reads++
      }
      return b
    }
    const r = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    expect(reads).toBeGreaterThan(0)
    expect(r.httpStatus).toBeGreaterThanOrEqual(400)
    expect(db.tables.users[0].role).toBe("dealer")
    expect(db.tables.user_shops.find((s: Row) => s.user_id === "u1")).toBeUndefined()
  })

  it("a double submit by the same user returns joined once more without a second shop, code or alert", async () => {
    const db = upgradeDb({ id: "u1", role: "user" })
    await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    const again = await joinExistingUser(db, { userId: "u1", parent: PARENT, shopName: "My Shop" })
    expect(again).toEqual({ httpStatus: 200, body: { status: "joined", target: JOIN_SETUP_TARGET } })
    expect(db.tables.user_shops.filter((s: Row) => s.user_id === "u1")).toHaveLength(1)
    expect(provisionShopCode).toHaveBeenCalledTimes(1)
    expect(notifyOwnerOfRecruit).toHaveBeenCalledTimes(1)
  })
})
