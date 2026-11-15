import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { handleMissedCall } from "@/lib/text-to-buy/call/decide"
import { defaultCallDeps } from "@/lib/text-to-buy/call/default-deps"
import { resolveForwardLine } from "@/lib/text-to-buy/forward-secrets"
import { parseReceived } from "@/lib/text-to-buy/parse-received"
import { loadTtbSettings } from "@/lib/text-to-buy/settings"
import { touchHeartbeat } from "@/lib/text-to-buy/store"

// The forwarder app on the business phone POSTs every missed call here (caller number + time). Text-to-Buy replies by SMS.
// Same x-sms-forward-secret header as the SMS webhook decides the line; this route has no MoMo (Send & Claim) lane at all.
// After a valid secret the answer is always 200 (the forwarder retries anything else); 401 only for bad auth.
// Never log the caller's number.
export const dynamic = "force-dynamic"
export const maxDuration = 60

const TAG = "[CALL-FORWARD]"
const MAX_BODY_BYTES = 16_384
const FROM_FIELDS = ["from", "sender", "number", "caller"] as const
const RECEIVED_FIELDS = ["received", "time", "receive_time", "date"] as const

const ok = () => NextResponse.json({ ok: true })
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 })

function firstScalar(src: (k: string) => unknown, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = src(k)
    if (typeof v === "string" && v.trim().length > 0) return v
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return null
}

/** { from, received } (received still raw) from a JSON or form-encoded body; null when there is nothing usable. */
async function readFields(request: NextRequest): Promise<{ from: string; received: unknown } | null> {
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

  const from = firstScalar(get, FROM_FIELDS)
  if (from === null) return null
  return { from: String(from), received: firstScalar(get, RECEIVED_FIELDS) }
}

// Name and PG code only: an error message can carry a phone number.
const safe = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "-")
const errParts = (err: unknown) => {
  const e = (err && typeof err === "object" ? err : {}) as { name?: unknown; code?: unknown }
  return { name: safe(e.name), code: safe(e.code) }
}

export async function POST(request: NextRequest) {
  const line = resolveForwardLine(process.env, request.headers.get("x-sms-forward-secret"))
  if (!line) return unauthorized()

  try {
    const fields = await readFields(request)
    if (!fields) return ok()

    const db = supabaseAdmin
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !db) {
      console.error(`${TAG} service role key missing; call not handled`)
      return ok()
    }

    // The business phone is alive. Best effort.
    try {
      await touchHeartbeat(db, line, new Date())
    } catch (err) {
      const p = errParts(err)
      console.error(`${TAG} heartbeat not recorded name=${p.name} code=${p.code}`)
    }

    const now = new Date()
    const received = parseReceived(fields.received, now)
    const settings = await loadTtbSettings(db)
    await handleMissedCall(defaultCallDeps(db, settings), {
      line,
      fromRaw: fields.from,
      receivedMs: received ? received.getTime() : null,
      nowMs: now.getTime(),
    })
  } catch (err) {
    const p = errParts(err)
    console.error(`${TAG} missed call not handled name=${p.name} code=${p.code}`)
  }
  return ok()
}
