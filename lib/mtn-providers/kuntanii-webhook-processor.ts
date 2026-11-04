import { createClient } from "@supabase/supabase-js"

// Kuntanii webhook = SIGNAL ONLY. Their signature scheme is undocumented, so
// nothing in the webhook body (status, amounts, etc.) is ever trusted or
// applied. A webhook only identifies which tracking row to re-check; the
// status then comes from our own authenticated API call (syncMTNOrderStatus
// -> KuntaniiProvider.checkOrderStatus). Helpers live here, not in route.ts,
// because Next rejects non-route exports from route files.

export const REFETCH_THROTTLE_MS = 15_000

const ID_RE = /^[0-9a-f-]{36}(-r[2-5])?$/i

export function extractExternalOrderId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const data = (body as any).data
  if (!data || typeof data !== "object") return null
  const id = data.externalOrderId
  if (typeof id !== "string" || id.length > 64) return null
  return ID_RE.test(id) ? id : null
}

export function signatureHeaderSnapshot(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (/signature|sig|timestamp/i.test(name)) out[name.toLowerCase()] = value
  })
  return out
}

type Tracking = { id: string; webhook_received_at: string | null }

export interface KuntaniiWebhookDeps {
  findTracking?: (externalOrderId: string) => Promise<Tracking | null>
  markReceived?: (trackingId: string) => Promise<void>
  sync?: (trackingId: string) => Promise<unknown>
  refreshOpenDisputes?: (trackingId: string) => Promise<void>
  now?: () => number
}

function getSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

async function defaultFindTracking(externalOrderId: string): Promise<Tracking | null> {
  const { data, error } = await getSupabase()
    .from("mtn_fulfillment_tracking")
    .select("id, webhook_received_at")
    .eq("provider", "kuntanii")
    .eq("mtn_order_id", externalOrderId)
    .order("created_at", { ascending: false })
    .limit(1)
  if (error) throw new Error(`findTracking failed: ${error.message}`)
  return data && data.length > 0 ? (data[0] as Tracking) : null
}

// Touches ONLY webhook_received_at.
async function defaultMarkReceived(trackingId: string): Promise<void> {
  const { error } = await getSupabase()
    .from("mtn_fulfillment_tracking")
    .update({ webhook_received_at: new Date().toISOString() })
    .eq("id", trackingId)
  if (error) throw new Error(`markReceived failed: ${error.message}`)
}

async function defaultSync(trackingId: string): Promise<unknown> {
  const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
  return syncMTNOrderStatus(trackingId)
}

// Task 7 wires the real implementation.
async function defaultRefreshOpenDisputes(_trackingId: string): Promise<void> {}

export async function processKuntaniiWebhook(
  input: { externalOrderId: string; event: string | null },
  deps: KuntaniiWebhookDeps = {}
): Promise<"ignored" | "throttled" | "synced"> {
  const findTracking = deps.findTracking ?? defaultFindTracking
  const markReceived = deps.markReceived ?? defaultMarkReceived
  const sync = deps.sync ?? defaultSync
  const refreshOpenDisputes = deps.refreshOpenDisputes ?? defaultRefreshOpenDisputes
  const now = deps.now ?? Date.now

  let tracking: Tracking | null
  try {
    tracking = await findTracking(input.externalOrderId)
  } catch (e) {
    console.error(`[WEBHOOK-KUNTANII] findTracking failed for ${input.externalOrderId}:`, (e as Error).message)
    return "ignored"
  }
  if (!tracking) {
    console.warn(`[WEBHOOK-KUNTANII] No tracking row for ${input.externalOrderId}, ignoring`)
    return "ignored"
  }

  if (tracking.webhook_received_at) {
    const last = Date.parse(tracking.webhook_received_at)
    if (Number.isFinite(last) && now() - last < REFETCH_THROTTLE_MS) return "throttled"
  }

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      console.error(`[WEBHOOK-KUNTANII] ${name} failed for tracking ${tracking!.id}:`, (e as Error).message)
    }
  }

  await step("markReceived", () => markReceived(tracking!.id))
  await step("sync", () => sync(tracking!.id))
  if (input.event && input.event.startsWith("order.not_received_")) {
    await step("refreshOpenDisputes", () => refreshOpenDisputes(tracking!.id))
  }
  return "synced"
}
