// lib/ussd-hubtel/services.ts
// Business lookups the Hubtel flows need, behind interfaces so router/flow tests use fakes.
// Defaults delegate to the same modules the Uzo flows use.
import { resolveDialer, type DialerInfo } from "@/lib/ussd/resolve-dialer"
import type { SupabaseClient } from "@supabase/supabase-js"
import { phoneVariants } from "@/lib/phone-format"
import type { ExamBoard } from "@/lib/results-check-validation"
import {
  calculateRCPrice, getAvailableCount, getMaxQuantity, getRCBulkHint, isExamBoardEnabled,
} from "@/lib/results-checker-service"
import { toLocalPhone } from "./protocol"
import { safeDbError } from "./log-safe"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"
import { getAirtimeProvider } from "@/lib/airtime-provider"
import { isDigiWapyConfigured, isDigiWapyEnabledForNetwork } from "@/lib/digiwapy-provider"
import { getCashbackConfig, type CashbackConfig } from "@/lib/cashback/config"
import { BOT_MENUS_HIDDEN, type BotMenuGate } from "./config"
import type { StorefrontQuote } from "@/lib/cashback/quote"
import { quoteBotAirtime } from "@/lib/cashback/storefront-airtime"
import type { BotContext } from "@/lib/bot-commission/context"
import type { BotCatalogResult } from "@/lib/bot-commission/catalog"
import type { BotBillOrderInput, BotBundleOrderInput, BotOrderResult } from "@/lib/bot-commission/orders"
import type { BundleNetwork } from "@/lib/standard-bundles/categories"
import { BILLERS, BILLER_KEYS, type BillerKey, type BillInputs } from "@/lib/bills/billers"
import type { VerifyResult } from "@/lib/bills/service"

export { resolveDialer }
export type { DialerInfo }

/** Cashback bots gate per bot menu: master switch AND bots surface AND the menu's group (bundles / bills). */
export function botMenuGate(cfg: CashbackConfig): BotMenuGate {
  const on = cfg.enabled === true && cfg.surfaces?.bots === true
  return { networkPlans: on && cfg.botGroups?.bundles === true, payBills: on && cfg.botGroups?.bills === true }
}

/** The gate from the stored cashback config; any read error hides both menus (fail closed). Never throws. */
export async function loadBotMenuGate(supabase: SupabaseClient): Promise<BotMenuGate> {
  try {
    return botMenuGate(await getCashbackConfig(supabase))
  } catch (e) {
    console.error("[HUBTEL] cashback config unavailable; hiding bot menus:", safeDbError(e))
    return { ...BOT_MENUS_HIDDEN }
  }
}

export interface AirtimeServices {
  isEnabled(network: string): Promise<boolean>
  getLimits(): Promise<{ min: number; max: number }>
  /** Platform fee rate (%) for the network; dealers and sub-agents pay the dealer rate. */
  feeRate(network: string, isDealer: boolean): Promise<number>
  /**
   * Commission-cashback quote on the Hubtel rail for `faceAmount` of `network` airtime, or null when
   * cashback is not applied (gate off, provider earns nothing, above Hubtel's cap, any error) — the
   * caller then runs today's fee pricing unchanged. `shop` = shop-mode session (storefront split).
   */
  cashbackQuote(network: string, faceAmount: number, shop: boolean): Promise<StorefrontQuote | null>
}

export function defaultAirtimeServices(supabase: SupabaseClient): AirtimeServices {
  const cashbackDeps = {
    getConfig: () => getCashbackConfig(supabase),
    getProvider: (network: string) => getAirtimeProvider(supabase, network, isDigiWapyEnabledForNetwork),
    digiwapyConfigured: () => isDigiWapyConfigured(),
  }
  return {
    isEnabled: isAirtimeEnabled,
    getLimits: getAirtimeLimits,
    feeRate: airtimeBaseFeeRate,
    cashbackQuote: (network, faceAmount, shop) => quoteBotAirtime(network, faceAmount, { rail: "hubtel", shop }, cashbackDeps),
  }
}

/**
 * Network Plans (Commission Cashback bots, Hubtel Standard Bundles). Thin wrappers over the bot engine
 * (lib/bot-commission) so flow tests use fakes; the runtime (service-role deps) is loaded per call.
 */
