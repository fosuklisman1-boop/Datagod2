// lib/ussd-hubtel/flow-kit.ts
// Shared plumbing for every Hubtel menu flow: the dependency bag, the step-handler type, reply
// helpers, and the ONE place an order + hubtel_transactions row is written (submitOrder) and
// replayed (replaySubmittedOrder). Flows never insert orders or tx rows themselves.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import type { PrefixValidationConfig } from "@/lib/network-prefix-config"
import type { BotMenuGate, HubtelUssdConfig } from "./config"
import type { AfaServices, AirtimeServices, DialerInfo, NetworkPlansServices, PayBillsServices, RcServices } from "./services"
import type { HubtelSessionStore } from "./session"
import type { ShopServices } from "./shop-services"
import type { CallerContext } from "./catalog"
import { resolveMainMenu, mainMenuText } from "./menus"
import { cartItemNameFor, failOrderGuarded, isHubtelOrderTable, type HubtelOrderTable } from "./order-tables"
import { addToCart, release, respond } from "./protocol"
import { safeDbError } from "./log-safe"
import type { DeliveryChannel } from "@/lib/delivery-estimate/query"
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
  networkPlans: NetworkPlansServices
  payBills: PayBillsServices
  /**
   * Cashback bots gate for the Network Plans / Pay Bills menus, loaded per request by hubtelRouter. Must not
   * throw (the default fails closed); the router also treats a throw as hidden.
   */
  botMenus(): Promise<BotMenuGate>
  /**
   * Optional "Delivery: ~N min" line for the data confirm screen, or null to show nothing. Must not throw
   * and must be fast (cached); a purchase never waits on it or fails because of it.
   */
  deliveryEstimate?(channel: DeliveryChannel): Promise<string | null>
  /**
   * Live customer-facing number verification (same check as the storefront / data packages page). Optional;
   * false = not yet verified (warn, still sellable); "blocked" = rejected while the admin blocking toggle is on
   * (not sellable). Must fail open; callers also time it out.
   */
  verifyRecipient?(phoneLocal: string): Promise<boolean | "blocked">
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

/** The main menu for this request. Bot menus need config.botMenus (set by hubtelRouter); absent = hidden. */
export function menuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveMainMenu(config.visibility, dataBlocked, config.botMenus)
}

export function mainMenuReply(ctx: FlowCtx): HubtelReply {
  return say(ctx, mainMenuText(menuFor(ctx.config, ctx.session.dataBlocked === true), ctx.config.welcome), "MAIN", { label: "Main menu" })
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
  // The order must still exist; its id alone names the cart (cartItemNameFor).
  const { data: order } = await deps.supabase.from(tx.order_table).select("id").eq("id", tx.order_id).single()
  if (!order) return alreadySubmitted()
  await deps.sessions.del(sid)
  return addToCart(sid, {
    itemName: cartItemNameFor(tx.order_id),
    price: Number(tx.expected_amount),
    message: CART_MESSAGE,
    platform,
  })
}

// Lives next to ORDER_TABLES (so non-Hubtel callers need not load the menu code); re-exported for Hubtel callers.
export { failOrderGuarded }

/**
 * An engine order that will NOT be carted this request (createOrder threw after committing, or its read-back
 * errored / was not open): fail it with the guarded fail patch so it never sits pending + unpaid with no
 * hubtel_transactions row (the expiry sweep only sees orders with one). Skipped when a tx row already tracks the
 * order (a concurrent CONFIRM carted it; the customer may be paying), or when that check itself fails.
 */
export async function failOrphanEngineOrder(
  deps: RouterDeps, table: HubtelOrderTable, id: string, logTag: string, sid: string,
): Promise<void> {
  const { data: tx, error } = await deps.supabase.from("hubtel_transactions").select("order_id").eq("order_table", table).eq("order_id", id).maybeSingle()
  if (error) {
    console.error(`[${logTag}] Orphan check failed; leaving engine order as is:`, id, "session:", sid, safeDbError(error))
    return
  }
  if (tx) return
  console.error(`[${logTag}] Failing uncarted engine order:`, id, "session:", sid)
  await failOrderGuarded(deps.supabase, table, id, true, logTag)
}

/** The order is inserted here from `row` (every flow except the commission bots). */
export interface SubmitNewOrder { table: HubtelOrderTable; row: Record<string, unknown>; price: number; logTag: string; orderId?: never }
/**
 * The order already exists: created (unpaid) by the commission engine, keyed by this session, so a
 * repeat CONFIRM gets the same id back. Only the hubtel_transactions row + cart are written here.
 */
export interface SubmitCreatedOrder { table: HubtelOrderTable; orderId: string; price: number; logTag: string; row?: never }

/**
 * Inserts the order (unless `orderId` names an engine-created one) + its hubtel_transactions row and
 * answers with AddToCart at `price` (our price: Hubtel adds its own charge on top). Callers MUST have
 * run replaySubmittedOrder first and re-verified price/stock. On a tx insert failure the order is
 * marked failed with the table's fail patch; on a unique violation (a concurrent CONFIRM won) the
 * winner's cart is replayed. An engine-created order is shared with that winner (same session key),
 * so it is never failed on a unique violation.
 */
export async function submitOrder(ctx: FlowCtx, args: SubmitNewOrder | SubmitCreatedOrder): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const sid = req.SessionId
  const platform = req.Platform
  const created = typeof args.orderId === "string"

  const rollback = (id: string) => failOrderGuarded(deps.supabase, args.table, id, created, args.logTag)

  if (!(Number.isFinite(args.price) && args.price > 0)) {
    console.error(`[${args.logTag}] Refusing to AddToCart a non-positive price:`, args.price, "session:", sid)
    if (created) await rollback(args.orderId!) // never leave an engine order open with no checkout
    return finish(ctx, "Service unavailable. Please try again later.")
  }

  let order: { id: string }
  if (created) {
    order = { id: args.orderId! }
  } else {
    const { data: inserted, error: orderError } = await deps.supabase.from(args.table).insert([args.row]).select("id").single()
    if (orderError || !inserted) {
      console.error(`[${args.logTag}] Failed to create order:`, safeDbError(orderError))
      return finish(ctx, "Error creating order. Please try again.")
    }
    order = inserted
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
    const conflict = (txError as { code?: string }).code === "23505"
    if (!(created && conflict)) await rollback(order.id)
    if (conflict) {
      // A concurrent CONFIRM for this session won the insert: answer exactly as it did, so the
      // customer pays for the order that is actually tracked.
      const replay = await replaySubmittedOrder(deps, sid, platform)
      if (replay) return replay
      if (created) {
        // No winner to replay: the engine order has no checkout row, so the expiry sweep would never see it.
        console.error(`[${args.logTag}] 23505 with no replayable tx row; failing engine order:`, order.id, "session:", sid)
        await rollback(order.id)
      }
    }
    return finish(ctx, "Error creating order. Please try again.")
  }

  await deps.sessions.del(sid)
  return addToCart(sid, { itemName: cartItemNameFor(order.id), price: args.price, message: CART_MESSAGE, platform })
}
