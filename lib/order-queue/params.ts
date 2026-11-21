import { z } from "zod"
import type { FailureReason } from "./failure-reason"
import { ORDER_TYPES, QUEUE_VIEWS, type OrderType, type QueueParams, type QueueView } from "./types"

const FAILURE_REASONS: readonly FailureReason[] = [
  "outcome_unknown", "not_enabled", "out_of_balance", "rate_limited", "no_bundle",
  "supplier_unavailable", "wrong_number", "rejected", "none",
]

const list = (v: string | null): string[] =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50) : []

const isoOrNull = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "bad date")

const schema = z.object({
  view: z.enum(QUEUE_VIEWS as [QueueView, ...QueueView[]]),
  statuses: z.array(z.string().max(40)),
  networks: z.array(z.string().max(40)),
  types: z.array(z.enum(ORDER_TYPES as [OrderType, ...OrderType[]])),
  from: isoOrNull.nullable(),
  to: isoOrNull.nullable(),
  search: z.string(),
  lastProvider: z.string().max(60).nullable(),
  failureReason: z.enum(FAILURE_REASONS as [FailureReason, ...FailureReason[]]).nullable(),
  limit: z.number().int(),
  offset: z.number().int(),
})

const intOr = (v: string | null, d: number) => {
  const n = parseInt(v ?? "", 10)
  return Number.isFinite(n) ? n : d
}

export function parseQueueParams(
  sp: URLSearchParams,
): { ok: true; value: QueueParams } | { ok: false; error: string } {
  const raw = {
    view: sp.get("view") || "needs_action",
    statuses: list(sp.get("statuses")),
    networks: list(sp.get("networks")),
    types: list(sp.get("types")),
    from: sp.get("from") || null,
    to: sp.get("to") || null,
    search: (sp.get("search") ?? "").trim().slice(0, 100).trim(),
    lastProvider: sp.get("lastProvider") || null,
    failureReason: sp.get("failureReason") || null,
    limit: Math.min(200, Math.max(1, intOr(sp.get("limit"), 50))),
    offset: Math.max(0, intOr(sp.get("offset"), 0)),
  }
  const r = schema.safeParse(raw)
  if (!r.success) return { ok: false, error: "Invalid queue parameters" }
  return { ok: true, value: r.data as QueueParams }
}

// Emits only non-default values; parseQueueParams(queueParamsToSearch(p)) deep-equals p.
export function queueParamsToSearch(p: QueueParams): string {
  const sp = new URLSearchParams()
  if (p.view !== "needs_action") sp.set("view", p.view)
  if (p.statuses.length) sp.set("statuses", p.statuses.join(","))
  if (p.networks.length) sp.set("networks", p.networks.join(","))
  if (p.types.length) sp.set("types", p.types.join(","))
  if (p.from) sp.set("from", p.from)
  if (p.to) sp.set("to", p.to)
  if (p.search) sp.set("search", p.search)
  if (p.lastProvider) sp.set("lastProvider", p.lastProvider)
  if (p.failureReason) sp.set("failureReason", p.failureReason)
  if (p.limit !== 50) sp.set("limit", String(p.limit))
  if (p.offset !== 0) sp.set("offset", String(p.offset))
  return sp.toString()
}
