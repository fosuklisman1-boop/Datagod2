// lib/payment-gateway/start.ts
// The gateway-aware replacement for chargeMobileMoney at call sites. Only server config decides the gateway.
//
// Hubtel path: row first, then the request. Fallback to Paystack only when we can show nothing reached Hubtel
// (refused, HubtelPayInputError, nothing sent yet). `unknown` never falls back: the row stays pending, the customer is
// told the prompt is on its way, and the callback or sweep settles it. So a start makes at most one Paystack call, and
// none after Hubtel may hold the request.
import type { SupabaseClient } from "@supabase/supabase-js"
import { chargeMobileMoney, type ChargeMobileMoneyParams } from "@/lib/paystack"
import { checkPaymentStatus, hubtelCallbackUrl, HubtelPayInputError, isConfigRefusal, receiveMoney, toPesewas, type PaymentStatus, type StartOutcome } from "@/lib/hubtel-pay/client"
import { newHubtelReference } from "@/lib/hubtel-pay/reference"
import { sendThrottledAlert } from "@/lib/hubtel-pay/alert-throttle"
import type { FeeBearer, Gateway, GatewayConfig, SurfaceConfig, SurfaceKey } from "./config"
import { isHubtelCollectionReady } from "./hubtel-readiness"
import { getGatewayConfig } from "./read-config"

export interface StartMomoResult {
  status: string
  /** Always the caller's reference, never the opaque Hubtel one. */
  reference: string
  gateway: Gateway
  hubtelReference?: string
}

export interface NewHubtelPaymentRow {
  reference: string
  internal_reference: string
  metadata: Record<string, unknown>
  surface: SurfaceKey
  mode: "direct"
  amount_pesewas: number
  handler_amount_pesewas: number | null
  msisdn: string
  channel: string
  expires_at: string
}

export interface RefusedPatch { refused_at: string; last_check: unknown; updated_at: string }

export interface StartStore {
  /** A paid or needs_review attempt for this order, if any. Throws on a database error. */
  findSettledSibling(internalReference: string): Promise<{ reference: string; status: string } | null>
  /** "duplicate" means an attempt for this order is already open. Any other failure is "error" (or a throw). */
  insert(row: NewHubtelPaymentRow): Promise<"ok" | "duplicate" | "error">
  /** pending -> failed, nothing reached Hubtel. Returns whether a row changed. Throws on a database error. */
  closeRefused(reference: string, patch: RefusedPatch): Promise<boolean>
  /** The open attempt for this order, if any. Throws on a database error. */
  findOpen(internalReference: string): Promise<{ reference: string; status: string; expires_at: string } | null>
  /** claim_hubtel_payment, used as a mutex. Null means another caller holds the row or it is final. Throws on a database error. */
  claim(reference: string): Promise<{ reference: string; claimed_at: string } | null>
  /**
   * Our claimed row -> failed, leaving refused_at NULL because Hubtel did get this one. Pass claimedAt exactly as the
   * claim returned it. Returns whether a row changed. Throws on a database error.
   */
  closeUnanswered(reference: string, claimedAt: string, patch: { last_check: unknown; updated_at: string }): Promise<boolean>
}

/** Each kind throttles on its own, so a noisy cause cannot hide a different one. */
export type StartAlertKind = "config" | "upstream" | "start_error" | "store" | "sibling"

export interface StartDeps {
  getConfig: () => Promise<GatewayConfig>
  isReady: () => boolean
  chargeMobileMoney: typeof chargeMobileMoney
  receiveMoney: typeof receiveMoney
  checkStatus: (reference: string) => Promise<PaymentStatus>
  store: StartStore
  newReference: () => string
  callbackUrl: (reference: string) => string
  /** Told about faults, PII-free. Must not reject on its own account: start.ts guards it anyway. */
  alert: (kind: StartAlertKind, message: string) => Promise<void>
  now: () => Date
}