export interface NetworkPlansServices {
  catalog(ctx: BotContext, network: BundleNetwork): Promise<BotCatalogResult>
  createOrder(ctx: BotContext, input: BotBundleOrderInput): Promise<BotOrderResult>
  /**
   * Id of the engine order this buyer already created under `idempotencyKey`, or null. Used after createOrder
   * threw (it may have committed) so the orphan can be failed. Throws on read error.
   */
  findOrderId(ctx: BotContext, idempotencyKey: string): Promise<string | null>
}

export function defaultNetworkPlansServices(): NetworkPlansServices {
  return {
    async findOrderId(ctx, idempotencyKey) {
      const [{ getBotBundlesRuntime }, { resolveBotContext }] = await Promise.all([
        import("@/lib/bot-commission/runtime"), import("@/lib/bot-commission/context"),
      ])
      const r = resolveBotContext(ctx)
      if (!r.ok) return null
      const row = await getBotBundlesRuntime().deps.findBotBundleOrder(r.ctx.botSurface, r.ctx.buyerPhone, idempotencyKey)
      return row?.id ?? null
    },
    async catalog(ctx, network) {
      const [{ getBotBundlesRuntime }, { botCatalog }] = await Promise.all([
        import("@/lib/bot-commission/runtime"), import("@/lib/bot-commission/catalog"),
      ])
      return botCatalog(getBotBundlesRuntime().deps, ctx, network)
    },
    async createOrder(ctx, input) {
      const [{ getBotBundlesRuntime }, { botCreateBundleOrder }] = await Promise.all([
        import("@/lib/bot-commission/runtime"), import("@/lib/bot-commission/orders"),
      ])
      return botCreateBundleOrder(getBotBundlesRuntime().deps, ctx, input)
    },
  }
}

/** One biller the Utility Bills config has switched on, with its amount limits (GHS). */
export interface PayBillsBiller { key: BillerKey; min: number; max: number }
export type PayBillsVerifyInput = { biller: string } & BillInputs & { addMeter?: boolean; consent?: boolean }

/**
 * Pay Bills (Commission Cashback bots, Utility Bills). Thin wrappers over the bot engine (lib/bot-commission)
 * so flow tests use fakes; the runtime (service-role deps) is loaded per call.
 */
export interface PayBillsServices {
  /** Billers switched on in the Utility Bills config (master + per biller), in BILLER_KEYS order. Throws on read error. */
  billers(): Promise<PayBillsBiller[]>
  /** botVerifyBill: masked names, bot-bound tokens, Ghana Water refused on USSD. */
  verify(ctx: BotContext, input: PayBillsVerifyInput): Promise<VerifyResult>
  /** The price the engine will charge for `faceAmount` (quoteBots, same config source as botCreateBillOrder). Throws on read error. */
  quote(ctx: BotContext, biller: BillerKey, faceAmount: number): Promise<StorefrontQuote>
  createOrder(ctx: BotContext, input: BotBillOrderInput): Promise<BotOrderResult>
  /**
   * Id of the engine order this buyer already created from verify `token`, or null. Used after createOrder threw
   * (it may have committed) so the orphan can be failed. Throws on read error.
   */
  findOrderId(ctx: BotContext, token: string): Promise<string | null>
}

export function defaultPayBillsServices(): PayBillsServices {
  const runtime = async () => (await import("@/lib/bot-commission/runtime")).getBotBillsRuntime()
  return {
    async billers() {
      const bills = await (await runtime()).deps.getBillsConfig()
      if (!bills.enabled) return []
      return BILLER_KEYS.filter(k => bills.billers[k]?.enabled)
        .map(k => ({ key: k, min: bills.billers[k].min, max: bills.billers[k].max }))
    },
    async verify(ctx, input) {
      const [{ deps }, { botVerifyBill }] = await Promise.all([runtime(), import("@/lib/bot-commission/verify")])
      return botVerifyBill(deps, ctx, input)
    },
    async quote(ctx, biller, faceAmount) {
      const [{ deps }, { quoteBots }] = await Promise.all([runtime(), import("@/lib/cashback/quote")])
      const cfg = await deps.getCashbackConfig()
      return quoteBots({ serviceKey: BILLERS[biller].serviceKey, provider: "hubtel", faceAmount, rail: ctx.rail, shop: !!ctx.shopId }, cfg)
    },
    async createOrder(ctx, input) {
      const [{ deps }, { botCreateBillOrder }] = await Promise.all([runtime(), import("@/lib/bot-commission/orders")])
      return botCreateBillOrder(deps, ctx, input)
    },
    async findOrderId(ctx, token) {
      const [{ deps }, { resolveBotContext }, { billTokenHash }] = await Promise.all([
        runtime(), import("@/lib/bot-commission/context"), import("@/lib/bills/service"),
      ])
      const r = resolveBotContext(ctx)
      if (!r.ok) return null
      const row = await deps.findBotBillOrderByHash(r.ctx.botSurface, r.ctx.buyerPhone, billTokenHash(token))
      return row?.id ?? null
    },
  }
}

