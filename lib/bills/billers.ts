import type { HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import { ghanaSignificant, isValidGhanaMobile } from "@/lib/phone-format"

export type BillerKey = "ecg" | "ghana_water" | "dstv" | "gotv" | "startimes" | "telecel_broadband"
export const BILLER_KEYS: readonly BillerKey[] = ["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"]
export const isBillerKey = (v: unknown): v is BillerKey => typeof v === "string" && (BILLER_KEYS as readonly string[]).includes(v)

export interface BillerDef { key: BillerKey; label: string; serviceKey: HubtelCsServiceKey; logo: string; inputHint: string; page: "bills" | "broadband" }
const def = (key: BillerKey, label: string, serviceKey: HubtelCsServiceKey, inputHint: string, page: "bills" | "broadband" = "bills"): BillerDef =>
  ({ key, label, serviceKey, logo: `/billers/${key}.png`, inputHint, page })
export const BILLERS: Record<BillerKey, BillerDef> = {
  ecg: def("ecg", "ECG Prepaid & Postpaid", "bill_ecg", "Meter number"),
  ghana_water: def("ghana_water", "Ghana Water", "bill_ghana_water", "Meter number"),
  dstv: def("dstv", "DSTV", "bill_dstv", "Smartcard number"),
  gotv: def("gotv", "GOtv", "bill_gotv", "Smartcard number"),
  startimes: def("startimes", "StarTimes TV", "bill_startimes", "Account number"),
  telecel_broadband: def("telecel_broadband", "Telecel Broadband", "bill_telecel_broadband", "Landline + broadband account", "broadband"),
}

export interface BillInputs { phone?: string; account?: string; email?: string; broadbandAccount?: string }
export interface NormalisedInputs { account: string; phone: string | null; email: string | null; broadbandAccount: string | null }

const ACCOUNT = /^[A-Za-z0-9-]{4,30}$/
const LANDLINE = /^0\d{9}$/
const BROADBAND = /^[A-Za-z0-9]{3,20}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phone233 = (p: string) => "233" + ghanaSignificant(p)!

/** The email rule normaliseInputs applies to Ghana Water (exported so a step-by-step bot can check it as typed). */
export const isValidBillEmail = (email: unknown): boolean => EMAIL.test(String(email ?? "").trim())
/** The meter / smartcard / account rule normaliseInputs applies (spaces removed first). */
export const isValidBillAccount = (account: unknown): boolean => ACCOUNT.test(String(account ?? "").trim().replace(/ /g, ""))

export function normaliseInputs(biller: BillerKey, i: BillInputs): { ok: true; value: NormalisedInputs } | { ok: false; error: string } {
  const str = (x: unknown) => String(x ?? "").trim()
  const compact = (x: unknown) => str(x).replace(/ /g, "")
  const account = compact(i.account)
  const phoneRaw = str(i.phone)
  const needPhone = biller === "ecg" || biller === "ghana_water"
  if (needPhone && !isValidGhanaMobile(phoneRaw)) return { ok: false, error: "Enter a valid Ghana mobile number" }
  const phone = needPhone ? phone233(phoneRaw) : null
  if (biller === "ecg") {
    if (account && !ACCOUNT.test(account)) return { ok: false, error: "Enter a valid meter or account number" }
    return { ok: true, value: { account, phone, email: null, broadbandAccount: null } }
  }
  if (biller === "telecel_broadband") {
    const bb = compact(i.broadbandAccount)
    if (!LANDLINE.test(account)) return { ok: false, error: "Enter the 10-digit landline (e.g. 0302450262)" }
    if (!BROADBAND.test(bb)) return { ok: false, error: "Enter the broadband account number (e.g. P0444101)" }
    return { ok: true, value: { account, phone: null, email: null, broadbandAccount: bb } }
  }
  if (!ACCOUNT.test(account)) return { ok: false, error: `Enter a valid ${BILLERS[biller].inputHint.toLowerCase()}` }
  if (biller === "ghana_water") {
    const email = str(i.email)
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email (Ghana Water requires it)" }
    return { ok: true, value: { account, phone, email, broadbandAccount: null } }
  }
  return { ok: true, value: { account, phone: null, email: null, broadbandAccount: null } }
}

export function lookupRequest(biller: BillerKey, n: NormalisedInputs): { destination: string; mobile?: string } {
  if (biller === "ecg") return { destination: n.phone! }
  if (biller === "ghana_water") return { destination: n.account, mobile: n.phone! }
  return { destination: n.account }
}

export interface ParsedLookup {
  customerName: string | null
  amountDue: number | null
  sessionId: string | null
  meters: { meter: string; name: string | null; outstanding: number | null }[]
}
const num = (v: unknown): number | null => {
  const s = typeof v === "number" ? String(v) : String(v ?? "").replace(/,/g, "").trim()
  const n = Number(s)
  return s !== "" && Number.isFinite(n) ? n : null
}
const keyOf = (d: string) => d.trim().toLowerCase().replace(/[\s_-]/g, "")

export function parseLookup(biller: BillerKey, items: HubtelQueryItem[]): ParsedLookup {
  const out: ParsedLookup = { customerName: null, amountDue: null, sessionId: null, meters: [] }
  for (const it of Array.isArray(items) ? items : []) {
    const display = String(it?.Display ?? "")
    const value = String(it?.Value ?? "").trim()
    if (biller === "ecg") {
      if (!value) continue
      const name = display.trim().replace(/\s*\([^)]*\)\s*$/, "").trim()
      out.meters.push({ meter: value, name: name || null, outstanding: num(it?.Amount) })
      continue
    }
    const k = keyOf(display)
    if (k === "name") out.customerName = value || null
    else if (k === "amountdue") out.amountDue = num(value) ?? (biller === "ghana_water" ? num(it?.Amount) : null)
    else if (k === "sessionid") out.sessionId = value || null
  }
  return out
}

/** Plain positive decimal with at most 2 decimal places (no sign, exponent, spaces). */
export function isValidAmountInput(s: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(s)
}

export function suggestedAmount(amountDue: number | null): number {
  if (amountDue === null || !Number.isFinite(amountDue) || amountDue <= 0) return 0
  return Math.round(amountDue * 100) / 100
}

export function purchaseFields(
  biller: BillerKey,
  v: { account: string; phone: string | null; email: string | null; broadbandAccount: string | null; sessionId: string | null },
): { destination: string; bundle?: string; extra?: { email?: string; sessionId?: string } } {
  if (biller === "ecg") return { destination: v.phone!, bundle: v.account }
  if (biller === "ghana_water") return { destination: v.phone!, bundle: v.account, extra: { email: v.email!, sessionId: v.sessionId! } }
  if (biller === "telecel_broadband") return { destination: v.account, bundle: v.broadbandAccount! }
  return { destination: v.account }
}
