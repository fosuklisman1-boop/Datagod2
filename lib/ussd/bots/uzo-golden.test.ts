// Golden transcripts of the Uzo USSD bot flows (Network Plans + Pay Bills, main + shop menus).
// Written against the reviewed Plan 3 code BEFORE the presentation-profile refactor: every screen, every saved
// session and every engine / charge call is pinned byte-for-byte in __snapshots__/uzo-golden.test.ts.snap.
// Uzo output must never change when the WhatsApp profile is added; a diff here is a regression, not a re-record.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { BotCatalogResult } from "@/lib/bot-commission/catalog"
import type { BotChargeResult } from "@/lib/bot-commission/momo"
import { BOT_BILL_TOKEN_EXPIRED, type BotOrderResult } from "@/lib/bot-commission/orders"
import type { VerifyResult } from "@/lib/bills/service"
import { PRICES_REFRESHED } from "@/lib/standard-bundles/service"
import { cont as mainCont, end as mainEnd } from "../menus"
import { cont as shopCont, end as shopEnd } from "@/lib/ussd-shop/menus"
import type { UzoResponse } from "../types"
import type { UzoBotCtx, UzoBotSession } from "./kit"
import { handleNetworkPlansStep, startNetworkPlans, type NetworkPlansDeps } from "./network-plans"
import { handlePayBillsStep, startPayBills, type PayBillsDeps, type PbVerifyInput } from "./pay-bills"

const SID = "uzo-golden-session-01"
const ME = "+233244123456"
const ME_LOCAL = "0244123456"
const SHOP = "11111111-2222-4333-8444-555555555555"
const ORDER = "99999999-8888-4777-8666-555555555555"
const LONG_SHOP = "The Very Long Shop Name Enterprises Limited Ghana"

type Surface = "ussd" | "ussd_shop"
type Log = unknown[]

let errSpy: ReturnType<typeof vi.spyOn>
beforeAll(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}) })
afterAll(() => errSpy.mockRestore())

/** Wrap every dep so each call (name + args) lands in the transcript. */
function logged<T extends object>(log: Log, deps: T): T {
  const out = {} as Record<string, unknown>
  for (const [k, v] of Object.entries(deps)) {
    out[k] = typeof v === "function"
      ? async (...args: unknown[]) => { log.push({ call: k, args: JSON.parse(JSON.stringify(args)) }); return (v as (...a: unknown[]) => unknown)(...args) }
      : v
  }
  return out as T
}

function harness(surface: Surface, shopName?: string, shopId?: string | null) {
  const shop = surface === "ussd_shop"
  const store = new Map<string, UzoBotSession>()
  const log: Log = []
  const io = {
    save: async (id: string, s: UzoBotSession) => {
      const copy = JSON.parse(JSON.stringify(s))
      log.push({ save: copy })
      store.set(id, copy)
    },
    cont: shop ? shopCont : mainCont,
    end: shop ? shopEnd : mainEnd,
    leave: async (_c: UzoBotCtx, s: UzoBotSession) => { log.push({ leave: JSON.parse(JSON.stringify(s)) }); return { message: "MENU", ussdServiceOp: 2 as const } },
  }
  const ctx: UzoBotCtx = {
    surface, sessionId: SID, dialingPhone: ME,
    shopId: shopId === undefined ? (shop ? SHOP : null) : shopId,
    shopName: shopName ?? (shop ? "Ama Shop" : undefined),
  }
  const base: UzoBotSession = shop
    ? { step: "SELECT_PRODUCT", dialingPhone: ME, shopId: ctx.shopId ?? undefined, shopName: ctx.shopName, shopCodeId: "c1" }
    : { step: "MAIN", dialingPhone: ME }
  const record = (input: string | null, r: UzoResponse) => log.push({ in: input, out: r })
  return { store, log, io, ctx, base, record }
}

// ── Network Plans ────────────────────────────────────────────────────────────