const MIN_HUBTEL_PESEWAS = 10
const EXPIRY_MS = 15 * 60_000
const DESCRIPTION = "Payment"
const CHANNELS: Record<string, string> = { mtn: "mtn-gh", vod: "vodafone-gh", tgo: "tigo-gh" }
const ALERT_WINDOW_MS = 60 * 60_000
/** A slow alert must not eat a USSD session. Past this the start carries on; the alert may still finish. */
const ALERT_TIMEOUT_MS = 3_000
const ALERT_TYPE = "hubtel_payment_start"
const UNIQUE_VIOLATION = "23505"

function toMsisdn(phone: string): string | null {
  if (/^\+?233\d{9}$/.test(phone)) return phone.replace("+", "")
  if (/^0\d{9}$/.test(phone)) return `233${phone.slice(1)}`
  return null
}

/** Rounded down to the pesewa. The inner round removes binary noise (98.9 × 1000 must not floor to 98899). */
function afterFeePesewas(pricePesewas: number, feePercent: number): number {
  return Math.floor(Math.round(pricePesewas * (100 - feePercent) * 1e4) / 1e6)
}

/** What is requested from Hubtel: the price, or the price less the fee when the merchant bears it. */
function requestedPesewas(surfaceConfig: SurfaceConfig, feePercent: number, pricePesewas: number): number {
  return surfaceConfig.feeBearer === "merchant" ? afterFeePesewas(pricePesewas, feePercent) : pricePesewas
}

/** Written so a NaN amount also counts as under the minimum. */
const meetsHubtelMinimum = (pesewas: number) => pesewas >= MIN_HUBTEL_PESEWAS

/**
 * Which gateway a charge on this surface would use, for callers that must decide fees before starting it. Same config,
 * readiness and verified-payer rules as startMomoCharge, with no side effects. This is a prediction: phone and provider
 * aren't checked here, and a start can still end on Paystack after a refusal, so the charge's own `gateway` is the truth.
 */
export async function resolveSurfaceGateway(
  surface: SurfaceKey,
  opts: { verifiedPayer?: boolean; amount?: number },
  deps: Partial<Pick<StartDeps, "getConfig" | "isReady">> = {},
): Promise<{ gateway: Gateway; feeBearer: FeeBearer }> {
  let config: GatewayConfig
  try {
    config = await (deps.getConfig ?? getGatewayConfig)()
  } catch {
    return { gateway: "paystack", feeBearer: "customer" }
  }
  const surfaceConfig = config.surfaces[surface]
  const hubtel = surfaceConfig.gateway === "hubtel" && (deps.isReady ?? isHubtelCollectionReady)() && opts.verifiedPayer === true &&
    (opts.amount === undefined || meetsHubtelMinimum(requestedPesewas(surfaceConfig, config.hubtelFeePercent, toPesewas(opts.amount))))
  return { gateway: hubtel ? "hubtel" : "paystack", feeBearer: surfaceConfig.feeBearer }
}

/** Codes are ours or Hubtel's short response codes; Hubtel's message text never reaches an alert. */
const safeCode = (code: string) => code.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30)

