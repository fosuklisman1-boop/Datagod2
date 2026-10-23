/**
 * Provider hand-off for v2 data orders. Mirrors the DIRECT dispatch that
 * app/api/v1/orders/route.ts does for api_orders (MTN via createMTNOrder +
 * tracking/hold, Telecel/AT via createNonMTNOrder with orderType "api").
 * The fulfillment_queue is NOT used: it is only fed by an admin enqueue
 * route, no order source hands work to providers through it.
 *
 * dispatchFulfillment is pure over injected deps and imports nothing heavy.
 * Real wiring (dynamic imports, so tests never load provider modules) lives
 * in realFulfillmentDeps. The routes pass next's after() in statically from
 * endpoints/data-deps.ts; the lazy realAfter here is only the default when
 * no afterFn is given.
 *
 * Replays must NOT dispatch again: that is the caller's job.
 */
import type { MTNOrderRequest, MTNOrderResponse } from "@/lib/mtn-fulfillment"
import type { NonMTNOrderParams } from "@/lib/non-mtn-fulfillment"

export interface FulfillmentDeps {
  isMtnAuto(): Promise<boolean>
  createMtnOrder(req: MTNOrderRequest): Promise<MTNOrderResponse>
  saveMtnTracking(
    orderId: string,
    mtnOrderId: number | string,
    req: MTNOrderRequest,
    resp: MTNOrderResponse,
    provider: string
  ): Promise<void>
  holdMtnOrder(p: { orderId: string; phone: string }): Promise<{ held: boolean }>
  markProcessing(orderId: string): Promise<void>
  createNonMtnOrder(req: NonMTNOrderParams): Promise<unknown>
}

export interface FulfillmentTarget {
  orderId: string
  dbNetwork: string
  gb: number
  msisdn: string
  /** Local 0XXXXXXXXX form, what the providers and the order row use. */
  local: string
}

export type FulfillmentOutcome = { attempted: boolean; outcome: "mtn" | "non_mtn" | "skipped" | "error" }

/** Same list v1 uses, compared lower-cased. */
const NON_MTN_AUTO = new Set(["at - ishare", "at-ishare", "telecel", "at - bigtime", "at-bigtime"])

/** Error class name only: messages can carry phone numbers or provider payloads. */
function errName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "UnknownError"
}

export async function dispatchFulfillment(deps: FulfillmentDeps, o: FulfillmentTarget): Promise<FulfillmentOutcome> {
  const network = o.dbNetwork.trim().toLowerCase()
  let attempted = false
  try {
    if (network === "mtn") {
      if (!(await deps.isMtnAuto())) return { attempted: false, outcome: "skipped" }
      attempted = true
      const req: MTNOrderRequest = {
        recipient_phone: o.local,
        network: "MTN",
        size_gb: o.gb,
        client_ref: o.orderId,
      }
      const res = await deps.createMtnOrder(req)
      if (res.held) {
        await deps.holdMtnOrder({ orderId: o.orderId, phone: o.local })
      } else if (res.order_id) {
        await deps.saveMtnTracking(o.orderId, res.order_id, req, res, res.provider || "sykes")
        if (res.success) await deps.markProcessing(o.orderId)
      }
      return { attempted: true, outcome: "mtn" }
    }

    if (NON_MTN_AUTO.has(network)) {
      attempted = true
      await deps.createNonMtnOrder({
        phoneNumber: o.local,
        sizeGb: o.gb,
        orderId: o.orderId,
        network,
        orderType: "api",
      })
      return { attempted: true, outcome: "non_mtn" }
    }

    return { attempted: false, outcome: "skipped" }
  } catch (err) {
    console.error("[API v2] fulfillment error:", errName(err))
    return { attempted, outcome: "error" }
  }
}

