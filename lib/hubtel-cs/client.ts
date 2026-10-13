import crypto from "crypto"
import { applyAndCommit } from "./apply"
import { buildCallbackUrl } from "./callback"
import type { HubtelCsConfig, HubtelCsMode } from "./config"
import {
  HubtelDisabledError, HubtelDuplicateOrderError, HubtelNotConfiguredError, HubtelOutcomeUnknownError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"
import { ghanaSignificant, isValidGhanaMobile } from "../phone-format"
import { getService, type HubtelCsServiceKey } from "./services"
import { applyPostResponse, classifyCode, type PostResult } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTransport } from "./transport"
import type { HubtelCsTx, HubtelQueryItem } from "./types"

export interface PurchaseInput {
  serviceKey: HubtelCsServiceKey
  destination: string
  amount: number
  /** Bundle value / meter number / broadband account, exactly as Hubtel's query returned it. */
  bundle?: string
  extra?: { email?: string; sessionId?: string }
  orderTable?: string
  orderId?: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Airtime/data destinations must be 233XXXXXXXXX (Hubtel docs). Bill account numbers pass through untouched. */
function normalizeDestination(input: PurchaseInput): string {
  const kind = getService(input.serviceKey).kind
  const raw = input.destination.trim()
  if (kind === "airtime" || kind === "data") return "233" + ghanaSignificant(raw)!
  return raw
}
const isDuplicateInsert = (e: any) =>
  e?.code === "23505" || (e instanceof Error && /duplicate key value violates unique constraint/i.test(e.message) && /order_active/.test(e.message))
const hasTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6

export function validatePurchase(input: PurchaseInput): void {
  const svc = getService(input.serviceKey)
  if (!input.destination || !input.destination.trim()) throw new HubtelValidationError("destination is required")
  // Both or neither: a NULL order_table would let the per-order unique index be bypassed.
  if (!!input.orderTable !== !!input.orderId) throw new HubtelValidationError("orderTable and orderId must be provided together")
  if ((svc.kind === "airtime" || svc.kind === "data") && !isValidGhanaMobile(input.destination)) {
    throw new HubtelValidationError(`${svc.label} destination must be a valid Ghana mobile number`)
  }
  const a = input.amount
  if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) throw new HubtelValidationError("amount must be a positive number")
  if (!hasTwoDecimals(a)) throw new HubtelValidationError("amount may have at most 2 decimal places")
  if (svc.maxAmount !== undefined && Math.round(a * 100) > svc.maxAmount * 100) {
    throw new HubtelValidationError(`${svc.label} amount cannot exceed GHS ${svc.maxAmount}`)
  }
  if (svc.needsBundle && (!input.bundle || !input.bundle.length)) throw new HubtelValidationError(`${svc.label} requires a bundle / account value`)
  if (svc.key === "bill_ghana_water") {
    if (!input.extra?.email || !EMAIL.test(input.extra.email)) throw new HubtelValidationError("Ghana Water requires a valid customer email")
    if (!input.extra?.sessionId) throw new HubtelValidationError("Ghana Water requires the sessionId from the meter lookup")
  }
}

export function buildPurchaseBody(input: PurchaseInput, callbackUrl: string, ref: string): Record<string, unknown> {
  const svc = getService(input.serviceKey)
  const body: Record<string, unknown> = {
    Destination: normalizeDestination(input),
    Amount: Number(input.amount.toFixed(2)),
    CallbackUrl: callbackUrl,
    ClientReference: ref,
  }
  if (svc.needsBundle) {
    const extra: Record<string, unknown> = { bundle: input.bundle }
    if (svc.key === "bill_ghana_water") { extra.Email = input.extra!.email; extra.SessionId = input.extra!.sessionId }
    body.Extradata = extra
  }
  return body
}

export interface ClientDeps {
  store: HubtelCsStore
  getConfig(): Promise<HubtelCsConfig>
  getTransport(mode: HubtelCsMode): HubtelCsTransport
  callbackBaseUrl: string
  callbackSecret: string
  onFloat(reason: string): Promise<void>
  onTransition?: (tx: HubtelCsTx) => Promise<void>
  now?: () => Date
  newRef?: (k: HubtelCsServiceKey) => string
}

type QueryOut = { ok: true; data: HubtelQueryItem[]; label: string | null } | { ok: false; error: string; code?: string }