export function createStartStore(sb: SupabaseClient): StartStore {
  return {
    async findSettledSibling(internalReference) {
      const { data, error } = await sb.from("hubtel_payments").select("reference, status")
        .eq("internal_reference", internalReference).in("status", ["paid", "needs_review"]).limit(1)
      if (error) throw new Error(`hubtel_payments sibling lookup failed: ${error.code ?? "no code"}`)
      return (data?.[0] as { reference: string; status: string } | undefined) ?? null
    },
    async findOpen(internalReference) {
      const { data, error } = await sb.from("hubtel_payments").select("reference, status, expires_at")
        .eq("internal_reference", internalReference).in("status", ["pending", "confirming"]).maybeSingle()
      if (error) throw new Error(`hubtel_payments open lookup failed: ${error.code ?? "no code"}`)
      return (data as { reference: string; status: string; expires_at: string } | null) ?? null
    },
    async claim(reference) {
      const { data, error } = await sb.rpc("claim_hubtel_payment", { p_reference: reference })
      if (error) throw new Error(`claim_hubtel_payment failed: ${error.code ?? "no code"}`)
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as { reference: string; claimed_at: string }[]
      return rows[0] ? { reference: rows[0].reference, claimed_at: rows[0].claimed_at } : null
    },
    async closeUnanswered(reference, claimedAt, patch) {
      const { data, error } = await sb.from("hubtel_payments").update({ status: "failed", ...patch })
        .eq("reference", reference).eq("status", "confirming").eq("claimed_at", claimedAt).select("reference")
      if (error) throw new Error(`hubtel_payments close failed: ${error.code ?? "no code"}`)
      return (data?.length ?? 0) > 0
    },
    async insert(row) {
      const { error } = await sb.from("hubtel_payments").insert(row)
      if (!error) return "ok"
      if (error.code === UNIQUE_VIOLATION) return "duplicate"
      console.error("[hubtel-start] row insert failed:", error.code ?? "no code")
      return "error"
    },
    async closeRefused(reference, patch) {
      const { data, error } = await sb.from("hubtel_payments").update({ status: "failed", ...patch })
        .eq("reference", reference).eq("status", "pending").select("reference")
      if (error) throw new Error(`hubtel_payments close failed: ${error.code ?? "no code"}`)
      return (data?.length ?? 0) > 0
    },
  }
}

