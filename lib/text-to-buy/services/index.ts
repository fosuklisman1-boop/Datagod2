import type { handleConfirm } from "@/lib/ussd/handlers/bundles"
import type { resolveOffer } from "../catalogue"
import { ORDER_TABLE_OF, type Service } from "../types"
import type { confirmAirtimeByText } from "@/lib/ussd/handlers/airtime"
import { airtimeAdapter } from "./airtime"
import { dataAdapter } from "./data"
import type { ServiceAdapter } from "./types"

export type Adapters = Partial<Record<Service, ServiceAdapter>>
export type AdapterDeps = { resolve?: typeof resolveOffer; confirm?: typeof handleConfirm; airtimeConfirm?: typeof confirmAirtimeByText }

/** One adapter per live service. Tests inject the same `resolve` / `confirm` fakes they always did. */
export function makeAdapters(deps: AdapterDeps = {}): Adapters {
  return {
    data: dataAdapter(deps) as unknown as ServiceAdapter,
    airtime: airtimeAdapter({ confirm: deps.airtimeConfirm }) as unknown as ServiceAdapter,
  }
}

/** The adapter for a stored link, or null when (service, orderTable) is not a pair ORDER_TABLE_OF knows or no adapter is registered. */
export function adapterForLink(adapters: Adapters, link: { service: string; orderTable: string }): ServiceAdapter | null {
  const service = link.service as Service
  if (!Object.prototype.hasOwnProperty.call(ORDER_TABLE_OF, service)) return null
  if (ORDER_TABLE_OF[service] !== link.orderTable) return null
  return adapters[service] ?? null
}
