// lib/ussd-hubtel/flow-kit.ts
// Shared plumbing for every Hubtel menu flow: the dependency bag, the step-handler type, reply
// helpers, and the ONE place an order + hubtel_transactions row is written (submitOrder) and
// replayed (replaySubmittedOrder). Flows never insert orders or tx rows themselves.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import type { PrefixValidationConfig } from "@/lib/network-prefix-config"
import type { HubtelUssdConfig } from "./config"
import type { AfaServices, AirtimeServices, DialerInfo, RcServices } from "./services"
import type { HubtelSessionStore } from "./session"
import type { ShopServices } from "./shop-services"
import type { ShopBillingGuard } from "./billing-guard"
import type { CallerContext } from "./catalog"
import { resolveMainMenu, mainMenuText, type MainMenuKey } from "./menus"
import { ORDER_TABLES, isHubtelOrderTable, type HubtelOrderTable } from "./order-tables"
import { addToCart, release, respond } from "./protocol"
import { safeDbError } from "./log-safe"
import type { HubtelFieldType, HubtelPlatform, HubtelReply, HubtelRequest, HubtelSession, HubtelStep } from "./types"

export interface RouterDeps {
  supabase: SupabaseClient
  getConfig(): Promise<HubtelUssdConfig>
  sessions: HubtelSessionStore
  fetchBundles: (network: string, page: number, tier: string, parentShopId?: string) => Promise<{ bundles: BundleOption[]; total: number }>
  resolveCaller: (phone: string) => Promise<CallerContext>
  isDataBlocked: (msisdn: string) => Promise<boolean>
  getPrefixConfig: () => Promise<PrefixValidationConfig>
  pageSize: number
  resolveDialer: (phone: string) => Promise<DialerInfo>
  airtime: AirtimeServices
  rc: RcServices
  afa: AfaServices
  shop: ShopServices
  shopBilling: ShopBillingGuard
}

export interface FlowCtx {
  /** req.Message, trimmed. */
  input: string
  req: HubtelRequest
  deps: RouterDeps
  config: HubtelUssdConfig
  session: HubtelSession
}

export type StepHandler = (ctx: FlowCtx) => Promise<HubtelReply>
export type StepTable = Partial<Record<HubtelStep, StepHandler>>

export interface ScreenOpts {
  label: string
  fieldType?: HubtelFieldType
}

export const CART_MESSAGE = "Request submitted. Approve the payment prompt on your phone to complete your order."

/** Answer on `step` without writing the session. ClientState echoes the step name. */
export function say(ctx: FlowCtx, text: string, step: HubtelStep, opts: ScreenOpts): HubtelReply {
  return respond(ctx.req.SessionId, text, {
    label: opts.label, fieldType: opts.fieldType, clientState: step, platform: ctx.req.Platform,
  })
}

/** Merge `patch` into the session (moving to patch.step) and show `text`. */
export async function goto(
  ctx: FlowCtx,
  patch: Partial<HubtelSession> & { step: HubtelStep },
  text: string,
  opts: ScreenOpts
): Promise<HubtelReply> {
  await ctx.deps.sessions.set(ctx.req.SessionId, { ...ctx.session, ...patch })
  return say(ctx, text, patch.step, opts)
}

/** End the session with a final message. */
export async function finish(ctx: FlowCtx, text: string): Promise<HubtelReply> {
  await ctx.deps.sessions.del(ctx.req.SessionId)
  return release(ctx.req.SessionId, text, { platform: ctx.req.Platform })
}

export function menuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveMainMenu(config.visibility as Record<MainMenuKey, boolean>, dataBlocked)
}

export function mainMenuReply(ctx: FlowCtx): HubtelReply {
  return say(ctx, mainMenuText(menuFor(ctx.config, ctx.session.dataBlocked === true)), "MAIN", { label: "Main menu" })
}

/** "0" on a flow's first screen: back to the main menu with a clean session. */
export async function backToMain(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  await ctx.deps.sessions.set(ctx.req.SessionId, {
    step: "MAIN", dialingPhone: s.dialingPhone, platform: s.platform, dataBlocked: s.dataBlocked,
  })
  return mainMenuReply(ctx)
}