type Bundle = Extract<BotCatalogResult, { ok: true }>["categories"][number]["bundles"][number]
const bundle = (i: number, over: Partial<Bundle> = {}): Bundle => ({
  value: `MTN_Data_${i}`, display: `${i}GB Data Bundle 30 Days`, amount: 10 + i, category: "Data",
  token: `tok-${i}`, payAmount: 9.5 + i, customerCashback: 0.6, paymentFee: 0.1, ...over,
})
const NP_CATALOG: BotCatalogResult = {
  ok: true,
  categories: [
    { name: "Video", bundles: [bundle(100, { display: "Video Bundle 2GB", category: "Video" })] },
    { name: "Midnight", bundles: [] },
    { name: "Data", bundles: [1, 2, 3, 4, 5, 6, 7].map(i => bundle(i)) },
  ],
}
const LONG = "Super Mega Data Bundle Ultra Value Pack For Students With Bonus Social Media Minutes Night"
const NP_LONG: BotCatalogResult = {
  ok: true,
  categories: [
    { name: "Fuse (Mins + Data)", bundles: [1, 2, 3, 4, 5, 6].map(i => bundle(i, { display: `${i} ${LONG}`, payAmount: 1000 + i, amount: 2000 })) },
    { name: "BigTime", bundles: [bundle(9, { display: "BigTime Data 10GB" })] },
  ],
}

interface NpOver {
  catalog?: NetworkPlansDeps["catalog"]; createOrder?: NetworkPlansDeps["createOrder"]; readOrder?: NetworkPlansDeps["readOrder"]
  charge?: NetworkPlansDeps["charge"]; findOrderId?: NetworkPlansDeps["findOrderId"]; prefixEnabled?: boolean
  shopName?: string; shopId?: string | null; session?: Partial<UzoBotSession>
}

async function npRun(surface: Surface, inputs: string[], o: NpOver = {}): Promise<Log> {
  const h = harness(surface, o.shopName, o.shopId)
  const deps: NetworkPlansDeps = {
    io: h.io,
    ...logged(h.log, {
      catalog: o.catalog ?? (async () => NP_CATALOG),
      createOrder: o.createOrder ?? (async (): Promise<BotOrderResult> => ({
        ok: true, order: { id: ORDER, reference: "R1", payAmount: 10.5, faceAmount: 11, customerCashback: 0.6, paymentFee: 0.1 },
      })),
      findOrderId: o.findOrderId ?? (async () => null),
      readOrder: o.readOrder ?? (async () => ({ status: "pending", payment_status: "unpaid" })),
      failOrder: async () => {},
      charge: o.charge ?? (async (): Promise<BotChargeResult> => ({ ok: true, reference: "ref1", status: "pay_offline", promptedPhone: "0241234567" })),
      getPrefixConfig: async () => ({ enabled: o.prefixEnabled ?? true, map: DEFAULT_NETWORK_PREFIXES }),
    }),
  }
  const base = { ...h.base, ...(o.session ?? {}) } as UzoBotSession
  h.record(null, await startNetworkPlans(h.ctx, base, deps))
  for (const m of inputs) h.record(m, await handleNetworkPlansStep(h.ctx, m, h.store.get(SID) ?? base, deps))
  return h.log
}

