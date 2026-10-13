import crypto from "crypto"
import { applyAndCommit } from "./apply"
import { applyCallback, parseCommission } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx, ParsedCallback } from "./types"

/** Hubtel's documented callback source IP. */
export const HUBTEL_CALLBACK_IPS = ["18.202.122.131"]

export function signRef(ref: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(ref).digest("hex")
}

export function verifySig(ref: string | null, sig: string | null, secret: string): boolean {
  if (!ref || !sig || !secret) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(signRef(ref, secret))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function buildCallbackUrl(baseUrl: string, ref: string, secret: string): string {
  const u = new URL("/api/hubtel-cs/callback", baseUrl)
  u.searchParams.set("ref", ref)
  u.searchParams.set("sig", signRef(ref, secret))
  return u.toString()
}

export function clientIpFromForwardedFor(header: string | null): string | null {
  const first = header?.split(",")[0]?.trim()
  return first ? first : null
}

export function isAllowedIp(ip: string | null, allowed: string[] = HUBTEL_CALLBACK_IPS): boolean {
  return !!ip && allowed.includes(ip)
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

export function parseCallbackBody(body: unknown): ParsedCallback | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, any>
  const d = (b.Data && typeof b.Data === "object" ? b.Data : {}) as Record<string, any>
  const code = b.ResponseCode !== undefined && b.ResponseCode !== null ? String(b.ResponseCode).trim() : ""
  const ref = str(d.ClientReference)
  if (!code || !ref) return null
  return {
    responseCode: code, clientReference: ref, transactionId: str(d.TransactionId), externalTransactionId: str(d.ExternalTransactionId),
    description: str(d.Description), amountDebited: num(d.AmountDebited), charges: num(d.Charges), commission: parseCommission(d.Meta?.Commission),
  }
}

export interface CallbackDeps {
  store: HubtelCsStore
  secret: string
  enforceIp: boolean
  onTransition: (tx: HubtelCsTx) => Promise<void>
  now?: () => Date
}

type Out = { status: number; body: Record<string, unknown> }

/**
 * Hubtel never signs callbacks, so the per-transaction HMAC in the callback URL is the
 * authentication. After auth we answer 200 for anything that cannot be retried into success
 * (unknown ref, duplicate) so Hubtel stops retrying; the status-check cron is the backstop.
 */
export async function processCallback(
  deps: CallbackDeps,
  input: { ref: string | null; sig: string | null; ip: string | null; rawBody: string }
): Promise<Out> {
  const now = deps.now ?? (() => new Date())
  if (!verifySig(input.ref, input.sig, deps.secret)) return { status: 401, body: { error: "unauthorized" } }
  if (deps.enforceIp && !isAllowedIp(input.ip)) return { status: 403, body: { error: "forbidden" } }
  const ref = input.ref as string

  let parsedJson: unknown
  try { parsedJson = JSON.parse(input.rawBody) } catch {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "invalid json", payload: { raw: input.rawBody.slice(0, 2000) }, source_ip: input.ip })
    return { status: 400, body: { error: "invalid json" } }
  }
  const cb = parseCallbackBody(parsedJson)
  if (!cb || cb.clientReference !== ref) {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "invalid or mismatched payload", payload: parsedJson, source_ip: input.ip })
    return { status: 400, body: { error: "invalid payload" } }
  }

  const tx = await deps.store.getByRef(ref)
  if (!tx) {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "unknown reference", payload: parsedJson, source_ip: input.ip })
    return { status: 200, body: { ok: false, error: "unknown reference" } }
  }

  const transition = applyCallback(tx, cb, now())
  const result = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  const ignored = "ignored" in transition ? transition.ignored : null
  await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: true, payload: parsedJson, error: ignored, source_ip: input.ip })
  return { status: 200, body: ignored ? { ok: true, ignored } : { ok: true, state: result.tx.state } }
}
