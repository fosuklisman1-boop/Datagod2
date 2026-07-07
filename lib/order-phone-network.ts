// Pure, DB-free logic for the all-time order phone export.
// Consumes the pre-aggregated rows from the get_all_order_phones() SQL function
// and groups phone numbers into per-network buckets, inferring the network for
// the order types that don't carry one (AFA, results-checker).
import { detectGhanaNetwork } from './phone-format'

/** The 9 order-bearing tables the export must cover. Kept in lockstep with the
 *  all_order_phones view. Adding a 10th order table means updating BOTH. */
export const ORDER_SOURCE_TABLES = [
  'orders',
  'shop_orders',
  'api_orders',
  'ussd_orders',
  'ussd_shop_orders',
  'airtime_orders',
  'afa_orders',
  'ussd_afa_orders',
  'results_checker_orders',
] as const

/** Order tables that have NO network column — network is inferred for these. */
export const NO_NETWORK_SOURCES = ['afa_orders', 'ussd_afa_orders', 'results_checker_orders'] as const

/** AFA is an MTN government scheme; its unknown-network phones default to MTN. */
export const AFA_SOURCES = ['afa_orders', 'ussd_afa_orders'] as const

/** Workbook sheet names, in display order. */
export const NETWORK_SHEETS = [
  'MTN', 'Telecel', 'AT', 'AT - iShare', 'AT - BigTime', 'Unknown',
] as const
export type NetworkSheet = (typeof NETWORK_SHEETS)[number]

/** One pre-aggregated row from get_all_order_phones(). */
export interface RawPhoneRow {
  source_table: string
  product_type: string // 'data' | 'airtime' | 'afa' | 'results'
  network_raw: string | null
  phone: string // normalized 0XXXXXXXXX, or the raw value when normalized === false
  normalized: boolean
  order_count: number
  first_order_at: string | null
  last_order_at: string | null
}

/** One deduplicated phone entry within a network sheet. */
export interface PhoneEntry {
  phone: string
  orderCount: number
  firstOrderAt: string | null
  lastOrderAt: string | null
  products: string[] // sorted unique product types
}
