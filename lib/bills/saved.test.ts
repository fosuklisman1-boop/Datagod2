import { describe, it, expect } from "vitest"
import { MAX_SAVED_PER_USER, parseSavedInput, saveAccount, deleteSaved } from "./saved"

describe("parseSavedInput", () => {
  it("ECG: meter + phone (normalised to 0XXXXXXXXX), optional prepaid/postpaid and nickname", () => {
    const r = parseSavedInput({ biller: "ecg", account: " 0123 4567 ", phone: "+233244123456", meterType: "prepaid", nickname: " Home ", customerName: "AMA MENSAH" })
    expect(r).toEqual({ ok: true, value: {
      biller: "ecg", account: "01234567", phone: "0244123456", email: null, broadband_account: null, meter_type: "prepaid", nickname: "Home", customer_name: "AMA MENSAH",
    } })
  })
  it("requires what each biller needs to verify again", () => {
    expect(parseSavedInput({ biller: "ecg", account: "01234567" })).toMatchObject({ ok: false, error: "Enter a valid phone number" })
    expect(parseSavedInput({ biller: "ghana_water", account: "01234567", phone: "0244123456" })).toMatchObject({ ok: false, error: "Enter a valid email" })
    expect(parseSavedInput({ biller: "telecel_broadband", account: "0302450262" })).toMatchObject({ ok: false })
    expect(parseSavedInput({ biller: "dstv", account: "12" })).toMatchObject({ ok: false })
    expect(parseSavedInput({ biller: "netflix", account: "12345" })).toMatchObject({ ok: false, error: "Unknown biller" })
    expect(parseSavedInput(null)).toMatchObject({ ok: false })
  })
  it("TV: just the smartcard number; phone/email ignored", () => {
    expect(parseSavedInput({ biller: "dstv", account: "7012345678", phone: "0244123456", email: "a@b.co" }))
      .toMatchObject({ ok: true, value: { biller: "dstv", account: "7012345678", phone: null, email: null, meter_type: null } })
  })
})

/** Tiny PostgREST stand-in over an in-memory table. */
function fakeDb(rows: any[] = []) {
  const table = rows
  const db = {
    from() {
      const filters: Array<[string, unknown]> = []
      let op: "select" | "update" | "insert" | "delete" = "select"
      let payload: any = null
      let head = false
      const match = (r: any) => filters.every(([k, v]) => r[k] === v)
      const q: any = {
        select: (_c?: string, o?: { head?: boolean }) => { head = !!o?.head; return q },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q },
        order: () => q, limit: () => q,
        update: (p: any) => { op = "update"; payload = p; return q },
        insert: (p: any) => { op = "insert"; payload = p; return q },
        delete: () => { op = "delete"; return q },
        maybeSingle: async () => ({ data: table.find(match) ?? null, error: null }),
        single: async () => {
          if (op === "insert") { const r = { id: `id-${table.length + 1}`, created_at: "t", ...payload }; table.push(r); return { data: r, error: null } }
          const r = table.find(match); Object.assign(r, payload); return { data: r, error: null }
        },
        then: (res: any) => {
          if (op === "delete") { const gone = table.filter(match); gone.forEach(g => table.splice(table.indexOf(g), 1)); return res({ data: gone, error: null }) }
          if (head) return res({ count: table.filter(match).length, error: null })
          return res({ data: table.filter(match), error: null })
        },
      }
      return q
    },
  }
  return { db: db as any, table }
}

const ecg = { biller: "ecg" as const, account: "01234567", phone: "0244123456", email: null, broadband_account: null, meter_type: null, nickname: "Home", customer_name: "AMA" }

describe("saveAccount", () => {
  it("adds a new entry, then refreshes it instead of duplicating, keeping the old nickname", async () => {
    const { db, table } = fakeDb()
    const a = await saveAccount(db, "u1", ecg)
    expect(a).toMatchObject({ ok: true, saved: { account: "01234567", nickname: "Home", broadband_account: null } })
    const b = await saveAccount(db, "u1", { ...ecg, nickname: null, phone: "0201234567" })
    expect(b).toMatchObject({ ok: true, saved: { nickname: "Home", phone: "0201234567" } })
    expect(table).toHaveLength(1)
  })
  it("refuses past the per-user limit", async () => {
    const rows = Array.from({ length: MAX_SAVED_PER_USER }, (_, i) => ({ id: `x${i}`, user_id: "u1", biller: "dstv", account: `acc${i}`, broadband_account: "" }))
    const { db } = fakeDb(rows)
    expect(await saveAccount(db, "u1", ecg)).toMatchObject({ ok: false, status: 409 })
  })
  it("only deletes the owner's own entry", async () => {
    const { db, table } = fakeDb([{ id: "a", user_id: "u1" }, { id: "b", user_id: "u2" }])
    expect(await deleteSaved(db, "u1", "b")).toBe(false)
    expect(await deleteSaved(db, "u1", "a")).toBe(true)
    expect(table.map(r => r.id)).toEqual(["b"])
  })
})
