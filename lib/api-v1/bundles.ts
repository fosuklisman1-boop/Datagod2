// Pure helpers for the v1 Standard Bundles endpoints (snake_case, wallet-paid, API-key auth).
// Routes wire the runtime; everything here takes its dependencies as arguments so it is unit-testable.

import { quoteCashback } from "@/lib/cashback/quote"
import type { CashbackConfig } from "@/lib/cashback/config"
import { NETWORK_SERVICE, BUNDLE_NETWORKS, type BundleNetwork } from "@/lib/standard-bundles/categories"
import type { BuyResult, DataOrderRow, PriceQuote } from "@/lib/standard-bundles/service"

export const NOT_AVAILABLE_BODY = { success: false, error: "not_available" } as const

export function parseNetwork(raw: string | null): BundleNetwork | null {
  const n = (raw ?? "").trim().toUpperCase()
  return (BUNDLE_NETWORKS as readonly string[]).includes(n) ? (n as BundleNetwork) : null
}

/** expected_pay: a finite number or a plain decimal string; anything else => undefined (no price check). */
export function parseExpectedPay(ep: unknown): number | undefined {
  if (typeof ep === "number" && Number.isFinite(ep)) return ep
  if (typeof ep === "string" && /^\d+(\.\d+)?$/.test(ep.trim())) return Number(ep.trim())
  return undefined
}

export type PostBody =
  | { ok: true; bundleToken: string; phone: string; idempotencyKey: string; expectedPay?: number }
  | { ok: false; error: string }

export function parsePostBody(body: any): PostBody {
  const bundleToken = body?.bundle_token
  const phone = body?.phone
  const idem = body?.idempotency_key
  if (typeof bundleToken !== "string" || !bundleToken || typeof phone !== "string" || !phone || typeof idem !== "string" || !idem) {
    return { ok: false, error: "Missing required fields: bundle_token, phone, idempotency_key" }
  }
  return { ok: true, bundleToken, phone: phone.replace(/\s/g, ""), idempotencyKey: idem, expectedPay: parseExpectedPay(body?.expected_pay) }
}

const money = (n: number) => Math.round(n * 100) / 100

/** Whether API-channel cashback pricing (and with it the bundles endpoints) is switched on. */
export const apiSurfaceOn = (cfg: CashbackConfig): boolean => !!cfg.enabled && !!cfg.surfaces.api

export const toQuote = (q: PriceQuote) => ({
  face_amount: money(q.faceAmount), pay_amount: money(q.payAmount), customer_cashback: money(q.customerCashback),
})

export interface PricedBundle { bundle_token: string; display: string; face_amount: number; pay_amount: number; customer_cashback: number }
export interface PricedCategory { name: string; bundles: PricedBundle[] }

/** Adds the key owner's price to each catalog bundle (api channel). Any quote failure => standard (face) price. */
export function priceCatalog(
  network: BundleNetwork,
  categories: { name: string; bundles: { token: string; display: string; amount: number }[] }[],
  cfg: CashbackConfig,
  buyer: "customer" | "dealer",
): PricedCategory[] {
  const serviceKey = NETWORK_SERVICE[network]
  return categories.map(c => ({
    name: c.name,
    bundles: c.bundles.map(b => {
      let pay = b.amount, cb = 0
      try {
        const q = quoteCashback({ serviceKey, provider: "hubtel", faceAmount: b.amount, buyer, channel: "api" }, cfg)
        pay = q.payAmount; cb = q.customerCashback
      } catch { /* standard price */ }
      return { bundle_token: b.token, display: b.display, face_amount: money(b.amount), pay_amount: money(pay), customer_cashback: money(cb) }
    }),
  }))
}

type OrderLike = Pick<DataOrderRow, "reference_code" | "status" | "payment_status" | "amount" | "paid_amount" | "cashback_amount" | "network" | "bundle_display" | "beneficiary_phone" | "created_at">

/** Explicit allow-list: never the raw row. */
export function mapOrder(o: OrderLike) {
  return {
    reference: o.reference_code,
    status: o.status,
    payment_status: o.payment_status,
    face_amount: money(o.amount),
    paid_amount: money(o.paid_amount ?? o.amount),
    cashback: money(o.cashback_amount ?? 0),
    network: o.network,
    bundle: o.bundle_display,
    phone: o.beneficiary_phone,
    created_at: o.created_at,
  }
}

export const ORDER_COLUMNS =
  "reference_code, status, payment_status, amount, paid_amount, cashback_amount, network, bundle_display, beneficiary_phone, created_at"

/** Maps a buyBundle result to an HTTP status + snake_case body. */
export function buyResultResponse(r: BuyResult): { status: number; body: Record<string, unknown> } {
  if (r.ok) return { status: 201, body: { success: true, order: mapOrder(r.order) } }
  if (r.status === 409 && r.quote) {
    return { status: 409, body: { success: false, error: "price_changed", message: r.error, quote: toQuote(r.quote) } }
  }
  return {
    status: r.status,
    body: { success: false, error: r.error, ...(r.order ? { order: mapOrder(r.order) } : {}) },
  }
}

// ---------------------------------------------------------------- sandbox (test keys)

interface SandboxBundle { token: string; display: string; amount: number }
const SANDBOX_CATALOG: Record<BundleNetwork, { name: string; bundles: SandboxBundle[] }[]> = {
  MTN: [{ name: "Data", bundles: [
    { token: "sbx_mtn_1gb", display: "1GB", amount: 5 },
    { token: "sbx_mtn_5gb", display: "5GB", amount: 22 },
  ] }],
  TELECEL: [{ name: "Daily", bundles: [{ token: "sbx_tel_1gb", display: "1GB Daily", amount: 6 }] }],
  AT: [{ name: "BigTime", bundles: [{ token: "sbx_at_2gb", display: "2GB BigTime", amount: 9 }] }],
}

/** Static catalog in the live response shape. Sandbox prices are face value (no cashback is simulated). */
export function sandboxCatalog(network: BundleNetwork): PricedCategory[] {
  return SANDBOX_CATALOG[network].map(c => ({
    name: c.name,
    bundles: c.bundles.map(b => ({ bundle_token: b.token, display: b.display, face_amount: b.amount, pay_amount: b.amount, customer_cashback: 0 })),
  }))
}

export function findSandboxBundle(token: string): { network: BundleNetwork; display: string; amount: number } | null {
  for (const network of BUNDLE_NETWORKS) {
    for (const c of SANDBOX_CATALOG[network]) {
      const b = c.bundles.find(x => x.token === token)
      if (b) return { network, display: b.display, amount: b.amount }
    }
  }
  return null
}

/** Deterministic reference per (idempotency key), so a retry maps to the same sandbox row. */
export function sandboxReference(idempotencyKey: string): string {
  return "SB-" + idempotencyKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 24).toUpperCase()
}

export function sandboxOrderFields(b: { network: BundleNetwork; display: string; amount: number }, phone: string) {
  return {
    payment_status: "paid", face_amount: b.amount, paid_amount: b.amount, cashback: 0,
    network: b.network, bundle: b.display, phone,
  }
}
