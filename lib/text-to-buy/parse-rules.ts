import { digitsOnly, normalizeGhanaPhone } from "@/lib/phone-format"
import type { Keyword, NetworkHint, ReadResult } from "./types"

// A Ghana number as people type it: 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX,
// with single spaces or dashes between digits. It may not touch another digit
// on either side, so 9- and 11-digit runs never match.
const NUMBER_RE = /(?<!\d)(?:\+?\s?233|0)[\s-]?(?:\d[\s-]?){8}\d(?!\d)/g

function matchNumbers(text: string): { raw: string; phone: string }[] {
  const out: { raw: string; phone: string }[] = []
  for (const m of text.matchAll(NUMBER_RE)) {
    const digits = digitsOnly(m[0])
    if (digits.length !== 10 && digits.length !== 12) continue
    const phone = normalizeGhanaPhone(digits)
    if (phone) out.push({ raw: m[0], phone })
  }
  return out
}

/** Valid Ghana mobile numbers in the text, local 0XXXXXXXXX form, in order of appearance. */
export function extractGhanaNumbers(text: string): string[] {
  return matchNumbers(text).map((n) => n.phone)
}

// Maps, not plain objects: customer text must never match inherited names like "constructor".
const KEYWORDS = new Map<string, Keyword>([
  ["prices", "PRICES"],
  ["menu", "PRICES"],
  ["price list", "PRICES"],
  ["again", "AGAIN"],
  ["status", "STATUS"],
  ["help", "HELP"],
  ["yes", "YES"],
  ["y", "YES"],
])

const NETWORKS = new Map<string, NetworkHint>([
  ["mtn", "MTN"],
  ["telecel", "Telecel"],
  ["voda", "Telecel"],
  ["vodafone", "Telecel"],
  ["at", "AT"],
  ["airteltigo", "AT"],
  ["ishare", "AT-iShare"],
  ["bigtime", "AT-BigTime"],
])

const NET = "(mtn|telecel|vodafone|voda|airteltigo|ishare|bigtime|at)"
const SIZE = "(\\d+(?:\\.\\d+)?)\\s*(gb|gigs|gig|g|mb)?"
const GRAMMAR = new RegExp(`^(?:${NET}\\s+)?${SIZE}(?:\\s+${NET})?$`)

const UNKNOWN: ReadResult = { kind: "unknown" }

/** The text with every Ghana phone number removed (so their digits are never read as an amount or a size). */
export function stripGhanaNumbers(text: string): string {
  let out = text
  for (const n of matchNumbers(text)) out = out.replace(n.raw, " ")
  return out
}

/** Words that mean "airtime"; one of these anywhere makes a text an airtime text. */
export const AIRTIME_WORD_RE = /\b(?:airtime|credit(?!\s+cards?\b)|recharge|topup|top\s?up)\b/gi
/** Any data unit or the word "data": in an airtime text it means the customer asked for data. */
export const DATA_WORD_RE =
  /\d\s*(?:gbs?|gigs?|gigabytes?|g|mbs?|megabytes?)\b|\b(?:gbs?|gigs?|gigabytes?|g|mbs?|megabytes?|data|bundles?)\b/i

const AIRTIME_NET = "(mtn|telecel|vodafone|voda|airteltigo|at)"
const AIRTIME_AMOUNT = "(?:(?:ghs|ghc|gh)\\s?)?(\\d+(?:\\.\\d{1,2})?)(?:\\s?(?:ghs|ghc|cedis|cedi))?"
const AIRTIME_GRAMMAR = new RegExp(`^(?:${AIRTIME_NET}\\s+)?${AIRTIME_AMOUNT}(?:\\s+${AIRTIME_NET})?$`)

/** Airtime grammar on a lower-cased, phone-free text. null when there is no airtime word at all, else a read or unknown. */
function parseAirtime(rest: string, recipient: string | null): ReadResult | null {
  const words = rest.match(AIRTIME_WORD_RE) ?? []
  if (words.length === 0) return null
  if (words.length > 1 || DATA_WORD_RE.test(rest)) return UNKNOWN
  const left = rest.replace(AIRTIME_WORD_RE, " ").replace(/\s+/g, " ").trim()
  const m = AIRTIME_GRAMMAR.exec(left)
  if (!m) return UNKNOWN
  const [, netBefore, amount, netAfter] = m
  if (netBefore && netAfter) return UNKNOWN
  const amountGhs = Number(amount)
  if (!Number.isFinite(amountGhs) || amountGhs <= 0) return UNKNOWN
  const net = netBefore ?? netAfter
  return {
    kind: "order",
    service: "airtime",
    amountGhs,
    networkHint: net ? (AIRTIME_NETWORKS.get(net) ?? null) : null,
    recipient,
  }
}

