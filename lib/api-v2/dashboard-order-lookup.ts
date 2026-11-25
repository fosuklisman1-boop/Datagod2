/**
 * "Check status now" for one order on the developer dashboard. Runs the SAME live lookup the public GET endpoint runs
 * (owner-scoped by ctx.userId, live environment), so the dashboard can never show anything the developer's own API key
 * could not read. The context carries no key id: the lookups never use one (only purchases do).
 */
import type { V2Context, V2HandlerResult } from "./handler"
import { ORDER_PRODUCTS, type OrderProduct } from "./dev-dashboard"

export type LookupFn = (reference: string, ctx: V2Context) => Promise<V2HandlerResult>
export type LookupTable = Record<OrderProduct, () => LookupFn>

export function dashboardContext(userId: string, product: OrderProduct): V2Context {
  return { keyId: "", userId, role: "", keyType: product === "data" ? "standard" : "commission", environment: "live", firstName: null }
}

export async function lookupOrder(product: string, reference: string, userId: string, table: LookupTable): Promise<V2HandlerResult> {
  if (!(ORDER_PRODUCTS as readonly string[]).includes(product) || !reference || reference.length > 100) {
    return { status: 404, error: { status: 404, message: "Order not found" } }
  }
  const p = product as OrderProduct
  try {
    return await table[p]()(reference, dashboardContext(userId, p))
  } catch {
    return { status: 503, error: { status: 503, message: "Could not check this order right now" } } as V2HandlerResult
  }
}
