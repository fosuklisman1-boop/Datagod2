// WhatsApp cashback switches (dark rollout): admin_settings `whatsapp_cashback_visibility`. Each switch is on only
// when stored `=== true` (missing key / read error => all off). An item is live only when the shared cashback bots
// gate (enabled && surfaces.bots && botGroups[group]) AND its WhatsApp switch are both on. Fails closed.
import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { CASHBACK_CONFIG_KEY } from "@/lib/cashback/config"
import {
  getWhatsAppCashbackVisibility, setWhatsAppCashbackVisibility, whatsappBotItemsVisible, WHATSAPP_CASHBACK_VISIBILITY_KEY,
} from "./cashback-visibility"

type Rows = Record<string, unknown>

/** admin_settings fake: `.select().eq("key", k).maybeSingle()` and `.upsert(row, opts)`; an Error value fails the read. */
function fakeDb(rows: Rows, opts: { upsertError?: boolean } = {}) {
  const reads: string[] = []
  const upserts: { row: any; opts: any }[] = []
  const db = {
    from(table: string) {
      expect(table).toBe("admin_settings")
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                async maybeSingle() {
                  reads.push(key)
                  const v = rows[key]
                  if (v instanceof Error) return { data: null, error: v }
                  return { data: v === undefined ? null : { value: v }, error: null }
                },
              }
            },
          }
        },
        async upsert(row: any, o: any) {
          if (opts.upsertError) return { error: { message: "nope" } }
          upserts.push({ row, opts: o })
          rows[row.key] = row.value
          return { error: null }
        },
      }
    },
  }
  return { db: db as unknown as SupabaseClient, reads, upserts, rows }
}

const ALL_OFF = { networkPlans: false, payBills: false, cashbackAirtime: false }
const cfg = (o: { enabled?: boolean; bots?: boolean; bundles?: boolean; bills?: boolean; airtime?: boolean } = {}) => ({
  enabled: o.enabled ?? true,
  surfaces: { bots: o.bots ?? true },
  botGroups: { bundles: o.bundles ?? true, bills: o.bills ?? true, airtime: o.airtime ?? true },
})

describe("getWhatsAppCashbackVisibility", () => {
  it("the key is whatsapp_cashback_visibility", () => {
    expect(WHATSAPP_CASHBACK_VISIBILITY_KEY).toBe("whatsapp_cashback_visibility")
  })

  it("a missing key => all off", async () => {
    const { db, reads } = fakeDb({})
    expect(await getWhatsAppCashbackVisibility(db)).toEqual(ALL_OFF)
    expect(reads).toEqual([WHATSAPP_CASHBACK_VISIBILITY_KEY])
  })

  it("a read error => all off (never throws)", async () => {
    const { db } = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: new Error("timeout") })
    expect(await getWhatsAppCashbackVisibility(db)).toEqual(ALL_OFF)
  })

  it("a thrown client => all off", async () => {
    const db = { from() { throw new Error("boom") } } as unknown as SupabaseClient
    expect(await getWhatsAppCashbackVisibility(db)).toEqual(ALL_OFF)
  })

  it("only a stored true turns an item on (truthy non-true values stay off)", async () => {
    const { db } = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: true, payBills: "true", cashbackAirtime: 1 } })
    expect(await getWhatsAppCashbackVisibility(db)).toEqual({ networkPlans: true, payBills: false, cashbackAirtime: false })
  })

  it("a non-object value => all off", async () => {
    const { db } = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: "on" })
    expect(await getWhatsAppCashbackVisibility(db)).toEqual(ALL_OFF)
  })

  it("all three stored true => all on", async () => {
    const { db } = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: true, payBills: true, cashbackAirtime: true } })
    expect(await getWhatsAppCashbackVisibility(db)).toEqual({ networkPlans: true, payBills: true, cashbackAirtime: true })
  })
})

