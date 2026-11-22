import { BULK_SEND_NETWORKS, type SendRejectReason } from "./enqueue"
import { ORDER_TYPES, type OrderType, type QueueRow } from "./types"

/** Reasons the client preview can give; the server's own reasons plus one it cannot see (a row with no order type). */
export type PreviewBlockReason =
  | "completed"
  | "live_at_supplier"
  | "not_pending"
  | "supplier_cannot_serve_network"
  | "unknown_type"

export type SelectionSummary = {
  count: number
  totalGb: number
  /** Distinct networks of the rows that could go out (sendable + risky), in first-seen order. Blocked rows never narrow the supplier list. */
  networks: string[]
  sendable: QueueRow[]
  risky: QueueRow[]
  blocked: { row: QueueRow; reason: PreviewBlockReason }[]
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()
const LIVE_ATTEMPT = ["pending", "processing", "completed"]

type Preview = { kind: "sendable" } | { kind: "risky" } | { kind: "blocked"; reason: PreviewBlockReason }

/**
 * Client-side preview of judgeOrder (lib/order-queue/eligibility.ts) using only QueueRow fields.
 * The server re-judges every order and is authoritative; this only drives the confirm dialog.
 * Same precedence: completed -> unmapped network -> live latest attempt -> reversed (risky)
 * -> processing: held (risky) else live -> pending (sendable) -> anything else not_pending.
 */
function preview(r: QueueRow): Preview {
  if (!ORDER_TYPES.includes(r.type as OrderType)) return { kind: "blocked", reason: "unknown_type" }
  const status = norm(r.status)
  if (status === "completed") return { kind: "blocked", reason: "completed" }
  if (!BULK_SEND_NETWORKS.includes((r.network ?? "").trim())) return { kind: "blocked", reason: "supplier_cannot_serve_network" }
  // isHeld means the latest attempt is abandoned / UNKNOWN_ (never live), matching the server's UNKNOWN_ exception.
  if (!r.isHeld && LIVE_ATTEMPT.includes(norm(r.lastAttemptStatus))) return { kind: "blocked", reason: "live_at_supplier" }
  if (status === "reversed") return { kind: "risky" }
  if (status === "processing") return r.isHeld ? { kind: "risky" } : { kind: "blocked", reason: "live_at_supplier" }
  if (status === "pending") return { kind: "sendable" }
  return { kind: "blocked", reason: "not_pending" }
}

function gbOf(v: string | null): number {
  const x = Number.parseFloat(v ?? "")
  return Number.isFinite(x) && x > 0 ? x : 0
}

export function summarizeSelection(rows: QueueRow[]): SelectionSummary {
  const sendable: QueueRow[] = []
  const risky: QueueRow[] = []
  const blocked: SelectionSummary["blocked"] = []
  const networks: string[] = []
  let totalGb = 0
  for (const r of rows) {
    totalGb += gbOf(r.volumeGb)
    const p = preview(r)
    if (p.kind === "blocked") {
      blocked.push({ row: r, reason: p.reason })
      continue
    }
    ;(p.kind === "risky" ? risky : sendable).push(r)
    const net = (r.network ?? "").trim()
    if (net && !networks.includes(net)) networks.push(net)
  }
  return { count: rows.length, totalGb: Math.round(totalGb * 100) / 100, networks, sendable, risky, blocked }
}

/** "3.5", "4", "0.3" — at most two decimals, no trailing zeros. */
export function formatGb(gb: number): string {
  return String(Math.round(gb * 100) / 100)
}

/** Send is allowed only when nothing is risky, or the box is ticked and the typed number is exactly the risky count. */
export function riskyAckReady(riskyCount: number, typed: string, checked: boolean): boolean {
  if (riskyCount === 0) return true
  const t = typed.trim()
  return checked && /^\d+$/.test(t) && Number(t) === riskyCount
}

/**
 * POST body for /api/admin/fulfillment/enqueue from the confirm dialog's summary. Risky orders are acknowledged
 * with the typed count AND the exact ids listed in the dialog, so the server can refuse if its set differs.
 */
export function buildSendBody(
  summary: SelectionSummary,
  provider: string,
  ackTyped: string,
): { orders: { id: string; type: OrderType }[]; provider: string; riskyAck?: { count: number; ids: string[] } } {
  const toSend = [...summary.sendable, ...summary.risky]
  const body: ReturnType<typeof buildSendBody> = {
    orders: toSend.map((r) => ({ id: r.id, type: r.type as OrderType })),
    provider,
  }
  if (summary.risky.length > 0) body.riskyAck = { count: Number(ackTyped.trim()), ids: summary.risky.map((r) => r.id) }
  return body
}

/**
 * Turns the GET /api/admin/fulfillment/mtn-balance body into { supplier: "GHS 1,234.50" }.
 * Suppliers without a numeric balance are left out (the dropdown then shows no balance for them).
 */
export function parseSupplierBalances(body: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!body || typeof body !== "object") return out
  const b = body as Record<string, unknown>
  const balances = b.balances
  if (balances && typeof balances === "object") {
    for (const [name, v] of Object.entries(balances as Record<string, unknown>)) {
      const bal = (v as { balance?: unknown } | null)?.balance
      if (typeof bal === "number" && Number.isFinite(bal)) {
        out[name] = `GHS ${bal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      }
    }
  }
  const gb = (b.spfastit as { balance_gb?: unknown } | null | undefined)?.balance_gb
  if (typeof gb === "number" && Number.isFinite(gb)) out.spfastit = `${formatGb(gb)} GB`
  return out
}

export const REJECT_REASON_LABELS: Record<SendRejectReason | PreviewBlockReason, string> = {
  completed: "Already completed",
  live_at_supplier: "Still live at a supplier",
  already_queued: "Already in the send queue",
  not_pending: "Not pending",
  supplier_cannot_serve_network: "This supplier does not serve its network",
  not_found: "Order not found",
  needs_confirmation: "Held/reversed — needs confirmation",
  duplicate_in_request: "Listed twice",
  changed: "Its status changed — check it again",
  update_failed: "Could not release it — try again",
  insert_failed: "Could not queue it — try again",
  unknown_type: "Order type unknown",
}

export function rejectReasonLabel(reason: string): string {
  return (REJECT_REASON_LABELS as Record<string, string>)[reason] ?? reason
}
