import type { HubtelCsKind } from "./types"

export type HubtelCsServiceKey =
  | "airtime_mtn" | "airtime_telecel" | "airtime_at"
  | "data_mtn" | "data_telecel" | "data_at"
  | "bill_ecg" | "bill_ghana_water" | "bill_dstv" | "bill_gotv" | "bill_startimes" | "bill_telecel_broadband"

export interface HubtelCsService {
  key: HubtelCsServiceKey
  label: string
  /** The 32-hex ServiceID in the Commission Services URL. */
  serviceId: string
  kind: HubtelCsKind
  network: "mtn" | "telecel" | "at" | null
  /** A GET query endpoint exists (bundle list / account lookup). */
  hasQuery: boolean
  /** The POST needs Extradata.bundle (bundle value, meter number or broadband account). */
  needsBundle: boolean
  /** Hubtel's documented per-request cap. */
  maxAmount?: number
  /** Initial per-service switch (the master switch still ships off). */
  defaultEnabled: boolean
}

export const HUBTEL_CS_SERVICES: Record<HubtelCsServiceKey, HubtelCsService> = {
  airtime_mtn:     { key: "airtime_mtn",     label: "MTN Airtime",     serviceId: "fdd76c884e614b1c8f669a3207b09a98", kind: "airtime", network: "mtn",     hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  airtime_telecel: { key: "airtime_telecel", label: "Telecel Airtime", serviceId: "f4be83ad74c742e185224fdae1304800", kind: "airtime", network: "telecel", hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  airtime_at:      { key: "airtime_at",      label: "AirtelTigo Airtime", serviceId: "dae2142eb5a14c298eace60240c09e4b", kind: "airtime", network: "at",    hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  data_mtn:        { key: "data_mtn",        label: "MTN Data",        serviceId: "b230733cd56b4a0fad820e39f66bc27c", kind: "data",    network: "mtn",     hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  data_telecel:    { key: "data_telecel",    label: "Telecel Data",    serviceId: "fa27127ba039455da04a2ac8a1613e00", kind: "data",    network: "telecel", hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  data_at:         { key: "data_at",         label: "AirtelTigo Data", serviceId: "06abd92da459428496967612463575ca", kind: "data",    network: "at",      hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  bill_ecg:        { key: "bill_ecg",        label: "ECG (Prepaid & Postpaid)", serviceId: "e6d6bac062b5499cb1ece1ac3d742a84", kind: "bill", network: null, hasQuery: true, needsBundle: true,  defaultEnabled: true },
  bill_ghana_water:{ key: "bill_ghana_water",label: "Ghana Water",     serviceId: "6c1e8a82d2e84feeb8bfd6be2790d71d", kind: "bill",    network: null,      hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  bill_dstv:       { key: "bill_dstv",       label: "DSTV",            serviceId: "297a96656b5846ad8b00d5d41b256ea7", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_gotv:       { key: "bill_gotv",       label: "GOtv",            serviceId: "e6ceac7f3880435cb30b048e9617eb41", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_startimes:  { key: "bill_startimes",  label: "StarTimes TV",    serviceId: "6598652d34ea4112949c93c079c501ce", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_telecel_broadband: { key: "bill_telecel_broadband", label: "Telecel Broadband", serviceId: "b9a1aa246ba748f9ba01ca4cdbb3d1d3", kind: "bill", network: null, hasQuery: true, needsBundle: true, defaultEnabled: false },
}

export const HUBTEL_CS_SERVICE_KEYS = Object.keys(HUBTEL_CS_SERVICES) as HubtelCsServiceKey[]

export function isServiceKey(v: unknown): v is HubtelCsServiceKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HUBTEL_CS_SERVICES, v)
}

export function getService(key: HubtelCsServiceKey): HubtelCsService {
  if (!isServiceKey(key)) throw new Error(`Unknown Hubtel service: ${String(key)}`)
  return HUBTEL_CS_SERVICES[key]
}