export function createHubtelCsClient(deps: ClientDeps) {
  const now = deps.now ?? (() => new Date())
  const newRef = deps.newRef ?? ((k: HubtelCsServiceKey) => `HCS-${k}-${crypto.randomBytes(8).toString("hex")}`)
  const onTransition = deps.onTransition ?? (async () => {})

  async function gate(serviceKey: HubtelCsServiceKey, opts: { checkPause: boolean }): Promise<HubtelCsConfig> {
    let cfg: HubtelCsConfig
    try {
      cfg = await deps.getConfig()
    } catch (e: any) {
      // Fail closed: if we cannot read the switches, treat the feature as disabled (no row, no POST).
      console.error("[hubtel-cs] config read failed; treating as disabled:", e?.message ?? e)
      throw new HubtelDisabledError()
    }
    if (!cfg.enabled) throw new HubtelDisabledError()
    if (!cfg.services[serviceKey]) throw new HubtelServiceDisabledError(serviceKey)
    if (opts.checkPause && cfg.paused) throw new HubtelPausedError(cfg.pausedReason)
    return cfg
  }

  return {
    /** Persist first, then call Hubtel exactly once. Unknown outcomes become needs_review and are never resent. */
    async purchase(input: PurchaseInput): Promise<HubtelCsTx> {
      const svc = getService(input.serviceKey)
      const cfg = await gate(input.serviceKey, { checkPause: true })
      validatePurchase(input)
      if (!deps.callbackSecret || !deps.callbackBaseUrl) {
        throw new HubtelNotConfiguredError([!deps.callbackSecret ? "HUBTEL_CS_CALLBACK_SECRET" : "", !deps.callbackBaseUrl ? "NEXT_PUBLIC_APP_URL" : ""].filter(Boolean))
      }
      const transport = deps.getTransport(cfg.mode) // may throw HubtelNotConfiguredError BEFORE any row exists

      const ref = newRef(input.serviceKey)
      const callbackUrl = buildCallbackUrl(deps.callbackBaseUrl, ref, deps.callbackSecret)
      const body = buildPurchaseBody(input, callbackUrl, ref)
      let row: HubtelCsTx
      try {
        row = await deps.store.insert({
          client_reference: ref, service_key: input.serviceKey, kind: svc.kind, destination: normalizeDestination(input),
          amount: Number(input.amount.toFixed(2)), bundle: input.bundle ?? null,
          extra: input.extra ? { email: input.extra.email ?? null, sessionId: input.extra.sessionId ?? null } : null,
          order_table: input.orderTable ?? null, order_id: input.orderId ?? null,
        })
      } catch (e) {
        if (isDuplicateInsert(e)) throw new HubtelDuplicateOrderError(input.orderTable ?? null, input.orderId ?? null)
        throw e
      }

      // The signature is never logged: it alone would let someone forge a callback for this reference.
      try {
        const logged = new URL(callbackUrl)
        logged.searchParams.delete("sig")
        await deps.store.logEvent({ client_reference: ref, direction: "request", payload: { serviceKey: input.serviceKey, body: { ...body, CallbackUrl: logged.toString() } } })
      } catch (e: any) {
        console.warn("[hubtel-cs] request event log failed:", e?.message ?? "error")
      }

      // From here on the POST may have been sent: any failure is "outcome unknown", never a plain error.
      try {
        let res: PostResult
        try {
          res = await transport.call({ method: "POST", serviceId: svc.serviceId, body })
        } catch (e: any) {
          res = { error: String(e?.message ?? e) }
        }
        await deps.store.logEvent({
          client_reference: ref, direction: "response",
          http_status: "httpStatus" in res ? res.httpStatus : null, ok: !("error" in res),
          payload: "body" in res ? res.body : null, error: "error" in res ? res.error : null,
        })

        const transition = applyPostResponse(row, res, now())
        const result = await applyAndCommit(deps.store, row, transition, onTransition)
        if ("float" in transition && transition.float && result.changed) {
          await deps.onFloat("Hubtel returned 4075: insufficient prepaid (Disbursement) balance").catch(e =>
            console.error("[hubtel-cs] onFloat failed:", e))
        }
        return result.tx
      } catch (e) {
        throw new HubtelOutcomeUnknownError(ref, e)
      }
    },

    /** Read-only lookup (bundle list / account or meter details). Not recorded in the ledger. */
    async query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }): Promise<QueryOut> {
      const svc = getService(serviceKey)
      const cfg = await gate(serviceKey, { checkPause: false })
      if (!svc.hasQuery) throw new HubtelValidationError(`${svc.label} has no query endpoint`)
      if (svc.key === "bill_ghana_water" && !params?.mobile) throw new HubtelValidationError("Ghana Water lookup requires the customer's mobile")
      if (!destination || !destination.trim()) throw new HubtelValidationError("destination is required")
      const query: Record<string, string> = { destination: destination.trim() }
      if (params?.mobile) query.mobile = params.mobile.trim()
      const res = await deps.getTransport(cfg.mode).call({ method: "GET", serviceId: svc.serviceId, query })
      if ("error" in res) return { ok: false, error: res.error }
      const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, any>
      if (classifyCode(b.ResponseCode) !== "success") {
        return { ok: false, error: typeof b.Message === "string" && b.Message ? b.Message : `Hubtel code ${b.ResponseCode ?? "none"}`, code: b.ResponseCode != null ? String(b.ResponseCode) : undefined }
      }
      return { ok: true, data: Array.isArray(b.Data) ? (b.Data as HubtelQueryItem[]) : [], label: typeof b.Label === "string" ? b.Label : null }
    },
  }
}
