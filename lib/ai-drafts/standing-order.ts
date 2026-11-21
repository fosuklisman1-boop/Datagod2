import { createHash } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { AiDraft } from "./types"
import { walletOrderPrice } from "@/lib/pricing/wallet-order-price"
import { computeNextRun } from "@/lib/ai-scheduled/next-run"

// A standing order is a scheduled data order the user approved ONCE on a card. The cron runs it WITHOUT the AI model:
// a background job charging a wallet with nobody present, so every run re-checks the approval, the user and the price
// before the purchase endpoint is called. Nothing here logs names, phones, emails or user ids.

export const STANDING_ORDER_NS = "6f1d2c3a-8b7e-4d10-9a5c-2e4f6a8b0c1d"

/** RFC 4122 name-based uuid, version 5 (sha1). */
export function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex")
  const hash = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** One key per task and scheduled slot, so a double fire of the same slot can place at most one order. */
export function standingOrderKey(taskId: string, slotIso: string): string {
  const t = Date.parse(slotIso)
  // Normalise ("...+00:00" and "....000Z" are the same slot). An unparseable slot keeps its text: still deterministic.
  const slot = Number.isFinite(t) ? new Date(t).toISOString() : slotIso
  return uuidV5(`${taskId}:${slot}`, STANDING_ORDER_NS)
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const sameMoney = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005

export const STANDING_ORDER_PROMPT = "Standing data order (runs without AI)"

const maskPhone = (local: string) => `${local.slice(0, 3)}***${local.slice(-4)}`

export interface StandingOrderFields {
  package_id: string
  network: string
  size: string
  recipient: string
  max_price_ghs: number
}

export interface StandingOrderTask {
  id: string
  user_id: string
  next_run_at: string
  standing_order: Partial<StandingOrderFields> | null
  approved_draft_id: string | null
}

export type StandingOrderOutcome =
  | { result: "ordered"; orderCode?: string }
  | { result: "skipped"; reason: string }
  | { result: "paused"; reason: string }
  | { result: "failed"; reason: string }

export interface StandingOrderCtx {
  baseUrl: string
  cronSecret: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

// ---------------------------------------------------------------------------------------------------------------------
// Creation (at confirm)
// ---------------------------------------------------------------------------------------------------------------------

export type CreateTaskResult = { ok: true; taskId: string; nextRunAt: string } | { ok: false }

/** Inserts the task row for a confirmed scheduled wallet_order draft. No order is placed. Idempotent per draft. */
export async function createStandingOrderTask(db: SupabaseClient, draft: Pick<AiDraft, "id" | "user_id" | "params">): Promise<CreateTaskResult> {
  const p = draft.params as Record<string, any>
  const s = p.schedule as { type: string; runAtTime?: string; runOnDays?: number[]; runAtTimestamp?: string } | undefined
  if (!s) return { ok: false }

  const { data: existing, error: exErr } = await db
    .from("ai_scheduled_tasks")
    .select("id, next_run_at")
    .eq("approved_draft_id", draft.id)
    .maybeSingle()
  if (exErr) return { ok: false }
  if (existing) return { ok: true, taskId: String((existing as any).id), nextRunAt: String((existing as any).next_run_at) }

  const { data: userRow } = await db.from("users").select("role").eq("id", draft.user_id).maybeSingle()
  const nextRunAt = computeNextRun({
    schedule_type: s.type,
    run_at_time: s.runAtTime ?? null,
    run_on_days: s.runOnDays ?? null,
    run_at_timestamp: s.runAtTimestamp ?? null,
  }).toISOString()

  const { data, error } = await db
    .from("ai_scheduled_tasks")
    .insert({
      name: `Data order: ${String(p.network).toUpperCase()} ${p.size} → ${maskPhone(String(p.recipient))}`,
      prompt: STANDING_ORDER_PROMPT,
      context: "dashboard",
      user_id: draft.user_id,
      user_role: String((userRow as any)?.role || "user"),
      schedule_type: s.type,
      run_at_time: s.runAtTime ?? null,
      run_on_days: s.runOnDays ?? null,
      run_at_timestamp: s.runAtTimestamp ?? null,
      notify_channels: ["push"],
      next_run_at: nextRunAt,
      is_active: true,
      consecutive_skips: 0,
      standing_order: {
        package_id: p.packageId,
        network: p.network,
        size: p.size,
        recipient: p.recipient,
        max_price_ghs: Number(p.price),
      },
      approved_draft_id: draft.id,
      created_by: draft.user_id,
    })
    .select("id, next_run_at")
    .single()
  if (error || !data) return { ok: false }
  return { ok: true, taskId: String((data as any).id), nextRunAt: String((data as any).next_run_at ?? nextRunAt) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Run (cron, no model)
// ---------------------------------------------------------------------------------------------------------------------

async function pause(db: SupabaseClient, taskId: string, reason: "safety_check" | "suspended"): Promise<StandingOrderOutcome> {
  // Fixed marker only: no ids, numbers or names.
  console.error(`[STANDING-ORDER] paused: ${reason}`)
  try {
    await db.from("ai_scheduled_tasks").update({ is_active: false }).eq("id", taskId)
  } catch {
    console.error("[STANDING-ORDER] pause write failed")
  }
  return { result: "paused", reason }
}

/**
 * Runs one scheduled slot of a standing order. Every early return happens BEFORE the purchase call; the purchase is
 * attempted at most once per call (no retry), and its idempotency key is fixed per (task, slot).
 */
export async function runStandingOrder(db: SupabaseClient, task: StandingOrderTask, ctx: StandingOrderCtx): Promise<StandingOrderOutcome> {
  const so = task.standing_order
  if (!so || !task.approved_draft_id || !so.package_id || !so.recipient || !Number.isFinite(Number(so.max_price_ghs))) {
    return pause(db, task.id, "safety_check")
  }

  // R7: the approval on file must still match exactly what the user confirmed on the card.
  let draft: Record<string, any> | null = null
  try {
    const { data, error } = await db.from("ai_drafts").select("id, user_id, action, status, params").eq("id", task.approved_draft_id).maybeSingle()
    if (error) throw error
    draft = (data as Record<string, any>) ?? null
  } catch {
    // A read failure is not proof of tampering, but nothing may be bought without the check: skip this run.
    return { result: "skipped", reason: "check_unavailable" }
  }
  const dp = draft?.params as Record<string, any> | undefined
  const approved =
    !!draft &&
    draft.user_id === task.user_id &&
    draft.action === "wallet_order" &&
    draft.status === "succeeded" &&
    !!dp?.schedule &&
    dp.packageId === so.package_id &&
    dp.recipient === so.recipient &&
    sameMoney(Number(dp.price), Number(so.max_price_ghs))
  if (!approved) return pause(db, task.id, "safety_check")

  let user: Record<string, any> | null = null
  let pkg: Record<string, any> | null = null
  let balance = NaN
  try {
    const u = await db.from("users").select("role, is_suspended").eq("id", task.user_id).maybeSingle()
    if (u.error) throw u.error
    user = (u.data as Record<string, any>) ?? null
    const pk = await db.from("packages").select("id, network, size, price, dealer_price, is_available").eq("id", so.package_id).maybeSingle()
    if (pk.error) throw pk.error
    pkg = (pk.data as Record<string, any>) ?? null
    const w = await db.from("wallets").select("balance").eq("user_id", task.user_id).maybeSingle()
    if (w.error) throw w.error
    balance = Number((w.data as any)?.balance)
  } catch {
    return { result: "skipped", reason: "check_unavailable" }
  }

  if (!user || user.is_suspended) return pause(db, task.id, "suspended")
  if (!pkg || !pkg.is_available) return { result: "skipped", reason: "package_unavailable" }

  let price: number
  try {
    price = round2(await walletOrderPrice(db, task.user_id, String(user.role || "user"), pkg as any))
  } catch {
    return { result: "skipped", reason: "prices_unavailable" }
  }
  if (!Number.isFinite(price) || price <= 0) return { result: "skipped", reason: "prices_unavailable" }
  if (price > Number(so.max_price_ghs) + 0.004) return { result: "skipped", reason: "above_cap" }
  if (!Number.isFinite(balance) || balance < price) return { result: "skipped", reason: "insufficient_balance" }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs ?? 15_000)
  try {
    const r = await (ctx.fetchImpl ?? fetch)(`${ctx.baseUrl}/api/orders/purchase`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.cronSecret}` },
      body: JSON.stringify({
        packageId: so.package_id,
        phoneNumber: so.recipient,
        network: String(pkg.network),
        userId: task.user_id,
        idempotencyKey: standingOrderKey(task.id, task.next_run_at),
      }),
      signal: ctrl.signal,
    })
    let body: Record<string, any> = {}
    try {
      const j = await r.json()
      if (j && typeof j === "object") body = j
    } catch {
      body = {}
    }
    if (r.status >= 200 && r.status < 300) {
      // alreadyPlaced:true is a double fire of the same slot: the order exists, so this is a success.
      const code = body.order?.order_code
      return { result: "ordered", ...(typeof code === "string" ? { orderCode: code } : {}) }
    }
    if (r.status === 402) return { result: "skipped", reason: "insufficient_balance" }
    return { result: "failed", reason: `http_${r.status}` }
  } catch {
    return { result: "failed", reason: "no_response" }
  } finally {
    clearTimeout(timer)
  }
}
