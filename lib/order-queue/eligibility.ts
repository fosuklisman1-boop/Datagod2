import { getProviderOptionsForNetwork } from "./supplier-capability"
import type { OrderType } from "./types"

export type OrderSnapshot = {
  id: string
  type: OrderType
  status: string
  network: string
  latestAttempt: { status: string; mtnOrderId: string | null } | null
  hasLiveAttempt: boolean
  queued: boolean
}

export type Verdict =
  | { kind: "eligible" }
  | { kind: "risky"; why: "held" | "reversed" }
  | {
      kind: "blocked"
      reason: "completed" | "live_at_supplier" | "already_queued" | "not_pending" | "supplier_cannot_serve_network" | "not_found"
    }

const blocked = (reason: Extract<Verdict, { kind: "blocked" }>["reason"]): Verdict => ({ kind: "blocked", reason })
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()

/**
 * Decides whether one order may be bulk-sent to `supplier`. Pure; the server recomputes this itself.
 *
 * Precedence (first match wins):
 *   not_found -> already_queued -> completed -> supplier_cannot_serve_network
 *   -> hasLiveAttempt on a non-processing order => live_at_supplier
 *   -> reversed => risky(reversed)
 *   -> processing: held (latest attempt abandoned or UNKNOWN_ id) => risky(held), else live_at_supplier
 *   -> pending => eligible
 *   -> anything else => not_pending
 *
 * A processing order is decided by the held rule alone, so hasLiveAttempt does not turn a held order
 * into a plain block (the abandoned attempt is the very thing the admin is acknowledging).
 */
export function judgeOrder(o: OrderSnapshot | null, supplier: string): Verdict {
  if (!o) return blocked("not_found")
  if (o.queued) return blocked("already_queued")

  const status = norm(o.status)
  if (status === "completed") return blocked("completed")

  const canServe = getProviderOptionsForNetwork(o.network).some((p) => p.value === supplier)
  if (!canServe) return blocked("supplier_cannot_serve_network")

  if (status !== "processing" && o.hasLiveAttempt) return blocked("live_at_supplier")

  if (status === "reversed") return { kind: "risky", why: "reversed" }

  if (status === "processing") {
    const a = o.latestAttempt
    const held = !!a && (norm(a.status) === "abandoned" || (a.mtnOrderId ?? "").startsWith("UNKNOWN_"))
    return held ? { kind: "risky", why: "held" } : blocked("live_at_supplier")
  }

  if (status === "pending") return { kind: "eligible" }
  return blocked("not_pending")
}

/** Typed-confirmation gate: ok when nothing is risky, or the admin's count equals the server's risky count. */
export function checkRiskyAck(verdicts: Verdict[], ack: { count: number } | undefined): { ok: true } | { ok: false; expected: number } {
  const expected = verdicts.filter((v) => v.kind === "risky").length
  if (expected === 0) return { ok: true }
  return ack && ack.count === expected ? { ok: true } : { ok: false, expected }
}
