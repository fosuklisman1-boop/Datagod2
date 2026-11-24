import { describe, it, expect } from "vitest"
import { createControls, CONTROLS_TTL_MS, CONTROLS_STALE_LIMIT_MS, PAUSED_USERS_CAP } from "./controls"

type Res = { data: unknown; error: unknown }
type Src = Res | (() => Res | Promise<Res>)
interface Opts {
  pauses?: Src
  services?: Src
}

function fake(opts: Opts) {
  const calls: string[] = []
  const client = {
    from(table: string) {
      calls.push(table)
      const src = table === "api_v2_developer_pauses" ? opts.pauses : opts.services
      const run = async (): Promise<Res> => {
        if (typeof src === "function") return src()
        return src ?? { data: [], error: null }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        limit: () => chain,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (a: any, b: any) => run().then(a, b),
      }
      return chain
    },
  }
  return { client, calls }
}

const okPauses = (ids: string[]): Res => ({ data: ids.map((user_id) => ({ user_id })), error: null })
const okServices = (rows: { service: string; paused: boolean; message: string | null }[]): Res => ({
  data: rows,
  error: null,
})

function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe("controls", () => {
  it("second read inside the TTL makes zero client calls (count them); after TTL one refresh = exactly 2 queries", async () => {
    const { client, calls } = fake({
      pauses: okPauses(["u1"]),
      services: okServices([
        { service: "data", paused: true, message: "msg" },
        { service: "sms", paused: false, message: null },
      ]),
    })
    const c = clock()
    const ctl = createControls({ client, now: c.now })
    const a = await ctl.read()
    expect(calls.length).toBe(2)
    if (a === "error") throw new Error("unexpected")
    expect(a.pausedUsers.has("u1")).toBe(true)
    expect(a.services.get("data")).toEqual({ message: "msg" })
    expect(a.services.has("sms")).toBe(false)
    c.advance(CONTROLS_TTL_MS - 1)
    await ctl.read()
    expect(calls.length).toBe(2)
    c.advance(2)
    await ctl.read()
    expect(calls.length).toBe(4)
  })

  it("50 concurrent reads at expiry share one refresh (single flight)", async () => {
    const { client, calls } = fake({})
    const c = clock()
    const ctl = createControls({ client, now: c.now })
    await ctl.read()
    c.advance(CONTROLS_TTL_MS + 1)
    const before = calls.length
    const results = await Promise.all(Array.from({ length: 50 }, () => ctl.read()))
    expect(calls.length - before).toBe(2)
    expect(new Set(results).size).toBe(1)
  })

  const missing = [
    { code: "42P01", message: "x" },
    { code: "PGRST205", message: "x" },
    { message: "Could not find the table 'public.api_v2_developer_pauses' in the schema cache" },
    { message: 'relation "api_v2_developer_pauses" does not exist' },
  ]

  // Review R4-T3 minor 1: wording alone must not fail open (a column error would release every pause).
  const notMissing = [
    { code: "42703", message: 'column api_v2_developer_pauses.user_idx does not exist' },
    { message: 'column "user_idx" does not exist' },
    { message: "Could not find a relationship between 'a' and 'b' in the schema cache" },
  ]
  for (const err of notMissing) {
    it(`controls: a non-table error with "does not exist"/"schema cache" wording (${JSON.stringify(err)}) -> "error", not an empty snapshot`, async () => {
      const { client } = fake({ pauses: { data: null, error: err } })
      expect(await createControls({ client, now: clock().now }).read()).toBe("error")
    })
  }

  it("controls: only one table missing -> that table reads as empty, the other table's pauses are kept", async () => {
    const { client } = fake({
      pauses: { data: null, error: { code: "42P01", message: "x" } },
      services: okServices([{ service: "data", paused: true, message: "m" }]),
    })
    const s = await createControls({ client, now: clock().now }).read()
    if (s === "error") throw new Error("unexpected")
    expect(s.pausedUsers.size).toBe(0)
    expect(s.services.get("data")).toEqual({ message: "m" })

    const { client: c2 } = fake({
      pauses: okPauses(["u1"]),
      services: { data: null, error: { code: "PGRST205", message: "x" } },
    })
    const s2 = await createControls({ client: c2, now: clock().now }).read()
    if (s2 === "error") throw new Error("unexpected")
    expect(s2.pausedUsers.has("u1")).toBe(true)
    expect(s2.services.size).toBe(0)
  })
  for (const err of missing) {
    it(`controls: table-missing errors (${JSON.stringify(err)}) -> empty snapshot, cached for the TTL, NOT "error"`, async () => {
      const { client, calls } = fake({ pauses: { data: null, error: err } })
      const ctl = createControls({ client, now: clock().now })
      const s = await ctl.read()
      expect(s).not.toBe("error")
      if (s === "error") return
      expect(s.pausedUsers.size).toBe(0)
      expect(s.services.size).toBe(0)
      const n = calls.length
      await ctl.read()
      expect(calls.length).toBe(n)
    })
  }

  it('controls: other read error + snapshot younger than 5 min -> returns the old snapshot; + older than 5 min or none -> "error"', async () => {
    let fail = false
    const { client } = fake({
      pauses: () => (fail ? { data: null, error: { code: "57014", message: "timeout" } } : okPauses(["u9"])),
    })
    const c = clock()
    const ctl = createControls({ client, now: c.now })
    const first = await ctl.read()
    fail = true
    c.advance(CONTROLS_TTL_MS + 1)
    expect(await ctl.read()).toBe(first)
    c.advance(CONTROLS_STALE_LIMIT_MS)
    expect(await ctl.read()).toBe("error")

    const { client: c2 } = fake({ pauses: { data: null, error: { code: "57014", message: "timeout" } } })
    expect(await createControls({ client: c2, now: clock().now }).read()).toBe("error")
  })

  it("controls: 5001 paused rows -> treated as an error (no truncated set returned)", async () => {
    const { client } = fake({ pauses: okPauses(Array.from({ length: PAUSED_USERS_CAP + 1 }, (_, i) => `u${i}`)) })
    expect(await createControls({ client, now: clock().now }).read()).toBe("error")
    const { client: ok } = fake({ pauses: okPauses(Array.from({ length: PAUSED_USERS_CAP }, (_, i) => `u${i}`)) })
    expect(await createControls({ client: ok, now: clock().now }).read()).not.toBe("error")
  })

  it("controls: a thrown client call is the same as an error; never throws", async () => {
    const client = {
      from() {
        throw new Error("boom")
      },
    }
    await expect(createControls({ client, now: clock().now }).read()).resolves.toBe("error")
    const { client: rej } = fake({
      services: () => {
        throw new Error("boom")
      },
    })
    await expect(createControls({ client: rej, now: clock().now }).read()).resolves.toBe("error")
  })

  it("controls: invalidate() makes the next read refresh", async () => {
    const { client, calls } = fake({})
    const ctl = createControls({ client, now: clock().now })
    await ctl.read()
    ctl.invalidate()
    await ctl.read()
    expect(calls.length).toBe(4)
  })
})
