import { createHash, timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { ingestForwardedSms } from "@/lib/momo-claim/ingest"
import { loadMomoClaimSettings } from "@/lib/momo-claim/settings"

// Send & Claim: the SMS forwarder app on the business phone POSTs every MoMo SMS here.
// Auth is the x-sms-forward-secret header only (never the query string). Everything after auth lives in
// lib/momo-claim/ingest.ts. Status: 401 bad auth; 503 when the SMS could not be stored (the forwarder
// retries; a stored txid then comes back as a harmless duplicate); 200 { ok: true } otherwise.
// Never log or echo the SMS: it holds payer names, phone numbers and amounts.
export const dynamic = "force-dynamic"

const TAG = "[SMS-FORWARD]"
const MAX_BODY_BYTES = 16_384
const TEXT_FIELDS = ["text", "body", "message", "sms", "content"] as const
const FROM_FIELDS = ["from", "sender"] as const

const ok = () => NextResponse.json({ ok: true })
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 })
const unavailable = () => NextResponse.json({ error: "unavailable" }, { status: 503 })

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest()

function authorized(request: NextRequest): boolean {
  const secret = process.env.SMS_FORWARD_SECRET
  if (!secret) return false
  const given = request.headers.get("x-sms-forward-secret")
  if (!given) return false
  return timingSafeEqual(sha256(given), sha256(secret))
}

function firstString(src: (k: string) => unknown, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = src(k)
    if (typeof v === "string" && v.trim().length > 0) return v
  }
  return null
}

/** { text, from } from a JSON or form-encoded body; null when there is nothing usable. */
async function readInput(request: NextRequest): Promise<{ text: string; from: string | null } | null> {
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
  return { text, from: firstString(get, FROM_FIELDS) }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return unauthorized()

  const input = await readInput(request)
  if (!input) return ok()

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) {
    console.error(`${TAG} service role key missing; SMS not stored`)
    return unavailable()
  }

  try {
    const settings = await loadMomoClaimSettings(supabaseAdmin)
    await ingestForwardedSms(supabaseAdmin, input, settings)
  } catch (err) {
    // Name and PostgREST/PG code only: an error message can carry the full txid or SMS text.
    const e = (err && typeof err === "object" ? err : {}) as { name?: unknown; code?: unknown }
    const safe = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "-")
    console.error(`${TAG} SMS could not be stored name=${safe(e.name)} code=${safe(e.code)}`)
    return unavailable()
  }
  return ok()
}
