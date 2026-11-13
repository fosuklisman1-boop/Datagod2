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

const KEYWORDS: Record<string, Keyword> = {
  prices: "PRICES",
  menu: "PRICES",
  "price list": "PRICES",
  again: "AGAIN",
  status: "STATUS",
  help: "HELP",
  yes: "YES",
  y: "YES",
}

const NETWORKS: Record<string, NetworkHint> = {
  mtn: "MTN",
  telecel: "Telecel",
  voda: "Telecel",
  vodafone: "Telecel",
  at: "AT",
  airteltigo: "AT",
  ishare: "AT-iShare",
  bigtime: "AT-BigTime",
}

const NET = "(mtn|telecel|vodafone|voda|airteltigo|ishare|bigtime|at)"
const SIZE = "(\\d+(?:\\.\\d+)?)\\s*(gb|gigs|gig|g|mb)?"
const GRAMMAR = new RegExp(`^(?:${NET}\\s+)?${SIZE}(?:\\s+${NET})?$`)

const UNKNOWN: ReadResult = { kind: "unknown" }

/** Rules-only reader. Never guesses: anything outside the grammar is "unknown". */
export function parseOrderText(text: string): ReadResult {
  const cleaned = (text ?? "").trim().toLowerCase().replace(/[.!?,]+$/, "").trim()
  if (!cleaned) return UNKNOWN

  const keyword = KEYWORDS[cleaned]
  if (keyword) return { kind: "keyword", keyword }

  const numbers = matchNumbers(cleaned)
  if (numbers.length > 1) return UNKNOWN
  let rest = cleaned
  if (numbers.length === 1) rest = rest.replace(numbers[0].raw, " ")
  rest = rest.replace(/\s+/g, " ").trim()

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
    networkHint: net ? NETWORKS[net] : null,
    recipient: numbers.length === 1 ? numbers[0].phone : null,
    bare,
  }
}