/**
 * Idempotency guard shared by every CONFIRM and the no-session path. If this Hubtel session
 * already produced an order: replay the identical AddToCart while it awaits payment, else say it
 * was already submitted. Returns null when no order exists for the session.
 */
export async function replaySubmittedOrder(
  deps: RouterDeps,
  sid: string,
  platform: HubtelPlatform
): Promise<HubtelReply | null> {
  const { data: tx } = await deps.supabase
    .from("hubtel_transactions")
    .select("order_table, order_id, expected_amount, state")
    .eq("session_id", sid)
    .maybeSingle()
  if (!tx) return null
  const alreadySubmitted = async () => {
    await deps.sessions.del(sid)
    return release(sid, "This order was already submitted.", { platform })
  }
  if (tx.state !== "awaiting_payment") return alreadySubmitted()
  if (!isHubtelOrderTable(tx.order_table)) {
    console.error("[HUBTEL-REPLAY] Unknown order table on tx row:", tx.order_table, "session:", sid)
    return alreadySubmitted()
  }
  const spec = ORDER_TABLES[tx.order_table]
  const { data: order } = await deps.supabase.from(tx.order_table).select(spec.cartColumns).eq("id", tx.order_id).single()
  if (!order) return alreadySubmitted()
  await deps.sessions.del(sid)
  return addToCart(sid, {
    itemName: spec.cartItemName(order as unknown as Record<string, unknown>),
    price: Number(tx.expected_amount),
    message: CART_MESSAGE,
    platform,
  })
}

/**
 * Inserts the order + its hubtel_transactions row and answers with AddToCart at `price` (our
 * price: Hubtel adds its own charge on top). Callers MUST have run replaySubmittedOrder first and
 * re-verified price/stock. On a tx insert failure the order is marked failed with the table's
 * fail patch; on a unique violation (a concurrent CONFIRM won) the winner's cart is replayed.
 */
export async function submitOrder(
  ctx: FlowCtx,
  args: { table: HubtelOrderTable; row: Record<string, unknown>; price: number; logTag: string }
): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const sid = req.SessionId
  const platform = req.Platform
  const spec = ORDER_TABLES[args.table]

  if (!(Number.isFinite(args.price) && args.price > 0)) {
    console.error(`[${args.logTag}] Refusing to AddToCart a non-positive price:`, args.price, "session:", sid)
    return finish(ctx, "Service unavailable. Please try again later.")
  }

  const { data: order, error: orderError } = await deps.supabase.from(args.table).insert([args.row]).select("id").single()
  if (orderError || !order) {
    console.error(`[${args.logTag}] Failed to create order:`, safeDbError(orderError))
    return finish(ctx, "Error creating order. Please try again.")
  }

  const { error: txError } = await deps.supabase.from("hubtel_transactions").insert({
    session_id: sid,
    platform,
    order_table: args.table,
    order_id: order.id,
    mobile: session.dialingPhone,
    expected_amount: args.price,
  })
  if (txError) {
    console.error(`[${args.logTag}] hubtel_transactions insert failed:`, safeDbError(txError))
    const { error: rollbackError } = await deps.supabase.from(args.table).update(spec.failPatch()).eq("id", order.id)
    if (rollbackError) console.error(`[${args.logTag}] Failed to mark order failed after tx insert error:`, order.id, safeDbError(rollbackError))
    if ((txError as { code?: string }).code === "23505") {
      // A concurrent CONFIRM for this session won the insert: answer exactly as it did, so the
      // customer pays for the order that is actually tracked.
      const replay = await replaySubmittedOrder(deps, sid, platform)
      if (replay) return replay
    }
    return finish(ctx, "Error creating order. Please try again.")
  }

  await deps.sessions.del(sid)
  return addToCart(sid, { itemName: spec.cartItemName(args.row), price: args.price, message: CART_MESSAGE, platform })
}
