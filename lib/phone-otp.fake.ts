// Test-only stand-in for the phone_otp_verifications table + bump_otp_attempts() RPC (migrations 0051/0052 and
// otp_verify_attempts_fallback.sql). Used by the /api/auth/*-phone-otp route tests, lib/phone-otp tests and the bot
// payer-verify tests. Not imported by production code.

export interface OtpRow {
  id: string; phone: string; code: string; purpose: string; used: boolean; attempts: number; expires_at: string; created_at: string
}

export interface FakeOtpDbOptions {
  /** `now()` for the DB side (created_at default, bump_otp_attempts). */
  now: () => number
  countError?: boolean
  insertError?: boolean
  selectError?: boolean
  /** "error" => the RPC answers { error }; "throw" => the call throws. */
  rpc?: "ok" | "error" | "throw"
  /** Override the RPC's returned max (e.g. a non-number). */
  rpcValue?: unknown
}

type Filter = [op: "eq" | "gte" | "in", col: string, val: unknown]

export function fakeOtpDb(rows: OtpRow[], opts: FakeOtpDbOptions) {
  let seq = rows.length
  const calls: { op: string; filters: Filter[]; payload?: unknown; select?: unknown }[] = []
  const rpcCalls: { fn: string; args: unknown }[] = []
  const match = (r: OtpRow, fs: Filter[]) => fs.every(([op, c, v]) => {
    const x = (r as unknown as Record<string, unknown>)[c]
    if (op === "eq") return x === v
    if (op === "in") return (v as unknown[]).includes(x)
    return String(x) >= String(v)
  })
  const client = {
    from(table: string) {
      if (table !== "phone_otp_verifications") throw new Error(`unexpected table ${table}`)
      let op: "select" | "insert" | "update" = "select"
      let payload: unknown
      let selectArgs: unknown[] = []
      let limitN: number | null = null
      let orderBy: { c: string; asc: boolean } | null = null
      const filters: Filter[] = []
      const run = () => {
        calls.push({ op, filters: [...filters], payload, select: selectArgs })
        if (op === "insert") {
          if (opts.insertError) return { data: null, error: { message: "insert failed" } }
          const p = payload as Partial<OtpRow>
          rows.push({
            id: `otp${++seq}`, used: false, attempts: 0, purpose: "signup", created_at: new Date(opts.now()).toISOString(),
            ...p,
          } as OtpRow)
          return { data: null, error: null }
        }
        if (op === "update") {
          const hit = rows.filter(r => match(r, filters))
          hit.forEach(r => Object.assign(r, payload))
          return { data: null, error: null }
        }
        const head = (selectArgs[1] as { head?: boolean } | undefined)?.head
        if (head) {
          if (opts.countError) return { data: null, count: null, error: { message: "count failed" } }
          return { data: null, count: rows.filter(r => match(r, filters)).length, error: null }
        }
        if (opts.selectError) return { data: null, error: { message: "select failed" } }
        let out = rows.filter(r => match(r, filters)).map(r => ({ ...r }))
        if (orderBy) {
          const { c, asc } = orderBy
          out.sort((a, b) => {
            const x = String((a as unknown as Record<string, unknown>)[c]); const y = String((b as unknown as Record<string, unknown>)[c])
            return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1)
          })
        }
        if (limitN !== null) out = out.slice(0, limitN)
        return { data: out, error: null }
      }
      const b: Record<string, unknown> = {
        select: (...a: unknown[]) => { selectArgs = a; return b },
        insert: (p: unknown) => { op = "insert"; payload = p; return b },
        update: (p: unknown) => { op = "update"; payload = p; return b },
        eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return b },
        in: (c: string, v: unknown[]) => { filters.push(["in", c, v]); return b },
        gte: (c: string, v: unknown) => { filters.push(["gte", c, v]); return b },
        order: (c: string, o?: { ascending?: boolean }) => { orderBy = { c, asc: o?.ascending !== false }; return b },
        limit: (n: number) => { limitN = n; return b },
        maybeSingle: async () => {
          const r = run() as { data: unknown; error: unknown }
          return { data: (r.data as unknown[] | null)?.[0] ?? null, error: r.error }
        },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
    async rpc(fn: string, args: { p_phone: string }) {
      rpcCalls.push({ fn, args })
      if (fn !== "bump_otp_attempts") throw new Error(`unexpected rpc ${fn}`)
      if (opts.rpc === "throw") throw new Error("rpc down")
      if (opts.rpc === "error") return { data: null, error: { message: "function does not exist" } }
      const nowIso = new Date(opts.now()).toISOString()
      const live = rows.filter(r => r.phone === args.p_phone && !r.used && r.expires_at > nowIso)
      live.forEach(r => { r.attempts += 1 })
      const max = live.reduce((m, r) => Math.max(m, r.attempts), 0)
      return { data: opts.rpcValue !== undefined ? opts.rpcValue : max, error: null }
    },
  }
  return { client, rows, calls, rpcCalls }
}

/** A stored code row. */
export function otpRow(o: Partial<OtpRow> & { phone: string; code: string }, now: number): OtpRow {
  return {
    id: `seed-${o.code}-${o.phone}-${Math.random().toString(36).slice(2, 7)}`, purpose: "signup", used: false, attempts: 0,
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(), created_at: new Date(now - 60 * 1000).toISOString(), ...o,
  }
}