const NP_SCRIPTS: [string, string[], NpOver?][] = [
  ["happy path, every screen + back", ["9", "1", "x", "0", "1", "1", "6", "8", "0", "0", "1", "6", "7", "5", "2", "123", "0201234567", "0", "1", "9", "0", "1", "1"]],
  ["other number on another network + confirm", ["1", "1", "2", "2", "055 123 4567", "1"]],
  ["my number on another network", ["2", "1", "1", "1"]],
  ["prefix check off", ["2", "1", "1", "1", "1"], { prefixEnabled: false }],
  ["cancel at confirm", ["1", "1", "1", "1", "2"]],
  ["catalog 403", ["3"], { catalog: async () => ({ ok: false, status: 403, error: "Not available" }) }],
  ["catalog 503", ["1"], { catalog: async () => ({ ok: false, status: 503, error: "provider text" }) }],
  ["catalog throws", ["1"], { catalog: async () => { throw new Error("boom") } }],
  ["engine 409 prices refreshed", ["1", "1", "1", "1", "1"], { createOrder: async () => ({ ok: false, status: 409, error: PRICES_REFRESHED }) }],
  ["engine 409", ["1", "1", "1", "1", "1"], { createOrder: async () => ({ ok: false, status: 409, error: "secret" }) }],
  ["engine 429", ["1", "1", "1", "1", "1"], { createOrder: async () => ({ ok: false, status: 429, error: "secret" }) }],
  ["engine 403", ["1", "1", "1", "1", "1"], { createOrder: async () => ({ ok: false, status: 403, error: "secret" }) }],
  ["engine 400", ["1", "1", "1", "1", "1"], { createOrder: async () => ({ ok: false, status: 400, error: "secret" }) }],
  ["engine throws + orphan", ["1", "1", "1", "1", "1"], { createOrder: async () => { throw new Error("db") }, findOrderId: async () => ORDER }],
  ["engine replay at another price", ["1", "1", "1", "1", "1"], {
    createOrder: async () => ({ ok: true, order: { id: ORDER, reference: "R0", payAmount: 12, faceAmount: 11, customerCashback: 0, paymentFee: 1 } }),
  }],
  ["read-back paid", ["1", "1", "1", "1", "1"], { readOrder: async () => ({ status: "pending", payment_status: "paid" }) }],
  ["read-back missing", ["1", "1", "1", "1", "1"], { readOrder: async () => null }],
  ["read-back throws", ["1", "1", "1", "1", "1"], { readOrder: async () => { throw new Error("read") } }],
  ["charge throws", ["1", "1", "1", "1", "1"], { charge: async () => { throw new Error("raw") } }],
  ["charge replay", ["1", "1", "1", "1", "1"], { charge: async () => ({ ok: true, reference: "ref0", status: "pending", promptedPhone: "0201234567" }) }],
  ["charge send_otp", ["1", "1", "1", "1", "1"], { charge: async () => ({ ok: true, reference: "ref2", status: "send_otp", promptedPhone: null }) }],
  ["charge NO_PROVIDER", ["1", "1", "1", "1", "1"], { charge: async () => ({ ok: false, code: "NO_PROVIDER", message: "Payment not available for your number." }) }],
  ["charge RATE_LIMITED", ["1", "1", "1", "1", "1"], { charge: async () => ({ ok: false, code: "RATE_LIMITED", message: "Too many attempts. Please try later." }) }],
  ["charge CHARGE_FAILED", ["1", "1", "1", "1", "1"], { charge: async () => ({ ok: false, code: "CHARGE_FAILED", message: "Service unavailable. Please try again later." }) }],
  ["closed after order: replayed 1 / 0", ["1", "1", "1", "1", "1", "1", "0"]],
  ["no (was) at face price", ["1", "1", "1", "1"], { catalog: async () => ({ ok: true, categories: [{ name: "Data", bundles: [bundle(1, { payAmount: 11 })] }] }) }],
  ["long names + long shop", ["9", "3", "x", "2", "x", "6", "x", "0", "1", "x", "2", "1", "0", "1", "x", "1"], { catalog: async () => NP_LONG, prefixEnabled: false, shopName: LONG_SHOP }],
  ["data blocked", ["1"], { session: { dataBlocked: true } }],
  ["stale page clamp", ["1", "1", "6", "8", "9"]],
  ["no shop id", ["1"], { shopId: null }],
]

describe("Uzo golden: Network Plans", () => {
  for (const surface of ["ussd", "ussd_shop"] as const) {
    for (const [name, inputs, o] of NP_SCRIPTS) {
      it(`${surface}: ${name}`, async () => {
        expect(await npRun(surface, inputs, o)).toMatchSnapshot()
      })
    }
  }
})

// ── Pay Bills ────────────────────────────────────────────────────────────────

