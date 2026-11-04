// lib/payment-gateway/start.ts
// The gateway-aware replacement for chargeMobileMoney at call sites. Only server config decides the gateway.
//
// Hubtel path: row first, then the request. Fallback to Paystack only when we can show nothing reached Hubtel
// (refused, HubtelPayInputError, nothing sent yet). `unknown` never falls back: the row stays pending, the customer is
// told the prompt is on its way, and the callback or sweep settles it. So a start makes at most one Paystack call, and
// none after Hubtel may hold the request.
import type { SupabaseClient } from "@supabase/supabase-js"
import { chargeMobileMoney, type ChargeMobileMoneyParams } from "@/lib/paystack"
import { hubtelCallbackUrl, HubtelPayInputError, isConfigRefusal, receiveMoney, toPesewas, type StartOutcome } from "@/lib/hubtel-pay/client"
import { newHubtelReference } from "@/lib/hubtel-pay/reference"
import { sendThrottledAlert } from "@/lib/hubtel-pay/alert-throttle"
import type { Gateway, GatewayConfig, SurfaceKey } from "./config"
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
  /** "duplicate" means an attempt for this order is already open. Any other failure is "error" (or a throw). */
  insert(row: NewHubtelPaymentRow): Promise<"ok" | "duplicate" | "error">
  /** pending -> failed, nothing reached Hubtel. Returns whether a row changed. Throws on a database error. */
  closeRefused(reference: string, patch: RefusedPatch): Promise<boolean>
}

/** Each kind throttles on its own, so a noisy cause cannot hide a different one. */
export type StartAlertKind = "config" | "upstream" | "start_error" | "store"

export interface StartDeps {
  getConfig: () => Promise<GatewayConfig>
  isReady: () => boolean
  chargeMobileMoney: typeof chargeMobileMoney
  receiveMoney: typeof receiveMoney
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

/** Codes are ours or Hubtel's short response codes; Hubtel's message text never reaches an alert. */
const safeCode = (code: string) => code.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30)

export function createStartStore(sb: SupabaseClient): StartStore {
  return {
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
  insert: async (row) => createStartStore(await getServiceClient()).insert(row),
  closeRefused: async (reference, patch) => createStartStore(await getServiceClient()).closeRefused(reference, patch),
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
    store: defaultStore,
    newReference: newHubtelReference,
    callbackUrl: (reference) => hubtelCallbackUrl(reference),
    alert: defaultAlert,
    now: () => new Date(),
    ...deps,
  }
  const { verifiedPayer, ...paystackParams } = params

  const viaPaystack = async (): Promise<StartMomoResult> => ({ ...(await d.chargeMobileMoney(paystackParams)), gateway: "paystack" })

  /** An alert decides nothing: a failure here is logged and never reaches the payment. */
  const tell = (kind: StartAlertKind, message: string): Promise<void> =>
    Promise.resolve().then(() => d.alert(kind, message)).catch((e) => {
      console.error("[hubtel-start] alert failed:", e instanceof Error ? e.message : "unknown error")
    })

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
  const amountPesewas = merchantBears ? afterFeePesewas(pricePesewas, config.hubtelFeePercent) : pricePesewas
  const msisdn = toMsisdn(params.phone)
  const channel = Object.hasOwn(CHANNELS, params.provider) ? CHANNELS[params.provider] : undefined
  // Written so a NaN amount also lands here.
  if (!(amountPesewas >= MIN_HUBTEL_PESEWAS) || !msisdn || !channel) return viaPaystack()

  const hubtelReference = d.newReference()
  let callbackUrl: string
  try {
    callbackUrl = d.callbackUrl(hubtelReference)
  } catch {
    return fallBack([tell("config", `Hubtel start (${surface}): callback URL unavailable; used Paystack.`)])
  }

  let inserted: "ok" | "duplicate" | "error"
  try {
    inserted = await d.store.insert({
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
    inserted = "error"
  }
  // An attempt is already open for this order: the customer already has a prompt. No second one, no fallback.
  if (inserted === "duplicate") return { status: "pay_offline", reference: params.reference, gateway: "hubtel" }
  if (inserted === "error") return fallBack([tell("store", `Hubtel start (${surface}): could not record the payment; nothing sent to Hubtel, used Paystack.`)])

  const pending: StartMomoResult = { status: "pay_offline", reference: params.reference, gateway: "hubtel", hubtelReference }

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