export interface MyVoucherOrder { id: string; exam_board: string; reference_code: string; created_at: string }

export interface RcServices {
  isBoardEnabled(board: ExamBoard): Promise<boolean>
  availableCount(board: ExamBoard): Promise<number>
  maxQuantity(): Promise<number>
  bulkHint(board: ExamBoard): Promise<{ minQty: number; bulkBasePrice: number } | null>
  price(board: ExamBoard, quantity: number, applyBulk: boolean): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean }>
  listMyVouchers(dialingPhone: string): Promise<MyVoucherOrder[]>
  /** SMS the vouchers again to the order's own customer_phone. */
  resendVouchers(orderId: string): Promise<{ success: boolean; message: string }>
  /** results_check_settings. A read error throws (the interaction route answers "Service unavailable"). */
  checkSettings(): Promise<{ enabled: boolean; fee: number }>
}

export function defaultRcServices(supabase: SupabaseClient): RcServices {
  return {
    isBoardEnabled: isExamBoardEnabled,
    availableCount: getAvailableCount,
    maxQuantity: getMaxQuantity,
    bulkHint: getRCBulkHint,
    price: async (examBoard, quantity, applyBulk) => {
      const r = await calculateRCPrice({ examBoard, quantity, applyBulk })
      return { unitPrice: r.unitPrice, totalPaid: r.totalPaid, bulkApplied: r.bulkApplied }
    },
    listMyVouchers: dialingPhone => listMyVouchers(supabase, dialingPhone),
    resendVouchers: async orderId => {
      const { resendVouchers } = await import("@/lib/results-checker-notification-service")
      return resendVouchers(orderId, "sms")
    },
    checkSettings: async () => {
      const { data, error } = await supabase.from("admin_settings").select("value").eq("key", "results_check_settings").maybeSingle()
      if (error) throw error
      const v = (data?.value ?? null) as { enabled?: unknown; fee?: unknown } | null
      // Same defaults as Uzo's getRcCheckSettings: enabled unless explicitly false; fee 2.00 unless a number.
      return { enabled: v?.enabled !== false, fee: typeof v?.fee === "number" ? v.fee : 2.0 }
    },
  }
}

/** Same query as Uzo's "My Vouchers" (completed, last 30 days, newest 5), matching every stored phone format. */
export async function listMyVouchers(supabase: SupabaseClient, dialingPhone: string): Promise<MyVoucherOrder[]> {
  const local = toLocalPhone(dialingPhone)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const filters = [...phoneVariants(dialingPhone).map(v => `dialing_phone.eq.${v}`), `customer_phone.eq.${local}`].join(",")
  const { data, error } = await supabase
    .from("results_checker_orders")
    .select("id, exam_board, reference_code, created_at")
    .or(filters)
    .eq("status", "completed")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(5)
  if (error) {
    console.error("[HUBTEL-RC] my vouchers query failed:", safeDbError(error))
    return []
  }
  return (data ?? []) as MyVoucherOrder[]
}

export interface AfaServices {
  /** Active default AFA price, or null when missing/invalid (AFA is then unavailable; never a fallback amount). */
  getPrice(): Promise<number | null>
}

export function defaultAfaServices(supabase: SupabaseClient): AfaServices {
  return { getPrice: () => getAfaPrice(supabase) }
}

/** Same query as submitAfaOrder (lib/afa-fulfillment.ts): the active row named 'default'. */
export async function getAfaPrice(supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()
  if (error) {
    console.error("[HUBTEL-AFA] price lookup failed:", safeDbError(error))
    return null
  }
  const price = data?.price != null ? Number(data.price) : NaN
  return Number.isFinite(price) && price > 0 ? price : null
}
