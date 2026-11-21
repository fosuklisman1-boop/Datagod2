// Hubnet webhook logic. Callbacks are unsigned, so the body is NEVER trusted: it only
// names a reference, and we re-check that reference with our own authenticated call.
import { timingSafeEqual } from "node:crypto"
import { parseHubnetRef, type HubnetStatus, type StatusLookup } from "./core"
import type { HubnetClient } from "./client"
import { applyHubnetStatusChange } from "./sync"
import { applyHubnetAirtimeStatus } from "@/lib/airtime-hubnet"
import { redactPhone } from "@/lib/mtn-providers/kuntanii-core"

export const HUBNET_WEBHOOK_MAX_BYTES = 64 * 1024

const TRACKING_COLUMNS = "id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, size_gb, provider, external_status"

export type HubnetWebhookResult = "applied" | "ignored" | "unknown"

export interface HubnetWebhookDeps {
  db: any
  client: Pick<HubnetClient, "getStatus">
  applyData: typeof applyHubnetStatusChange
  applyAirtime: typeof applyHubnetAirtimeStatus
}

/** Constant-time token check. False when the env token is unset/empty or the given one is null/empty. */
export function tokenOk(given: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = env.HUBNET_WEBHOOK_TOKEN
  if (!expected || !given) return false
  const a = Buffer.from(given, "utf8")
  const b = Buffer.from(expected, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Look at reference / batch_id (top level, then data.*). Only a ref that parses as ours is returned. */
export function extractHubnetRef(payload: unknown): string | null {
  if (!isObj(payload)) return null
  const scopes: Record<string, unknown>[] = [payload]
  if (isObj(payload.data)) scopes.push(payload.data)
  for (const scope of scopes) {
    for (const key of ["reference", "batch_id"]) {
      const v = scope[key]
      if (typeof v === "string" && parseHubnetRef(v.trim())) return v.trim()
    }
  }
  return null
}

/** Mask 10-digit 0XXXXXXXXX and 233XXXXXXXXX numbers, then cap at 2000 chars. */
export function redactHubnetBody(body: string): string {
  return body
    .replace(/[\r\n]/g, " ")
    .replace(/(?<!\d)(?:233\d{9}|0\d{9})(?!\d)/g, (m) => redactPhone(m))
    .slice(0, 2000)
}

export async function processHubnetWebhook(ref: string, deps: HubnetWebhookDeps): Promise<HubnetWebhookResult> {
  try {
    const parsed = parseHubnetRef(ref)
    if (!parsed) return "ignored"

    if (parsed.kind === "airtime") return await processAirtime(ref, deps)
    return await processData(ref, deps)
  } catch (e: any) {
    console.error(`[HUBNET-WEBHOOK] error for ${ref}: ${e?.message ?? e}`)
    return "unknown"
  }
}

async function processData(ref: string, deps: HubnetWebhookDeps): Promise<HubnetWebhookResult> {
  const { data: rows, error } = await deps.db.from("mtn_fulfillment_tracking").select(TRACKING_COLUMNS)
    .eq("provider", "hubnet").eq("mtn_order_id", ref).limit(5)
  if (error) throw error
  const movable = (rows ?? []).filter((r: any) => r.status === "pending" || r.status === "processing")
  if (movable.length === 0) return "ignored"

  const lookup = await deps.client.getStatus(ref)
  if (lookup.kind !== "found") return "unknown"

  const newStatus: HubnetStatus = lookup.refunded ? "failed" : lookup.status
  let applied = false
  for (const row of movable) {
    if (row.status === newStatus) continue
    const raw = lookup.refunded ? "refunded" : newStatus
    const moved = await deps.applyData(deps.db, row, newStatus, { status: raw, message: `Hubnet webhook re-check: ${raw}` })
    if (moved) applied = true
  }
  return applied ? "applied" : "ignored"
}

async function processAirtime(ref: string, deps: HubnetWebhookDeps): Promise<HubnetWebhookResult> {
  const marker = `[hubnetRef:${ref}]`
  const { data: rows, error } = await deps.db.from("airtime_orders").select("id, status, notes")
    .eq("status", "processing").ilike("notes", `%${marker}%`).limit(5)
  if (error) throw error
  const matches = (rows ?? []).filter((r: any) => r.status === "processing" && String(r.notes ?? "").includes(marker))
  if (matches.length === 0) return "ignored"

  const lookup: StatusLookup = await deps.client.getStatus(ref)
  if (lookup.kind !== "found") return "unknown"

  let applied = false
  for (const row of matches) {
    if (await deps.applyAirtime(deps.db, row.id, lookup)) applied = true
  }
  return applied ? "applied" : "ignored"
}
