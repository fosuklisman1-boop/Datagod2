import { NextRequest, NextResponse } from "next/server"
import { verifySig } from "@/lib/hubtel-cs/callback"
import { confirmHubtelPayment } from "@/lib/hubtel-pay/confirm"

// Hubtel payments callback (URL built by hubtelCallbackUrl in lib/hubtel-pay/client.ts: ?ref=<32 hex>&sig=<HMAC>).
// Hubtel never signs callbacks, so the per-reference HMAC is the only authentication. The body is NEVER trusted:
// a valid callback only names a reference, and confirmHubtelPayment decides paid/failed from the relay status check.
// Every authenticated request answers 200 { received: true } (even when confirm throws) so Hubtel stops retrying;
// the 5-minute sweep (app/api/cron/hubtel-payments-sweep) is the backstop.
export const dynamic = "force-dynamic"
// Well under the 10-minute confirming-claim window.
export const maxDuration = 120

const REF_RE = /^[0-9a-f]{32}$/
const TAG = "[HUBTEL-PAYMENTS-CALLBACK]"

const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 })

/** PII-free summary of the callback body: the response code and status words only, never phones or names. */
function summarise(body: unknown): string {
  if (!body || typeof body !== "object") return "body=unparsed"
  const b = body as Record<string, unknown>
  const d = (b.Data && typeof b.Data === "object" ? b.Data : {}) as Record<string, unknown>
  const word = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 30) : "-")
  return `code=${word(b.ResponseCode)} status=${word(d.Status ?? b.Status)}`
}

export async function POST(request: NextRequest) {
  const ref = request.nextUrl.searchParams.get("ref")
  const sig = request.nextUrl.searchParams.get("sig")
  if (!ref || !REF_RE.test(ref)) return unauthorized()

  const secret = process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
  if (!secret || secret.length < 32) {
    console.error(`${TAG} HUBTEL_PAYMENTS_CALLBACK_SECRET is not configured (must be at least 32 chars); callback not processed`)
    return NextResponse.json({ error: "not configured" }, { status: 503 })
  }
  if (!verifySig(ref, sig, secret)) {
    console.warn(`${TAG} bad signature ref=${ref}`)
    return unauthorized()
  }

  let body: unknown = null
  try { body = await request.json() } catch { /* logging only; the body never decides anything */ }

  try {
    const outcome = await confirmHubtelPayment(ref)
    console.log(`${TAG} ref=${ref} ${summarise(body)} outcome=${outcome}`)
  } catch (err) {
    console.error(`${TAG} confirm failed for ref=${ref}:`, err instanceof Error ? err.message : "unknown error")
  }
  return NextResponse.json({ received: true }, { status: 200 })
}