const ALL_BILLERS = [
  { key: "ecg", min: 1, max: 5000 }, { key: "ghana_water", min: 1, max: 5000 }, { key: "dstv", min: 5, max: 2000 },
  { key: "gotv", min: 5, max: 2000 }, { key: "startimes", min: 5, max: 2000 }, { key: "telecel_broadband", min: 10, max: 3000 },
] as Awaited<ReturnType<PayBillsDeps["billers"]>>

const meter = (i: number, over: Partial<{ meter: string; name: string | null; outstanding: number | null; token: string }> = {}) => ({
  meter: `P1234567${i}`, name: `K***${i} A***h`, outstanding: i === 1 ? 12.5 : null, token: `tok-m${i}`, ...over,
})

function defaultVerify(meters: Record<string, ReturnType<typeof meter>[]>, name = "K***h M***h", due = 120) {
  return async (_bc: unknown, i: PbVerifyInput): Promise<VerifyResult> => {
    if (i.biller === "ecg" && i.addMeter) return { ok: true, customerName: "N***a O***i", amountDue: null, suggestedAmount: 0, token: "tok-link" }
    if (i.biller === "ecg") return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters: meters[i.phone ?? ""] ?? [] }
    return { ok: true, customerName: name, amountDue: due, suggestedAmount: due, token: `tok-${i.biller}` }
  }
}

interface PbOver {
  billers?: PayBillsDeps["billers"]; verify?: PayBillsDeps["verify"]; quote?: PayBillsDeps["quote"]
  createOrder?: PayBillsDeps["createOrder"]; readOrder?: PayBillsDeps["readOrder"]; charge?: PayBillsDeps["charge"]
  findOrderId?: PayBillsDeps["findOrderId"]; meters?: Record<string, ReturnType<typeof meter>[]>
  shopName?: string; shopId?: string | null; mutate?: (s: UzoBotSession) => UzoBotSession; mutateAt?: number
}

async function pbRun(surface: Surface, inputs: string[], o: PbOver = {}): Promise<Log> {
  const h = harness(surface, o.shopName, o.shopId)
  const deps: PayBillsDeps = {
    io: h.io,
    ...logged(h.log, {
      billers: o.billers ?? (async () => ALL_BILLERS),
      verify: o.verify ?? defaultVerify(o.meters ?? { [ME_LOCAL]: [meter(1), meter(2)] }),
      quote: o.quote ?? (async (_bc: unknown, _b: unknown, face: number) => ({ payAmount: Math.round(face * 99) / 100 })),
      createOrder: o.createOrder ?? (async (_bc: unknown, i: { amount: number; expectedPay: number }): Promise<BotOrderResult> => ({
        ok: true, order: { id: ORDER, reference: "R1", payAmount: i.expectedPay, faceAmount: i.amount, customerCashback: 0.5, paymentFee: 0 },
      })),
      findOrderId: o.findOrderId ?? (async () => null),
      readOrder: o.readOrder ?? (async () => ({ status: "pending", payment_status: "unpaid" })),
      failOrder: async () => {},
      charge: o.charge ?? (async (): Promise<BotChargeResult> => ({ ok: true, reference: "ref1", status: "pay_offline", promptedPhone: "0241234567" })),
    }) as unknown as Omit<PayBillsDeps, "io">,
  }
  h.record(null, await startPayBills(h.ctx, h.base, deps))
  for (const [i, m] of inputs.entries()) {
    if (o.mutate && o.mutateAt === i && h.store.get(SID)) h.store.set(SID, o.mutate(h.store.get(SID)!))
    h.record(m, await handlePayBillsStep(h.ctx, m, h.store.get(SID) ?? h.base, deps))
  }
  return h.log
}

const LONG_NAME = "Bundle Data Akwasi-Kwabena Oppong-Mensah Enterprises Ltd"
const longMeters = [1, 2, 3, 4, 5, 6].map(i => meter(i, { meter: `${i}`.repeat(13), name: LONG_NAME, outstanding: 1234.56 }))
const longVerify: PayBillsDeps["verify"] = async (bc, i) => {
  const r = await defaultVerify({ [ME_LOCAL]: longMeters })(bc, i)
  return r.ok && !r.meters ? { ...r, customerName: LONG_NAME, amountDue: 1234.56 } : r
}
const SEVEN = { [ME_LOCAL]: [1, 2, 3, 4, 5, 6, 7].map(i => meter(i)) }

