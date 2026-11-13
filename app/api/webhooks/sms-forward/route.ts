import { createHash, timingSafeEqual } from "crypto"
import { after, NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { ingestForwardedSms } from "@/lib/momo-claim/ingest"
import { loadMomoClaimSettings } from "@/lib/momo-claim/settings"
import { isValidGhanaMobile, normalizeGhanaPhone } from "@/lib/phone-format"
import { acceptInbound, processInbound } from "@/lib/text-to-buy/handle-inbound"
import { parseReceived } from "@/lib/text-to-buy/parse-received"
import { loadTtbSettings, type TtbSettings } from "@/lib/text-to-buy/settings"
import { touchHeartbeat } from "@/lib/text-to-buy/store"
import type { Line } from "@/lib/text-to-buy/types"

// The SMS forwarder app on the business phone POSTs every SMS here. Two lanes share the URL:
//  - Send & Claim: MoMo payment notices from an allow-listed sender (primary secret only). Lives in lib/momo-claim/ingest.ts.
//  - Text-to-Buy: a text from an ordinary Ghana mobile number is an order request (lib/text-to-buy), only when ttb_main_enabled.
// Auth is the x-sms-forward-secret header only (never the query string). Status: 401 bad auth; 503 when the SMS could not be
// stored (the forwarder retries; a stored txid or a duplicate text then comes back as harmless); 200 { ok: true } otherwise.
// Never log or echo the SMS: it holds payer names, phone numbers and amounts.
export const dynamic = "force-dynamic"
export const maxDuration = 60

const TAG = "[SMS-FORWARD]"
const MAX_BODY_BYTES = 16_384
const TEXT_FIELDS = ["text", "body", "message", "sms", "content"] as const
const FROM_FIELDS = ["from", "sender"] as const
const RECEIVED_FIELDS = ["received", "time", "receive_time", "date"] as const

const ok = () => NextResponse.json({ ok: true })
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 })
const unavailable = () => NextResponse.json({ error: "unavailable" }, { status: 503 })

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest()

function matches(given: string | null, secret: string | undefined): boolean {
  if (!secret || !given) return false
  return timingSafeEqual(sha256(given), sha256(secret))
}

/** Which secret the header carries. Both comparisons always run; identical secrets resolve to the MoMo-lane source. */
function resolveSource(request: NextRequest): { line: Line; momoLane: boolean } | null {
  const given = request.headers.get("x-sms-forward-secret")
  const primary = matches(given, process.env.SMS_FORWARD_SECRET)
  const mainOnly = matches(given, process.env.SMS_FORWARD_SECRET_MAIN)
  if (primary) return { line: "main", momoLane: true }
  if (mainOnly) return { line: "main", momoLane: false }
  return null
}

function firstString(src: (k: string) => unknown, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = src(k)
    if (typeof v === "string" && v.trim().length > 0) return v
  }
  return null
}

/** The first alias holding a non-empty string or a finite number (JSON numbers and form strings both occur). */
function firstScalar(src: (k: string) => unknown, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = src(k)
    if (typeof v === "string" && v.trim().length > 0) return v
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return null
}

/** { text, from, received } (received still raw) from a JSON or form-encoded body; null when there is nothing usable. */
async function readFields(request: NextRequest): Promise<{ text: string; from: string | null; received: unknown } | null> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase()
  if (type.includes("multipart/")) return null

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return null
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null

  let get: (k: string) => unknown
  const looksJson = type.includes("json") || (!type.includes("x-www-form-urlencoded") && raw.trimStart().startsWith("{"))
  if (looksJson) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    get = (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined)
  } else {
    const params = new URLSearchParams(raw)
    get = (k) => params.get(k) ?? undefined
  }

  const text = firstString(get, TEXT_FIELDS)
  if (!text) return null
  return { text, from: firstString(get, FROM_FIELDS), received: firstScalar(get, RECEIVED_FIELDS) }
}

/** { text, from, received } from a JSON or form-encoded body; null when there is nothing usable. */
async function readInput(request: NextRequest): Promise<{ text: string; from: string | null; received: Date | null } | null> {
  const raw = await readFields(request)
  if (!raw) return null
  return { text: raw.text, from: raw.from, received: parseReceived(raw.received, new Date()) }
}

