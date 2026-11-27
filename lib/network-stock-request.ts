// Validates the admin POST body for /api/admin/packages/network-stock.
// Kept out of the route so it is testable without a request harness.
import { STOCK_TRACKED_NETWORKS, type TrackedNetwork } from "./network-stock-service"

export type NetworkStockRequest =
  | { ok: true; network: TrackedNetwork; outOfStock: boolean; reason?: string | null }
  | { ok: false; error: string }

export function parseNetworkStockBody(body: unknown): NetworkStockRequest {
  const { network, outOfStock, reason } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>

  if (!STOCK_TRACKED_NETWORKS.includes(network as TrackedNetwork)) {
    return { ok: false, error: `network must be one of: ${STOCK_TRACKED_NETWORKS.join(", ")}` }
  }
  if (typeof outOfStock !== "boolean") return { ok: false, error: "outOfStock must be a boolean" }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { ok: false, error: "reason must be text" }
  }

  return {
    ok: true,
    network: network as TrackedNetwork,
    outOfStock,
    reason: outOfStock ? (reason as string | null | undefined) : undefined,
  }
}
