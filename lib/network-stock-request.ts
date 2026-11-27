// Validates the admin POST body for /api/admin/packages/network-stock.
// Kept out of the route so it is testable without a request harness.
import { STOCK_TRACKED_NETWORKS, type TrackedNetwork } from "./network-stock-service"

export type NetworkStockRequest =
  | { ok: true; network: TrackedNetwork; outOfStock: boolean; reason?: string | null; reasonOnly?: boolean }
  | { ok: false; error: string }

export function parseNetworkStockBody(body: unknown): NetworkStockRequest {
  const { network, outOfStock, reason, reasonOnly } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>

  if (!STOCK_TRACKED_NETWORKS.includes(network as TrackedNetwork)) {
    return { ok: false, error: `network must be one of: ${STOCK_TRACKED_NETWORKS.join(", ")}` }
  }
  if (typeof outOfStock !== "boolean") return { ok: false, error: "outOfStock must be a boolean" }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { ok: false, error: "reason must be text" }
  }
  // reasonOnly = "Save reason": change the text of a network that is already out of stock, never
  // disable packages (the server refuses if the network was restocked meanwhile).
  if (reasonOnly !== undefined && typeof reasonOnly !== "boolean") return { ok: false, error: "reasonOnly must be a boolean" }
  if (reasonOnly === true && !outOfStock) return { ok: false, error: "reasonOnly needs outOfStock: true" }

  return {
    ok: true,
    network: network as TrackedNetwork,
    outOfStock,
    reason: outOfStock ? (reason as string | null | undefined) : undefined,
    ...(reasonOnly === true ? { reasonOnly: true } : {}),
  }
}
