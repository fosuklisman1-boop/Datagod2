import type { handleConfirm } from "@/lib/ussd/handlers/bundles"
import type { resolveOffer } from "../catalogue"
import { isKnownLinkTriple, type Line, type Service } from "../types"
import type { ShopRef } from "../shop/resolve"
import type { confirmAirtimeByText } from "@/lib/ussd/handlers/airtime"
import type { confirmRcByText } from "@/lib/ussd/handlers/results-checker"
import { airtimeAdapter } from "./airtime"
import { dataAdapter } from "./data"
import { resultsCheckerAdapter } from "./results-checker"
import { shopDataAdapter, type ShopDataDeps } from "./shop-data"
import type { ServiceAdapter } from "./types"

export type Adapters = Partial<Record<Service, ServiceAdapter>>
export type AdapterDeps = {
  resolve?: typeof resolveOffer
  confirm?: typeof handleConfirm
  airtimeConfirm?: typeof confirmAirtimeByText
  rcConfirm?: typeof confirmRcByText
  /** The shop line's collaborators (shop prices, shop confirm); the real ones when absent. */
  shopData?: ShopDataDeps
}

/**
 * One adapter per live service of a line. Tests inject the same `resolve` / `confirm` fakes they always did.
 * The main line (the default) is the Stage 1 + 2 set, unchanged. The shop line sells data only, through the shop adapter for
 * `shop` (null: a read-only set for status and notices, whose resolve fails closed). It registers NO airtime or results_checker
 * adapter, so the lane answers a shop airtime or voucher read exactly as if that service's text switch were off.
 */
export function makeAdapters(deps: AdapterDeps = {}, line: Line = "main", shop: ShopRef | null = null): Adapters {
  if (line === "shop") return { data: shopDataAdapter(deps.shopData ?? {}, shop) as unknown as ServiceAdapter }
  return {
    data: dataAdapter(deps) as unknown as ServiceAdapter,
    airtime: airtimeAdapter({ confirm: deps.airtimeConfirm }) as unknown as ServiceAdapter,
    results_checker: resultsCheckerAdapter({ confirm: deps.rcConfirm }) as unknown as ServiceAdapter,
  }
}

/**
 * The adapter for a stored link, or null when (line, service, orderTable) is not a triple isKnownLinkTriple knows, no adapter is
 * registered for the service, or the registered adapter writes a different table (a shop link is never read through the main
 * adapters, and a main link never through the shop adapters). A link row with no line is a main-line row.
 */
export function adapterForLink(adapters: Adapters, link: { line?: string; service: string; orderTable: string }): ServiceAdapter | null {
  if (!isKnownLinkTriple(link.line ?? "main", link.service, link.orderTable)) return null
  const adapter = adapters[link.service as Service] ?? null
  return adapter && adapter.orderTable === link.orderTable ? adapter : null
}