describe("setWhatsAppCashbackVisibility", () => {
  it("read-modify-write: patches one switch and keeps the others", async () => {
    const f = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: true, payBills: false, cashbackAirtime: true } })
    await setWhatsAppCashbackVisibility(f.db, { payBills: true })
    expect(f.upserts).toHaveLength(1)
    expect(f.upserts[0].row).toMatchObject({
      key: WHATSAPP_CASHBACK_VISIBILITY_KEY, value: { networkPlans: true, payBills: true, cashbackAirtime: true },
    })
    expect(f.upserts[0].opts).toEqual({ onConflict: "key" })
  })

  it("from a missing key: writes the full map, unpatched switches off", async () => {
    const f = fakeDb({})
    await setWhatsAppCashbackVisibility(f.db, { cashbackAirtime: true })
    expect(f.upserts[0].row.value).toEqual({ networkPlans: false, payBills: false, cashbackAirtime: true })
  })

  it("a read error throws and writes nothing (never wipes the stored switches)", async () => {
    const f = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: new Error("timeout") })
    await expect(setWhatsAppCashbackVisibility(f.db, { payBills: true })).rejects.toBeTruthy()
    expect(f.upserts).toHaveLength(0)
  })

  it("an upsert error throws", async () => {
    const f = fakeDb({}, { upsertError: true })
    await expect(setWhatsAppCashbackVisibility(f.db, { payBills: true })).rejects.toBeTruthy()
  })

  it("rejects non-boolean values and unknown keys, writing nothing", async () => {
    const f = fakeDb({})
    await expect(setWhatsAppCashbackVisibility(f.db, { payBills: "yes" } as any)).rejects.toThrow()
    await expect(setWhatsAppCashbackVisibility(f.db, { other: true } as any)).rejects.toThrow()
    expect(f.upserts).toHaveLength(0)
  })
})

describe("whatsappBotItemsVisible: gate AND switch, every combination", () => {
  const bools = [true, false]
  for (const enabled of bools) for (const bots of bools) for (const group of bools) for (const sw of bools) {
    it(`enabled=${enabled} bots=${bots} group=${group} switch=${sw}`, async () => {
      const { db } = fakeDb({
        [CASHBACK_CONFIG_KEY]: cfg({ enabled, bots, bundles: group, bills: group, airtime: group }),
        [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: sw, payBills: sw, cashbackAirtime: sw },
      })
      const on = enabled && bots && group && sw
      expect(await whatsappBotItemsVisible(db)).toEqual({ networkPlans: on, payBills: on, cashbackAirtime: on })
    })
  }

  it("group mapping: bundles => networkPlans, bills => payBills, airtime => cashbackAirtime", async () => {
    const on = { networkPlans: true, payBills: true, cashbackAirtime: true }
    for (const [group, item] of [["bundles", "networkPlans"], ["bills", "payBills"], ["airtime", "cashbackAirtime"]] as const) {
      const { db } = fakeDb({
        [CASHBACK_CONFIG_KEY]: cfg({ bundles: group === "bundles", bills: group === "bills", airtime: group === "airtime" }),
        [WHATSAPP_CASHBACK_VISIBILITY_KEY]: on,
      })
      expect(await whatsappBotItemsVisible(db)).toEqual({ ...ALL_OFF, [item]: true })
    }
  })

  it("switches all off => all off without reading the cashback config", async () => {
    const f = fakeDb({ [CASHBACK_CONFIG_KEY]: cfg(), [WHATSAPP_CASHBACK_VISIBILITY_KEY]: ALL_OFF })
    expect(await whatsappBotItemsVisible(f.db)).toEqual(ALL_OFF)
    expect(f.reads).toEqual([WHATSAPP_CASHBACK_VISIBILITY_KEY])
  })

  it("a cashback config read error => all off (fail closed)", async () => {
    const { db } = fakeDb({
      [CASHBACK_CONFIG_KEY]: new Error("timeout"),
      [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: true, payBills: true, cashbackAirtime: true },
    })
    expect(await whatsappBotItemsVisible(db)).toEqual(ALL_OFF)
  })

  it("a switch read error => all off", async () => {
    const { db } = fakeDb({ [CASHBACK_CONFIG_KEY]: cfg(), [WHATSAPP_CASHBACK_VISIBILITY_KEY]: new Error("timeout") })
    expect(await whatsappBotItemsVisible(db)).toEqual(ALL_OFF)
  })

  it("a missing cashback config => all off (master defaults off)", async () => {
    const { db } = fakeDb({ [WHATSAPP_CASHBACK_VISIBILITY_KEY]: { networkPlans: true, payBills: true, cashbackAirtime: true } })
    expect(await whatsappBotItemsVisible(db)).toEqual(ALL_OFF)
  })
})
