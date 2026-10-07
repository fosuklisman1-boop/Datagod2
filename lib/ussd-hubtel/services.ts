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

export { resolveDialer }
export type { DialerInfo }

export interface AirtimeServices {
  isEnabled(network: string): Promise<boolean>
  getLimits(): Promise<{ min: number; max: number }>
  /** Platform fee rate (%) for the network; dealers and sub-agents pay the dealer rate. */
  feeRate(network: string, isDealer: boolean): Promise<number>
}

export function defaultAirtimeServices(): AirtimeServices {
  return { isEnabled: isAirtimeEnabled, getLimits: getAirtimeLimits, feeRate: airtimeBaseFeeRate }
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
