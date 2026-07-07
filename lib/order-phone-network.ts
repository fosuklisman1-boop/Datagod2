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

/** Map a canonical network_raw string to one of the workbook sheets. */
function networkRawToSheet(networkRaw: string): NetworkSheet {
  return (NETWORK_SHEETS as readonly string[]).includes(networkRaw)
    ? (networkRaw as NetworkSheet)
    : 'Unknown'
}

/** Map lib/phone-format's detectGhanaNetwork output to a workbook sheet. */
function prefixToSheet(phone: string): NetworkSheet {
  switch (detectGhanaNetwork(phone)) {
    case 'MTN': return 'MTN'
    case 'TELECEL': return 'Telecel'
    case 'AT': return 'AT'
    default: return 'Unknown'
  }
}

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
function later(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/**
 * Group pre-aggregated rows into per-network sheets.
 * Precedence for a phone's network:
 *   1. Known-network-wins — any network the phone was actually seen on.
 *   2. AFA source with no known network -> MTN.
 *   3. Otherwise infer from the phone prefix.
 *   4. Unknown prefix / un-normalizable -> Unknown. Nothing is dropped.
 */
export function groupPhonesByNetwork(rows: RawPhoneRow[]): Map<NetworkSheet, PhoneEntry[]> {
  // Step 1: known-network map (only rows that actually carry a network).
  const known = new Map<string, Set<NetworkSheet>>()
  for (const r of rows) {
    if (r.network_raw == null) continue
    const sheet = networkRawToSheet(r.network_raw)
    if (!known.has(r.phone)) known.set(r.phone, new Set())
    known.get(r.phone)!.add(sheet)
  }

  // Step 2: accumulate into (sheet -> phone -> entry).
  const acc = new Map<NetworkSheet, Map<string, PhoneEntry & { _products: Set<string> }>>()
  for (const s of NETWORK_SHEETS) acc.set(s, new Map())

  const addTo = (sheet: NetworkSheet, r: RawPhoneRow) => {
    const bucket = acc.get(sheet)!
    let e = bucket.get(r.phone)
    if (!e) {
      e = { phone: r.phone, orderCount: 0, firstOrderAt: null, lastOrderAt: null,
            products: [], _products: new Set<string>() }
      bucket.set(r.phone, e)
    }
    e.orderCount += Number(r.order_count) || 0
    e.firstOrderAt = earlier(e.firstOrderAt, r.first_order_at)
    e.lastOrderAt = later(e.lastOrderAt, r.last_order_at)
    e._products.add(r.product_type)
  }

  for (const r of rows) {
    if (r.network_raw != null) {
      addTo(networkRawToSheet(r.network_raw), r)
      continue
    }
    // No network on this row: resolve via precedence.
    const knownSheets = known.get(r.phone)
    if (knownSheets && knownSheets.size > 0) {
      for (const s of knownSheets) addTo(s, r)
    } else if ((AFA_SOURCES as readonly string[]).includes(r.source_table)) {
      addTo('MTN', r)
    } else {
      addTo(prefixToSheet(r.phone), r)
    }
  }

  // Step 3: finalize — resolve products, sort by orderCount desc then phone.
  const out = new Map<NetworkSheet, PhoneEntry[]>()
  for (const s of NETWORK_SHEETS) {
    const entries = [...acc.get(s)!.values()].map(e => ({
      phone: e.phone,
      orderCount: e.orderCount,
      firstOrderAt: e.firstOrderAt,
      lastOrderAt: e.lastOrderAt,
      products: [...e._products].sort(),
    }))
    entries.sort((a, b) => b.orderCount - a.orderCount || a.phone.localeCompare(b.phone))
    out.set(s, entries)
  }
  return out
}