let serviceClient: SupabaseClient | null = null
async function getServiceClient(): Promise<SupabaseClient> {
  if (!serviceClient) {
    const { createClient } = await import("@supabase/supabase-js")
    serviceClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return serviceClient
}

const defaultStore: StartStore = {
  findSettledSibling: async (internalReference) => createStartStore(await getServiceClient()).findSettledSibling(internalReference),
  insert: async (row) => createStartStore(await getServiceClient()).insert(row),
  closeRefused: async (reference, patch) => createStartStore(await getServiceClient()).closeRefused(reference, patch),
  findOpen: async (internalReference) => createStartStore(await getServiceClient()).findOpen(internalReference),
  claim: async (reference) => createStartStore(await getServiceClient()).claim(reference),
  closeUnanswered: async (reference, claimedAt, patch) => createStartStore(await getServiceClient()).closeUnanswered(reference, claimedAt, patch),
}

async function defaultAlert(kind: StartAlertKind, message: string): Promise<void> {
  await sendThrottledAlert(await getServiceClient(), message, {
    key: `last_hubtel_payment_start_alert_${kind}`, type: ALERT_TYPE, description: "Hubtel payment start alert throttle",
    windowMs: ALERT_WINDOW_MS, logPrefix: "[hubtel-start]",
  })
}

export async function startMomoCharge(
  surface: SurfaceKey,
  params: ChargeMobileMoneyParams & { verifiedPayer?: boolean },
  deps: Partial<StartDeps> = {},
): Promise<StartMomoResult> {
  const d: StartDeps = {
    getConfig: getGatewayConfig,
    isReady: isHubtelCollectionReady,
    chargeMobileMoney,
    receiveMoney,
    checkStatus: (reference) => checkPaymentStatus(reference),
    store: defaultStore,
    newReference: newHubtelReference,
    callbackUrl: (reference) => hubtelCallbackUrl(reference),
    alert: defaultAlert,
    now: () => new Date(),
    ...deps,
  }
  const { verifiedPayer, ...paystackParams } = params

  const viaPaystack = async (): Promise<StartMomoResult> => ({ ...(await d.chargeMobileMoney(paystackParams)), gateway: "paystack" })

  /** An alert decides nothing: a failure here is logged and never reaches the payment, and it gets ALERT_TIMEOUT_MS at most. */
  const tell = (kind: StartAlertKind, message: string): Promise<void> => {
    const sent = Promise.resolve().then(() => d.alert(kind, message)).catch((e) => {
      console.error("[hubtel-start] alert failed:", e instanceof Error ? e.message : "unknown error")
    })
    let timer: ReturnType<typeof setTimeout>
    const timedOut = new Promise<void>((resolve) => { timer = setTimeout(resolve, ALERT_TIMEOUT_MS) })
    return Promise.race([sent, timedOut]).finally(() => clearTimeout(timer))
  }

  /** The alert runs alongside the charge, so it cannot delay the prompt, and still finishes before we return. */
  const fallBack = async (alerts: Promise<void>[]): Promise<StartMomoResult> => {
    try {
      return await viaPaystack()
    } finally {
      await Promise.all(alerts)
    }
  }

  let config: GatewayConfig
  try {
    config = await d.getConfig()
  } catch {
    return fallBack([tell("start_error", `Hubtel start (${surface}): gateway config unreadable; used Paystack.`)])
  }
  const surfaceConfig = config.surfaces[surface]
  if (surfaceConfig.gateway !== "hubtel") return viaPaystack()
  if (!d.isReady()) return fallBack([tell("config", `Hubtel start (${surface}): surface is set to Hubtel but Hubtel is not ready; used Paystack.`)])

  // undefined counts as not verified: every caller must state it. Hubtel's rule is no unsolicited prompts.
  if (verifiedPayer !== true) return viaPaystack()

  const pricePesewas = toPesewas(params.amount)
  const merchantBears = surfaceConfig.feeBearer === "merchant"
  const amountPesewas = requestedPesewas(surfaceConfig, config.hubtelFeePercent, pricePesewas)
  const msisdn = toMsisdn(params.phone)
  const channel = Object.hasOwn(CHANNELS, params.provider) ? CHANNELS[params.provider] : undefined
  if (!meetsHubtelMinimum(amountPesewas) || !msisdn || !channel) return viaPaystack()

  const offline: StartMomoResult = { status: "pay_offline", reference: params.reference, gateway: "hubtel" }

  // A paid or in-review attempt may already hold this customer's money: no prompt on any gateway. The index can't do
  // this, because a failed -> needs_review late payment has to be able to land beside a paid or open attempt.
  let settled: { reference: string; status: string } | null
  try {
    settled = await d.store.findSettledSibling(params.reference)
  } catch (e) {
    // Falling back can't double-charge in practice: a sibling only exists when a reference is reused, and no caller
    // reuses one today. Revisit this if one ever does, because a paid sibling would go unseen while the DB is down.
    console.error("[hubtel-start] sibling lookup failed:", e instanceof Error ? e.message : "unknown error")
    return fallBack([tell("store", `Hubtel start (${surface}): could not check earlier attempts; nothing sent to Hubtel, used Paystack.`)])
  }
  if (settled) {
    await tell("sibling", `Hubtel start (${surface}): attempt ${settled.reference} for this order is ${settled.status}; no new prompt sent.`)
    return offline
  }

  // Never sent or stored at this point, so the retry below can use it too. A reference Hubtel has seen is never reused.
  const hubtelReference = d.newReference()
  let callbackUrl: string
  try {
    callbackUrl = d.callbackUrl(hubtelReference)
  } catch {
    return fallBack([tell("config", `Hubtel start (${surface}): callback URL unavailable; used Paystack.`)])
  }

  const insertRow = async (): Promise<"ok" | "duplicate" | "error"> => {
    try {
      return await d.store.insert({
        reference: hubtelReference,
        internal_reference: params.reference,
        metadata: { ...params.metadata, gateway: "hubtel" },
        surface,
        mode: "direct",
        amount_pesewas: amountPesewas,
        handler_amount_pesewas: merchantBears ? pricePesewas : null,
        msisdn,
        channel,
        expires_at: new Date(d.now().getTime() + EXPIRY_MS).toISOString(),
      })
    } catch (e) {
      console.error("[hubtel-start] row insert threw:", e instanceof Error ? e.message : "unknown error")
      return "error"
    }
  }

  /**
   * An open attempt past its expiry may never have reached Hubtel, and would otherwise block this order for a day.
   * The claim is the mutex, so concurrent starts get one winner. Only `not_found` and `unpaid` free the order; the row
   * closes with no failure handler (the order is about to be retried) and with refused_at NULL, so the 72h late check
   * still catches a real payment. Everything else stays with the sweep. Returns whether the order is free to retry.
   */
  const freeStuckAttempt = async (): Promise<boolean> => {
    try {
      const open = await d.store.findOpen(params.reference)
      if (!open || !(d.now().getTime() >= new Date(open.expires_at).getTime())) return false
      const claimed = await d.store.claim(open.reference)
      if (!claimed) return false
      const status = await d.checkStatus(open.reference)
      if (status.kind !== "not_found" && status.kind !== "unpaid") return false
      return await d.store.closeUnanswered(open.reference, claimed.claimed_at, { last_check: status.raw, updated_at: d.now().toISOString() })
    } catch (e) {
      console.error("[hubtel-start] stuck attempt check failed:", e instanceof Error ? e.message : "unknown error")
      return false
    }
  }

  let inserted = await insertRow()
  // Same reference, attempt already open. This only guards starts that reuse a reference, not a caller minting a new
  // one per attempt. No second prompt and no fallback unless that attempt is expired and freed; a retry that loses
  // the race to another start hits 23505 again and also stops here.
  if (inserted === "duplicate") {
    if (!(await freeStuckAttempt())) return offline
    inserted = await insertRow()
    if (inserted === "duplicate") return offline
  }
  if (inserted === "error") return fallBack([tell("store", `Hubtel start (${surface}): could not record the payment; nothing sent to Hubtel, used Paystack.`)])

  const pending: StartMomoResult = { ...offline, hubtelReference }

  /** Nothing reached Hubtel: close this attempt for good and charge on Paystack under the caller's reference. */
  const closeAndFallBack = async (code: string, alertFirst?: Promise<void>): Promise<StartMomoResult> => {
    const alerts = alertFirst ? [alertFirst] : []
    const at = d.now().toISOString()
    try {
      const closed = await d.store.closeRefused(hubtelReference, { refused_at: at, updated_at: at, last_check: { start_outcome: { kind: "refused", code } } })
      if (!closed) alerts.push(tell("store", `Hubtel start (${surface}): refused attempt ${hubtelReference} was not open to close; used Paystack.`))
    } catch (e) {
      console.error("[hubtel-start] close failed:", e instanceof Error ? e.message : "unknown error")
      alerts.push(tell("store", `Hubtel start (${surface}): could not close refused attempt ${hubtelReference}; used Paystack.`))
    }
    return fallBack(alerts)
  }

  let outcome: StartOutcome
  try {
    outcome = await d.receiveMoney({
      reference: hubtelReference, msisdn, channel, amount: amountPesewas / 100, description: DESCRIPTION, callbackUrl,
    })
  } catch (e) {
    if (e instanceof HubtelPayInputError) {
      return closeAndFallBack("input_error", tell("start_error", `Hubtel start (${surface}): the relay rejected our request; used Paystack.`))
    }
    // Not proof that nothing was sent, so this is treated like unknown.
    console.error("[hubtel-start] send threw:", e instanceof Error ? e.name : "unknown error")
    await tell("start_error", `Hubtel start (${surface}): unexpected error sending attempt ${hubtelReference}; left pending for the sweep.`)
    return pending
  }

  const code = "code" in outcome ? safeCode(outcome.code) : ""
  const upstream = "upstreamStatus" in outcome ? outcome.upstreamStatus : undefined
  const endpointGone = upstream === 404 || upstream === 405

  if (outcome.kind === "refused") {
    let alert: Promise<void> | undefined
    if (isConfigRefusal(outcome)) alert = tell("config", `Hubtel start (${surface}): refused because of our setup (${code}); used Paystack.`)
    else if (endpointGone) alert = tell("upstream", `Hubtel start (${surface}): Hubtel answered HTTP ${upstream} (${code}); used Paystack.`)
    return closeAndFallBack(code, alert)
  }
  if (outcome.kind === "unknown" && (code === "relay_404" || endpointGone)) {
    await tell("upstream", `Hubtel start (${surface}): unexpected reply (${code}); attempt ${hubtelReference} left pending for the sweep.`)
  }
  return pending
}