/** The SAME underlying modules v1 uses, loaded lazily. */
export function realFulfillmentDeps(): FulfillmentDeps {
  return {
    isMtnAuto: async () => (await import("@/lib/mtn-fulfillment")).isAutoFulfillmentEnabled(),
    createMtnOrder: async (req) => (await import("@/lib/mtn-fulfillment")).createMTNOrder(req),
    saveMtnTracking: async (orderId, mtnOrderId, req, resp, provider) => {
      const m = await import("@/lib/mtn-fulfillment")
      await m.saveMTNTracking(orderId, mtnOrderId, req, resp, "api", provider)
    },
    holdMtnOrder: async ({ orderId, phone }) => {
      const { holdMtnOrder } = await import("@/lib/mtn-hold")
      return holdMtnOrder({ table: "api_orders", orderId, phone })
    },
    markProcessing: async (orderId) => {
      const { createClient } = await import("@supabase/supabase-js")
      const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      // Guarded (v1 is unconditional): never move a row a webhook already advanced.
      await client.from("api_orders").update({ status: "processing" }).eq("id", orderId).eq("status", "pending")
    },
    createNonMtnOrder: async (req) => (await import("@/lib/non-mtn-fulfillment")).createNonMTNOrder(req),
  }
}

export type AfterFn = (cb: () => Promise<void>) => void

async function realAfter(cb: () => Promise<void>): Promise<void> {
  const { after } = await import("next/server")
  after(cb)
}

/**
 * Synchronous from the caller's view; never throws and never leaves an
 * unhandled rejection. Prefers next's after() (runs once the response is
 * sent); if after() is unavailable or throws (no request scope), falls back to
 * a caught fire-and-forget dispatch. Logs a fixed string with the error name.
 */
export function scheduleFulfillment(
  o: FulfillmentTarget,
  afterFn?: AfterFn,
  makeDeps: () => FulfillmentDeps = realFulfillmentDeps
): void {
  const run = async () => {
    try {
      await dispatchFulfillment(makeDeps(), o)
    } catch (err) {
      console.error("[API v2] fulfillment schedule error:", errName(err))
    }
  }
  scheduleRun(run, afterFn)
}

/** How many bulk orders are handed to providers at once (one createMTNOrder chain each). */
export const BULK_DISPATCH_CONCURRENCY = 4

/**
 * Bulk variant: ONE after() callback that dispatches every target with at
 * most `concurrency` in flight (a small worker pool), instead of one
 * callback per order starting up to 100 provider chains at once. Same
 * contract as scheduleFulfillment: synchronous, never throws, a failing
 * target never stops the rest, inline fallback when after() is unavailable,
 * PII-free logs. An empty list registers nothing.
 */
export function scheduleFulfillmentBatch(
  targets: FulfillmentTarget[],
  opts: { concurrency: number },
  afterFn?: AfterFn,
  makeDeps: () => FulfillmentDeps = realFulfillmentDeps
): void {
  if (targets.length === 0) return
  const list = [...targets]
  const limit = Math.max(1, Math.floor(opts.concurrency) || 1)
  const run = async () => {
    let deps: FulfillmentDeps
    try {
      deps = makeDeps()
    } catch (err) {
      console.error("[API v2] fulfillment schedule error:", errName(err))
      return
    }
    let next = 0
    const worker = async () => {
      while (next < list.length) {
        const o = list[next++]
        try {
          await dispatchFulfillment(deps, o)
        } catch (err) {
          console.error("[API v2] fulfillment schedule error:", errName(err))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => worker()))
  }
  scheduleRun(run, afterFn)
}

/**
 * Registers `run` with after() (the given one, else next's, loaded lazily),
 * falling back to a caught inline run when after() is unavailable or throws.
 */
function scheduleRun(run: () => Promise<void>, afterFn?: AfterFn): void {
  const fallback = () => {
    void run().catch(() => {})
  }
  try {
    if (afterFn) {
      afterFn(run)
      return
    }
    realAfter(run).catch((err) => {
      console.error("[API v2] after() unavailable, dispatching inline:", errName(err))
      fallback()
    })
  } catch (err) {
    console.error("[API v2] after() unavailable, dispatching inline:", errName(err))
    fallback()
  }
}