const AIRTIME_NETWORKS = new Map<string, "MTN" | "Telecel" | "AT">([
  ["mtn", "MTN"], ["telecel", "Telecel"], ["voda", "Telecel"], ["vodafone", "Telecel"], ["airteltigo", "AT"], ["at", "AT"],
])

/** Exam board words as people type them: "nov dec", "nov/dec" and "novdec" all mean NOVDEC. */
export const BOARD_WORD_RE = /\b(?:wassce|bece|nov[\s/]?dec)\b/gi
/** Words that mean "results checker voucher". */
export const CHECKER_WORD_RE = /\b(?:checkers?|vouchers?)\b/gi
const NETWORK_WORD_RE = /\b(?:mtn|telecel|vodafone|voda|airteltigo|ishare|bigtime|at)\b/i

/** The board a board word names. */
export function boardOfWord(word: string): "WASSCE" | "BECE" | "NOVDEC" {
  const w = word.toLowerCase()
  return w === "wassce" ? "WASSCE" : w === "bece" ? "BECE" : "NOVDEC"
}

const VOUCHER_QTY = /^(?:(\d{1,3})\s*x?\s*)?(.*)$/

/** Voucher grammar on a lower-cased, phone-free text. null when there is no board or checker word, else a read or unknown. */
function parseVoucher(rest: string, hadPhone: boolean): ReadResult | null {
  const boards = rest.match(BOARD_WORD_RE) ?? []
  const checkers = rest.match(CHECKER_WORD_RE) ?? []
  if (boards.length === 0 && checkers.length === 0) return null
  if (hadPhone || boards.length > 1 || checkers.length > 1) return UNKNOWN
  if (DATA_WORD_RE.test(rest) || NETWORK_WORD_RE.test(rest)) return UNKNOWN
  const m = VOUCHER_QTY.exec(rest)
  if (!m) return UNKNOWN
  const [, digits, remainder] = m
  if (remainder.replace(BOARD_WORD_RE, " ").replace(CHECKER_WORD_RE, " ").trim() !== "") return UNKNOWN
  let quantity = 1
  if (digits !== undefined) {
    quantity = Number(digits)
    if (/^0/.test(digits) || quantity < 1 || quantity > 100) return UNKNOWN
  } else if (/^(?:checkers|vouchers)$/.test(checkers[0] ?? "")) {
    return UNKNOWN // a plural checker word with no number: how many?
  }
  return { kind: "order", service: "results_checker", board: boards[0] ? boardOfWord(boards[0]) : null, quantity }
}

/** Rules-only reader. Never guesses: anything outside the grammar is "unknown". */
export function parseOrderText(text: string): ReadResult {
  const cleaned = (text ?? "").trim().toLowerCase().replace(/[.!?,]+$/, "").trim()
  if (!cleaned) return UNKNOWN

  const keyword = KEYWORDS.get(cleaned)
  if (keyword) return { kind: "keyword", keyword }

  const numbers = matchNumbers(cleaned)
  if (numbers.length > 1) return UNKNOWN
  let rest = cleaned
  if (numbers.length === 1) rest = rest.replace(numbers[0].raw, " ")
  rest = rest.replace(/\s+/g, " ").trim()

  const airtime = parseAirtime(rest, numbers.length === 1 ? numbers[0].phone : null)
  if (airtime) return airtime

  const voucher = parseVoucher(rest, numbers.length === 1)
  if (voucher) return voucher

  const m = GRAMMAR.exec(rest)
  if (!m) return UNKNOWN
  const [, netBefore, amount, unit, netAfter] = m
  if (netBefore && netAfter) return UNKNOWN

  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return UNKNOWN

  let sizeMb: number
  let bare = false
  if (unit === "mb") {
    sizeMb = Math.round(value)
  } else {
    if (!unit && (!Number.isInteger(value) || value < 1 || value > 100)) return UNKNOWN
    sizeMb = Math.round(value * 1000)
    bare = !unit && numbers.length === 0 && !netBefore && !netAfter
  }
  if (sizeMb <= 0) return UNKNOWN

  const net = netBefore ?? netAfter
  return {
    kind: "order",
    service: "data",
    sizeMb,
    networkHint: net ? NETWORKS.get(net) ?? null : null,
    recipient: numbers.length === 1 ? numbers[0].phone : null,
    bare,
  }
}