const PB_SCRIPTS: [string, string[], PbOver?][] = [
  ["biller list: invalid + leave", ["9", "0"]],
  ["ECG this number: meters, amount, confirm, pay", ["1", "1", "1", "50", "1"]],
  ["ECG meter paging", ["1", "1", "6", "8", "0", "6", "7", "0", "0", "1", "6", "7", "abc", "0.5", "20", "9", "0", "20", "1"], { meters: SEVEN }],
  ["ECG no meters: entry, type, consent repaint, link", ["1", "1", "P99887766", "x", "1", "9", "1", "20", "1"], { meters: {} }],
  ["ECG consent back + cancel", ["1", "1", "P99887766", "2", "0", "2", "2"], { meters: {} }],
  ["ECG other number: invalid, none, postpaid, consent", ["1", "2", "123", "055 123 4567", "P55555555", "2", "1", "30", "1"], { meters: {} }],
  ["ECG other number with meters", ["1", "2", "0551234567", "1"], { meters: { "0551234567": [meter(3)] } }],
  ["ECG meter number linked", ["1", "3", "p12345672", "1", "15", "1"]],
  ["ECG meter number invalid then unlinked", ["1", "3", "#!", "P00000001", "2", "0", "0", "0", "0"]],
  ["ECG mode invalid + back", ["1", "7", "2", "0", "3", "0", "0"]],
  ["DStv full", ["2", "70 1234 5678", "120", "1"]],
  ["GOtv bad amounts", ["3", "7012345678", "4.99", "2000.01", "abc", "1.234", "0.00", "-5", "5", "0", "6", "2"]],
  ["StarTimes", ["4", "#", "1234567", "0", "4", "1234567", "100", "1"]],
  ["Telecel Broadband", ["5", "12", "0302450262", "0", "0302450262", "x", "P0444101", "100", "1"]],
  ["biller back from account", ["2", "0", "0"]],
  ["no (was) at face price", ["2", "7012345678", "50"], { quote: async (_bc, _b, face) => ({ payAmount: face + 1 }) }],
  ["quote throws", ["2", "7012345678", "50"], { quote: async () => { throw new Error("cfg") } }],
  ["quote zero", ["2", "7012345678", "50"], { quote: async () => ({ payAmount: 0 }) }],
  ["verify 422", ["2", "7012345678"], { verify: async () => ({ ok: false, status: 422, error: "secret" }) }],
  ["verify 400", ["2", "7012345678"], { verify: async () => ({ ok: false, status: 400, error: "secret" }) }],
  ["verify 429", ["2", "7012345678"], { verify: async () => ({ ok: false, status: 429, error: "secret" }) }],
  ["verify 403", ["2", "7012345678"], { verify: async () => ({ ok: false, status: 403, error: "secret" }) }],
  ["verify 500", ["2", "7012345678"], { verify: async () => ({ ok: false, status: 500, error: "secret" }) }],
  ["verify throws", ["2", "7012345678"], { verify: async () => { throw new Error("secret") } }],
  ["verify no token", ["2", "7012345678"], { verify: async () => ({ ok: true, customerName: "x", amountDue: null, suggestedAmount: 0 }) }],
  ["ECG this number 422", ["1", "1"], { verify: async () => ({ ok: false, status: 422, error: "secret" }) }],
  ["ECG other number 400", ["1", "2", "0551234567"], { verify: async () => ({ ok: false, status: 400, error: "secret" }) }],
  ["consent lookup 422", ["1", "1", "P99887766", "1", "1"], {
    meters: {}, verify: async (bc, i) => (i.addMeter ? { ok: false, status: 422, error: "secret" } : defaultVerify({})(bc, i)),
  }],
  ["engine 400 token expired", ["2", "7012345678", "50", "1"], { createOrder: async () => ({ ok: false, status: 400, error: BOT_BILL_TOKEN_EXPIRED }) }],
  ["engine 400", ["2", "7012345678", "50", "1"], { createOrder: async () => ({ ok: false, status: 400, error: "Amount out of range" }) }],
  ["engine 409", ["2", "7012345678", "50", "1"], { createOrder: async () => ({ ok: false, status: 409, error: "secret" }) }],
  ["engine 429", ["2", "7012345678", "50", "1"], { createOrder: async () => ({ ok: false, status: 429, error: "secret" }) }],
  ["engine 403", ["2", "7012345678", "50", "1"], { createOrder: async () => ({ ok: false, status: 403, error: "secret" }) }],
  ["engine throws + orphan", ["2", "7012345678", "50", "1"], { createOrder: async () => { throw new Error("db") }, findOrderId: async () => ORDER }],
  ["engine replay other price", ["2", "7012345678", "50", "1"], {
    createOrder: async () => ({ ok: true, order: { id: ORDER, reference: "R0", payAmount: 60, faceAmount: 50, customerCashback: 0, paymentFee: 0 } }),
  }],
  ["engine replay other face", ["2", "7012345678", "50", "1"], {
    createOrder: async () => ({ ok: true, order: { id: ORDER, reference: "R0", payAmount: 49.5, faceAmount: 80, customerCashback: 0, paymentFee: 0 } }),
  }],
  ["read-back failed row", ["2", "7012345678", "50", "1"], { readOrder: async () => ({ status: "failed", payment_status: "unpaid" }) }],
  ["read-back missing", ["2", "7012345678", "50", "1"], { readOrder: async () => null }],
  ["charge throws", ["2", "7012345678", "50", "1"], { charge: async () => { throw new Error("raw") } }],
  ["charge replay", ["2", "7012345678", "50", "1"], { charge: async () => ({ ok: true, reference: "ref0", status: "pending", promptedPhone: null }) }],
  ["charge NO_PROVIDER", ["2", "7012345678", "50", "1"], { charge: async () => ({ ok: false, code: "NO_PROVIDER", message: "Payment not available for your number." }) }],
  ["confirm repaint, back, cancel", ["2", "7012345678", "50", "9", "0", "50", "2"]],
  ["closed after order: replayed 1 / 0", ["2", "7012345678", "50", "1", "1", "0"]],
  ["confirm without token", ["2", "7012345678", "50", "1"], { mutate: s => ({ ...s, pbToken: undefined }), mutateAt: 3 }],
  ["stale Ghana Water in the list", ["1"], { mutate: s => ({ ...s, pbBillers: [{ key: "ghana_water", min: 1, max: 10 }] }), mutateAt: 0 }],
  ["only Ghana Water switched on", [], { billers: async () => [{ key: "ghana_water", min: 1, max: 10 }] as Awaited<ReturnType<PayBillsDeps["billers"]>> }],
  ["billers throw", [], { billers: async () => { throw new Error("db") } }],
  ["no shop id", ["1"], { shopId: null }],
  ["long names: ECG this number", ["x", "1", "x", "1", "6", "x", "0", "1", "abc", "4999.99", "x", "0", "4999.99", "1"], {
    shopName: LONG_SHOP, meters: { [ME_LOCAL]: longMeters }, verify: longVerify,
  }],
  ["long names: other + meter + DStv + StarTimes", ["1", "2", "1", "0551234567", "x", "0", "3", "X".repeat(30), "x", "1", "x", "0", "2", "1", "0", "0", "0", "0", "2", "1", "0", "4", "7".repeat(30), "100", "2"], {
    shopName: LONG_SHOP, meters: {}, verify: longVerify,
  }],
  ["long names: broadband", ["5", "0302450262", "x", "P0444101", "100", "1"], { meters: {}, verify: longVerify }],
]

describe("Uzo golden: Pay Bills", () => {
  for (const surface of ["ussd", "ussd_shop"] as const) {
    for (const [name, inputs, o] of PB_SCRIPTS) {
      it(`${surface}: ${name}`, async () => {
        expect(await pbRun(surface, inputs, o)).toMatchSnapshot()
      })
    }
  }
})
