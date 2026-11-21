import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, any>

const h = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, authUser: "" }))

function makeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: h.authUser } }, error: null }) },
    from(table: string) {
      if (!h.tables[table]) h.tables[table] = []
      const rows = h.tables[table]
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" | "delete" = "select"
      let patch: Row = {}
      const run = () => {
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        if (op === "delete") for (const m of matched) rows.splice(rows.indexOf(m), 1)
        return { data: matched.map((r) => ({ ...r })), error: null as any }
      }
      const b: any = {
        update(p: Row) { op = "update"; patch = p; return b },
        delete() { op = "delete"; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        single() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: x.data.length ? null : { message: "no row" } }) },
        maybeSingle() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeDb() }))

import { PATCH, DELETE } from "./route"

const USER = "11111111-1111-4111-8111-111111111111"
const call = (body: unknown) =>
  PATCH({ headers: new Headers({ authorization: "Bearer tok" }), json: async () => body } as any, { params: Promise.resolve({ id: "t1" }) })

beforeEach(() => {
  h.authUser = USER
  h.tables = {
    users: [{ id: USER, role: "user" }],
    ai_scheduled_tasks: [
      {
        id: "t1", user_id: USER, name: "Data order", prompt: "Standing data order (runs without AI)", context: "dashboard",
        schedule_type: "daily", run_at_time: "08:00", run_on_days: null, run_at_timestamp: null, is_active: true,
        standing_order: { package_id: "p", recipient: "0241234567", max_price_ghs: 5 },
      },
      { id: "t2", user_id: USER, name: "Plain", prompt: "hi", context: "dashboard", schedule_type: "daily", is_active: true, standing_order: null },
    ],
  }
})

describe("scheduled-tasks PATCH on a standing order", () => {
  it("patch_refuses_schedule_edit_on_standing_task", async () => {
    for (const body of [
      { schedule_type: "hourly" }, { run_at_time: "09:00" }, { run_on_days: [1] }, { run_at_timestamp: "2026-12-01T00:00:00Z" },
      { prompt: "buy something else" }, { context: "admin" }, { name: "x" },
      { is_active: false, prompt: "sneaky" },
    ]) {
      const res = await call(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toEqual({ error: "Scheduled orders can't be edited. Pause or delete it and confirm a new card." })
    }
    const t = h.tables.ai_scheduled_tasks[0]
    expect(t).toMatchObject({ schedule_type: "daily", run_at_time: "08:00", prompt: "Standing data order (runs without AI)", is_active: true })
  })

  it("patch_allows_pause_on_standing_task", async () => {
    const res = await call({ is_active: false })
    expect(res.status).toBe(200)
    expect(h.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    const res2 = await call({ is_active: true })
    expect(res2.status).toBe(200)
  })

  it("non-standing tasks keep editing as before", async () => {
    const res = await PATCH({ headers: new Headers({ authorization: "Bearer tok" }), json: async () => ({ name: "Renamed" }) } as any, { params: Promise.resolve({ id: "t2" }) })
    expect(res.status).toBe(200)
    expect(h.tables.ai_scheduled_tasks[1].name).toBe("Renamed")
  })

  it("delete still works on a standing task", async () => {
    const res = await DELETE({ headers: new Headers({ authorization: "Bearer tok" }) } as any, { params: Promise.resolve({ id: "t1" }) })
    expect(res.status).toBe(200)
    expect(h.tables.ai_scheduled_tasks.find((t) => t.id === "t1")).toBeUndefined()
  })
})