// Name and PostgREST/PG code only: an error message can carry the full txid, SMS text or a phone number.
const safe = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "-")
const errParts = (err: unknown) => {
  const e = (err && typeof err === "object" ? err : {}) as { name?: unknown; code?: unknown }
  return { name: safe(e.name), code: safe(e.code) }
}

/** A customer's own number as local 0XXXXXXXXX: only 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX. Never a sender name or short code. */
function customerPhone(from: string | null): string | null {
  const s = from?.trim() ?? ""
  if (!/^\+?\d+$/.test(s)) return null
  if (!isValidGhanaMobile(s)) return null
  return normalizeGhanaPhone(s)
}

export async function POST(request: NextRequest) {
  const source = resolveSource(request)
  if (!source) return unauthorized()

  const input = await readInput(request)
  if (!input) return ok()

  const db = supabaseAdmin
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !db) {
    console.error(`${TAG} service role key missing; SMS not stored`)
    return unavailable()
  }

  // The business phone is alive. Best effort: never fail the request over it.
  try {
    await touchHeartbeat(db, source.line, new Date())
  } catch (err) {
    const p = errParts(err)
    console.error(`${TAG} heartbeat not recorded name=${p.name} code=${p.code}`)
  }

  // Send & Claim input: exactly {text, from}, as before the order lane existed.
  const momoInput = { text: input.text, from: input.from }
  const ingest = async (settings: Awaited<ReturnType<typeof loadMomoClaimSettings>>): Promise<NextResponse> => {
    try {
      await ingestForwardedSms(db, momoInput, settings)
    } catch (err) {
      const p = errParts(err)
      console.error(`${TAG} SMS could not be stored name=${p.name} code=${p.code}`)
      return unavailable()
    }
    return ok()
  }

  // 1. Sender allowlist, exact match, first: a payment notice always goes to Send & Claim (primary secret only).
  let momoSettings: Awaited<ReturnType<typeof loadMomoClaimSettings>> | null = null
  if (source.momoLane) {
    try {
      momoSettings = await loadMomoClaimSettings(db)
    } catch (err) {
      const p = errParts(err)
      console.error(`${TAG} SMS could not be stored name=${p.name} code=${p.code}`)
      return unavailable()
    }
    const from = input.from?.trim() ?? ""
    const allowed = momoSettings.senderAllowlist.map((s) => s.trim()).filter((s) => s.length > 0)
    if (from.length > 0 && allowed.includes(from)) return await ingest(momoSettings)
  }

  // 2. The order lane: only a customer's own Ghana mobile number, only with the switch on.
  const phone = customerPhone(input.from)
  if (phone) {
    let ttb: TtbSettings | null = null
    try {
      ttb = await loadTtbSettings(db)
    } catch {
      ttb = null // unreadable settings mean off
    }
    if (ttb?.mainEnabled === true) {
      const text = input.text
      const receivedAt = input.received
      let accepted: { id: string; duplicate: boolean; processed: boolean }
      try {
        accepted = await acceptInbound(db, { line: source.line, from: phone, text, receivedAt, now: new Date() })
      } catch (err) {
        const p = errParts(err)
        console.error(`${TAG} order text could not be stored name=${p.name} code=${p.code}`)
        return unavailable()
      }
      if (!accepted.duplicate || !accepted.processed) {
        const settings = ttb
        after(async () => {
          try {
            // The real time processing starts, not the webhook receive time: every window is computed from it.
            await processInbound(db, accepted.id, { line: source.line, from: phone, text, receivedAt, now: new Date() }, settings)
          } catch (err) {
            console.error(`${TAG} order text processing failed id=${safe(accepted.id)} name=${errParts(err).name}`)
          }
        })
      }
      return ok()
    }
  }

  // 3. Everything else: Send & Claim as today (stores a rejected_sender row); the main-only secret stores nothing.
  if (momoSettings) return await ingest(momoSettings)
  return ok()
}
