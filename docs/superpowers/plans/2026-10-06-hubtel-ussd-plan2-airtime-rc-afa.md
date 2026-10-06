# Hubtel USSD — Plan 2: Airtime, Results Checker, AFA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Buy Airtime, Results Checker (buy vouchers, my vouchers, resend, and the "Check Results" on-behalf service) and AFA Registration to the Hubtel channel in MAIN mode, each paid through Hubtel AddToCart, plus an admin "mark resolved" action for `needs_review` rows.

**Architecture:** Plan 1's single-file router is split into a step registry: `flow-kit.ts` holds the dependency bag, reply helpers and the ONE place an order + `hubtel_transactions` row is written (`submitOrder`) or replayed (`replaySubmittedOrder`); each service is a `flows/*.ts` module that exports its step handlers. A per-table registry (`order-tables.ts`) drives rollback, replay and expiry for every order table. Post-payment handlers in `order-handlers.ts` reuse the exported library functions the Paystack webhook uses, behind the same payable-state guard as the Plan 1 `ussd_orders` handler, and always run inside `processFulfillment`'s atomic claim.

**Tech Stack:** Next.js 15 App Router route handlers, TypeScript, Supabase (service-role client), Upstash Redis (session), Vitest with hand-rolled fakes.

**Spec:** `docs/superpowers/specs/2026-10-05-hubtel-ussd-design.md` (read §5, §6, §8 and §14). Plan 1 (already executed, the style reference): `docs/superpowers/plans/2026-10-05-hubtel-ussd-core-and-data-bundles.md`. Plan 1 ledger with rulings: `.superpowers/sdd/2026-10-05-hubtel-ussd-core-and-data-bundles/progress.md` and `final-fix-report.md`.

**Out of scope (Plan 3):** shop mode (`mode=shop`, shop code step, `ussd_shop_orders`, token deduction, shop profit on Hubtel orders).

## Decisions made while planning

The code and spec did not settle these. Each is the conservative choice; the cost if wrong is stated. Rulings from Plan 1 stand.

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| D1 | Split `router.ts` into `flow-kit.ts` + `flows/*.ts` with a step registry; the data flow moves verbatim. | Five flows in one switch would be ~1,500 lines; the registry lets each task add a flow without touching the others. | One refactor task before any feature; existing router tests are the regression net. |
| D2 | Every order insert, tx insert, rollback and replay goes through `submitOrder` / `replaySubmittedOrder`, driven by `ORDER_TABLES`. The AddToCart `ItemName` is computed from the stored order row, so a replay is byte-identical. Item names: `5GB MTN Data`, `MTN Airtime to 0244123456`, `WASSCE Checker x2`, `WASSCE Results Check` / `WASSCE Voucher + Results Check`, `AFA Registration`. | Plan 1's final review required table-generic replay and a 23505 replay for every flow; one implementation cannot drift per flow. | Item names are customer-visible at Hubtel; changing one later is a one-line registry edit. |
| D3 | New airtime / results-checker / check-request rows use `channel: "ussd"` (same as Uzo); Hubtel origin is recorded by the `hubtel_transactions` row, not a new channel value. | Results delivery branches on `channel` (`deliverResultsCheckRequest`: `whatsapp` vs `web` vs everything else); `ussd` gets the correct SMS + WhatsApp delivery with zero downstream changes. Uzo's OTP-redial lookup filters `payment_status='otp_required'`, which Hubtel rows never reach. | Reports cannot split Hubtel vs Uzo by `channel`; they must join `hubtel_transactions (order_table, order_id)`. |
| D4 | Payable-state guard per handler: `results_checker_orders` and `ussd_afa_orders` use an atomic conditional mark (`UPDATE … WHERE payment_status IN (payable) RETURNING id`, 0 rows ⇒ throw), exactly like Plan 1's `ussd_orders`. `airtime_orders` and `results_check_requests` read-check (already done ⇒ return; not payable ⇒ throw) and then call `markAirtimeOrderPaid` / `fulfillPaidResultsCheckRequest`, because those library functions are their own idempotency gate and a pre-mark would make them no-op. Exclusivity for those two comes from `processFulfillment`'s claim on the single tx row per order. | Reuse the exact Paystack post-payment code paths (spec §14) while never fulfilling a failed or already-paid order. | A non-Hubtel writer flipping one of those two orders in the ms between read and library write would be overwritten; no such writer exists for Hubtel-created rows. |
| D5 | Paid but undeliverable ⇒ handler throws ⇒ `needs_review`: results-checker vouchers out of stock after payment (`fulfillPaidResultsCheckerOrder` returns `pending`), and a combo check request where no voucher could be assigned. Provider failures for airtime (Digiwapy) and AFA do NOT throw (same as Paystack: the existing manual queues own them). | Spec §8: fulfilment failures must be loudly visible; the Paystack path leaves these silently `pending`. | Admin must deliver vouchers manually and then "mark resolved" (Task 6). |
| D6 | Any price drift between the confirm screen and "1" releases with "Price changed … restart" and creates no order: RC total, check fee / combo total, AFA price, and the airtime **delivered** amount (fee-rate change). | Same rule Plan 1 applies to data; Uzo silently charged the new value, which on Hubtel would show a different cart than the confirm screen. | Rare extra restart for the customer. |
| D7 | Airtime keeps Uzo's prefix auto-detect (`detectAirtimeNetwork`) and the manual network pick for unknown prefixes, and ADDS the admin network-prefix validation (when the toggle is on) on the final network/recipient pair, like web `purchaseAirtime`. Networks are shown as `MTN`, `Telecel`, `AT`. | Never buy airtime for a number on another network; matches the stricter web path. | A prefix in Uzo's hardcoded airtime map but missing from the admin map (e.g. `028`) is blocked while validation is on, as it already is on the web. |
| D8 | Airtime amount must match `^\d+(\.\d{1,2})?$` and be > 0 (Uzo used `parseFloat`, accepting `10abc`). | Money input. | None. |
| D9 | AFA: the dialing number must be MTN (live admin prefix map, applied regardless of the validation toggle), checked before any data entry. Price comes from the canonical active `name='default'` row in `afa_registration_prices` (same query as `submitAfaOrder`); missing/invalid price ⇒ service unavailable (Uzo silently fell back to 50). Order `amount` = that price with NO Paystack fee (Uzo added the fee). Full name: 3-100 chars of letters, spaces, `.`, `'`, `-` (Uzo: non-empty). | AFA is an MTN registration whose contact number is the dialer; Uzo's Paystack charge was hardcoded `provider:'mtn'`, so non-MTN Uzo callers already could not complete it. | Non-MTN callers cannot register AFA on Hubtel; a misconfigured price hides AFA instead of charging 50. |
| D10 | Check Results keeps Uzo's registered-account requirement ("create a Datagod account"), checked at entry AND at confirm. Combo (voucher + check) is offered only when the board is enabled AND in stock (Uzo: in stock only), and stock is re-checked at confirm. A `results_check_settings` read error fails closed (router error ⇒ "Service unavailable"; Uzo defaulted to enabled, fee 2). The WhatsApp-number step gains `0. Back`. | Keep existing business gating; never sell a voucher of a disabled board. | Unregistered callers cannot use the check service on Hubtel (same as Uzo). |
| D11 | Main-mode handlers refuse a shop-scoped AFA row (`shop_id` set ⇒ throw ⇒ `needs_review`) because Paystack's inline AFA shop-profit block is not ported; airtime / RC / check requests handle shop rows inside the reused library functions. The Hubtel main router never sets `shop_id`. | No silent missed shop profit. | None until Plan 3. |
| D12 | Mark resolved (Task 6): two outcomes. `fulfilled` (any `needs_review` row): state `fulfilled`; if `callback_status='not_due'` and `hubtel_order_id` is known ⇒ callback `pending` (+ `paid_at` if null, which bounds the 55-minute window); if the id is unknown ⇒ callback stays `not_due` and the response says so. `not_paid` (only rows with `paid_at IS NULL` and callback `not_due`, i.e. indeterminate-expiry rows): state `failed` + the table's fail handler (same as a definite expiry; a later Hubtel success webhook still recovers it to `needs_review`). Note 5-500 chars required. Conditional update on `state='needs_review'` + the read `callback_status` + `paid_at IS NULL` when it was null; 0 rows ⇒ 409. A signed-in admin user id is required (`admin_audit_log.admin_id` is NOT NULL, so the CRON bypass is refused). Migration `0107` adds `resolution_note`, `resolved_by`, `resolved_at` (no FK). No manual Hubtel order id entry. | Conservative: an admin can never resolve a row whose shape changed underneath (late webhook), never mark a recorded payment as unpaid, and never send a callback with a guessed OrderId. | Rows needing a hand-typed Hubtel order id still need SQL. |
| D13 | Blacklist / whitelist: Uzo applies the blacklist only inside data fulfilment (`lib/ussd/fulfill.ts`, already reused) and the `dataBlocked` whitelist only to data; neither is applied to airtime / RC / AFA here either. | Port Uzo gating exactly. | None. |
| D14 | Every Hubtel confirm uses `1. Pay now` / `2. Cancel` (Uzo's check-results confirm used `1. Proceed` / `0. Cancel`). The "not built yet" badges on the admin page are derived from `IMPLEMENTED_SERVICES`, so each disappears as its flow ships. | One consistent rule on this channel. | None. |

## Global Constraints

Every task's requirements implicitly include these.

- **Payment is Hubtel-only.** Every purchase ends in `AddToCart`. No wallet, Paystack, OTP, `PAYMENT_METHOD`, `SUBMIT_OTP` or pending-OTP-redial step on this channel (spec §5).
- **Order amount = OUR price**, no Paystack fee added; `hubtel_transactions.expected_amount` = that same price; the customer pays Hubtel's charge on top at Hubtel (spec §14, Plan 1 deviation table).
- **Price must be > 0** to AddToCart (`submitOrder` refuses otherwise).
- **The fulfilment callback is ALWAYS `success`**; failures go to `needs_review` (spec §8).
- **Fulfilment only through `processFulfillment`'s atomic claim.** Never call an order handler from anywhere else (not from the router, not from an admin route).
- **Payment fields are persisted before a handler runs** (Plan 1 I3; already in `payment.ts`, do not change it).
- **An indeterminate status check never expires a row** (Plan 1 I1; do not change `status-check.ts`).
- **Handlers must be safe:** throw (⇒ `needs_review`) when the order is not in a payable state, never fulfil twice, never send an SMS for a non-payable order.
- **Phones:** Hubtel `Mobile` arrives as `233…`. Normalise with `toLocalPhone` / `toE164` from `lib/ussd-hubtel/protocol.ts`. `dialing_phone` is stored E.164 (`+233…`, Plan 1 convention); recipient / customer phones are stored local `0XXXXXXXXX`.
- **Hubtel messages:** printable ASCII + `\n` only, truncated to 182 chars on `USSD` (Webstore / Hubtel-App untruncated). Always build replies with `respond` / `release` / `addToCart` from `protocol.ts` (via the `flow-kit.ts` helpers). No `·`, `—`, `✓` or other non-ASCII in menu text.
- **Real network names** (MTN, Telecel, AT iShare, AT BigTime for data; MTN, Telecel, AT for airtime) and normal wording. Never the Uzo nicknames "Yellow Plans / Tele / Instant Blue / Delay Blue" or the "Browse Services" rebrand (spec §4.4).
- `hubtel_transactions.order_table` CHECK is fixed by `migrations/0106_hubtel_ussd.sql`: `ussd_orders, ussd_shop_orders, airtime_orders, results_checker_orders, results_check_requests, ussd_afa_orders`. Do not add tables outside it.
- `lib/ussd-hubtel/menus.ts` must stay client-safe (no Supabase or server imports): the admin page imports `IMPLEMENTED_SERVICES` from it.
- **Do not modify** `app/api/webhooks/paystack/route.ts`, `lib/ussd/router.ts`, `lib/ussd/handlers/*`, `lib/ussd-shop/*`, `lib/airtime-service.ts`, `lib/results-checker-service.ts`, `lib/ussd/fulfill-afa.ts`. (No `export` additions are needed: every function used is already exported.)
- Per-service admin visibility (`hubtel_ussd_config.visibility`) is ANDed with `IMPLEMENTED_SERVICES`; flip each flag only in the task that ships the flow.
- Tests: `npx vitest run lib/ussd-hubtel` stays green after every task; `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok` prints `ok` after every task. There are 9 pre-existing, unrelated failures in `lib/order-health-service.test.ts` in the full suite: do not fix them.
- Migrations are plain SQL in `migrations/`, next number `0107`, applied manually to production BEFORE deploy (runbook). New columns only; no new policies.
- Commit after each task with a `feat(hubtel): …` / `test(hubtel): …` message ending in the `Co-Authored-By` line from the session's attribution reminder.

## Review Focus

Failure modes a person would hit that no task's happy-path test exercises, most likely first. Each has a pinned test in the owning task.

1. **Retried "1" at CONFIRM in each new flow** (customer double-presses, Hubtel retries, or two CONFIRMs race to the unique `session_id`): exactly one order, the identical AddToCart, and the losing order marked failed with that table's own fail patch → Tasks 2, 3, 4, 5 ("idempotent CONFIRM" describe blocks).
2. **Stock or price drift between the confirm screen and payment:** vouchers sold out at confirm (release, no order), sold out after payment (handler throws ⇒ `needs_review`), combo voucher gone at confirm, fee / price / airtime rate changed at confirm → Tasks 2, 3, 4 (+ handler tests).
3. **Airtime amount outside min/max or malformed** (`0.5`, `501`, `abc`, `10.555`) and **recipient on another network / unknown prefix** must re-prompt without losing the session → Task 2.
4. **AFA with a malformed Ghana Card number, a non-MTN dialer, or no configured price** must never reach AddToCart → Task 5.
5. **Late payment for an order that already expired** (the fail handler marked the order failed): the handler must throw, not fulfil, not SMS, for every new table; every fail handler only touches orders still in a payable state → Tasks 2, 3, 4, 5 handler + fail-handler tests.
6. **Session expiry after AddToCart** (Redis miss, the customer re-sends "1"): the router must replay the cart of the RIGHT table, not restart the menu or rebuild a data-bundle cart → Task 1 (unknown table) and Task 2 (airtime replay).
7. **Admin resolves a row that changed underneath** (late webhook recovered it, or it was already resolved): 409, never clobber; "not paid" refused for a row with a recorded payment → Task 6.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/ussd-hubtel/flow-kit.ts` (new) | `RouterDeps`, `FlowCtx`, `StepHandler`, reply helpers (`say`, `goto`, `finish`, `backToMain`), `submitOrder`, `replaySubmittedOrder` | 1 |
| `lib/ussd-hubtel/order-tables.ts` (+test, new) | Per-table registry: payable statuses, fail patch, cart columns + item name | 1, 2-5 |
| `lib/ussd-hubtel/flows/data.ts` (new) | Data-bundle steps, moved from `router.ts` | 1 |
| `lib/ussd-hubtel/router.ts` | Entry guards, session start, main menu, step dispatch, `MAIN_MENU_ENTRIES` | 1, 2-5 |
| `lib/ussd-hubtel/testing/fakes.ts` (new) | Shared test fakes (`fakeSupabase`, `makeDeps`, `req`, `digitFor`, service fakes) | 1, 2-5 |
| `lib/ussd-hubtel/services.ts` (new) | Service interfaces + defaults (dialer, airtime pricing, RC stock/price/vouchers/check settings, AFA price) | 2-5 |
| `lib/ussd-hubtel/flows/airtime.ts` (+test) | Buy Airtime | 2 |
| `lib/ussd-hubtel/flows/rc-buy.ts` (+test) | Results Checker menu, buy vouchers, my vouchers, resend | 3 |
| `lib/ussd-hubtel/flows/rc-check.ts` (+test) | Check Results (combo / own voucher) | 4 |
| `lib/ussd-hubtel/flows/afa.ts` (+test) | AFA Registration | 5 |
| `lib/ussd-hubtel/order-handlers.ts` (+test) | Post-payment + fail handlers for all five tables | 1-5 |
| `lib/ussd-hubtel/types.ts` | New steps + session fields; resolution columns on `HubtelTxRow` | 2-6 |
| `lib/ussd-hubtel/menus.ts` (+test) | `IMPLEMENTED_SERVICES` flips, airtime network labels, `rcMenuText` | 1-5 |
| `migrations/0107_hubtel_resolution.sql` (new) | `resolution_note`, `resolved_by`, `resolved_at` | 6 |
| `lib/ussd-hubtel/resolve.ts` (+test, new) | Mark-resolved logic | 6 |
| `app/api/admin/ussd-hubtel/resolve/route.ts` (+test, new) | Admin API | 6 |
| `app/admin/ussd-hubtel/page.tsx` | Derived service badges, Mark resolved dialog, resolution display | 6 |
| `scripts/hubtel-simulate.ts`, `docs/hubtel-ussd-runbook.md` | `FLOW=` simulator flows; Plan 2 runbook | 7 |

---

### Task 1: Router step registry, generic order submit/replay, table registry

Pure refactor plus the generic machinery every later flow plugs into. No customer-visible change: the data-bundle flow behaves exactly as in Plan 1, and all existing tests stay green.

**Files:**
- Create: `lib/ussd-hubtel/order-tables.ts`, `lib/ussd-hubtel/order-tables.test.ts`
- Create: `lib/ussd-hubtel/flow-kit.ts`
- Create: `lib/ussd-hubtel/flows/data.ts`
- Create: `lib/ussd-hubtel/testing/fakes.ts`
- Modify (rewrite): `lib/ussd-hubtel/router.ts`
- Modify: `lib/ussd-hubtel/router.test.ts` (header lines 1-72 replaced; one test adjusted; new describe appended)
- Modify: `lib/ussd-hubtel/menus.test.ts` (the "hides data" test made independent of which services are built)
- Modify: `lib/ussd-hubtel/order-handlers.ts` (`createFailHandlers` driven by `ORDER_TABLES`)

**Interfaces:**
- Consumes (Plan 1, unchanged): `respond`, `release`, `addToCart`, `toE164`, `toLocalPhone` (`protocol.ts`); `resolveMainMenu`, `mainMenuText`, `HUBTEL_NETWORKS`, `formatSize`, `networkMenuText`, `bundleMenuText`, `recipientPromptText`, `confirmMenuText`, `IMPLEMENTED_SERVICES`, `MainMenuKey` (`menus.ts`); `fetchBundles`, `PAGE_SIZE`, `resolveCaller`, `isDataBlocked`, `priceForTier`, `CallerContext` (`catalog.ts`); `HubtelSessionStore`, `sessionStore` (`session.ts`); `getHubtelUssdConfig`, `HubtelUssdConfig` (`config.ts`); `OrderHandlers` (`payment.ts`).
- Produces (used by Tasks 2-6):
  - `order-tables.ts`: `type HubtelOrderTable` (union of registered tables; Task 1: `"ussd_orders"`), `interface OrderTableSpec { payableStatuses: readonly string[]; failPatch(): Record<string, unknown>; cartColumns: string; cartItemName(row: Record<string, unknown>): string }`, `const ORDER_TABLES: Record<HubtelOrderTable, OrderTableSpec>`, `isHubtelOrderTable(t: string): t is HubtelOrderTable`.
  - `flow-kit.ts`: `interface RouterDeps` (Plan 1 fields; later tasks add fields), `interface FlowCtx { input: string; req: HubtelRequest; deps: RouterDeps; config: HubtelUssdConfig; session: HubtelSession }`, `type StepHandler = (ctx: FlowCtx) => Promise<HubtelReply>`, `type StepTable = Partial<Record<HubtelStep, StepHandler>>`, `interface ScreenOpts { label: string; fieldType?: HubtelFieldType }`, `CART_MESSAGE`, `say(ctx, text, step, opts): HubtelReply`, `goto(ctx, patch: Partial<HubtelSession> & { step: HubtelStep }, text, opts): Promise<HubtelReply>`, `finish(ctx, text): Promise<HubtelReply>`, `menuFor(config, dataBlocked)`, `mainMenuReply(ctx): HubtelReply`, `backToMain(ctx): Promise<HubtelReply>`, `replaySubmittedOrder(deps, sid, platform): Promise<HubtelReply | null>`, `submitOrder(ctx, { table: HubtelOrderTable; row: Record<string, unknown>; price: number; logTag: string }): Promise<HubtelReply>`.
  - `router.ts`: `hubtelRouter`, `defaultRouterDeps`, `type RouterDeps` (re-export), `MAIN_MENU_ENTRIES: Partial<Record<MainMenuKey, StepHandler>>`.
  - `flows/data.ts`: `startData(ctx)`, `DATA_STEPS: StepTable`.
  - `testing/fakes.ts`: `NEW_ID`, `OK_PKG`, `fakeSupabase(opts?: FakeSupabaseOpts)` returning `{ client, inserts, updates }`, `makeDeps(over?, sup?)` returning `{ deps, store, sup }`, `req(over)`, `digitFor(menu, label)`.

- [ ] **Step 1: Write the failing table-registry test**

```ts
// lib/ussd-hubtel/order-tables.test.ts
import { describe, it, expect } from "vitest"
import { ORDER_TABLES, isHubtelOrderTable } from "./order-tables"

// Copied from the CHECK constraint in migrations/0106_hubtel_ussd.sql. A table the channel writes
// but the CHECK does not allow would make every CONFIRM fail at the hubtel_transactions insert.
const ALLOWED_BY_0106 = [
  "ussd_orders", "ussd_shop_orders", "airtime_orders",
  "results_checker_orders", "results_check_requests", "ussd_afa_orders",
]

describe("ORDER_TABLES", () => {
  it("only registers tables the hubtel_transactions CHECK allows", () => {
    for (const t of Object.keys(ORDER_TABLES)) expect(ALLOWED_BY_0106, t).toContain(t)
  })
  it("isHubtelOrderTable recognises registered tables only", () => {
    expect(isHubtelOrderTable("ussd_orders")).toBe(true)
    expect(isHubtelOrderTable("nope")).toBe(false)
    expect(isHubtelOrderTable("toString")).toBe(false)
  })
  it("ussd_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.ussd_orders
    expect(s.payableStatuses).toEqual(["pending", "otp_required"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ package_size: "5", network: "MTN" })).toBe("5GB MTN Data")
    expect(s.cartItemName({ package_size: "500MB", network: "AT-iShare" })).toBe("500MB AT iShare Data")
  })
  it("every fail patch stamps updated_at and every spec names its cart columns", () => {
    for (const [t, s] of Object.entries(ORDER_TABLES)) {
      expect(s.failPatch(), t).toHaveProperty("updated_at")
      expect(s.cartColumns.length, t).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/order-tables.test.ts`
Expected: FAIL with `Failed to resolve import "./order-tables"`.

- [ ] **Step 3: Create the table registry**

```ts
// lib/ussd-hubtel/order-tables.ts
// One entry per order table the Hubtel channel writes. Used by CONFIRM (rollback when the
// hubtel_transactions insert fails), replay (rebuild the identical AddToCart from the stored
// order), and expiry (fail an unpaid order). Every key must be allowed by the order_table CHECK
// in migrations/0106_hubtel_ussd.sql (pinned by order-tables.test.ts).
import { HUBTEL_NETWORKS, formatSize } from "./menus"

export type HubtelOrderTable = "ussd_orders"

export interface OrderTableSpec {
  /** payment_status values of an order that is still unpaid (it may yet be paid or expired). */
  payableStatuses: readonly string[]
  /** Marks an unpaid order failed (expiry, CONFIRM rollback). */
  failPatch(): Record<string, unknown>
  /** Columns cartItemName needs; read back from the order on replay. */
  cartColumns: string
  /** AddToCart ItemName, built from the order row so a replay is identical to the first cart. */
  cartItemName(row: Record<string, unknown>): string
}

const now = () => new Date().toISOString()

export const ORDER_TABLES: Record<HubtelOrderTable, OrderTableSpec> = {
  ussd_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "package_size, network",
    cartItemName: r => {
      const label = HUBTEL_NETWORKS.find(n => n.dbName === r.network)?.label ?? String(r.network)
      return `${formatSize(String(r.package_size))} ${label} Data`
    },
  },
}

export function isHubtelOrderTable(t: string): t is HubtelOrderTable {
  return Object.prototype.hasOwnProperty.call(ORDER_TABLES, t)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/order-tables.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the flow kit**

```ts
// lib/ussd-hubtel/flow-kit.ts
// Shared plumbing for every Hubtel menu flow: the dependency bag, the step-handler type, reply
// helpers, and the ONE place an order + hubtel_transactions row is written (submitOrder) and
// replayed (replaySubmittedOrder). Flows never insert orders or tx rows themselves.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import type { PrefixValidationConfig } from "@/lib/network-prefix-config"
import type { HubtelUssdConfig } from "./config"
import type { HubtelSessionStore } from "./session"
import type { CallerContext } from "./catalog"
import { resolveMainMenu, mainMenuText, type MainMenuKey } from "./menus"
import { ORDER_TABLES, isHubtelOrderTable, type HubtelOrderTable } from "./order-tables"
import { addToCart, release, respond } from "./protocol"
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
    console.error(`[${args.logTag}] Failed to create order:`, orderError)
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
    console.error(`[${args.logTag}] hubtel_transactions insert failed:`, txError)
    const { error: rollbackError } = await deps.supabase.from(args.table).update(spec.failPatch()).eq("id", order.id)
    if (rollbackError) console.error(`[${args.logTag}] Failed to mark order failed after tx insert error:`, order.id, rollbackError)
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
```

- [ ] **Step 6: Move the data-bundle steps into `flows/data.ts`**

Behaviour, texts, labels and field types are identical to Plan 1's `router.ts` lines 142-333; only the plumbing changes (helpers + `submitOrder`).

```ts
// lib/ussd-hubtel/flows/data.ts
// Main-mode data bundles. Moved from router.ts (Plan 2 Task 1) with identical behaviour.
import { validateNetworkPrefix } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { priceForTier } from "../catalog"
import { HUBTEL_NETWORKS, networkMenuText, bundleMenuText, recipientPromptText, confirmMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelSession } from "../types"

const NETWORK = { label: "Select network" }
const PACKAGE = { label: "Select package" }
const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm order" }

function confirmText(s: HubtelSession): string {
  const net = HUBTEL_NETWORKS.find(n => n.dbName === s.network)
  return confirmMenuText(net?.label ?? s.network!, s.bundleSize!, s.bundlePrice!, s.recipientPhone!, toLocalPhone(s.dialingPhone))
}

export async function startData(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "SELECT_NETWORK" }, networkMenuText(), NETWORK)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return backToMain(ctx)
  const net = HUBTEL_NETWORKS.find(n => n.digit === input)
  if (!net) return say(ctx, networkMenuText(), "SELECT_NETWORK", NETWORK)

  const caller = await deps.resolveCaller(session.dialingPhone)
  const { bundles, total } = await deps.fetchBundles(net.dbName, 0, caller.effectivePriceTier, caller.subAgentParentShopId)
  if (bundles.length === 0) return say(ctx, `No ${net.label} packages available.\n` + networkMenuText(), "SELECT_NETWORK", NETWORK)
  return goto(ctx, {
    step: "SELECT_BUNDLE", network: net.dbName, bundlePage: 0,
    effectivePriceTier: caller.effectivePriceTier, subAgentParentShopId: caller.subAgentParentShopId, userId: caller.userId,
  }, bundleMenuText(bundles, 0, total, deps.pageSize), PACKAGE)
}

async function selectBundle(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return goto(ctx, { step: "SELECT_NETWORK" }, networkMenuText(), NETWORK)
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  const tier = session.effectivePriceTier ?? "regular"
  // Re-fetch the current page: trusting a cached page goes stale when pages advance.
  const { bundles, total } = await deps.fetchBundles(session.network!, page, tier, session.subAgentParentShopId)
  const chosen = parseInt(input, 10)

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await deps.fetchBundles(session.network!, next, tier, session.subAgentParentShopId)
    return goto(ctx, { step: "SELECT_BUNDLE", bundlePage: next }, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), PACKAGE)
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) return say(ctx, bundleMenuText(bundles, page, total, deps.pageSize), "SELECT_BUNDLE", PACKAGE)
  return goto(ctx, {
    step: "ENTER_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  }, recipientPromptText(), RECIPIENT)
}

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    return goto(ctx, { step: "SELECT_BUNDLE" }, bundleMenuText(bundles, page, total, deps.pageSize), PACKAGE)
  }
  const local = toLocalPhone(input)
  const reprompt = (msg: string) => say(ctx, `${msg}\n${recipientPromptText()}`, "ENTER_RECIPIENT", RECIPIENT)

  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }
  return goto(ctx, { step: "CONFIRM", recipientPhone: local }, confirmText({ ...session, recipientPhone: local }), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "2") return finish(ctx, "Order cancelled.")
  if (input !== "1") return say(ctx, confirmText(session), "CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const { data: pkg } = await deps.supabase.from("packages").select("price, dealer_price, is_available").eq("id", session.bundleId!).single()
  if (!pkg || !pkg.is_available) return finish(ctx, "Package no longer available. Please try again.")

  const tier = session.effectivePriceTier ?? "regular"
  let catalogRow: { parent_price: number | string; wholesale_margin: number | string } | null = null
  if (tier === "sub_agent" && session.subAgentParentShopId) {
    const { data } = await deps.supabase.from("sub_agent_catalog").select("parent_price, wholesale_margin")
      .eq("shop_id", session.subAgentParentShopId).eq("package_id", session.bundleId!).single()
    catalogRow = data
  }
  const { price, parentProfit } = priceForTier(pkg, tier, catalogRow)
  if (Math.abs(price - session.bundlePrice!) > 0.01) {
    return finish(ctx, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "ussd_orders",
    price,
    logTag: "HUBTEL-CONFIRM",
    row: {
      dialing_phone: session.dialingPhone,
      recipient_phone: session.recipientPhone,
      network: session.network,
      // Column is required by the table; the value is unused on the Hubtel channel (payment is Hubtel's).
      paystack_provider: paystackProviderFromPhone(session.dialingPhone) ?? "mtn",
      package_id: session.bundleId,
      package_size: session.bundleSize,
      amount: price, // our price only: the customer pays Hubtel's charge on top, at Hubtel
      price_tier: tier,
      parent_shop_id: session.subAgentParentShopId ?? null,
      parent_profit_amount: parentProfit,
      shop_owner_id: session.userId ?? null,
      order_status: "pending",
      payment_status: "pending",
    },
  })
}

export const DATA_STEPS: StepTable = {
  SELECT_NETWORK: selectNetwork,
  SELECT_BUNDLE: selectBundle,
  ENTER_RECIPIENT: enterRecipient,
  CONFIRM: confirm,
}
```

- [ ] **Step 7: Rewrite `router.ts` as entry + dispatch**

```ts
// lib/ussd-hubtel/router.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { keyForDigit } from "@/lib/ussd/menu-items"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { getHubtelUssdConfig, type HubtelUssdConfig } from "./config"
import { sessionStore } from "./session"
import { fetchBundles, PAGE_SIZE, resolveCaller, isDataBlocked } from "./catalog"
import { mainMenuText, type MainMenuKey } from "./menus"
import { release, respond, toE164 } from "./protocol"
import {
  finish, mainMenuReply, menuFor, replaySubmittedOrder,
  type FlowCtx, type RouterDeps, type StepHandler, type StepTable,
} from "./flow-kit"
import { DATA_STEPS, startData } from "./flows/data"
import type { HubtelReply, HubtelRequest } from "./types"

export type { RouterDeps } from "./flow-kit"

export function defaultRouterDeps(supabase: SupabaseClient): RouterDeps {
  return {
    supabase,
    getConfig: () => getHubtelUssdConfig(supabase),
    sessions: sessionStore,
    fetchBundles,
    resolveCaller: phone => resolveCaller(supabase, phone),
    isDataBlocked: msisdn => isDataBlocked(supabase, msisdn),
    getPrefixConfig: getPrefixValidationConfig,
    pageSize: PAGE_SIZE,
  }
}

/** First screen of each main-menu service. Every IMPLEMENTED_SERVICES key must have one (tested). */
export const MAIN_MENU_ENTRIES: Partial<Record<MainMenuKey, StepHandler>> = {
  data: startData,
}

const STEPS: StepTable = {
  MAIN: handleMain,
  ...DATA_STEPS,
}

const UNAVAILABLE = "Service unavailable. Please try again later."

export async function hubtelRouter(req: HubtelRequest, deps: RouterDeps): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform = req.Platform

  if (req.Type === "Timeout") {
    await deps.sessions.del(sid)
    return release(sid, "Session ended.", { platform })
  }

  const config = await deps.getConfig()
  // Shop mode ships in Plan 3; treat it as unavailable until then.
  if (!config.enabled || config.mode !== "main") return release(sid, UNAVAILABLE, { platform })

  if (req.Type === "Initiation") return startSession(req, deps, config, "")

  const session = await deps.sessions.get(sid)
  if (!session) {
    // A retry after our first reply was lost: the session is already gone but the order exists.
    const replay = await replaySubmittedOrder(deps, sid, platform)
    if (replay) return replay
    return startSession(req, deps, config, "Session expired.\n")
  }

  const handler = STEPS[session.step]
  if (!handler) return startSession(req, deps, config, "")
  return handler({ input: req.Message.trim(), req, deps, config, session })
}

async function startSession(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  const resolved = menuFor(config, dataBlocked)
  if (resolved.length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, { step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked })
  return respond(req.SessionId, prefix + mainMenuText(resolved), { label: "Main menu", clientState: "MAIN", platform: req.Platform })
}

async function handleMain(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return finish(ctx, "Thank you for using Datagod.")
  const key = keyForDigit(menuFor(ctx.config, ctx.session.dataBlocked === true), ctx.input)
  const start = key ? MAIN_MENU_ENTRIES[key] : undefined
  return start ? start(ctx) : mainMenuReply(ctx)
}
```

- [ ] **Step 8: Create the shared test fakes**

```ts
// lib/ussd-hubtel/testing/fakes.ts
// Test-only fakes shared by router.test.ts and flows/*.test.ts. Never imported by production code.
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { RouterDeps } from "../flow-kit"
import type { HubtelRequest, HubtelSession } from "../types"

export const NEW_ID = "11111111-1111-1111-1111-111111111111"
export const OK_PKG = { price: 10, dealer_price: null, is_available: true }

export interface FakeSupabaseOpts {
  /** Row returned by .single()/.maybeSingle() for a table; wins over rows written by insert. */
  rows?: Record<string, unknown>
  /** Plan 1 aliases for rows.packages / rows.hubtel_transactions / rows.ussd_orders. */
  pkg?: unknown
  txRow?: unknown
  orderRow?: unknown
  /** The hubtel_transactions insert fails with a generic error. */
  txError?: boolean
  /** The hubtel_transactions insert hits a unique violation; this row is what the winner wrote. */
  txConflictRow?: unknown
  /** Tables whose insert(...).select().single() fails. */
  failInsert?: string[]
}

export function fakeSupabase(opts: FakeSupabaseOpts = {}) {
  const fixed: Record<string, unknown> = { ...(opts.rows ?? {}) }
  if (opts.pkg !== undefined) fixed.packages = opts.pkg
  if (opts.txRow !== undefined) fixed.hubtel_transactions = opts.txRow
  if (opts.orderRow !== undefined) fixed.ussd_orders = opts.orderRow
  const inserts: Record<string, any[]> = {}
  const updates: Array<{ table: string; patch: any }> = []
  // Successful inserts become readable, so a replayed CONFIRM sees what the first one wrote.
  const stored: Record<string, unknown> = {}
  const read = async (table: string) => ({ data: fixed[table] ?? stored[table] ?? null, error: null })

  const client: any = {
    from(table: string) {
      const b: any = {
        select() { return b }, eq() { return b }, is() { return b }, not() { return b }, in() { return b },
        single: () => read(table),
        maybeSingle: () => read(table),
        insert(rows: any) {
          const list = ([] as any[]).concat(rows)
          ;(inserts[table] ??= []).push(...list)
          const isTx = table === "hubtel_transactions"
          const conflict = isTx && opts.txConflictRow !== undefined
          const failed = (opts.failInsert ?? []).includes(table)
          if (conflict) stored[table] = opts.txConflictRow
          else if (!(isTx && opts.txError) && !failed) stored[table] = { ...list[0], state: "awaiting_payment" }
          const txErr = conflict ? { code: "23505", message: "duplicate key value violates unique constraint" }
            : isTx && opts.txError ? { message: "boom" } : null
          const ib: any = {
            select() { return ib },
            single: async () => (failed ? { data: null, error: { message: "insert failed" } } : { data: { id: NEW_ID }, error: null }),
            then: (res: any) => res({ error: txErr }),
          }
          return ib
        },
        update(patch: any) { updates.push({ table, patch }); return b },
        then: (res: any) => res({ error: null }),
      }
      return b
    },
  }
  return { client, inserts, updates }
}

export function makeDeps(over: Partial<RouterDeps> = {}, sup = fakeSupabase({ pkg: OK_PKG })) {
  const store = new Map<string, HubtelSession>()
  const deps: RouterDeps = {
    supabase: sup.client,
    getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }),
    sessions: {
      get: async id => store.get(id) ?? null,
      set: async (id, s) => { store.set(id, s) },
      del: async id => { store.delete(id) },
    },
    fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 10 }], total: 1 }),
    resolveCaller: async () => ({ effectivePriceTier: "regular" }),
    isDataBlocked: async () => false,
    getPrefixConfig: async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES }),
    pageSize: 5,
    ...over,
  }
  return { deps, store, sup }
}

export const req = (over: Partial<HubtelRequest>): HubtelRequest => ({
  Type: "Response", Mobile: "233200585542", SessionId: "S1", ServiceCode: "713",
  Message: "", Operator: "vodafone", Sequence: 2, ClientState: "", Platform: "USSD", ...over,
})

/** The digit for `label` in a numbered menu ("2. Buy Airtime" -> "2"). Numbering depends on which services are visible. */
export function digitFor(menu: string, label: string): string {
  const line = menu.split("\n").find(l => l.replace(/^\d+\.\s*/, "") === label)
  if (!line) throw new Error(`"${label}" not in menu:\n${menu}`)
  return line.split(".")[0]
}
```

- [ ] **Step 9: Point `router.test.ts` at the shared fakes and add the registry tests**

Replace lines 1-72 of `lib/ussd-hubtel/router.test.ts` (the imports, the local `fakeSupabase`, `makeDeps` and `req`) with:

```ts
// lib/ussd-hubtel/router.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, MAIN_MENU_ENTRIES, type RouterDeps } from "./router"
import { IMPLEMENTED_SERVICES, type MainMenuKey } from "./menus"
import { fakeSupabase, makeDeps, req } from "./testing/fakes"
```

The shared fake supports the option names `pkg`, `txRow`, `orderRow`, `txError`, `txConflictRow`, so every other test body stays as it is. Replace the test `"releases politely when no service is available to this caller"` (it assumed data is the only service) with:

```ts
  it("releases politely when no service is available to this caller", async () => {
    const { deps } = makeDeps({
      isDataBlocked: async () => true,
      getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: false, airtime: false, resultsChecker: false } }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
```

Append at the end of the file:

```ts
describe("hubtelRouter: flow registry", () => {
  it("every implemented main-menu service has an entry handler", () => {
    for (const [key, on] of Object.entries(IMPLEMENTED_SERVICES)) {
      if (on) expect(MAIN_MENU_ENTRIES[key as MainMenuKey], key).toBeTypeOf("function")
    }
  })
  it("replay with an unknown order table says already submitted instead of crashing (review focus #6)", async () => {
    const sup = fakeSupabase({ txRow: { order_table: "nope", order_id: "o1", expected_amount: 10, state: "awaiting_payment" } })
    const { deps } = makeDeps({}, sup)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("already submitted")
  })
  it("refuses to AddToCart a zero price and creates no order", async () => {
    const sup = fakeSupabase({ pkg: { price: 0, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({ fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 0 }], total: 1 }) }, sup)
    await walkTo("CONFIRM", deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("an unknown step in a stored session restarts at the main menu", async () => {
    const { deps, store } = makeDeps()
    store.set("S1", { step: "NOT_A_STEP" as any, dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Buy Data Bundle")
  })
})
```

- [ ] **Step 10: Make the menus test independent of which services are built**

In `lib/ussd-hubtel/menus.test.ts`, replace the test `"hides data when the caller is whitelist-blocked or admin-hidden"` with:

```ts
  it("hides data when the caller is whitelist-blocked or admin-hidden", () => {
    expect(resolveMainMenu(allOn, true).map(i => i.key)).not.toContain("data")
    expect(resolveMainMenu({ ...allOn, data: false }, false).map(i => i.key)).not.toContain("data")
  })
```

- [ ] **Step 11: Drive `createFailHandlers` from the registry**

In `lib/ussd-hubtel/order-handlers.ts`, add `import { ORDER_TABLES } from "./order-tables"` under the existing imports and replace the whole `createFailHandlers` function with:

```ts
/** Used when an AddToCart never gets paid (definite expiry, or an admin "not paid" resolution). */
export function createFailHandlers(supabase: SupabaseClient): OrderHandlers {
  const handlers: OrderHandlers = {}
  for (const [table, spec] of Object.entries(ORDER_TABLES)) {
    handlers[table] = async orderId => {
      // Only an order that is still unpaid may be failed: a paid order is never touched here.
      const { error } = await supabase
        .from(table)
        .update(spec.failPatch())
        .eq("id", orderId)
        .in("payment_status", [...spec.payableStatuses])
      if (error) console.error("[HUBTEL-ORDER] fail handler update error:", table, orderId, error)
    }
  }
  return handlers
}
```

- [ ] **Step 12: Run the whole Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS, 13 test files (Plan 1's 12 + `order-tables.test.ts`), 166 tests (Plan 1's 158 + 4 order-tables + 4 router registry).
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 13: Commit**

```bash
git add lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/flows/data.ts lib/ussd-hubtel/testing/fakes.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/router.test.ts lib/ussd-hubtel/menus.test.ts lib/ussd-hubtel/order-handlers.ts
git commit -m "refactor(hubtel): step registry, generic order submit/replay and table registry"
```

---

### Task 2: Buy Airtime flow + `airtime_orders` handler

Port of `lib/ussd/handlers/airtime.ts` minus wallet, Paystack and OTP. Pricing is fee-inclusive exactly as in Uzo: the caller enters what they PAY; the recipient gets `amount - fee` (`splitInclusive`), with the dealer rate for `dealer` and `sub_agent` callers. The order's `total_paid` (= Hubtel `Price` = `expected_amount`) is that amount, with nothing added.

Step transitions:

| Step | Input | Next |
|---|---|---|
| MAIN | "Buy Airtime" digit | AIRTIME_ENTER_RECIPIENT (phone field) |
| AIRTIME_ENTER_RECIPIENT | `0` | MAIN |
| | not `0XXXXXXXXX` after `toLocalPhone` | same, "Invalid number." |
| | prefix known to `detectAirtimeNetwork` | network gate (below) |
| | prefix unknown | AIRTIME_SELECT_NETWORK |
| AIRTIME_SELECT_NETWORK | `0` | AIRTIME_ENTER_RECIPIENT |
| | `1`/`2`/`3` (MTN/Telecel/AT) | network gate |
| network gate | airtime disabled for the network, or admin prefix validation (when on) rejects the pair | AIRTIME_ENTER_RECIPIENT with the reason |
| | ok | AIRTIME_ENTER_AMOUNT (decimal field) |
| AIRTIME_ENTER_AMOUNT | `0` | AIRTIME_ENTER_RECIPIENT |
| | not `^\d+(\.\d{1,2})?$`, `<= 0`, `< min`, `> max`, or delivers `<= 0` | same, "Enter a valid amount." |
| | ok | AIRTIME_CONFIRM |
| AIRTIME_CONFIRM | `2` | release "Order cancelled." |
| | not `1` | same screen |
| | `1` | replay guard; re-verify enabled, limits and delivered amount; `submitOrder` |

**Files:**
- Create: `lib/ussd-hubtel/services.ts`
- Create: `lib/ussd-hubtel/flows/airtime.ts`, `lib/ussd-hubtel/flows/airtime.test.ts`
- Modify: `lib/ussd-hubtel/types.ts` (steps + session fields)
- Modify: `lib/ussd-hubtel/menus.ts` (`AIRTIME_NETWORKS`, `airtimeLabel`, flip `IMPLEMENTED_SERVICES.airtime`)
- Modify: `lib/ussd-hubtel/flow-kit.ts` (`RouterDeps` gains `resolveDialer`, `airtime`)
- Modify: `lib/ussd-hubtel/router.ts` (defaults, entry, steps)
- Modify: `lib/ussd-hubtel/order-tables.ts` (+ `airtime_orders`), `lib/ussd-hubtel/order-tables.test.ts`
- Modify: `lib/ussd-hubtel/order-handlers.ts` (+ airtime handler), `lib/ussd-hubtel/order-handlers.test.ts` (rewritten: table-aware fake + all module mocks for Tasks 2-5)
- Modify: `lib/ussd-hubtel/testing/fakes.ts` (`fakeAirtime`, new `makeDeps` defaults)

**Interfaces:**
- Consumes: Task 1 `flow-kit.ts` helpers and `submitOrder`; `detectAirtimeNetwork`, `splitInclusive`, `isAirtimeEnabled`, `getAirtimeLimits`, `airtimeBaseFeeRate` (`lib/airtime-pricing.ts`); `resolveDialer`, `DialerInfo` (`lib/ussd/resolve-dialer.ts`); `validateNetworkPrefix` (`lib/phone-format.ts`); `secureReference` (`lib/secure-random.ts`); `markAirtimeOrderPaid(orderId, transactionId?) => Promise<{ success: boolean; alreadyProcessed?: boolean }>` (`lib/airtime-service.ts`); `SMSTemplates.ussdAirtimePaymentReceived(amount: string, network: string, phone: string)`.
- Produces:
  - `services.ts`: `type DialerInfo`, `resolveDialer`, `interface AirtimeServices { isEnabled(network: string): Promise<boolean>; getLimits(): Promise<{ min: number; max: number }>; feeRate(network: string, isDealer: boolean): Promise<number> }`, `defaultAirtimeServices(): AirtimeServices`.
  - `RouterDeps.resolveDialer: (phone: string) => Promise<DialerInfo>`, `RouterDeps.airtime: AirtimeServices`.
  - `menus.ts`: `type AirtimeNetworkKey = "MTN" | "Telecel" | "AT"`, `AIRTIME_NETWORKS`, `airtimeLabel(network: string): string`.
  - `flows/airtime.ts`: `startAirtime(ctx)`, `AIRTIME_STEPS: StepTable`, text builders `airtimeRecipientPromptText()`, `airtimeNetworkMenuText()`, `airtimeAmountPromptText(label, min, max)`, `airtimeConfirmText(label, recipient, pay, get, payerLocal)`.
  - `testing/fakes.ts`: `fakeAirtime(over?: Partial<AirtimeServices>): AirtimeServices`.
  - `HubtelOrderTable` now includes `"airtime_orders"`; `createOrderHandlers(...).airtime_orders`.

- [ ] **Step 1: Add the steps and session fields**

In `lib/ussd-hubtel/types.ts`, replace the `HubtelStep` line with:

```ts
export type HubtelStep =
  | "MAIN" | "SELECT_NETWORK" | "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM"
  | "AIRTIME_ENTER_RECIPIENT" | "AIRTIME_SELECT_NETWORK" | "AIRTIME_ENTER_AMOUNT" | "AIRTIME_CONFIRM"
```

and add inside `interface HubtelSession`, after `recipientPhone?: string // local 0XXXXXXXXX`:

```ts
  // Airtime
  airtimeRecipient?: string // local 0XXXXXXXXX
  airtimeNetwork?: "MTN" | "Telecel" | "AT"
  airtimeAmount?: number // what the caller pays = order total_paid = Hubtel Price
  airtimeFee?: number
  airtimeToDeliver?: number // what the recipient gets (amount - fee)
```

- [ ] **Step 2: Add the airtime network labels and flip the flag**

In `lib/ussd-hubtel/menus.ts`, change `airtime: false,` in `IMPLEMENTED_SERVICES` to `airtime: true,` and append:

```ts
// Airtime networks (lib/airtime-pricing.ts vocabulary: "AT" is AirtelTigo).
export type AirtimeNetworkKey = "MTN" | "Telecel" | "AT"
export const AIRTIME_NETWORKS: ReadonlyArray<{ digit: string; key: AirtimeNetworkKey; label: string }> = [
  { digit: "1", key: "MTN", label: "MTN" },
  { digit: "2", key: "Telecel", label: "Telecel" },
  { digit: "3", key: "AT", label: "AT" },
]

export function airtimeLabel(network: string): string {
  return AIRTIME_NETWORKS.find(n => n.key === network)?.label ?? network
}
```

- [ ] **Step 3: Create the services module**

```ts
// lib/ussd-hubtel/services.ts
// Business lookups the Hubtel flows need, behind interfaces so router/flow tests use fakes.
// Defaults delegate to the same modules the Uzo flows use.
import { resolveDialer, type DialerInfo } from "@/lib/ussd/resolve-dialer"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"

export { resolveDialer }
export type { DialerInfo }

export interface AirtimeServices {
  isEnabled(network: string): Promise<boolean>
  getLimits(): Promise<{ min: number; max: number }>
  /** Platform fee rate (%) for the network; dealers and sub-agents pay the dealer rate. */
  feeRate(network: string, isDealer: boolean): Promise<number>
}

export function defaultAirtimeServices(): AirtimeServices {
  return { isEnabled: isAirtimeEnabled, getLimits: getAirtimeLimits, feeRate: airtimeBaseFeeRate }
}
```

- [ ] **Step 4: Extend `RouterDeps`, the defaults and the test fakes**

In `lib/ussd-hubtel/flow-kit.ts` add `import type { AirtimeServices, DialerInfo } from "./services"` and, at the end of `interface RouterDeps`, after `pageSize: number`:

```ts
  resolveDialer: (phone: string) => Promise<DialerInfo>
  airtime: AirtimeServices
```

In `lib/ussd-hubtel/router.ts` add `import { defaultAirtimeServices, resolveDialer } from "./services"` and, in `defaultRouterDeps`, after `pageSize: PAGE_SIZE,`:

```ts
    resolveDialer,
    airtime: defaultAirtimeServices(),
```

In `lib/ussd-hubtel/testing/fakes.ts` add `import type { AirtimeServices } from "../services"`, add after `pageSize: 5,` in `makeDeps`:

```ts
    resolveDialer: async () => ({}),
    airtime: fakeAirtime(),
```

and append:

```ts
export function fakeAirtime(over: Partial<AirtimeServices> = {}): AirtimeServices {
  return { isEnabled: async () => true, getLimits: async () => ({ min: 1, max: 500 }), feeRate: async () => 5, ...over }
}
```

- [ ] **Step 5: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/airtime.test.ts
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAirtime, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"

async function toAirtime(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
}
async function toConfirm(deps: RouterDeps, recipient = "0244123456", amount = "10") {
  await toAirtime(deps)
  await hubtelRouter(req({ Message: recipient }), deps)
  return hubtelRouter(req({ Message: amount }), deps)
}

describe("airtime: entry and recipient", () => {
  it("is on the main menu and asks for the recipient with a phone field", async () => {
    const { deps, store } = makeDeps()
    const r = await toAirtime(deps)
    expect(r.Message).toContain("Enter recipient number")
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("is hidden when the admin turns airtime off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).not.toContain("Buy Airtime")
  })
  it("'0' goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("Buy Airtime")
    expect(store.get("S1")?.step).toBe("MAIN")
  })
  it("detects MTN from a 233... recipient and asks the amount with a decimal field", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(r.Message).toContain("MTN Airtime")
    expect(r.Message).toContain("(GHS 1 - 500)")
    expect(r.FieldType).toBe("decimal")
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0244123456", airtimeNetwork: "MTN" })
  })
  it("rejects a malformed number and stays on the recipient step", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(r.Message).toContain("Invalid number.")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix: asks the network (real names), then blocks the pair when prefix validation is on (review focus #3)", async () => {
    const { deps, store } = makeDeps()
    await toAirtime(deps)
    const menu = await hubtelRouter(req({ Message: "0230000000" }), deps)
    expect(menu.Message).toContain("Select recipient network")
    expect(menu.Message).toContain("1. MTN\n2. Telecel\n3. AT")
    for (const nick of ["Yellow Plans", "Instant Blue", "Delay Blue"]) expect(menu.Message).not.toContain(nick)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("doesn't match any Ghana mobile network")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix with prefix validation off: the picked network is used", async () => {
    const { deps, store } = makeDeps({ getPrefixConfig: async () => ({ enabled: false, map: DEFAULT_NETWORK_PREFIXES }) })
    await toAirtime(deps)
    await hubtelRouter(req({ Message: "0230000000" }), deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0230000000", airtimeNetwork: "Telecel" })
  })
  it("a network whose airtime is disabled re-prompts the recipient", async () => {
    const { deps, store } = makeDeps({ airtime: fakeAirtime({ isEnabled: async n => n !== "MTN" }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0244123456" }), deps)
    expect(r.Message).toContain("MTN airtime is unavailable.")
    expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_RECIPIENT")
  })
})

describe("airtime: amount (review focus #3)", () => {
  for (const bad of ["0.5", "501", "abc", "10.555", "10abc", "-5"]) {
    it(`rejects "${bad}" and stays on the amount step`, async () => {
      const { deps, store } = makeDeps()
      await toAirtime(deps)
      await hubtelRouter(req({ Message: "0244123456" }), deps)
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Enter a valid amount.")
      expect(store.get("S1")?.step).toBe("AIRTIME_ENTER_AMOUNT")
    })
  }
  it("confirm shows what the caller pays, what the recipient gets, and the payer", async () => {
    const { deps, store } = makeDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toContain("MTN to 0244123456")
    expect(r.Message).toContain("You pay GHS 10.00")
    expect(r.Message).toContain("They get GHS 9.52") // 5% inclusive: fee 0.48
    expect(r.Message).toContain("from 0200585542")
    expect(r.Message).toContain("1. Pay now\n2. Cancel")
    expect(store.get("S1")).toMatchObject({ step: "AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0.48, airtimeToDeliver: 9.52 })
  })
  it("dealers and sub-agents get the dealer fee rate", async () => {
    const feeRate = vi.fn(async () => 5)
    const { deps } = makeDeps({ airtime: fakeAirtime({ feeRate }), resolveDialer: async () => ({ userId: "u1", role: "sub_agent" }) })
    await toConfirm(deps)
    expect(feeRate).toHaveBeenCalledWith("MTN", true)
  })
})

describe("airtime: confirm -> AddToCart", () => {
  it("creates the airtime order + tx and returns AddToCart at the amount the caller pays (no fee added)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = makeDeps({ resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    const row = sup.inserts["airtime_orders"][0]
    expect(row).toMatchObject({
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.52, fee_amount: 0.48, total_paid: 10,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: "u1", shop_id: null, merchant_commission: 0, customer_name: "USSD Customer", customer_email: "a@b.c",
      dialing_phone: "+233200585542", channel: "ussd",
    })
    expect(row.reference_code).toMatch(/^AT-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})

describe("airtime: stale-session guard at confirm (review focus #2)", () => {
  it("limits lowered since the confirm screen: release, no order", async () => {
    let max = 500
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ getLimits: async () => ({ min: 1, max }) }) }, sup)
    await toConfirm(deps)
    max = 5
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Amount must be GHS 1-5")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("fee rate changed (recipient would get a different amount): release, no order", async () => {
    let rate = 5
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ feeRate: async () => rate }) }, sup)
    await toConfirm(deps)
    rate = 10
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/rates changed/i)
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("network disabled since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ airtime: fakeAirtime({ isEnabled: async () => on }) }, sup)
    await toConfirm(deps)
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
})

describe("airtime: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "airtime_orders", order_id: "o-winner", expected_amount: 10, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Type).toBe("AddToCart")
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["airtime_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("a tx row already exists while the session is alive: CONFIRM's own guard replays, inserts nothing", async () => {
    const { deps } = makeDeps()
    await toConfirm(deps)
    // A concurrent request already wrote the order + tx for this session; the session is still alive.
    const withTx = fakeSupabase({ pkg: OK_PKG, rows: { hubtel_transactions: winner, airtime_orders: { network: "MTN", beneficiary_phone: "0244123456" } } })
    deps.supabase = withTx.client
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    expect(withTx.inserts["airtime_orders"]).toBeUndefined()
  })
  it("tx insert hits a unique violation: orphan airtime order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    expect(sup.updates.some(u => u.table === "airtime_orders" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
  it("session expired after AddToCart: the next '1' replays the AIRTIME cart, not the menu (review focus #6)", async () => {
    const sup = fakeSupabase({ rows: { hubtel_transactions: { ...winner, order_id: "o1" }, airtime_orders: { network: "Telecel", beneficiary_phone: "0201234567" } } })
    const { deps } = makeDeps({}, sup)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "Telecel Airtime to 0201234567", Qty: 1, Price: 10 })
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/airtime.test.ts`
Expected: FAIL: "Buy Airtime" is listed (the flag was flipped in Step 2) but has no entry handler yet, so picking it re-shows the main menu and the first assertion fails with `expected 'Welcome to Datagod…' to contain 'Enter recipient number'`.

- [ ] **Step 7: Write the airtime flow**

```ts
// lib/ussd-hubtel/flows/airtime.ts
// Buy Airtime on the Hubtel channel. Port of lib/ussd/handlers/airtime.ts minus wallet, Paystack
// and OTP: CONFIRM ends in AddToCart. Fee-inclusive pricing exactly like Uzo: the caller enters
// what they pay; the recipient gets amount - fee (splitInclusive).
import { detectAirtimeNetwork, splitInclusive } from "@/lib/airtime-pricing"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { secureReference } from "@/lib/secure-random"
import { AIRTIME_NETWORKS, airtimeLabel, type AirtimeNetworkKey } from "../menus"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply } from "../types"

const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const NETWORK = { label: "Recipient network" }
const AMOUNT = { label: "Airtime amount", fieldType: "decimal" as const }
const CONFIRM = { label: "Confirm airtime" }
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function airtimeRecipientPromptText(): string {
  return "Buy Airtime\nEnter recipient number\n(who gets the airtime):\n0. Back"
}

export function airtimeNetworkMenuText(): string {
  return "Select recipient network:\n" + AIRTIME_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

export function airtimeAmountPromptText(label: string, min: number, max: number): string {
  return `${label} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n0. Back`
}

export function airtimeConfirmText(label: string, recipient: string, pay: number, get: number, payerLocal: string): string {
  return (
    `Confirm Airtime\n${label} to ${recipient}\nYou pay GHS ${pay.toFixed(2)}\n` +
    `They get GHS ${get.toFixed(2)}\nfrom ${payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const isDealerRole = (role?: string) => role === "dealer" || role === "sub_agent"

export async function startAirtime(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "AIRTIME_ENTER_RECIPIENT" }, airtimeRecipientPromptText(), RECIPIENT)
}

const toRecipient = (ctx: FlowCtx, msg = "") =>
  goto(ctx, { step: "AIRTIME_ENTER_RECIPIENT", airtimeRecipient: undefined, airtimeNetwork: undefined },
    (msg ? `${msg}\n` : "") + airtimeRecipientPromptText(), RECIPIENT)

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToMain(ctx)
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  if (!/^0[0-9]{9}$/.test(local)) return say(ctx, "Invalid number.\n" + airtimeRecipientPromptText(), "AIRTIME_ENTER_RECIPIENT", RECIPIENT)
  const network = detectAirtimeNetwork(local)
  if (!network) {
    // Unknown prefix: let the caller say which network the recipient is on.
    return goto(ctx, { step: "AIRTIME_SELECT_NETWORK", airtimeRecipient: local }, airtimeNetworkMenuText(), NETWORK)
  }
  return useNetwork(ctx, local, network)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return toRecipient(ctx)
  const picked = AIRTIME_NETWORKS.find(n => n.digit === ctx.input)
  if (!picked) return say(ctx, airtimeNetworkMenuText(), "AIRTIME_SELECT_NETWORK", NETWORK)
  return useNetwork(ctx, ctx.session.airtimeRecipient!, picked.key)
}

/** Shared tail of recipient entry and network pick: availability + prefix gate, then ask the amount. */
async function useNetwork(ctx: FlowCtx, local: string, network: AirtimeNetworkKey): Promise<HubtelReply> {
  const { deps } = ctx
  const label = airtimeLabel(network)
  if (!(await deps.airtime.isEnabled(network))) return toRecipient(ctx, `${label} airtime is unavailable.`)
  // Same hard block the web purchase path applies (purchaseAirtime): never top up a number that
  // the admin prefix map says is on another network.
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled) {
    const check = validateNetworkPrefix(network, local, prefix.map)
    if (!check.ok) return toRecipient(ctx, check.message ?? "Number does not match the network.")
  }
  const { min, max } = await deps.airtime.getLimits()
  return goto(ctx, { step: "AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network },
    airtimeAmountPromptText(label, min, max), AMOUNT)
}

async function enterAmount(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  if (ctx.input === "0") return toRecipient(ctx)
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const { min, max } = await deps.airtime.getLimits()
  const invalid = () => say(ctx, "Enter a valid amount.\n" + airtimeAmountPromptText(label, min, max), "AIRTIME_ENTER_AMOUNT", AMOUNT)

  const amount = AMOUNT_RE.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(amount > 0) || amount < min || amount > max) return invalid()

  const dialer = await deps.resolveDialer(session.dialingPhone)
  const rate = await deps.airtime.feeRate(network, isDealerRole(dialer.role))
  const { fee, toDeliver } = splitInclusive(amount, rate)
  if (!(toDeliver > 0)) return invalid()

  return goto(ctx, {
    step: "AIRTIME_CONFIRM", airtimeAmount: amount, airtimeFee: fee, airtimeToDeliver: toDeliver, userId: dialer.userId,
  }, airtimeConfirmText(label, session.airtimeRecipient!, amount, toDeliver, toLocalPhone(session.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const amount = session.airtimeAmount!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, airtimeConfirmText(label, session.airtimeRecipient!, amount, session.airtimeToDeliver!, toLocalPhone(session.dialingPhone)), "AIRTIME_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: settings may have changed since the confirm screen was shown.
  if (!(await deps.airtime.isEnabled(network))) return finish(ctx, `${label} airtime is no longer available.`)
  const { min, max } = await deps.airtime.getLimits()
  if (amount < min || amount > max) return finish(ctx, `Amount must be GHS ${min}-${max}. Please restart.`)
  const dialer = await deps.resolveDialer(session.dialingPhone)
  const rate = await deps.airtime.feeRate(network, isDealerRole(dialer.role))
  const { fee, toDeliver } = splitInclusive(amount, rate)
  if (Math.abs(toDeliver - session.airtimeToDeliver!) > 0.001) {
    return finish(ctx, "Airtime rates changed. Please restart your order.")
  }

  return submitOrder(ctx, {
    table: "airtime_orders",
    price: amount,
    logTag: "HUBTEL-AIRTIME",
    row: {
      reference_code: secureReference("AT", 2, 3),
      network,
      beneficiary_phone: session.airtimeRecipient,
      airtime_amount: toDeliver,
      fee_amount: fee,
      total_paid: amount, // our price; Hubtel adds its own charge on top, at Hubtel
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: dialer.userId ?? null,
      shop_id: null,
      merchant_commission: 0,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      dialing_phone: session.dialingPhone,
      channel: "ussd",
    },
  })
}

export const AIRTIME_STEPS: StepTable = {
  AIRTIME_ENTER_RECIPIENT: enterRecipient,
  AIRTIME_SELECT_NETWORK: selectNetwork,
  AIRTIME_ENTER_AMOUNT: enterAmount,
  AIRTIME_CONFIRM: confirm,
}
```

- [ ] **Step 8: Register the table and wire the router**

In `lib/ussd-hubtel/order-tables.ts`: change the import to `import { HUBTEL_NETWORKS, airtimeLabel, formatSize } from "./menus"`, change the union to `export type HubtelOrderTable = "ussd_orders" | "airtime_orders"`, and add this entry to `ORDER_TABLES`:

```ts
  airtime_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "network, beneficiary_phone",
    cartItemName: r => `${airtimeLabel(String(r.network))} Airtime to ${r.beneficiary_phone}`,
  },
```

Append to `lib/ussd-hubtel/order-tables.test.ts` inside the describe:

```ts
  it("airtime_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.airtime_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ network: "AT", beneficiary_phone: "0271234567" })).toBe("AT Airtime to 0271234567")
  })
```

In `lib/ussd-hubtel/router.ts` add `import { AIRTIME_STEPS, startAirtime } from "./flows/airtime"`, add `airtime: startAirtime,` to `MAIN_MENU_ENTRIES`, and add `...AIRTIME_STEPS,` to `STEPS`.

- [ ] **Step 9: Run the flow test to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/flows/airtime.test.ts lib/ussd-hubtel/order-tables.test.ts`
Expected: PASS.

Note: the "tx row already exists while the session is alive" test swaps `deps.supabase` for a fake that already holds the winner's tx row after walking to CONFIRM, so CONFIRM's own replay guard (not the no-session path) answers.

- [ ] **Step 10: Rewrite the order-handler test with a table-aware fake and all module mocks**

Replace the whole of `lib/ussd-hubtel/order-handlers.test.ts` with (the three Plan 1 `ussd_orders` tests are kept unchanged; the mocks for Tasks 3-5 are added now so those tasks only append describe blocks):

```ts
// lib/ussd-hubtel/order-handlers.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fulfillUssdOrder = vi.fn()
const sendSMS = vi.fn()
const markAirtimeOrderPaid = vi.fn()
const fulfillPaidResultsCheckerOrder = vi.fn()
const fulfillPaidResultsCheckRequest = vi.fn()
const fulfillUssdAfaOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: any[]) => fulfillUssdOrder(...a) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: any[]) => sendSMS(...a),
  SMSTemplates: {
    ussdOrderConfirmed: () => "confirmed",
    ussdPaymentConfirmed: () => "paid",
    ussdAirtimePaymentReceived: () => "airtime-paid",
    ussdAfaPaymentReceived: () => "afa-paid",
  },
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: async () => "link" }))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: (...a: any[]) => markAirtimeOrderPaid(...a) }))
vi.mock("@/lib/results-checker-service", () => ({
  fulfillPaidResultsCheckerOrder: (...a: any[]) => fulfillPaidResultsCheckerOrder(...a),
  fulfillPaidResultsCheckRequest: (...a: any[]) => fulfillPaidResultsCheckRequest(...a),
}))
vi.mock("@/lib/ussd/fulfill-afa", () => ({ fulfillUssdAfaOrder: (...a: any[]) => fulfillUssdAfaOrder(...a) }))

import { createOrderHandlers, createFailHandlers } from "./order-handlers"

/**
 * Table-aware fake. select(...).eq(...).maybeSingle() returns rows[table] (the same object every
 * time, so a mocked library call may mutate it). An update chain ending in .select() only matches
 * when the row's in() column value is in the list, like the real conditional update; an awaited
 * update without .select() always applies. `updates` holds applied patches in order; `log` also
 * records the table and the in() filter.
 */
function fakeDb(rows: Record<string, any>) {
  const updates: any[] = []
  const log: Array<{ table: string; patch: any; inCol?: string; inVals?: string[] }> = []
  const client = {
    from(table: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }) }),
        update: (patch: any) => {
          const rec: { table: string; patch: any; inCol?: string; inVals?: string[] } = { table, patch }
          const chain: any = {
            eq: () => chain,
            in: (col: string, vals: string[]) => { rec.inCol = col; rec.inVals = vals; return chain },
            select: async () => {
              const row = rows[table]
              const ok = !!row && (!rec.inCol || (rec.inVals ?? []).includes(row[rec.inCol]))
              if (ok) { updates.push(patch); log.push(rec) }
              return { data: ok ? [{ id: row.id }] : [], error: null }
            },
            then: (res: any) => { updates.push(patch); log.push(rec); return res({ error: null }) },
          }
          return chain
        },
        insert: async () => ({ error: null }),
      }
    },
  }
  return { client: client as any, updates, log }
}
const fakeSupabase = (order: any) => fakeDb({ ussd_orders: order })

beforeEach(() => {
  for (const m of [fulfillUssdOrder, sendSMS, markAirtimeOrderPaid, fulfillPaidResultsCheckerOrder, fulfillPaidResultsCheckRequest, fulfillUssdAfaOrder]) m.mockReset()
  fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" })
  markAirtimeOrderPaid.mockResolvedValue({ success: true })
})

const baseOrder = {
  id: "o1", network: "MTN", recipient_phone: "0241234567", dialing_phone: "0241234567",
  package_size: "1", parent_shop_id: null, parent_profit_amount: 0,
}

describe("ussd_orders post-payment handler", () => {
  it("failed order → throws, no fulfilment, no SMS", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "failed" })
    await expect(createOrderHandlers(client).ussd_orders("o1")).rejects.toThrow(/not in a payable state: failed/)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("pending order → marks completed, fulfils once, SMSes recipient", async () => {
    const { client, updates } = fakeSupabase({ ...baseOrder, payment_status: "pending" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(updates[0]).toMatchObject({ payment_status: "completed" })
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0].phone).toBe("0241234567")
  })

  it("already completed → returns without fulfilling", async () => {
    const { client } = fakeSupabase({ ...baseOrder, payment_status: "completed" })
    await createOrderHandlers(client).ussd_orders("o1")
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
})

describe("airtime_orders post-payment handler", () => {
  const base = { id: "t1", network: "MTN", beneficiary_phone: "0244123456", dialing_phone: "+233200585542", airtime_amount: 9.52 }

  it("failed order (late payment after expiry) → throws, never marked paid, no SMS (review focus #5)", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "failed" } })
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/not in a payable state: failed/)
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("pending_payment → markAirtimeOrderPaid once, SMS to the recipient and to a different payer", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
    expect(markAirtimeOrderPaid).toHaveBeenCalledWith("t1", null)
    expect(sendSMS.mock.calls.map(c => c[0].phone)).toEqual(["0244123456", "+233200585542"])
    expect(sendSMS.mock.calls[0][0].message).toBe("airtime-paid")
  })
  it("payer is the recipient → one SMS", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, dialing_phone: "+233244123456", payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "completed" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("markAirtimeOrderPaid says alreadyProcessed → no SMS", async () => {
    markAirtimeOrderPaid.mockResolvedValue({ success: true, alreadyProcessed: true })
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("markAirtimeOrderPaid fails → throws (needs_review), no SMS", async () => {
    markAirtimeOrderPaid.mockResolvedValue({ success: false })
    const { client } = fakeDb({ airtime_orders: { ...base, payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/could not be marked paid/)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("missing order → throws", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).airtime_orders("t1")).rejects.toThrow(/not found/)
  })
})

describe("fail handlers only touch unpaid orders (review focus #5)", () => {
  it("ussd_orders", async () => {
    const { client, log } = fakeDb({ ussd_orders: { id: "o1", payment_status: "pending" } })
    await createFailHandlers(client).ussd_orders("o1")
    expect(log[0]).toMatchObject({ table: "ussd_orders", patch: { order_status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending", "otp_required"] })
  })
  it("airtime_orders", async () => {
    const { client, log } = fakeDb({ airtime_orders: { id: "t1", payment_status: "pending_payment" } })
    await createFailHandlers(client).airtime_orders("t1")
    expect(log[0]).toMatchObject({ table: "airtime_orders", patch: { status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending_payment", "otp_required"] })
  })
})
```

- [ ] **Step 11: Run it to verify the new airtime handler tests fail**

Run: `npx vitest run lib/ussd-hubtel/order-handlers.test.ts`
Expected: FAIL in "airtime_orders post-payment handler" with `createOrderHandlers(...).airtime_orders is not a function`; the ussd_orders and fail-handler tests pass.

- [ ] **Step 12: Add the airtime handler**

In `lib/ussd-hubtel/order-handlers.ts` add this function above `createOrderHandlers`, and add `airtime_orders: orderId => airtimeOrderPostPayment(supabase, orderId),` to the object `createOrderHandlers` returns (replace the Plan 1 comment line there with `// Plan 3 registers ussd_shop_orders`):

```ts
/**
 * Mirrors the Paystack webhook's USSD airtime branch (app/api/webhooks/paystack/route.ts, "Handle
 * USSD airtime orders"). markAirtimeOrderPaid is that branch's own post-payment path (mark paid,
 * shop profit, customer tracking, Digiwapy or a manual-airtime admin alert) and is its own
 * idempotency gate, so it is called after a read-check rather than a conditional pre-mark (which
 * would make it no-op). Once-only is guaranteed by processFulfillment's claim on this order's
 * single tx row. WhatsApp-shop token deduction does not apply: channel is "ussd".
 */
async function airtimeOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("airtime_orders")
    .select("id, payment_status, beneficiary_phone, dialing_phone, network, airtime_amount")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] airtime_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`airtime_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed
  if (!ORDER_TABLES.airtime_orders.payableStatuses.includes(order.payment_status)) {
    throw new Error(`airtime_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  const { markAirtimeOrderPaid } = await import("@/lib/airtime-service")
  const marked = await markAirtimeOrderPaid(orderId, null)
  if (!marked.success) throw new Error(`airtime_orders ${orderId} could not be marked paid`)
  if (marked.alreadyProcessed) return

  // Same message as the Paystack branch: airtime may be fulfilled manually, so never claim it landed.
  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  const benef = String(order.beneficiary_phone)
  const msg = SMSTemplates.ussdAirtimePaymentReceived(Number(order.airtime_amount).toFixed(2), order.network, benef)
  try {
    await sendSMS({ phone: benef, message: msg, type: "airtime_order_created", reference: orderId })
  } catch (e) { console.warn("[HUBTEL-ORDER] airtime recipient SMS failed:", e) }
  const payer = order.dialing_phone as string | null
  if (payer && last9(payer) && last9(payer) !== last9(benef)) {
    try {
      await sendSMS({ phone: payer, message: msg, type: "airtime_order_created", reference: orderId })
    } catch (e) { console.warn("[HUBTEL-ORDER] airtime payer SMS failed:", e) }
  }
}
```

- [ ] **Step 13: Run the whole Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS (all files, including `flows/airtime.test.ts` and the rewritten `order-handlers.test.ts`).
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 14: Commit**

```bash
git add lib/ussd-hubtel/services.ts lib/ussd-hubtel/flows/airtime.ts lib/ussd-hubtel/flows/airtime.test.ts lib/ussd-hubtel/types.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/order-handlers.ts lib/ussd-hubtel/order-handlers.test.ts lib/ussd-hubtel/testing/fakes.ts
git commit -m "feat(hubtel): Buy Airtime flow and airtime_orders handler"
```

---

### Task 3: Results Checker menu, Buy Vouchers, My Vouchers + `results_checker_orders` handler

Port of the buy / my-vouchers half of `lib/ussd/handlers/results-checker.ts` (lines 39-421) minus wallet, Paystack and OTP. "Check Results" (option 3) is added in Task 4; this task ships a working Results Checker entry with options 1 and 2 and flips `IMPLEMENTED_SERVICES.resultsChecker`.

Business gating kept from Uzo: a board is offered only if it is enabled (`isExamBoardEnabled`) AND in stock (`getAvailableCount > 0`); quantity is `1..min(available, maxQuantity)`; price is `calculateRCPrice({ examBoard, quantity, applyBulk: true })` (bulk rate when the threshold is met). At "1" the board is re-checked (enabled and `available >= qty`) and the price recomputed; a changed total releases (D6). Vouchers are SMSed to `customer_phone` = the caller's local number, by `fulfillPaidResultsCheckerOrder` → `deliverVouchers` after payment.

Step transitions:

| Step | Input | Next |
|---|---|---|
| MAIN | "Results Checker" digit | RC_MENU |
| RC_MENU | `0` | MAIN |
| | `1` | no enabled+in-stock board ⇒ same, "No vouchers available right now."; else RC_SELECT_BOARD |
| | `2` | RC_MY_VOUCHERS (last 5 completed orders of this caller, 30 days) |
| | other | same |
| RC_SELECT_BOARD | `0` | RC_MENU |
| | valid digit | RC_ENTER_QTY |
| RC_ENTER_QTY | `0` | RC_SELECT_BOARD |
| | cap `< 1` (sold out meanwhile) | RC_MENU, "sold out" |
| | not an integer in `1..cap` | same, "Enter a valid quantity." |
| | ok | RC_CONFIRM |
| RC_CONFIRM | `2` | release "Order cancelled." |
| | `1` | replay guard; re-check stock + price; `submitOrder` |
| RC_MY_VOUCHERS | `0` | RC_MENU |
| | valid digit | RC_VOUCHER_DETAIL |
| RC_VOUCHER_DETAIL | `0` | RC_MY_VOUCHERS |
| | `1` | `resendVouchers(orderId, "sms")` then release |

**Files:**
- Create: `lib/ussd-hubtel/flows/rc-buy.ts`, `lib/ussd-hubtel/flows/rc-buy.test.ts`
- Create: `lib/ussd-hubtel/services.test.ts`
- Modify: `lib/ussd-hubtel/services.ts` (+ `RcServices`, `defaultRcServices`, `listMyVouchers`)
- Modify: `lib/ussd-hubtel/types.ts`, `lib/ussd-hubtel/menus.ts` (`rcMenuText`, flip flag), `lib/ussd-hubtel/flow-kit.ts` (`RouterDeps.rc`), `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/testing/fakes.ts` (`fakeRc`)
- Modify: `lib/ussd-hubtel/order-tables.ts` (+ `results_checker_orders`), `lib/ussd-hubtel/order-tables.test.ts`
- Modify: `lib/ussd-hubtel/order-handlers.ts` (+ handler), `lib/ussd-hubtel/order-handlers.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 kit; Task 2 `RouterDeps.resolveDialer`; `isExamBoardEnabled`, `getAvailableCount`, `getMaxQuantity`, `getRCBulkHint`, `calculateRCPrice`, `fulfillPaidResultsCheckerOrder(orderId) => Promise<{ success: boolean; status: "completed" | "pending" | "failed" | "not_found"; message: string; newlyPaid: boolean }>` (`lib/results-checker-service.ts`); `resendVouchers(orderId, "sms" | "email") => Promise<{ success: boolean; message: string }>` (`lib/results-checker-notification-service.ts`); `phoneVariants` (`lib/phone-format.ts`); `type ExamBoard` (`lib/results-check-validation.ts`, client-safe, same union as the service's).
- Produces:
  - `services.ts`: `interface MyVoucherOrder { id: string; exam_board: string; reference_code: string; created_at: string }`, `interface RcServices { isBoardEnabled(board: ExamBoard): Promise<boolean>; availableCount(board: ExamBoard): Promise<number>; maxQuantity(): Promise<number>; bulkHint(board: ExamBoard): Promise<{ minQty: number; bulkBasePrice: number } | null>; price(board: ExamBoard, quantity: number, applyBulk: boolean): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean }>; listMyVouchers(dialingPhone: string): Promise<MyVoucherOrder[]>; resendVouchers(orderId: string): Promise<{ success: boolean; message: string }> }` (Task 4 adds `checkSettings`), `defaultRcServices(supabase): RcServices`, `listMyVouchers(supabase, dialingPhone)`.
  - `RouterDeps.rc: RcServices`; `fakeRc(over?)` in `testing/fakes.ts`.
  - `menus.ts`: `rcMenuText(): string` (Task 4 adds option 3).
  - `flows/rc-buy.ts`: `startRc(ctx)`, `RC_BUY_STEPS: StepTable`, `ALL_BOARDS`, text builders `rcBoardMenuText`, `rcQtyPromptText`, `rcConfirmText`, `rcMyVouchersText`, `rcVoucherDetailText`.
  - `HubtelOrderTable` includes `"results_checker_orders"`; `createOrderHandlers(...).results_checker_orders`.

- [ ] **Step 1: Steps, session fields, menu text and the flag**

In `lib/ussd-hubtel/types.ts` append to the `HubtelStep` union:

```ts
  | "RC_MENU" | "RC_SELECT_BOARD" | "RC_ENTER_QTY" | "RC_CONFIRM" | "RC_MY_VOUCHERS" | "RC_VOUCHER_DETAIL"
```

and add inside `interface HubtelSession` after the airtime fields:

```ts
  // Results checker (buy / my vouchers)
  rcBoardOptions?: string[] // boards shown on RC_SELECT_BOARD, in order
  rcBoard?: string // WASSCE | BECE | NOVDEC
  rcQty?: number
  rcUnitPrice?: number
  rcTotal?: number // = order total_paid = Hubtel Price
  rcBulkApplied?: boolean
  rcMyOrders?: Array<{ id: string; exam_board: string; reference_code: string; created_at: string }>
  rcSelectedOrderId?: string
```

In `lib/ussd-hubtel/menus.ts` change `resultsChecker: false,` to `resultsChecker: true,` and append:

```ts
/** Results Checker sub-menu (Task 4 adds "3. Check Results"). */
export function rcMenuText(): string {
  return "Results Checker\n1. Buy Vouchers\n2. My Vouchers\n0. Back"
}
```

- [ ] **Step 2: Add the RC services, dependency and fake**

Append to `lib/ussd-hubtel/services.ts` (and add the imports at the top):

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { phoneVariants } from "@/lib/phone-format"
import type { ExamBoard } from "@/lib/results-check-validation"
import {
  calculateRCPrice, getAvailableCount, getMaxQuantity, getRCBulkHint, isExamBoardEnabled,
} from "@/lib/results-checker-service"
import { toLocalPhone } from "./protocol"
```

```ts
export interface MyVoucherOrder { id: string; exam_board: string; reference_code: string; created_at: string }

export interface RcServices {
  isBoardEnabled(board: ExamBoard): Promise<boolean>
  availableCount(board: ExamBoard): Promise<number>
  maxQuantity(): Promise<number>
  bulkHint(board: ExamBoard): Promise<{ minQty: number; bulkBasePrice: number } | null>
  price(board: ExamBoard, quantity: number, applyBulk: boolean): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean }>
  listMyVouchers(dialingPhone: string): Promise<MyVoucherOrder[]>
  /** SMS the vouchers again to the order's own customer_phone. */
  resendVouchers(orderId: string): Promise<{ success: boolean; message: string }>
}

export function defaultRcServices(supabase: SupabaseClient): RcServices {
  return {
    isBoardEnabled: isExamBoardEnabled,
    availableCount: getAvailableCount,
    maxQuantity: getMaxQuantity,
    bulkHint: getRCBulkHint,
    price: async (examBoard, quantity, applyBulk) => {
      const r = await calculateRCPrice({ examBoard, quantity, applyBulk })
      return { unitPrice: r.unitPrice, totalPaid: r.totalPaid, bulkApplied: r.bulkApplied }
    },
    listMyVouchers: dialingPhone => listMyVouchers(supabase, dialingPhone),
    resendVouchers: async orderId => {
      const { resendVouchers } = await import("@/lib/results-checker-notification-service")
      return resendVouchers(orderId, "sms")
    },
  }
}

/** Same query as Uzo's "My Vouchers" (completed, last 30 days, newest 5), matching every stored phone format. */
export async function listMyVouchers(supabase: SupabaseClient, dialingPhone: string): Promise<MyVoucherOrder[]> {
  const local = toLocalPhone(dialingPhone)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const filters = [...phoneVariants(dialingPhone).map(v => `dialing_phone.eq.${v}`), `customer_phone.eq.${local}`].join(",")
  const { data, error } = await supabase
    .from("results_checker_orders")
    .select("id, exam_board, reference_code, created_at")
    .or(filters)
    .eq("status", "completed")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(5)
  if (error) {
    console.error("[HUBTEL-RC] my vouchers query failed:", error)
    return []
  }
  return (data ?? []) as MyVoucherOrder[]
}
```

In `lib/ussd-hubtel/flow-kit.ts` change the services import to `import type { AirtimeServices, DialerInfo, RcServices } from "./services"` and add `rc: RcServices` at the end of `RouterDeps`.

In `lib/ussd-hubtel/router.ts` change the services import to `import { defaultAirtimeServices, defaultRcServices, resolveDialer } from "./services"` and add `rc: defaultRcServices(supabase),` after `airtime: defaultAirtimeServices(),`.

In `lib/ussd-hubtel/testing/fakes.ts` change the type import to `import type { AirtimeServices, RcServices } from "../services"`, add `rc: fakeRc(),` after `airtime: fakeAirtime(),` in `makeDeps`, and append:

```ts
export function fakeRc(over: Partial<RcServices> = {}): RcServices {
  return {
    isBoardEnabled: async () => true,
    availableCount: async () => 10,
    maxQuantity: async () => 50,
    bulkHint: async () => null,
    price: async (_board, qty) => ({ unitPrice: 20, totalPaid: 20 * qty, bulkApplied: false }),
    listMyVouchers: async () => [],
    resendVouchers: async () => ({ success: true, message: "ok" }),
    ...over,
  }
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// lib/ussd-hubtel/services.test.ts
import { describe, it, expect } from "vitest"
import { listMyVouchers } from "./services"

describe("listMyVouchers", () => {
  it("matches every stored phone format, completed only, newest 5", async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const b: any = {}
    for (const m of ["select", "or", "eq", "gte", "order"]) b[m] = (...a: unknown[]) => { calls.push([m, ...a]); return b }
    b.limit = async (n: number) => { calls.push(["limit", n]); return { data: [{ id: "v1" }], error: null } }
    const supabase: any = { from: (t: string) => { calls.push(["from", t]); return b } }
    const rows = await listMyVouchers(supabase, "+233200585542")
    expect(rows).toEqual([{ id: "v1" }])
    const or = String(calls.find(c => c[0] === "or")![1])
    for (const v of ["dialing_phone.eq.+233200585542", "dialing_phone.eq.0200585542", "dialing_phone.eq.233200585542", "customer_phone.eq.0200585542"]) {
      expect(or).toContain(v)
    }
    expect(calls).toContainEqual(["from", "results_checker_orders"])
    expect(calls).toContainEqual(["eq", "status", "completed"])
    expect(calls).toContainEqual(["limit", 5])
  })
  it("returns [] on a query error", async () => {
    const b: any = { select: () => b, or: () => b, eq: () => b, gte: () => b, order: () => b, limit: async () => ({ data: null, error: { message: "x" } }) }
    const supabase: any = { from: () => b }
    const err = console.error
    console.error = () => {}
    expect(await listMyVouchers(supabase, "0200585542")).toEqual([])
    console.error = err
  })
})
```

```ts
// lib/ussd-hubtel/flows/rc-buy.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"

async function toRc(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
}
/** Results Checker -> Buy -> first board -> quantity -> confirm screen. */
async function toConfirm(deps: RouterDeps, qty = "2") {
  await toRc(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: qty }), deps)
}

describe("results checker: menus", () => {
  it("is on the main menu and opens the Results Checker menu", async () => {
    const { deps, store } = makeDeps()
    const r = await toRc(deps)
    expect(r.Message).toContain("1. Buy Vouchers")
    expect(r.Message).toContain("2. My Vouchers")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("is hidden when the admin turns it off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: false } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(menu.Message).not.toContain("Results Checker")
  })
  it("offers only boards that are enabled AND in stock", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ isBoardEnabled: async b => b !== "NOVDEC", availableCount: async b => (b === "BECE" ? 0 : 10) }) })
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("1. WASSCE")
    expect(r.Message).not.toContain("BECE")
    expect(r.Message).not.toContain("NOVDEC")
  })
  it("says no vouchers when every board is sold out, and stays on the RC menu", async () => {
    const { deps, store } = makeDeps({ rc: fakeRc({ availableCount: async () => 0 }) })
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("No vouchers available right now.")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("'0' on the RC menu goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toRc(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("MAIN")
  })
})

describe("results checker: quantity", () => {
  it("shows the cap (min of stock and max) and the bulk hint", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ availableCount: async () => 3, bulkHint: async () => ({ minQty: 5, bulkBasePrice: 15 }) }) })
    await toRc(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("(1 - 3)")
    expect(r.Message).toContain("Buy 5+ for GHS 15.00 each")
  })
  for (const bad of ["4", "0.5", "abc", "-1"]) {
    it(`rejects quantity "${bad}" above stock or malformed`, async () => {
      const { deps, store } = makeDeps({ rc: fakeRc({ availableCount: async () => 3 }) })
      const r = await toConfirm(deps, bad)
      expect(r.Message).toContain("Enter a valid quantity.")
      expect(store.get("S1")?.step).toBe("RC_ENTER_QTY")
    })
  }
  it("confirm shows board x qty, total and payer; bulk rate when applied", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ price: async (_b, q) => ({ unitPrice: 15, totalPaid: 15 * q, bulkApplied: true }) }) })
    const r = await toConfirm(deps, "5")
    expect(r.Message).toContain("WASSCE x 5")
    expect(r.Message).toContain("Bulk rate GHS 15.00 each")
    expect(r.Message).toContain("GHS 75.00 from 0200585542")
    expect(r.Message).toContain("1. Pay now\n2. Cancel")
  })
})

describe("results checker: confirm -> AddToCart", () => {
  it("creates the RC order + tx and returns AddToCart at the voucher total", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ resolveDialer: async () => ({ userId: "u1", email: "a@b.c" }) }, sup)
    await toConfirm(deps, "2")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Checker x2", Qty: 1, Price: 40 })
    const row = sup.inserts["results_checker_orders"][0]
    expect(row).toMatchObject({
      exam_board: "WASSCE", quantity: 2, unit_price: 20, fee_amount: 0, total_paid: 40,
      customer_name: "USSD Customer", customer_email: "a@b.c", customer_phone: "0200585542",
      shop_id: null, merchant_commission: 0, user_id: "u1",
      status: "pending_payment", payment_status: "pending_payment", dialing_phone: "+233200585542", channel: "ussd",
    })
    expect(row.reference_code).toMatch(/^RC-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_checker_orders", order_id: NEW_ID, expected_amount: 40 })
  })
  it("stock dropped below the quantity since the confirm screen: release, no order (review focus #2)", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toConfirm(deps, "2")
    stock = 1
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("board disabled since the confirm screen: release, no order", async () => {
    let on = true
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ isBoardEnabled: async () => on }) }, sup)
    await toConfirm(deps, "2")
    on = false
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("price changed since the confirm screen: release, no order", async () => {
    let unit = 20
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ rc: fakeRc({ price: async (_b, q) => ({ unitPrice: unit, totalPaid: unit * q, bulkApplied: false }) }) }, sup)
    await toConfirm(deps, "2")
    unit = 25
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 50.00")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
})

describe("results checker: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "results_checker_orders", order_id: "o-winner", expected_amount: 40, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps, "2")
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_checker_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan RC order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toConfirm(deps, "2")
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Checker x2", Qty: 1, Price: 40 })
    expect(sup.updates.some(u => u.table === "results_checker_orders" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})

describe("results checker: my vouchers", () => {
  const order = { id: "v1", exam_board: "WASSCE", reference_code: "RC-AAA-BBB", created_at: "2026-10-05T10:00:00Z" }
  it("lists the caller's vouchers, opens one and resends it by SMS", async () => {
    const resendVouchers = vi.fn(async () => ({ success: true, message: "ok" }))
    const { deps } = makeDeps({ rc: fakeRc({ listMyVouchers: async () => [order], resendVouchers }) })
    await toRc(deps)
    const list = await hubtelRouter(req({ Message: "2" }), deps)
    expect(list.Message).toContain("1. WASSCE RC-AAA-BBB (5 Oct)")
    const detail = await hubtelRouter(req({ Message: "1" }), deps)
    expect(detail.Message).toContain("1. Resend SMS")
    const done = await hubtelRouter(req({ Message: "1" }), deps)
    expect(resendVouchers).toHaveBeenCalledWith("v1")
    expect(done.Type).toBe("release")
    expect(done.Message).toContain("resent by SMS")
  })
  it("says so when there are no vouchers", async () => {
    const { deps } = makeDeps()
    await toRc(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toContain("No completed vouchers")
  })
  it("a failed or throwing resend releases with a safe message", async () => {
    const { deps } = makeDeps({ rc: fakeRc({ listMyVouchers: async () => [order], resendVouchers: async () => { throw new Error("db down") } }) })
    await toRc(deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Resend failed")
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/services.test.ts lib/ussd-hubtel/flows/rc-buy.test.ts`
Expected: `services.test.ts` PASSES (the function was written in Step 2); `rc-buy.test.ts` FAILS: "Results Checker" has no entry handler yet, so `expected 'Welcome to Datagod…' to contain '1. Buy Vouchers'`.

- [ ] **Step 5: Write the flow**

```ts
// lib/ussd-hubtel/flows/rc-buy.ts
// Results Checker on the Hubtel channel: sub-menu, buy vouchers, my vouchers, resend. Port of
// lib/ussd/handlers/results-checker.ts lines 39-421 minus wallet, Paystack and OTP.
import { secureReference } from "@/lib/secure-random"
import type { ExamBoard } from "@/lib/results-check-validation"
import { rcMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { MyVoucherOrder } from "../services"
import type { HubtelReply } from "../types"

export const ALL_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

const MENU = { label: "Results Checker" }
const BOARD = { label: "Select exam" }
const QTY = { label: "Quantity", fieldType: "number" as const }
const CONFIRM = { label: "Confirm vouchers" }
const MINE = { label: "My vouchers" }
const DETAIL = { label: "Voucher" }

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })

export function rcBoardMenuText(boards: string[]): string {
  return "Buy Results Checker\nSelect exam:\n" + boards.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}

export function rcQtyPromptText(board: string, available: number, max: number, bulk: { minQty: number; unitPrice: number } | null): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)} each` : ""
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n0. Back`
}

export function rcConfirmText(board: string, qty: number, total: number, payerLocal: string, bulkUnit: number | null): string {
  const bulk = bulkUnit != null ? `\nBulk rate GHS ${bulkUnit.toFixed(2)} each` : ""
  return `Confirm Vouchers\n${board} x ${qty}${bulk}\nGHS ${total.toFixed(2)} from ${payerLocal}\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel`
}

export function rcMyVouchersText(orders: MyVoucherOrder[]): string {
  if (orders.length === 0) return "No completed vouchers\nfor this number.\n0. Back"
  return "My Vouchers\n" + orders.map((o, i) => `${i + 1}. ${o.exam_board} ${o.reference_code} (${shortDate(o.created_at)})`).join("\n") + "\n0. Back"
}

export function rcVoucherDetailText(o: MyVoucherOrder): string {
  return `${o.exam_board} ${o.reference_code}\nBought ${shortDate(o.created_at)}\n1. Resend SMS\n0. Back`
}

export async function startRc(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "RC_MENU" }, rcMenuText(), MENU)
}

const toRcMenu = (ctx: FlowCtx, prefix = "") => goto(ctx, { step: "RC_MENU" }, prefix + rcMenuText(), MENU)

/** Boards that are enabled AND in stock, in fixed order (Uzo buildRcBoardOptions). */
async function boardOptions(ctx: FlowCtx): Promise<ExamBoard[]> {
  const rc = ctx.deps.rc
  const picks = await Promise.all(ALL_BOARDS.map(async b => ((await rc.isBoardEnabled(b)) && (await rc.availableCount(b)) > 0 ? b : null)))
  return picks.filter((b): b is ExamBoard => b !== null)
}

async function qtyScreen(ctx: FlowCtx, board: ExamBoard) {
  const [available, max, hint] = await Promise.all([ctx.deps.rc.availableCount(board), ctx.deps.rc.maxQuantity(), ctx.deps.rc.bulkHint(board)])
  return {
    available,
    max,
    text: rcQtyPromptText(board, available, max, hint ? { minQty: hint.minQty, unitPrice: hint.bulkBasePrice } : null),
  }
}

async function rcMenu(ctx: FlowCtx): Promise<HubtelReply> {
  switch (ctx.input) {
    case "0":
      return backToMain(ctx)
    case "1": {
      const boards = await boardOptions(ctx)
      if (boards.length === 0) return say(ctx, "No vouchers available right now.\n" + rcMenuText(), "RC_MENU", MENU)
      return goto(ctx, { step: "RC_SELECT_BOARD", rcBoardOptions: boards }, rcBoardMenuText(boards), BOARD)
    }
    case "2": {
      const orders = await ctx.deps.rc.listMyVouchers(ctx.session.dialingPhone)
      return goto(ctx, { step: "RC_MY_VOUCHERS", rcMyOrders: orders }, rcMyVouchersText(orders), MINE)
    }
    default:
      return say(ctx, rcMenuText(), "RC_MENU", MENU)
  }
}

async function selectBoard(ctx: FlowCtx): Promise<HubtelReply> {
  const options = (ctx.session.rcBoardOptions ?? []) as ExamBoard[]
  if (ctx.input === "0") return toRcMenu(ctx)
  const board = /^\d+$/.test(ctx.input) ? options[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, rcBoardMenuText(options), "RC_SELECT_BOARD", BOARD)
  const { text } = await qtyScreen(ctx, board)
  return goto(ctx, { step: "RC_ENTER_QTY", rcBoard: board }, text, QTY)
}

async function enterQty(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  const board = session.rcBoard as ExamBoard
  if (ctx.input === "0") return goto(ctx, { step: "RC_SELECT_BOARD" }, rcBoardMenuText(session.rcBoardOptions ?? []), BOARD)

  const { available, max, text } = await qtyScreen(ctx, board)
  const cap = Math.min(available, max)
  if (cap < 1) return toRcMenu(ctx, `${board} vouchers are sold out.\n`)
  const qty = /^\d+$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(qty >= 1 && qty <= cap)) return say(ctx, "Enter a valid quantity.\n" + text, "RC_ENTER_QTY", QTY)

  const pricing = await deps.rc.price(board, qty, true)
  return goto(ctx, {
    step: "RC_CONFIRM", rcQty: qty, rcUnitPrice: pricing.unitPrice, rcTotal: pricing.totalPaid, rcBulkApplied: pricing.bulkApplied,
  }, rcConfirmText(board, qty, pricing.totalPaid, toLocalPhone(session.dialingPhone), pricing.bulkApplied ? pricing.unitPrice : null), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const board = session.rcBoard as ExamBoard
  const qty = session.rcQty!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, rcConfirmText(board, qty, session.rcTotal!, toLocalPhone(session.dialingPhone), session.rcBulkApplied ? session.rcUnitPrice! : null), "RC_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: stock and price may have moved since the confirm screen.
  const [enabled, available] = await Promise.all([deps.rc.isBoardEnabled(board), deps.rc.availableCount(board)])
  if (!enabled || available < qty) {
    return finish(ctx, `${board} vouchers are no longer available in that quantity. Please try again.`)
  }
  const pricing = await deps.rc.price(board, qty, true)
  if (Math.abs(pricing.totalPaid - session.rcTotal!) > 0.001) {
    return finish(ctx, `Price changed to GHS ${pricing.totalPaid.toFixed(2)}. Please restart your order.`)
  }
  const dialer = await deps.resolveDialer(session.dialingPhone)

  return submitOrder(ctx, {
    table: "results_checker_orders",
    price: pricing.totalPaid,
    logTag: "HUBTEL-RC",
    row: {
      reference_code: secureReference("RC", 2, 3),
      exam_board: board,
      quantity: qty,
      customer_name: "USSD Customer",
      customer_email: dialer.email ?? null,
      customer_phone: toLocalPhone(session.dialingPhone), // the PINs are SMSed here after payment
      unit_price: pricing.unitPrice,
      fee_amount: 0,
      total_paid: pricing.totalPaid, // our price; Hubtel adds its own charge on top, at Hubtel
      shop_id: null,
      merchant_commission: 0,
      user_id: dialer.userId ?? null,
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: session.dialingPhone,
      channel: "ussd",
    },
  })
}

async function myVouchers(ctx: FlowCtx): Promise<HubtelReply> {
  const orders = ctx.session.rcMyOrders ?? []
  if (ctx.input === "0") return toRcMenu(ctx)
  const o = /^\d+$/.test(ctx.input) ? orders[Number(ctx.input) - 1] : undefined
  if (!o) return say(ctx, rcMyVouchersText(orders), "RC_MY_VOUCHERS", MINE)
  return goto(ctx, { step: "RC_VOUCHER_DETAIL", rcSelectedOrderId: o.id }, rcVoucherDetailText(o), DETAIL)
}

async function voucherDetail(ctx: FlowCtx): Promise<HubtelReply> {
  const orders = ctx.session.rcMyOrders ?? []
  const o = orders.find(x => x.id === ctx.session.rcSelectedOrderId)
  if (ctx.input === "0" || !o) return goto(ctx, { step: "RC_MY_VOUCHERS" }, rcMyVouchersText(orders), MINE)
  if (ctx.input !== "1") return say(ctx, rcVoucherDetailText(o), "RC_VOUCHER_DETAIL", DETAIL)
  try {
    const result = await ctx.deps.rc.resendVouchers(o.id)
    if (!result.success) return finish(ctx, result.message.length < 100 ? result.message : "Resend failed. Please contact support.")
  } catch (e) {
    console.error("[HUBTEL-RC] resend failed:", o.id, e)
    return finish(ctx, "Resend failed. Please contact support.")
  }
  // Sent to the order's own customer_phone (which may not be this caller), so do not name a number.
  return finish(ctx, "Vouchers resent by SMS to the number on the order.")
}

export const RC_BUY_STEPS: StepTable = {
  RC_MENU: rcMenu,
  RC_SELECT_BOARD: selectBoard,
  RC_ENTER_QTY: enterQty,
  RC_CONFIRM: confirm,
  RC_MY_VOUCHERS: myVouchers,
  RC_VOUCHER_DETAIL: voucherDetail,
}
```

- [ ] **Step 6: Register the table and wire the router**

In `lib/ussd-hubtel/order-tables.ts`: union becomes `export type HubtelOrderTable = "ussd_orders" | "airtime_orders" | "results_checker_orders"`; add:

```ts
  results_checker_orders: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "exam_board, quantity",
    cartItemName: r => `${r.exam_board} Checker x${r.quantity}`,
  },
```

Append to `lib/ussd-hubtel/order-tables.test.ts` inside the describe:

```ts
  it("results_checker_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.results_checker_orders
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ exam_board: "BECE", quantity: 3 })).toBe("BECE Checker x3")
  })
```

In `lib/ussd-hubtel/router.ts` add `import { RC_BUY_STEPS, startRc } from "./flows/rc-buy"`, add `resultsChecker: startRc,` to `MAIN_MENU_ENTRIES` and `...RC_BUY_STEPS,` to `STEPS`.

- [ ] **Step 7: Run the flow tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/rc-buy.test.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/services.test.ts`
Expected: PASS.

- [ ] **Step 8: Append the failing handler tests**

Append to `lib/ussd-hubtel/order-handlers.test.ts`:

```ts
describe("results_checker_orders post-payment handler", () => {
  const base = { id: "r1", exam_board: "WASSCE", quantity: 2 }

  it("failed order (late payment after expiry) → throws, no fulfilment (review focus #5)", async () => {
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "failed", payment_status: "failed" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })
  it("pending_payment → payment marked completed (conditional), then vouchers fulfilled once", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: true, status: "completed", message: "ok", newlyPaid: true })
    const { client, log } = fakeDb({ results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } })
    await createOrderHandlers(client).results_checker_orders("r1")
    expect(log[0]).toMatchObject({ table: "results_checker_orders", patch: { payment_status: "completed" }, inCol: "payment_status" })
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledWith("r1")
  })
  it("paid but out of stock → throws so the row lands in needs_review (review focus #2)", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: false, status: "pending", message: "Stock exhausted", newlyPaid: true })
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "pending_payment", payment_status: "pending_payment" } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/out of stock/)
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ results_checker_orders: { ...base, status: "completed", payment_status: "completed" } })
    await createOrderHandlers(client).results_checker_orders("r1")
    expect(fulfillPaidResultsCheckerOrder).not.toHaveBeenCalled()
  })
  it("fail handler fails only an unpaid RC order", async () => {
    const { client, log } = fakeDb({ results_checker_orders: { id: "r1", payment_status: "pending_payment" } })
    await createFailHandlers(client).results_checker_orders("r1")
    expect(log[0]).toMatchObject({ patch: { status: "failed", payment_status: "failed" }, inVals: ["pending_payment", "otp_required"] })
  })
})
```

Run: `npx vitest run lib/ussd-hubtel/order-handlers.test.ts`
Expected: FAIL in the new describe with `createOrderHandlers(...).results_checker_orders is not a function` (the fail-handler test already passes: the registry drives it).

- [ ] **Step 9: Add the handler**

In `lib/ussd-hubtel/order-handlers.ts` add above `createOrderHandlers`, and register `results_checker_orders: orderId => rcOrderPostPayment(supabase, orderId),`:

```ts
/**
 * Mirrors the Paystack webhook's USSD results-checker branch. The atomic pending→completed
 * payment mark is the once-only gate; fulfillPaidResultsCheckerOrder then assigns, finalises and
 * SMSes the vouchers (it checks `status`, not payment_status, so the pre-mark does not block it).
 * Stock exhausted after payment ⇒ throw ⇒ needs_review (the Paystack path leaves it silently
 * pending): a human must deliver the vouchers.
 */
async function rcOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("results_checker_orders")
    .select("id, status, payment_status")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] results_checker_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`results_checker_orders ${orderId} not found`)
  if (order.status === "completed") return // already processed
  const payable = ORDER_TABLES.results_checker_orders.payableStatuses
  if (order.status === "failed" || !payable.includes(order.payment_status)) {
    throw new Error(`results_checker_orders ${orderId} not in a payable state: ${order.status}/${order.payment_status}`)
  }

  const { data: marked, error: markErr } = await supabase
    .from("results_checker_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) throw new Error(`results_checker_orders ${orderId} not in a payable state (lost the mark)`)

  const { fulfillPaidResultsCheckerOrder } = await import("@/lib/results-checker-service")
  const result = await fulfillPaidResultsCheckerOrder(orderId)
  if (result.status === "pending") {
    throw new Error(`results_checker_orders ${orderId} paid but out of stock: deliver the vouchers manually`)
  }
  if (!result.success) throw new Error(`results_checker_orders ${orderId} fulfilment failed: ${result.message}`)
}
```

- [ ] **Step 10: Run the whole Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 11: Commit**

```bash
git add lib/ussd-hubtel/flows/rc-buy.ts lib/ussd-hubtel/flows/rc-buy.test.ts lib/ussd-hubtel/services.ts lib/ussd-hubtel/services.test.ts lib/ussd-hubtel/types.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/testing/fakes.ts lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/order-handlers.ts lib/ussd-hubtel/order-handlers.test.ts
git commit -m "feat(hubtel): Results Checker buy vouchers, my vouchers, and results_checker_orders handler"
```

---

### Task 4: "Check Results" on-behalf service + `results_check_requests` handler

Port of the Results Check Service half of `lib/ussd/handlers/results-checker.ts` (lines 423-916, USSD channel only) minus wallet, Paystack and OTP. Datagod checks the customer's results; the request goes to the existing admin queue (`/admin/results-check-requests`) after payment, and results are delivered later by SMS and to the WhatsApp number the caller gives.

Business gating kept from Uzo (+ D10): service enabled (`results_check_settings.enabled !== false`); fee = `results_check_settings.fee` if a number, else 2.00; registered account required (entry and confirm); two modes: **combo** (buy one voucher + check, total = round2(single-voucher unit price without bulk + fee), offered only when the board is enabled and in stock) and **own voucher** (check fee only; PIN/serial validated per board); index number, exam year (1980..current) and date of birth validated with the shared pure validators; WhatsApp number mandatory. At "1": settings, account, combo stock and the amount are re-verified.

Step transitions:

| Step | Input | Next |
|---|---|---|
| RC_MENU | `3` | disabled ⇒ same, "Service not available."; no account ⇒ release; else RC_CHECK_BOARD |
| RC_CHECK_BOARD | `0` | RC_MENU |
| | `1`/`2`/`3` (WASSCE/BECE/NOVDEC) | RC_CHECK_CANDIDATE_TYPE (fee + combo total computed) |
| RC_CHECK_CANDIDATE_TYPE | `0` | RC_CHECK_BOARD |
| | `1`/`2` (School/Private) | combo offered ⇒ RC_CHECK_MODE; else RC_CHECK_VOUCHER ("No vouchers in stock") |
| RC_CHECK_MODE | `0` | RC_CHECK_CANDIDATE_TYPE |
| | `1` | combo ⇒ RC_CHECK_INDEX |
| | `2` | own voucher ⇒ RC_CHECK_VOUCHER |
| RC_CHECK_VOUCHER | `0` | RC_CHECK_MODE if combo offered, else RC_CHECK_CANDIDATE_TYPE |
| | valid `PIN/Serial` for the board | RC_CHECK_INDEX |
| RC_CHECK_INDEX | `0` | RC_CHECK_VOUCHER (own) or RC_CHECK_MODE (combo) |
| | valid index | RC_CHECK_YEAR |
| RC_CHECK_YEAR | `0` | RC_CHECK_INDEX |
| | 4-digit year 1980..current | RC_CHECK_DOB |
| RC_CHECK_DOB | `0` | RC_CHECK_YEAR |
| | valid past date (`-` accepted for `/`) | RC_CHECK_WA_NUMBER (phone field) |
| RC_CHECK_WA_NUMBER | `0` | RC_CHECK_DOB |
| | `0[2345]XXXXXXXX` after `toLocalPhone` | RC_CHECK_CONFIRM |
| RC_CHECK_CONFIRM | `2` | release "Order cancelled." |
| | `1` | replay guard; re-verify; `submitOrder` |

**Files:**
- Create: `lib/ussd-hubtel/flows/rc-check.ts`, `lib/ussd-hubtel/flows/rc-check.test.ts`
- Modify: `lib/ussd-hubtel/services.ts` (`RcServices.checkSettings` + default), `lib/ussd-hubtel/testing/fakes.ts` (`fakeRc` default)
- Modify: `lib/ussd-hubtel/types.ts`, `lib/ussd-hubtel/menus.ts` (`rcMenuText` option 3), `lib/ussd-hubtel/flows/rc-buy.ts` (`rcMenu` case 3), `lib/ussd-hubtel/router.ts`
- Modify: `lib/ussd-hubtel/order-tables.ts` (+ `results_check_requests`), `lib/ussd-hubtel/order-tables.test.ts`
- Modify: `lib/ussd-hubtel/order-handlers.ts` (+ handler), `lib/ussd-hubtel/order-handlers.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 kit; Task 2 `resolveDialer`; Task 3 `RcServices` (`isBoardEnabled`, `availableCount`, `price`), `rcMenuText`, `RC_BUY_STEPS`; `isValidDob`, `isValidExamYear`, `isValidIndexNumber`, `isValidVoucherPin`, `isValidVoucherSerial`, `ExamBoard` (`lib/results-check-validation.ts`); `fulfillPaidResultsCheckRequest(requestId) => Promise<{ success: boolean; status: "paid" | "already_paid" | "not_found"; message: string }>` (`lib/results-checker-service.ts`; it marks paid, assigns a combo voucher, notifies admins, SMSes `phone_number` and WhatsApps `whatsapp_number`).
- Produces: `RcServices.checkSettings(): Promise<{ enabled: boolean; fee: number }>`; `flows/rc-check.ts`: `startRcCheck(ctx)`, `RC_CHECK_STEPS: StepTable`, text builders; `HubtelOrderTable` includes `"results_check_requests"`; `createOrderHandlers(...).results_check_requests`.

- [ ] **Step 1: Steps and session fields**

Append to the `HubtelStep` union in `lib/ussd-hubtel/types.ts`:

```ts
  | "RC_CHECK_BOARD" | "RC_CHECK_CANDIDATE_TYPE" | "RC_CHECK_MODE" | "RC_CHECK_VOUCHER" | "RC_CHECK_INDEX"
  | "RC_CHECK_YEAR" | "RC_CHECK_DOB" | "RC_CHECK_WA_NUMBER" | "RC_CHECK_CONFIRM"
```

and add inside `interface HubtelSession` after the results-checker fields:

```ts
  // Results check service (Datagod checks results on the caller's behalf)
  rcCheckBoard?: string // WASSCE | BECE | NOVDEC
  rcCheckCandidateType?: "school" | "private"
  rcCheckMode?: "combo" | "own_voucher"
  rcCheckVoucherPin?: string
  rcCheckVoucherSerial?: string
  rcCheckIndex?: string
  rcCheckYear?: number
  rcCheckDob?: string // DD/MM/YYYY
  rcCheckWaNumber?: string // local 0XXXXXXXXX
  rcCheckFee?: number // check-only fee
  rcCheckComboTotal?: number // one voucher + fee; undefined when combo is not offered
```

- [ ] **Step 2: Check settings service, fake default and menu option 3**

In `lib/ussd-hubtel/services.ts` add to `interface RcServices`:

```ts
  /** results_check_settings. A read error throws (the interaction route answers "Service unavailable"). */
  checkSettings(): Promise<{ enabled: boolean; fee: number }>
```

and to the object returned by `defaultRcServices`:

```ts
    checkSettings: async () => {
      const { data, error } = await supabase.from("admin_settings").select("value").eq("key", "results_check_settings").maybeSingle()
      if (error) throw error
      const v = (data?.value ?? null) as { enabled?: unknown; fee?: unknown } | null
      // Same defaults as Uzo's getRcCheckSettings: enabled unless explicitly false; fee 2.00 unless a number.
      return { enabled: v?.enabled !== false, fee: typeof v?.fee === "number" ? v.fee : 2.0 }
    },
```

In `lib/ussd-hubtel/testing/fakes.ts`, inside `fakeRc`'s returned object before `...over`, add `checkSettings: async () => ({ enabled: true, fee: 2 }),`.

In `lib/ussd-hubtel/menus.ts` replace `rcMenuText` with:

```ts
/** Results Checker sub-menu. */
export function rcMenuText(): string {
  return "Results Checker\n1. Buy Vouchers\n2. My Vouchers\n3. Check Results\n0. Back"
}
```

- [ ] **Step 3: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/rc-check.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"
import type { HubtelReply } from "../types"

const member = { resolveDialer: async () => ({ userId: "u1" }) }

async function toCheck(deps: RouterDeps) {
  const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
  return hubtelRouter(req({ Message: "3" }), deps)
}
async function send(deps: RouterDeps, inputs: string[]): Promise<HubtelReply> {
  let r: HubtelReply | undefined
  for (const m of inputs) r = await hubtelRouter(req({ Message: m }), deps)
  return r!
}
// WASSCE, School, combo, index, year, DOB, WhatsApp
const COMBO = ["1", "1", "1", "0070202043", "2024", "15/06/2008", "0244123456"]
// WASSCE, Private, (no stock: no mode menu) PIN/serial, index, year, DOB, WhatsApp
const OWN_NO_STOCK = ["1", "2", "012345678912/WGR1900112581", "0070202043", "2024", "15/06/2008", "0244123456"]

describe("check results: entry gates", () => {
  it("option 3 opens the exam board menu for a registered caller", async () => {
    const { deps, store } = makeDeps(member)
    const r = await toCheck(deps)
    expect(r.Message).toContain("1. WASSCE\n2. BECE\n3. NOVDEC")
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_BOARD", userId: "u1" })
  })
  it("disabled service: stays on the RC menu", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled: false, fee: 2 }) }) })
    const r = await toCheck(deps)
    expect(r.Message).toContain("Service not available.")
    expect(store.get("S1")?.step).toBe("RC_MENU")
  })
  it("caller without a Datagod account is told to register (Uzo gate kept)", async () => {
    const { deps } = makeDeps()
    const r = await toCheck(deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("create a Datagod account")
  })
})

describe("check results: combo (voucher + check)", () => {
  it("mode menu shows combo total (unit price + fee) and the check fee", async () => {
    const { deps } = makeDeps(member)
    await toCheck(deps)
    const r = await send(deps, ["1", "1"])
    expect(r.Message).toContain("1. Buy voucher + check\n   GHS 22.00")
    expect(r.Message).toContain("2. I have a voucher\n   GHS 2.00")
  })
  it("full walk: confirm, then AddToCart at the combo total with the request columns", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    const confirm = await send(deps, COMBO)
    expect(confirm.Message).toContain("WASSCE (School)")
    expect(confirm.Message).toContain("Index 0070202043 Year 2024")
    expect(confirm.Message).toContain("Voucher + check")
    expect(confirm.Message).toContain("GHS 22.00 from 0200585542")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Voucher + Results Check", Qty: 1, Price: 22 })
    const row = sup.inserts["results_check_requests"][0]
    expect(row).toMatchObject({
      phone_number: "0200585542", exam_board: "WASSCE", candidate_type: "school", index_number: "0070202043",
      dob: "15/06/2008", exam_year: 2024, fee: 22, payment_status: "pending_payment", status: "pending",
      channel: "ussd", user_id: "u1", mode: "combo", voucher_pin: null, voucher_serial: null, whatsapp_number: "0244123456",
    })
    expect(row.payment_reference).toMatch(/^RCK-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_check_requests", order_id: NEW_ID, expected_amount: 22 })
  })
  it("combo is not offered for a board that is disabled for voucher sales", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ isBoardEnabled: async () => false }) })
    await toCheck(deps)
    const r = await send(deps, ["1", "1"])
    expect(r.Message).toContain("No vouchers in stock.")
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_VOUCHER", rcCheckMode: "own_voucher" })
  })
  it("combo voucher sold out since the confirm screen: release, no request (review focus #2)", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("sold out")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
  it("fee changed since the confirm screen: release, no request", async () => {
    let fee = 2
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ checkSettings: async () => ({ enabled: true, fee }) }) }, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    fee = 3
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 23.00")
    expect(sup.inserts["results_check_requests"]).toBeUndefined()
  })
})

describe("check results: own voucher", () => {
  it("no stock: skips the mode menu, validates PIN/serial, AddToCart at the check fee", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0 }) }, sup)
    await toCheck(deps)
    const prompt = await send(deps, ["1", "2"])
    expect(prompt.Message).toContain("No vouchers in stock.")
    const bad = await hubtelRouter(req({ Message: "12345/ABC" }), deps)
    expect(bad.Message).toContain("Invalid PIN or serial.")
    const confirm = await send(deps, OWN_NO_STOCK.slice(2))
    expect(confirm.Message).toContain("PIN 012345678912")
    expect(confirm.Message).toContain("GHS 2.00 from 0200585542")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Item).toEqual({ ItemName: "WASSCE Results Check", Qty: 1, Price: 2 })
    expect(sup.inserts["results_check_requests"][0]).toMatchObject({
      candidate_type: "private", mode: "own_voucher", fee: 2, voucher_pin: "012345678912", voucher_serial: "WGR1900112581",
    })
  })
  it("BECE: alphanumeric PIN with numeric serial is accepted", async () => {
    const { deps, store } = makeDeps({ ...member, rc: fakeRc({ availableCount: async () => 0 }) })
    await toCheck(deps)
    await send(deps, ["2", "1", "5fbr336742d4/252100270719"])
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_INDEX", rcCheckVoucherPin: "5FBR336742D4", rcCheckVoucherSerial: "252100270719" })
  })
})

describe("check results: field validation keeps the step", () => {
  async function at(step: "index" | "year" | "dob" | "wa", board = "1") {
    const { deps, store } = makeDeps(member)
    await toCheck(deps)
    const path = [board, "1", "1"]
    if (step !== "index") path.push(board === "2" ? "007020204312" : "0070202043")
    if (step === "dob" || step === "wa") path.push("2024")
    if (step === "wa") path.push("15/06/2008")
    await send(deps, path)
    return { deps, store }
  }
  it("WASSCE index must be exactly 10 digits", async () => {
    const { deps, store } = await at("index")
    const r = await hubtelRouter(req({ Message: "007020204312" }), deps)
    expect(r.Message).toContain("Invalid index number.")
    expect(store.get("S1")?.step).toBe("RC_CHECK_INDEX")
  })
  it("BECE index may be 12 digits", async () => {
    const { deps, store } = await at("index", "2")
    await hubtelRouter(req({ Message: "007020204312" }), deps)
    expect(store.get("S1")?.step).toBe("RC_CHECK_YEAR")
  })
  for (const year of ["1979", String(new Date().getFullYear() + 1), "24"]) {
    it(`rejects exam year ${year}`, async () => {
      const { deps, store } = await at("year")
      const r = await hubtelRouter(req({ Message: year }), deps)
      expect(r.Message).toContain("Invalid year.")
      expect(store.get("S1")?.step).toBe("RC_CHECK_YEAR")
    })
  }
  it("rejects an impossible date and accepts dashes", async () => {
    const { deps, store } = await at("dob")
    const r = await hubtelRouter(req({ Message: "31/02/2008" }), deps)
    expect(r.Message).toContain("Invalid date.")
    await hubtelRouter(req({ Message: "15-06-2008" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "RC_CHECK_WA_NUMBER", rcCheckDob: "15/06/2008" })
  })
  it("WhatsApp number is mandatory, phone-typed, and '0' goes back", async () => {
    const { deps, store } = await at("wa")
    const bad = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(bad.Message).toContain("Invalid number.")
    expect(bad.FieldType).toBe("phone")
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("RC_CHECK_DOB")
  })
})

describe("check results: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "results_check_requests", order_id: "o-winner", expected_amount: 22, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE request + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_check_requests"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan request failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps(member, sup)
    await toCheck(deps)
    await send(deps, COMBO)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Item).toEqual({ ItemName: "WASSCE Voucher + Results Check", Qty: 1, Price: 22 })
    expect(sup.updates.some(u => u.table === "results_check_requests" && u.patch.status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/rc-check.test.ts`
Expected: FAIL: option 3 is listed but `rcMenu` has no case for it yet, so `expected 'Results Checker…' to contain '1. WASSCE\n2. BECE\n3. NOVDEC'`.

- [ ] **Step 5: Write the flow**

```ts
// lib/ussd-hubtel/flows/rc-check.ts
// "Check Results" on the Hubtel channel: Datagod checks exam results on the caller's behalf.
// Port of lib/ussd/handlers/results-checker.ts lines 423-916 (USSD channel) minus wallet,
// Paystack and OTP. After payment the request joins the admin queue (/admin/results-check-requests).
import { secureReference } from "@/lib/secure-random"
import {
  isValidDob, isValidExamYear, isValidIndexNumber, isValidVoucherPin, isValidVoucherSerial, type ExamBoard,
} from "@/lib/results-check-validation"
import { rcMenuText } from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelSession } from "../types"

const CHECK_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]
const round2 = (n: number) => Math.round(n * 100) / 100
const ACCOUNT_REQUIRED = "Please create a Datagod account\nwith this number to use\nthis service."

const MENU = { label: "Results Checker" }
const BOARD = { label: "Select exam" }
const TYPE = { label: "Candidate type" }
const MODE = { label: "How to pay" }
const VOUCHER = { label: "Voucher PIN/Serial", fieldType: "text" as const }
const INDEX = { label: "Index number", fieldType: "number" as const }
const YEAR = { label: "Exam year", fieldType: "number" as const }
const DOB = { label: "Date of birth", fieldType: "text" as const }
const WA = { label: "WhatsApp number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm results check" }

export function rcCheckBoardMenuText(): string {
  return "Check Results\nSelect exam:\n" + CHECK_BOARDS.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}
export function rcCheckCandidateTypeText(): string {
  return "Candidate type:\n1. School\n2. Private\n0. Back"
}
export function rcCheckModeText(comboTotal: number, fee: number): string {
  return `Check Results\n1. Buy voucher + check\n   GHS ${comboTotal.toFixed(2)}\n2. I have a voucher\n   GHS ${fee.toFixed(2)}\n0. Back`
}
export function rcCheckVoucherPromptText(board: string): string {
  const eg = board === "BECE" ? "5FBR336742D4/252100270719" : "012345678912/WGR1900112581"
  return `Enter voucher PIN and\nserial as PIN/Serial\ne.g. ${eg}\n0. Back`
}
function invalidVoucherText(board: string): string {
  return board === "BECE"
    ? "Invalid PIN or serial.\nPIN: 10-12 letters/digits\nSerial: digits e.g. 252100270719\nFormat: PIN/Serial\n0. Back"
    : "Invalid PIN or serial.\nPIN: 12 digits\nSerial: e.g. WGR1900112581\nFormat: PIN/Serial\n0. Back"
}
export function rcCheckIndexPromptText(board: string): string {
  return `Enter index number\n(${board === "BECE" ? "10 or 12" : "10"} digits)\ne.g. 0070202043\n0. Back`
}
export function rcCheckYearPromptText(): string {
  return "Enter exam year\n(e.g. 2024):\n0. Back"
}
export function rcCheckDobPromptText(): string {
  return "Enter date of birth\n(DD/MM/YYYY)\ne.g. 15/06/2008\n0. Back"
}
export function rcCheckWaPromptText(): string {
  return "Enter WhatsApp number\nto receive your results\n(e.g. 0244123456):\n0. Back"
}
export function rcCheckConfirmText(a: {
  board: string; candidateType: "school" | "private"; index: string; year: number; dob: string
  mode: "combo" | "own_voucher"; pin?: string; amount: number; payerLocal: string
}): string {
  const who = a.candidateType === "school" ? "School" : "Private"
  const detail = a.mode === "combo" ? "Voucher + check" : `PIN ${a.pin ?? ""}`
  return (
    `Check Results\n${a.board} (${who})\nIndex ${a.index} Year ${a.year}\nDOB ${a.dob}\n${detail}\n` +
    `GHS ${a.amount.toFixed(2)} from ${a.payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const sessionAmount = (s: HubtelSession): number => (s.rcCheckMode === "combo" ? s.rcCheckComboTotal! : s.rcCheckFee!)

function confirmText(s: HubtelSession): string {
  return rcCheckConfirmText({
    board: s.rcCheckBoard!, candidateType: s.rcCheckCandidateType ?? "school", index: s.rcCheckIndex!, year: s.rcCheckYear!,
    dob: s.rcCheckDob!, mode: s.rcCheckMode ?? "own_voucher", pin: s.rcCheckVoucherPin, amount: sessionAmount(s),
    payerLocal: toLocalPhone(s.dialingPhone),
  })
}

/** Combo = one voucher (single, no bulk) + the check fee; only for a board that is enabled and in stock. */
async function comboTotalFor(ctx: FlowCtx, board: ExamBoard, fee: number): Promise<number | undefined> {
  const [enabled, available] = await Promise.all([ctx.deps.rc.isBoardEnabled(board), ctx.deps.rc.availableCount(board)])
  if (!enabled || available < 1) return undefined
  const { unitPrice } = await ctx.deps.rc.price(board, 1, false)
  return round2(unitPrice + fee)
}

export async function startRcCheck(ctx: FlowCtx): Promise<HubtelReply> {
  const settings = await ctx.deps.rc.checkSettings()
  if (!settings.enabled) return say(ctx, "Service not available.\n" + rcMenuText(), "RC_MENU", MENU)
  const dialer = await ctx.deps.resolveDialer(ctx.session.dialingPhone)
  if (!dialer.userId) return finish(ctx, ACCOUNT_REQUIRED)
  return goto(ctx, { step: "RC_CHECK_BOARD", userId: dialer.userId }, rcCheckBoardMenuText(), BOARD)
}

const toBoard = (ctx: FlowCtx) => goto(ctx, { step: "RC_CHECK_BOARD" }, rcCheckBoardMenuText(), BOARD)
const toType = (ctx: FlowCtx) => goto(ctx, { step: "RC_CHECK_CANDIDATE_TYPE" }, rcCheckCandidateTypeText(), TYPE)
const toMode = (ctx: FlowCtx) =>
  goto(ctx, { step: "RC_CHECK_MODE" }, rcCheckModeText(ctx.session.rcCheckComboTotal!, ctx.session.rcCheckFee!), MODE)
const toVoucher = (ctx: FlowCtx, prefix = "") =>
  goto(ctx, { step: "RC_CHECK_VOUCHER", rcCheckMode: "own_voucher" }, prefix + rcCheckVoucherPromptText(ctx.session.rcCheckBoard!), VOUCHER)

async function checkBoard(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_MENU" }, rcMenuText(), MENU)
  const board = /^\d$/.test(ctx.input) ? CHECK_BOARDS[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, rcCheckBoardMenuText(), "RC_CHECK_BOARD", BOARD)
  const settings = await ctx.deps.rc.checkSettings()
  const comboTotal = await comboTotalFor(ctx, board, settings.fee)
  return goto(ctx, {
    step: "RC_CHECK_CANDIDATE_TYPE", rcCheckBoard: board, rcCheckFee: settings.fee, rcCheckComboTotal: comboTotal,
    rcCheckMode: undefined, rcCheckVoucherPin: undefined, rcCheckVoucherSerial: undefined,
  }, rcCheckCandidateTypeText(), TYPE)
}

async function candidateType(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toBoard(ctx)
  if (ctx.input !== "1" && ctx.input !== "2") return say(ctx, rcCheckCandidateTypeText(), "RC_CHECK_CANDIDATE_TYPE", TYPE)
  const t = ctx.input === "1" ? "school" : "private"
  if (s.rcCheckComboTotal !== undefined) {
    return goto(ctx, { step: "RC_CHECK_MODE", rcCheckCandidateType: t }, rcCheckModeText(s.rcCheckComboTotal, s.rcCheckFee!), MODE)
  }
  return goto(ctx, { step: "RC_CHECK_VOUCHER", rcCheckCandidateType: t, rcCheckMode: "own_voucher" },
    "No vouchers in stock.\nUse your own voucher.\n" + rcCheckVoucherPromptText(s.rcCheckBoard!), VOUCHER)
}

async function mode(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return toType(ctx)
  if (ctx.input === "1") {
    return goto(ctx, { step: "RC_CHECK_INDEX", rcCheckMode: "combo", rcCheckVoucherPin: undefined, rcCheckVoucherSerial: undefined },
      rcCheckIndexPromptText(s.rcCheckBoard!), INDEX)
  }
  if (ctx.input === "2") return toVoucher(ctx)
  return say(ctx, rcCheckModeText(s.rcCheckComboTotal!, s.rcCheckFee!), "RC_CHECK_MODE", MODE)
}

async function voucher(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const board = s.rcCheckBoard as ExamBoard
  if (ctx.input === "0") return s.rcCheckComboTotal !== undefined ? toMode(ctx) : toType(ctx)
  // Accept "PIN/Serial", "PIN Serial" or "PIN,Serial" (Uzo format), case-insensitive.
  const [pin = "", serial = ""] = ctx.input.toUpperCase().split(/[\/,\s]+/)
  if (!isValidVoucherPin(board, pin) || !isValidVoucherSerial(board, serial)) {
    return say(ctx, invalidVoucherText(board), "RC_CHECK_VOUCHER", VOUCHER)
  }
  return goto(ctx, { step: "RC_CHECK_INDEX", rcCheckVoucherPin: pin, rcCheckVoucherSerial: serial }, rcCheckIndexPromptText(board), INDEX)
}

async function index(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  const board = s.rcCheckBoard as ExamBoard
  if (ctx.input === "0") return s.rcCheckMode === "own_voucher" ? toVoucher(ctx) : toMode(ctx)
  const idx = ctx.input.replace(/\s/g, "")
  if (!isValidIndexNumber(board, idx)) return say(ctx, "Invalid index number.\n" + rcCheckIndexPromptText(board), "RC_CHECK_INDEX", INDEX)
  return goto(ctx, { step: "RC_CHECK_YEAR", rcCheckIndex: idx }, rcCheckYearPromptText(), YEAR)
}

async function year(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_INDEX" }, rcCheckIndexPromptText(ctx.session.rcCheckBoard!), INDEX)
  const y = /^\d{4}$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!isValidExamYear(y)) {
    return say(ctx, `Invalid year.\nEnter a year from 1980\nto ${new Date().getFullYear()}.\n0. Back`, "RC_CHECK_YEAR", YEAR)
  }
  return goto(ctx, { step: "RC_CHECK_DOB", rcCheckYear: y }, rcCheckDobPromptText(), DOB)
}

async function dob(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_YEAR" }, rcCheckYearPromptText(), YEAR)
  const normalised = ctx.input.replace(/-/g, "/")
  if (!isValidDob(normalised)) return say(ctx, "Invalid date.\nUse DD/MM/YYYY\ne.g. 15/06/2008\n0. Back", "RC_CHECK_DOB", DOB)
  return goto(ctx, { step: "RC_CHECK_WA_NUMBER", rcCheckDob: normalised }, rcCheckWaPromptText(), WA)
}

async function waNumber(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "RC_CHECK_DOB" }, rcCheckDobPromptText(), DOB)
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  // Mandatory: results (incl. image/PDF) are delivered to this WhatsApp number.
  if (!/^0[2345]\d{8}$/.test(local)) return say(ctx, "Invalid number.\n" + rcCheckWaPromptText(), "RC_CHECK_WA_NUMBER", WA)
  const next: HubtelSession = { ...ctx.session, rcCheckWaNumber: local }
  return goto(ctx, { step: "RC_CHECK_CONFIRM", rcCheckWaNumber: local }, confirmText(next), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session: s } = ctx
  const board = s.rcCheckBoard as ExamBoard
  const mode = s.rcCheckMode ?? "own_voucher"
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") return say(ctx, confirmText(s), "RC_CHECK_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Re-verify everything that sets the price or gates the service.
  const settings = await deps.rc.checkSettings()
  if (!settings.enabled) return finish(ctx, "Results check is not available right now.")
  const dialer = await deps.resolveDialer(s.dialingPhone)
  if (!dialer.userId) return finish(ctx, ACCOUNT_REQUIRED)
  let amount = settings.fee
  if (mode === "combo") {
    const combo = await comboTotalFor(ctx, board, settings.fee)
    if (combo === undefined) return finish(ctx, `${board} vouchers are sold out.\nPlease restart and use\nyour own voucher.`)
    amount = combo
  }
  if (Math.abs(amount - sessionAmount(s)) > 0.001) {
    return finish(ctx, `Price changed to GHS ${amount.toFixed(2)}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "results_check_requests",
    price: amount,
    logTag: "HUBTEL-RC-CHECK",
    row: {
      phone_number: toLocalPhone(s.dialingPhone), // payment confirmation + SMS results go here
      exam_board: board,
      candidate_type: s.rcCheckCandidateType ?? "school",
      index_number: s.rcCheckIndex,
      dob: s.rcCheckDob ?? null,
      exam_year: s.rcCheckYear,
      fee: amount, // our price; Hubtel adds its own charge on top, at Hubtel
      payment_status: "pending_payment",
      status: "pending",
      channel: "ussd",
      user_id: dialer.userId,
      payment_reference: secureReference("RCK", 2, 3),
      mode,
      voucher_pin: mode === "own_voucher" ? (s.rcCheckVoucherPin ?? null) : null,
      voucher_serial: mode === "own_voucher" ? (s.rcCheckVoucherSerial ?? null) : null,
      whatsapp_number: s.rcCheckWaNumber ?? null,
    },
  })
}

export const RC_CHECK_STEPS: StepTable = {
  RC_CHECK_BOARD: checkBoard,
  RC_CHECK_CANDIDATE_TYPE: candidateType,
  RC_CHECK_MODE: mode,
  RC_CHECK_VOUCHER: voucher,
  RC_CHECK_INDEX: index,
  RC_CHECK_YEAR: year,
  RC_CHECK_DOB: dob,
  RC_CHECK_WA_NUMBER: waNumber,
  RC_CHECK_CONFIRM: confirm,
}
```

- [ ] **Step 6: Wire option 3, the table and the router**

In `lib/ussd-hubtel/flows/rc-buy.ts` add `import { startRcCheck } from "./rc-check"` and, in `rcMenu`, add a case before `default:`:

```ts
    case "3":
      return startRcCheck(ctx)
```

In `lib/ussd-hubtel/order-tables.ts` the union becomes `export type HubtelOrderTable = "ussd_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests"`; add:

```ts
  results_check_requests: {
    payableStatuses: ["pending_payment", "otp_required"],
    failPatch: () => ({ status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "exam_board, mode",
    cartItemName: r => (r.mode === "combo" ? `${r.exam_board} Voucher + Results Check` : `${r.exam_board} Results Check`),
  },
```

Append to `lib/ussd-hubtel/order-tables.test.ts` inside the describe:

```ts
  it("results_check_requests: payable statuses, fail patch and item names", () => {
    const s = ORDER_TABLES.results_check_requests
    expect(s.payableStatuses).toEqual(["pending_payment", "otp_required"])
    expect(s.failPatch()).toMatchObject({ status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ exam_board: "BECE", mode: "combo" })).toBe("BECE Voucher + Results Check")
    expect(s.cartItemName({ exam_board: "BECE", mode: "own_voucher" })).toBe("BECE Results Check")
  })
```

In `lib/ussd-hubtel/router.ts` add `import { RC_CHECK_STEPS } from "./flows/rc-check"` and `...RC_CHECK_STEPS,` to `STEPS` (the entry is the RC menu's option 3, not a main-menu key).

- [ ] **Step 7: Run the flow tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/rc-check.test.ts lib/ussd-hubtel/flows/rc-buy.test.ts lib/ussd-hubtel/order-tables.test.ts`
Expected: PASS.

- [ ] **Step 8: Append the failing handler tests**

Append to `lib/ussd-hubtel/order-handlers.test.ts`:

```ts
describe("results_check_requests post-payment handler", () => {
  const paid = { success: true, status: "paid", message: "Payment confirmed" }

  it("failed request (late payment after expiry) → throws, never marked paid (review focus #5)", async () => {
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "failed", status: "failed", mode: "own_voucher" } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/not in a payable state/)
    expect(fulfillPaidResultsCheckRequest).not.toHaveBeenCalled()
  })
  it("pending own-voucher request → fulfillPaidResultsCheckRequest once", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue(paid)
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "own_voucher" } })
    await createOrderHandlers(client).results_check_requests("q1")
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckRequest).toHaveBeenCalledWith("q1")
  })
  it("combo with a voucher assigned → ok", async () => {
    const row: any = { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null }
    fulfillPaidResultsCheckRequest.mockImplementation(async () => { row.voucher_pin = "123456789012"; return paid })
    const { client } = fakeDb({ results_check_requests: row })
    await createOrderHandlers(client).results_check_requests("q1")
  })
  it("combo paid but no voucher in stock → throws so the row lands in needs_review (review focus #2)", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue(paid)
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "combo", voucher_pin: null } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/no voucher/)
  })
  it("already paid → no-op", async () => {
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "paid", status: "pending", mode: "own_voucher" } })
    await createOrderHandlers(client).results_check_requests("q1")
    expect(fulfillPaidResultsCheckRequest).not.toHaveBeenCalled()
  })
  it("library reports not_found → throws", async () => {
    fulfillPaidResultsCheckRequest.mockResolvedValue({ success: false, status: "not_found", message: "Results check request not found" })
    const { client } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment", status: "pending", mode: "own_voucher" } })
    await expect(createOrderHandlers(client).results_check_requests("q1")).rejects.toThrow(/not marked paid/)
  })
  it("fail handler fails only an unpaid request", async () => {
    const { client, log } = fakeDb({ results_check_requests: { id: "q1", payment_status: "pending_payment" } })
    await createFailHandlers(client).results_check_requests("q1")
    expect(log[0]).toMatchObject({ patch: { status: "failed", payment_status: "failed" }, inVals: ["pending_payment", "otp_required"] })
  })
})
```

Run: `npx vitest run lib/ussd-hubtel/order-handlers.test.ts`
Expected: FAIL in the new describe with `createOrderHandlers(...).results_check_requests is not a function`.

- [ ] **Step 9: Add the handler**

In `lib/ussd-hubtel/order-handlers.ts` add above `createOrderHandlers`, and register `results_check_requests: orderId => checkRequestPostPayment(supabase, orderId),`:

```ts
/**
 * Post-payment for a "Check Results" request. Uses fulfillPaidResultsCheckRequest (the storefront
 * path): marks paid, assigns the combo voucher, notifies admins, SMSes the caller and WhatsApps the
 * number they gave — which suits USSD callers better than the Paystack WhatsApp-bot branch (that one
 * WhatsApps phone_number only). It is its own idempotency gate (payment_status 'paid'), so it is
 * called after a read-check; once-only comes from processFulfillment's claim on this request's
 * single tx row. A combo paid with no voucher left in stock throws ⇒ needs_review.
 */
async function checkRequestPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: request, error: lookupErr } = await supabase
    .from("results_check_requests")
    .select("id, payment_status, status, mode")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] results_check_requests lookup failed:", orderId, lookupErr)
  if (!request) throw new Error(`results_check_requests ${orderId} not found`)
  if (request.payment_status === "paid") return // already processed
  const payable = ORDER_TABLES.results_check_requests.payableStatuses
  if (request.status === "failed" || !payable.includes(request.payment_status)) {
    throw new Error(`results_check_requests ${orderId} not in a payable state: ${request.status}/${request.payment_status}`)
  }

  const { fulfillPaidResultsCheckRequest } = await import("@/lib/results-checker-service")
  const result = await fulfillPaidResultsCheckRequest(orderId)
  if (!result.success) throw new Error(`results_check_requests ${orderId} not marked paid: ${result.message}`)

  if (request.mode === "combo") {
    const { data: after } = await supabase.from("results_check_requests").select("id, voucher_pin").eq("id", orderId).maybeSingle()
    if (!after?.voucher_pin) {
      throw new Error(`results_check_requests ${orderId} paid (combo) but no voucher was in stock: assign one manually`)
    }
  }
}
```

- [ ] **Step 10: Run the whole Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 11: Commit**

```bash
git add lib/ussd-hubtel/flows/rc-check.ts lib/ussd-hubtel/flows/rc-check.test.ts lib/ussd-hubtel/flows/rc-buy.ts lib/ussd-hubtel/services.ts lib/ussd-hubtel/testing/fakes.ts lib/ussd-hubtel/types.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/order-handlers.ts lib/ussd-hubtel/order-handlers.test.ts
git commit -m "feat(hubtel): Check Results service flow and results_check_requests handler"
```

---

### Task 5: AFA Registration flow + `ussd_afa_orders` handler

Port of `lib/ussd/handlers/afa.ts` minus Paystack, with D9: MTN dialer required, canonical price row, NO Paystack fee in `amount`, stricter name check. The Ghana Card number is normalised with `parseGhanaCardNumber` before any money moves (same rule as Uzo and `submitAfaOrder`); `fulfillUssdAfaOrder` re-validates it at fulfilment. The registration contact is the dialing number (`dialing_phone`, E.164 like Uzo's `msisdn`).

Step transitions:

| Step | Input | Next |
|---|---|---|
| MAIN | "AFA Registration" digit | dialer not MTN (live prefix map) ⇒ release; else AFA_ENTER_NAME |
| AFA_ENTER_NAME | `0` | MAIN |
| | 3-100 chars, starts with a letter, only letters / space / `.` `'` `-` | AFA_ENTER_CARD |
| AFA_ENTER_CARD | `0` | AFA_ENTER_NAME |
| | `parseGhanaCardNumber` ok | AFA_ENTER_LOCATION (stores the normalised `GHA-XXXXXXXXX-X`) |
| AFA_ENTER_LOCATION | `0` | AFA_ENTER_CARD |
| | 2-100 chars | AFA_ENTER_REGION |
| AFA_ENTER_REGION | `0` | AFA_ENTER_LOCATION |
| | 2-100 chars, price available | AFA_CONFIRM |
| | price unavailable | release |
| AFA_CONFIRM | `2` | release "Registration cancelled." |
| | `1` | replay guard; re-read price; `submitOrder` |

**Files:**
- Create: `lib/ussd-hubtel/flows/afa.ts`, `lib/ussd-hubtel/flows/afa.test.ts`
- Modify: `lib/ussd-hubtel/services.ts` (+ `AfaServices`, `defaultAfaServices`), `lib/ussd-hubtel/services.test.ts` (append)
- Modify: `lib/ussd-hubtel/types.ts`, `lib/ussd-hubtel/menus.ts` (flip `afa`), `lib/ussd-hubtel/flow-kit.ts` (`RouterDeps.afa`), `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/testing/fakes.ts` (`fakeAfa`)
- Modify: `lib/ussd-hubtel/order-tables.ts` (+ `ussd_afa_orders`), `lib/ussd-hubtel/order-tables.test.ts`
- Modify: `lib/ussd-hubtel/order-handlers.ts` (+ handler), `lib/ussd-hubtel/order-handlers.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 kit; `parseGhanaCardNumber(raw) => string | null` (`lib/ghana-card.ts`); `validateNetworkPrefix` (`lib/phone-format.ts`); `fulfillUssdAfaOrder(orderId) => Promise<{ success: boolean; message: string }>` (`lib/ussd/fulfill-afa.ts`); `SMSTemplates.ussdAfaPaymentReceived()`.
- Produces: `services.ts`: `interface AfaServices { getPrice(): Promise<number | null> }`, `defaultAfaServices(supabase): AfaServices`, `getAfaPrice(supabase): Promise<number | null>`; `RouterDeps.afa: AfaServices`; `fakeAfa(over?)`; `flows/afa.ts`: `startAfa(ctx)`, `AFA_STEPS: StepTable`, text builders; `HubtelOrderTable` includes `"ussd_afa_orders"` (the full Plan 2 union); `createOrderHandlers(...).ussd_afa_orders`.

- [ ] **Step 1: Steps, session fields, flag**

Append to the `HubtelStep` union in `lib/ussd-hubtel/types.ts`:

```ts
  | "AFA_ENTER_NAME" | "AFA_ENTER_CARD" | "AFA_ENTER_LOCATION" | "AFA_ENTER_REGION" | "AFA_CONFIRM"
```

and add inside `interface HubtelSession` after the results-check fields:

```ts
  // AFA registration
  afaFullName?: string
  afaGhCard?: string // normalised GHA-XXXXXXXXX-X
  afaLocation?: string
  afaRegion?: string
  afaPrice?: number // = order amount = Hubtel Price
```

In `lib/ussd-hubtel/menus.ts` change `afa: false,` to `afa: true,`.

- [ ] **Step 2: AFA price service, dependency and fake**

Append to `lib/ussd-hubtel/services.ts`:

```ts
export interface AfaServices {
  /** Active default AFA price, or null when missing/invalid (AFA is then unavailable; never a fallback amount). */
  getPrice(): Promise<number | null>
}

export function defaultAfaServices(supabase: SupabaseClient): AfaServices {
  return { getPrice: () => getAfaPrice(supabase) }
}

/** Same query as submitAfaOrder (lib/afa-fulfillment.ts): the active row named 'default'. */
export async function getAfaPrice(supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()
  if (error) {
    console.error("[HUBTEL-AFA] price lookup failed:", error)
    return null
  }
  const price = data?.price != null ? Number(data.price) : NaN
  return Number.isFinite(price) && price > 0 ? price : null
}
```

In `lib/ussd-hubtel/flow-kit.ts` change the services import to `import type { AfaServices, AirtimeServices, DialerInfo, RcServices } from "./services"` and add `afa: AfaServices` at the end of `RouterDeps`.

In `lib/ussd-hubtel/router.ts` change the services import to `import { defaultAfaServices, defaultAirtimeServices, defaultRcServices, resolveDialer } from "./services"` and add `afa: defaultAfaServices(supabase),` after `rc: defaultRcServices(supabase),`.

In `lib/ussd-hubtel/testing/fakes.ts` change the type import to `import type { AfaServices, AirtimeServices, RcServices } from "../services"`, add `afa: fakeAfa(),` after `rc: fakeRc(),` in `makeDeps`, and append:

```ts
export function fakeAfa(over: Partial<AfaServices> = {}): AfaServices {
  return { getPrice: async () => 50, ...over }
}
```

Append to `lib/ussd-hubtel/services.test.ts`:

```ts
import { getAfaPrice } from "./services"

describe("getAfaPrice", () => {
  const client = (data: unknown, error: unknown = null) => {
    const calls: unknown[][] = []
    const b: any = { select: () => b, eq: (...a: unknown[]) => { calls.push(a); return b }, maybeSingle: async () => ({ data, error }) }
    return { supabase: { from: () => b } as any, calls }
  }
  it("reads the active 'default' row", async () => {
    const { supabase, calls } = client({ price: "50.00" })
    expect(await getAfaPrice(supabase)).toBe(50)
    expect(calls).toContainEqual(["is_active", true])
    expect(calls).toContainEqual(["name", "default"])
  })
  it("returns null for a missing, zero or unparseable price, and on error", async () => {
    expect(await getAfaPrice(client(null).supabase)).toBeNull()
    expect(await getAfaPrice(client({ price: 0 }).supabase)).toBeNull()
    expect(await getAfaPrice(client({ price: "abc" }).supabase)).toBeNull()
    const err = console.error
    console.error = () => {}
    expect(await getAfaPrice(client(null, { message: "x" }).supabase)).toBeNull()
    console.error = err
  })
})
```

(Merge the new `import { getAfaPrice } from "./services"` into the file's existing `import { listMyVouchers } from "./services"` line.)

- [ ] **Step 3: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/afa.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAfa, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req } from "../testing/fakes"
import type { HubtelReply } from "../types"

const MTN_CALLER = "233244123456"

async function toAfa(deps: RouterDeps, mobile = MTN_CALLER) {
  const menu = await hubtelRouter(req({ Type: "Initiation", Mobile: mobile }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "AFA Registration") }), deps)
}
async function send(deps: RouterDeps, inputs: string[]): Promise<HubtelReply> {
  let r: HubtelReply | undefined
  for (const m of inputs) r = await hubtelRouter(req({ Message: m }), deps)
  return r!
}
const DETAILS = ["Kwame Mensah", "GHA1234567890", "Accra", "Greater Accra"]

describe("afa: entry", () => {
  it("MTN caller: asks for the full name (text field)", async () => {
    const { deps, store } = makeDeps()
    const r = await toAfa(deps)
    expect(r.Message).toContain("Enter your full name")
    expect(r.FieldType).toBe("text")
    expect(store.get("S1")).toMatchObject({ step: "AFA_ENTER_NAME", dialingPhone: "+233244123456" })
  })
  it("non-MTN caller is refused before any data entry (review focus #4)", async () => {
    const { deps, store } = makeDeps()
    const r = await toAfa(deps, "233200585542") // Telecel
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("needs an MTN number")
    expect(store.has("S1")).toBe(false)
  })
  it("is hidden when the admin turns AFA off", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: false, airtime: true, resultsChecker: true } }) })
    const menu = await hubtelRouter(req({ Type: "Initiation", Mobile: MTN_CALLER }), deps)
    expect(menu.Message).not.toContain("AFA Registration")
  })
  it("'0' on the name step goes back to the main menu", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("MAIN")
  })
})

describe("afa: field validation (review focus #4)", () => {
  for (const bad of ["K", "1234", "Kwame@Mensah", ""]) {
    it(`rejects name "${bad}"`, async () => {
      const { deps, store } = makeDeps()
      await toAfa(deps)
      await hubtelRouter(req({ Message: bad }), deps)
      expect(store.get("S1")?.step).toBe("AFA_ENTER_NAME")
    })
  }
  for (const bad of ["GHA-12345", "123456789", "GHA-12345678X-0", "hello"]) {
    it(`rejects Ghana Card "${bad}" and stays on the card step`, async () => {
      const { deps, store } = makeDeps()
      await toAfa(deps)
      await hubtelRouter(req({ Message: "Kwame Mensah" }), deps)
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Invalid Ghana Card number.")
      expect(store.get("S1")?.step).toBe("AFA_ENTER_CARD")
    })
  }
  it("stores the normalised card number whatever the typed shape", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "gha 123456789 0"])
    expect(store.get("S1")).toMatchObject({ step: "AFA_ENTER_LOCATION", afaGhCard: "GHA-123456789-0" })
  })
  it("an empty location re-prompts", async () => {
    const { deps, store } = makeDeps()
    await toAfa(deps)
    await send(deps, ["Kwame Mensah", "GHA1234567890", ""])
    expect(store.get("S1")?.step).toBe("AFA_ENTER_LOCATION")
  })
  it("no configured AFA price: release, never a fallback amount", async () => {
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => null }) })
    await toAfa(deps)
    const r = await send(deps, DETAILS)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("unavailable")
  })
})

describe("afa: confirm -> AddToCart", () => {
  it("confirm screen, then AddToCart at the AFA price with NO Paystack fee added", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    const confirm = await send(deps, DETAILS)
    expect(confirm.Message).toContain("Kwame Mensah")
    expect(confirm.Message).toContain("Card: GHA-123456789-0")
    expect(confirm.Message).toContain("GHS 50.00 from 0244123456")
    expect(confirm.Message).toContain("1. Pay now\n2. Cancel")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "AFA Registration", Qty: 1, Price: 50 })
    expect(sup.inserts["ussd_afa_orders"][0]).toEqual({
      dialing_phone: "+233244123456", full_name: "Kwame Mensah", gh_card_number: "GHA-123456789-0",
      location: "Accra", region: "Greater Accra", occupation: "Farmer", amount: 50,
      payment_status: "pending", order_status: "pending",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "ussd_afa_orders", order_id: NEW_ID, expected_amount: 50 })
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toContain("Registration cancelled.")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
  it("price changed since the confirm screen: release, no order", async () => {
    let price = 50
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({ afa: fakeAfa({ getPrice: async () => price }) }, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    price = 60
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Price changed to GHS 60.00")
    expect(sup.inserts["ussd_afa_orders"]).toBeUndefined()
  })
})

describe("afa: idempotent CONFIRM (review focus #1)", () => {
  const winner = { order_table: "ussd_afa_orders", order_id: "o-winner", expected_amount: 50, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["ussd_afa_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan AFA order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = makeDeps({}, sup)
    await toAfa(deps)
    await send(deps, DETAILS)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Item).toEqual({ ItemName: "AFA Registration", Qty: 1, Price: 50 })
    expect(sup.updates.some(u => u.table === "ussd_afa_orders" && u.patch.order_status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/afa.test.ts`
Expected: FAIL: "AFA Registration" is listed but has no entry handler yet, so the first test fails with `expected 'Welcome to Datagod…' to contain 'Enter your full name'`.

- [ ] **Step 5: Write the flow**

```ts
// lib/ussd-hubtel/flows/afa.ts
// AFA Registration on the Hubtel channel. Port of lib/ussd/handlers/afa.ts minus Paystack:
// CONFIRM ends in AddToCart at the AFA price (no Paystack fee). AFA is an MTN registration whose
// contact number is the dialer, so only MTN callers may start it.
import { parseGhanaCardNumber } from "@/lib/ghana-card"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { toLocalPhone } from "../protocol"
import { backToMain, finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import type { HubtelReply } from "../types"

const NAME = { label: "Full name", fieldType: "text" as const }
const CARD = { label: "Ghana Card number", fieldType: "text" as const }
const LOCATION = { label: "City or town", fieldType: "text" as const }
const REGION = { label: "Region", fieldType: "text" as const }
const CONFIRM = { label: "Confirm AFA registration" }

const NAME_RE = /^[A-Za-z][A-Za-z .'-]{2,99}$/
const isPlace = (s: string) => s.length >= 2 && s.length <= 100
const UNAVAILABLE = "AFA registration is unavailable right now. Please try again later."

export function afaNamePromptText(): string {
  return "AFA Registration\nEnter your full name:\n0. Back"
}
export function afaCardPromptText(): string {
  return "Enter your Ghana Card\nnumber:\n(e.g. GHA-123456789-0)\n0. Back"
}
export function afaLocationPromptText(): string {
  return "Enter your city or town:\n(e.g. Accra)\n0. Back"
}
export function afaRegionPromptText(): string {
  return "Enter your region:\n(e.g. Ashanti,\nGreater Accra)\n0. Back"
}
export function afaConfirmText(name: string, card: string, price: number, payerLocal: string): string {
  return (
    `AFA Registration\n${name}\nCard: ${card}\nGHS ${price.toFixed(2)} from ${payerLocal}\n` +
    `Takes 12-24hrs to reflect\n1. Pay now\n2. Cancel`
  )
}

export async function startAfa(ctx: FlowCtx): Promise<HubtelReply> {
  // Applied regardless of the prefix-validation toggle: Uzo charged AFA as MTN MoMo, so non-MTN
  // callers could never complete it, and the registered contact is this number.
  const prefix = await ctx.deps.getPrefixConfig()
  const check = validateNetworkPrefix("MTN", toLocalPhone(ctx.session.dialingPhone), prefix.map)
  if (!check.ok) return finish(ctx, "AFA registration needs an MTN number.\nPlease dial from your MTN line.")
  return goto(ctx, { step: "AFA_ENTER_NAME" }, afaNamePromptText(), NAME)
}

async function enterName(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToMain(ctx)
  const name = ctx.input.replace(/\s+/g, " ")
  if (!NAME_RE.test(name)) return say(ctx, "Enter your full name\n(letters only).\n" + afaNamePromptText(), "AFA_ENTER_NAME", NAME)
  return goto(ctx, { step: "AFA_ENTER_CARD", afaFullName: name }, afaCardPromptText(), CARD)
}

async function enterCard(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_NAME" }, afaNamePromptText(), NAME)
  // Reject here, before payment: a malformed number used to surface only as a failed order after paying.
  const card = parseGhanaCardNumber(ctx.input)
  if (!card) return say(ctx, "Invalid Ghana Card number.\nUse the format:\nGHA-123456789-0\n0. Back", "AFA_ENTER_CARD", CARD)
  return goto(ctx, { step: "AFA_ENTER_LOCATION", afaGhCard: card }, afaLocationPromptText(), LOCATION)
}

async function enterLocation(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_CARD" }, afaCardPromptText(), CARD)
  if (!isPlace(ctx.input)) return say(ctx, afaLocationPromptText(), "AFA_ENTER_LOCATION", LOCATION)
  return goto(ctx, { step: "AFA_ENTER_REGION", afaLocation: ctx.input }, afaRegionPromptText(), REGION)
}

async function enterRegion(ctx: FlowCtx): Promise<HubtelReply> {
  const s = ctx.session
  if (ctx.input === "0") return goto(ctx, { step: "AFA_ENTER_LOCATION" }, afaLocationPromptText(), LOCATION)
  if (!isPlace(ctx.input)) return say(ctx, afaRegionPromptText(), "AFA_ENTER_REGION", REGION)
  const price = await ctx.deps.afa.getPrice()
  if (price === null) return finish(ctx, UNAVAILABLE)
  return goto(ctx, { step: "AFA_CONFIRM", afaRegion: ctx.input, afaPrice: price },
    afaConfirmText(s.afaFullName!, s.afaGhCard!, price, toLocalPhone(s.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session: s } = ctx
  if (ctx.input === "2") return finish(ctx, "Registration cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, afaConfirmText(s.afaFullName!, s.afaGhCard!, s.afaPrice!, toLocalPhone(s.dialingPhone)), "AFA_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  const price = await deps.afa.getPrice()
  if (price === null) return finish(ctx, UNAVAILABLE)
  if (Math.abs(price - s.afaPrice!) > 0.001) return finish(ctx, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`)

  return submitOrder(ctx, {
    table: "ussd_afa_orders",
    price,
    logTag: "HUBTEL-AFA",
    row: {
      dialing_phone: s.dialingPhone, // the registered contact (same E.164 form Uzo stored)
      full_name: s.afaFullName,
      gh_card_number: s.afaGhCard,
      location: s.afaLocation,
      region: s.afaRegion,
      occupation: "Farmer",
      amount: price, // our price only: Uzo added a Paystack fee here; Hubtel adds its own charge at Hubtel
      payment_status: "pending",
      order_status: "pending",
    },
  })
}

export const AFA_STEPS: StepTable = {
  AFA_ENTER_NAME: enterName,
  AFA_ENTER_CARD: enterCard,
  AFA_ENTER_LOCATION: enterLocation,
  AFA_ENTER_REGION: enterRegion,
  AFA_CONFIRM: confirm,
}
```

- [ ] **Step 6: Register the table and wire the router**

In `lib/ussd-hubtel/order-tables.ts` the union becomes:

```ts
export type HubtelOrderTable =
  | "ussd_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests" | "ussd_afa_orders"
```

and add:

```ts
  ussd_afa_orders: {
    payableStatuses: ["pending"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "id",
    cartItemName: () => "AFA Registration",
  },
```

Append to `lib/ussd-hubtel/order-tables.test.ts` inside the describe:

```ts
  it("ussd_afa_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.ussd_afa_orders
    expect(s.payableStatuses).toEqual(["pending"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(s.cartItemName({ id: "x" })).toBe("AFA Registration")
  })
```

In `lib/ussd-hubtel/router.ts` add `import { AFA_STEPS, startAfa } from "./flows/afa"`, add `afa: startAfa,` to `MAIN_MENU_ENTRIES` and `...AFA_STEPS,` to `STEPS`.

- [ ] **Step 7: Run the flow tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/afa.test.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/services.test.ts`
Expected: PASS.

- [ ] **Step 8: Append the failing handler tests**

Append to `lib/ussd-hubtel/order-handlers.test.ts`:

```ts
describe("ussd_afa_orders post-payment handler", () => {
  const base = { id: "a1", dialing_phone: "+233244123456", shop_id: null }
  beforeEach(() => { fulfillUssdAfaOrder.mockResolvedValue({ success: true, message: "ok" }) })

  it("failed order (late payment after expiry) → throws, no fulfilment, no SMS (review focus #5)", async () => {
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "failed" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/not in a payable state: failed/)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("pending → marked completed (conditional), registration submitted once, payer SMSed", async () => {
    const { client, log } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "pending" } })
    await createOrderHandlers(client).ussd_afa_orders("a1")
    expect(log[0]).toMatchObject({ table: "ussd_afa_orders", patch: { payment_status: "completed" }, inVals: ["pending"] })
    expect(fulfillUssdAfaOrder).toHaveBeenCalledTimes(1)
    expect(fulfillUssdAfaOrder).toHaveBeenCalledWith("a1")
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0]).toMatchObject({ phone: "+233244123456", message: "afa-paid" })
  })
  it("a provider failure does not throw (the AFA manual queue owns it); payer still SMSed", async () => {
    fulfillUssdAfaOrder.mockResolvedValue({ success: false, message: "provider down" })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "pending" } })
    await createOrderHandlers(client).ussd_afa_orders("a1")
    err.mockRestore()
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("a shop-scoped AFA row is refused (shop profit is not ported) → throws, nothing marked", async () => {
    const { client, updates } = fakeDb({ ussd_afa_orders: { ...base, shop_id: "s1", payment_status: "pending" } })
    await expect(createOrderHandlers(client).ussd_afa_orders("a1")).rejects.toThrow(/shop-scoped/)
    expect(updates).toHaveLength(0)
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
  })
  it("already completed → no-op", async () => {
    const { client } = fakeDb({ ussd_afa_orders: { ...base, payment_status: "completed" } })
    await createOrderHandlers(client).ussd_afa_orders("a1")
    expect(fulfillUssdAfaOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("fail handler fails only an unpaid AFA order", async () => {
    const { client, log } = fakeDb({ ussd_afa_orders: { id: "a1", payment_status: "pending" } })
    await createFailHandlers(client).ussd_afa_orders("a1")
    expect(log[0]).toMatchObject({ patch: { order_status: "failed", payment_status: "failed" }, inVals: ["pending"] })
  })
})
```

Run: `npx vitest run lib/ussd-hubtel/order-handlers.test.ts`
Expected: FAIL in the new describe with `createOrderHandlers(...).ussd_afa_orders is not a function`.

- [ ] **Step 9: Add the handler**

In `lib/ussd-hubtel/order-handlers.ts` add above `createOrderHandlers`, and register `ussd_afa_orders: orderId => afaOrderPostPayment(supabase, orderId),`:

```ts
/**
 * Mirrors the Paystack webhook's USSD AFA branch: mark paid → fulfillUssdAfaOrder (it has its own
 * atomic fulfilment claim) → payer SMS. The mark is conditional (pending→completed) and is the
 * once-only gate. A provider failure is logged, not thrown: the order stays visible to the AFA
 * retry/manual tools exactly as on the Paystack path. Shop-scoped rows are refused because that
 * branch's inline shop-profit credit is not ported (the Hubtel main router never sets shop_id).
 */
async function afaOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase
    .from("ussd_afa_orders")
    .select("id, payment_status, dialing_phone, shop_id")
    .eq("id", orderId)
    .maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_afa_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`ussd_afa_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed
  const payable = ORDER_TABLES.ussd_afa_orders.payableStatuses
  if (!payable.includes(order.payment_status)) {
    throw new Error(`ussd_afa_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }
  if (order.shop_id) throw new Error(`ussd_afa_orders ${orderId} is shop-scoped; not handled on the Hubtel main channel`)

  const { data: marked, error: markErr } = await supabase
    .from("ussd_afa_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) throw new Error(`ussd_afa_orders ${orderId} not in a payable state (lost the mark)`)

  try {
    const { fulfillUssdAfaOrder } = await import("@/lib/ussd/fulfill-afa")
    const result = await fulfillUssdAfaOrder(orderId)
    if (!result.success) console.error("[HUBTEL-ORDER] AFA fulfilment failed:", orderId, result.message)
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger AFA fulfilment:", orderId, e)
  }

  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  try {
    await sendSMS({ phone: order.dialing_phone, message: SMSTemplates.ussdAfaPaymentReceived(), type: "order_confirmation", reference: orderId })
  } catch (e) { console.warn("[HUBTEL-ORDER] AFA payer SMS failed:", e) }
}
```

- [ ] **Step 10: Run the whole Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS. All four services are now on the Hubtel main menu (menus.test's "shows only implemented services" now expects all four keys).
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 11: Commit**

```bash
git add lib/ussd-hubtel/flows/afa.ts lib/ussd-hubtel/flows/afa.test.ts lib/ussd-hubtel/services.ts lib/ussd-hubtel/services.test.ts lib/ussd-hubtel/types.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/testing/fakes.ts lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/order-handlers.ts lib/ussd-hubtel/order-handlers.test.ts
git commit -m "feat(hubtel): AFA Registration flow and ussd_afa_orders handler"
```

---

### Task 6: Admin "Mark resolved" for `needs_review` rows + derived service badges

Deferred from Plan 1 (its final review: "needs_review rows can only be cleared via SQL"). Design per D12. The logic lives in a testable `lib/ussd-hubtel/resolve.ts`; the route is thin. The admin page gains a "Mark resolved" dialog and shows who/when/why on resolved rows, and the "not built yet" badges are derived from `IMPLEMENTED_SERVICES` (all four services are built after Task 5, so no badge shows).

Outcomes:

| Outcome | Allowed when (row is `needs_review` AND …) | Effect |
|---|---|---|
| `fulfilled` ("Fulfilled manually, customer paid") | always | state `fulfilled`. Callback: `not_due` + Hubtel order id known ⇒ `pending` (+ `paid_at` if null, which bounds the 55-minute window); `not_due` + no order id ⇒ stays `not_due`, response says no callback can be sent; `pending` / `failed` / `sent` ⇒ unchanged (cron / Retry button own them). |
| `not_paid` ("Customer did not pay") | `paid_at IS NULL` AND callback `not_due` (indeterminate-expiry rows only) | state `failed`, callback stays `not_due`, the table's fail handler marks the order failed (same as a definite expiry). A later Hubtel success webhook still recovers it to `needs_review` (`payment.ts` late-payment path). |

Every resolution needs a 5-500 character note and a signed-in admin, writes `resolution_note`, `resolved_by`, `resolved_at`, and an `admin_audit_log` row (`action: "hubtel_resolve_needs_review"`). The update is conditional on `state='needs_review'`, the `callback_status` that was read, and `paid_at IS NULL` when it was read as null; losing that race returns 409.

**Files:**
- Create: `migrations/0107_hubtel_resolution.sql`
- Create: `lib/ussd-hubtel/resolve.ts`, `lib/ussd-hubtel/resolve.test.ts`
- Create: `app/api/admin/ussd-hubtel/resolve/route.ts`, `app/api/admin/ussd-hubtel/resolve/route.test.ts`
- Modify: `lib/ussd-hubtel/types.ts` (`HubtelTxRow` resolution fields)
- Modify: `app/admin/ussd-hubtel/page.tsx`

**Interfaces:**
- Consumes: `createFailHandlers(supabase): OrderHandlers` (Task 1, registry-driven, all five tables after Task 5); `verifyAdminAccess(request) => Promise<{ isAdmin: boolean; userId?: string; errorResponse?: NextResponse }>` (`lib/admin-auth.ts`); `IMPLEMENTED_SERVICES` (`menus.ts`, client-safe).
- Produces: `type ResolveOutcome = "fulfilled" | "not_paid"`, `type ResolveResult = { ok: true; state: "fulfilled" | "failed"; callbackStatus: HubtelCallbackStatus; callbackNote: string } | { ok: false; status: 400 | 404 | 409; error: string }`, `resolveNeedsReview(args: { supabase; failHandlers: OrderHandlers; sessionId: string; outcome: ResolveOutcome; note: string; adminId: string; now?: Date }): Promise<ResolveResult>`; `POST /api/admin/ussd-hubtel/resolve` body `{ sessionId, outcome, note }` → 200 `ResolveResult` (ok) or `{ error }` with 400/401/403/404/409/500.

- [ ] **Step 1: Write the migration and extend the row type**

```sql
-- 0107_hubtel_resolution.sql
-- Admin "mark resolved" for needs_review Hubtel rows: why, who, when.
-- Columns only: hubtel_transactions stays service-role only (no policies, see 0106).
ALTER TABLE hubtel_transactions
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS resolved_by     uuid,
  ADD COLUMN IF NOT EXISTS resolved_at     timestamptz;
```

In `lib/ussd-hubtel/types.ts` add inside `interface HubtelTxRow`, after `updated_at: string` (optional, so existing test fakes that build rows stay valid):

```ts
  resolution_note?: string | null
  resolved_by?: string | null
  resolved_at?: string | null
```

- [ ] **Step 2: Write the failing resolve test**

```ts
// lib/ussd-hubtel/resolve.test.ts
import { describe, it, expect, vi } from "vitest"
import { resolveNeedsReview } from "./resolve"

/** select→eq→maybeSingle returns `row`; update chain records filters; `matches: false` simulates losing the race. */
function fakeDb(row: any, opts: { matches?: boolean } = {}) {
  const updates: any[] = []
  const filters: Array<[string, string, unknown]> = []
  const audits: any[] = []
  const client: any = {
    from(table: string) {
      if (table === "admin_audit_log") return { insert: async (rows: any[]) => { audits.push(...rows); return { error: null } } }
      const read: any = { select: () => read, eq: () => read, maybeSingle: async () => ({ data: row, error: null }) }
      return {
        select: read.select,
        update: (patch: any) => {
          const u: any = {
            eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return u },
            is: (c: string, v: unknown) => { filters.push(["is", c, v]); return u },
            select: async () => {
              const ok = opts.matches !== false
              if (ok) updates.push(patch)
              return { data: ok ? [{ session_id: row?.session_id }] : [], error: null }
            },
          }
          return u
        },
      }
    },
  }
  return { client, updates, filters, audits }
}

const NOW = new Date("2026-10-06T12:00:00.000Z")
// Parked by an indeterminate expiry: no payment recorded, no callback due.
const parked = {
  session_id: "S1", order_table: "airtime_orders", order_id: "o1", state: "needs_review",
  callback_status: "not_due", paid_at: null, hubtel_order_id: null,
  callback_last_error: "status check indeterminate at expiry: relay down",
}
// Paid but held (e.g. under-payment or a failing handler): callback already due.
const paidHeld = { ...parked, callback_status: "pending", paid_at: "2026-10-06T11:00:00.000Z", hubtel_order_id: "H1", callback_last_error: "x" }

function run(row: any, over: Partial<Parameters<typeof resolveNeedsReview>[0]> = {}, opts: { matches?: boolean } = {}) {
  const db = fakeDb(row, opts)
  const fail = vi.fn(async () => {})
  const p = resolveNeedsReview({
    supabase: db.client, failHandlers: { airtime_orders: fail }, sessionId: "S1",
    outcome: "fulfilled", note: "Delivered manually via Digiwapy dashboard", adminId: "admin-1", now: NOW, ...over,
  })
  return { db, fail, p }
}

describe("resolveNeedsReview", () => {
  it("requires a 5-500 character note", async () => {
    const { p, db } = run(paidHeld, { note: " ok " })
    expect(await p).toMatchObject({ ok: false, status: 400 })
    expect(db.updates).toHaveLength(0)
  })
  it("404 for an unknown session", async () => {
    expect(await run(null).p).toMatchObject({ ok: false, status: 404 })
  })
  it("refuses a row that is not needs_review (review focus #7)", async () => {
    const { p, db } = run({ ...paidHeld, state: "fulfilled" })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(db.updates).toHaveLength(0)
  })
  it("fulfilled on a paid row: state fulfilled, callback untouched, guarded update, audited", async () => {
    const { p, db } = run(paidHeld)
    expect(await p).toEqual({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Callback left as pending." })
    expect(db.updates[0]).toMatchObject({
      state: "fulfilled", resolution_note: "Delivered manually via Digiwapy dashboard", resolved_by: "admin-1", resolved_at: NOW.toISOString(),
    })
    expect(db.updates[0]).not.toHaveProperty("callback_status")
    expect(db.filters).toContainEqual(["eq", "state", "needs_review"])
    expect(db.filters).toContainEqual(["eq", "callback_status", "pending"])
    expect(db.filters).not.toContainEqual(["is", "paid_at", null])
    expect(db.audits[0]).toMatchObject({ admin_id: "admin-1", action: "hubtel_resolve_needs_review", target_user_id: null })
  })
  it("fulfilled on a parked row WITH a Hubtel order id: callback becomes pending with a fresh paid_at", async () => {
    const { p, db } = run({ ...parked, hubtel_order_id: "H9" })
    expect(await p).toMatchObject({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Success callback queued." })
    expect(db.updates[0]).toMatchObject({ callback_status: "pending", paid_at: NOW.toISOString() })
    expect(db.filters).toContainEqual(["is", "paid_at", null])
  })
  it("fulfilled on a parked row WITHOUT a Hubtel order id: no callback, and it says so", async () => {
    const { p, db } = run(parked)
    const r = await p
    expect(r).toMatchObject({ ok: true, state: "fulfilled", callbackStatus: "not_due" })
    expect(r.ok && r.callbackNote).toMatch(/No Hubtel order id/)
    expect(db.updates[0]).not.toHaveProperty("callback_status")
  })
  it("not_paid is refused for a row with a recorded payment (review focus #7)", async () => {
    const { p, db, fail } = run(paidHeld, { outcome: "not_paid" })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(db.updates).toHaveLength(0)
    expect(fail).not.toHaveBeenCalled()
  })
  it("not_paid on a parked row: state failed and the order's fail handler runs", async () => {
    const { p, db, fail } = run(parked, { outcome: "not_paid", note: "Hubtel dashboard shows Unpaid" })
    expect(await p).toMatchObject({ ok: true, state: "failed", callbackStatus: "not_due" })
    expect(db.updates[0]).toMatchObject({ state: "failed" })
    expect(fail).toHaveBeenCalledWith("o1")
  })
  it("the row changed underneath (late webhook): 409, no fail handler, no audit (review focus #7)", async () => {
    const { p, db, fail } = run(parked, { outcome: "not_paid" }, { matches: false })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(fail).not.toHaveBeenCalled()
    expect(db.audits).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/resolve.test.ts`
Expected: FAIL with `Failed to resolve import "./resolve"`.

- [ ] **Step 4: Write `resolve.ts`**

```ts
// lib/ussd-hubtel/resolve.ts
// Admin "mark resolved" for needs_review Hubtel rows. Conservative by design: only needs_review
// rows; only while the row is still in the exact shape the admin saw; "not paid" only for rows
// with no recorded payment and no callback due; never invents a Hubtel OrderId.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderHandlers } from "./payment"
import type { HubtelCallbackStatus, HubtelTxRow } from "./types"

export type ResolveOutcome = "fulfilled" | "not_paid"

export type ResolveResult =
  | { ok: true; state: "fulfilled" | "failed"; callbackStatus: HubtelCallbackStatus; callbackNote: string }
  | { ok: false; status: 400 | 404 | 409; error: string }

export const RESOLUTION_NOTE_MIN = 5
export const RESOLUTION_NOTE_MAX = 500

export async function resolveNeedsReview(args: {
  supabase: SupabaseClient
  failHandlers: OrderHandlers
  sessionId: string
  outcome: ResolveOutcome
  note: string
  adminId: string
  now?: Date
}): Promise<ResolveResult> {
  const note = (args.note ?? "").trim()
  if (note.length < RESOLUTION_NOTE_MIN || note.length > RESOLUTION_NOTE_MAX) {
    return { ok: false, status: 400, error: `A note of ${RESOLUTION_NOTE_MIN}-${RESOLUTION_NOTE_MAX} characters is required.` }
  }
  if (args.outcome !== "fulfilled" && args.outcome !== "not_paid") {
    return { ok: false, status: 400, error: "Unknown outcome." }
  }

  const { data, error } = await args.supabase.from("hubtel_transactions").select("*").eq("session_id", args.sessionId).maybeSingle()
  if (error) throw error
  if (!data) return { ok: false, status: 404, error: "Transaction not found." }
  const row = data as HubtelTxRow
  if (row.state !== "needs_review") {
    return { ok: false, status: 409, error: `Only needs_review rows can be resolved (this one is ${row.state}).` }
  }
  const noPaymentRecorded = row.paid_at == null && row.callback_status === "not_due"
  if (args.outcome === "not_paid" && !noPaymentRecorded) {
    return { ok: false, status: 409, error: "This row has a recorded payment or a due callback, so it cannot be resolved as not paid." }
  }

  const nowIso = (args.now ?? new Date()).toISOString()
  const state: "fulfilled" | "failed" = args.outcome === "not_paid" ? "failed" : "fulfilled"
  const patch: Record<string, unknown> = {
    state, resolution_note: note, resolved_by: args.adminId, resolved_at: nowIso, updated_at: nowIso,
  }
  let callbackStatus: HubtelCallbackStatus = row.callback_status
  let callbackNote: string
  if (args.outcome === "not_paid") {
    callbackNote = "No callback: the customer did not pay."
  } else if (row.callback_status === "not_due" && row.hubtel_order_id) {
    callbackStatus = "pending"
    patch.callback_status = "pending"
    patch.paid_at = row.paid_at ?? nowIso // the callbacks cron bounds its 55-minute window by paid_at
    callbackNote = "Success callback queued."
  } else if (row.callback_status === "not_due") {
    callbackNote = "No Hubtel order id on record, so no callback can be sent."
  } else {
    callbackNote = `Callback left as ${row.callback_status}.`
  }

  // Win only if the row is still exactly what was read: a late webhook or a second admin changes it.
  let q = args.supabase
    .from("hubtel_transactions")
    .update(patch)
    .eq("session_id", args.sessionId)
    .eq("state", "needs_review")
    .eq("callback_status", row.callback_status)
  if (row.paid_at == null) q = q.is("paid_at", null)
  const { data: updated, error: updErr } = await q.select("session_id")
  if (updErr) throw updErr
  if (!updated || updated.length === 0) {
    return { ok: false, status: 409, error: "The row changed while you were resolving it. Reload and try again." }
  }

  if (args.outcome === "not_paid") {
    try {
      const fail = args.failHandlers[row.order_table]
      if (fail) await fail(row.order_id)
    } catch (e) { console.error("[HUBTEL-RESOLVE] fail handler error:", args.sessionId, e) }
  }

  const { error: auditErr } = await args.supabase.from("admin_audit_log").insert([{
    admin_id: args.adminId,
    action: "hubtel_resolve_needs_review",
    target_user_id: null,
    old_value: {
      session_id: row.session_id, order_table: row.order_table, order_id: row.order_id,
      state: row.state, callback_status: row.callback_status, callback_last_error: row.callback_last_error,
    },
    new_value: { outcome: args.outcome, state, callback_status: callbackStatus, note },
    created_at: nowIso,
  }])
  if (auditErr) console.warn("[ADMIN-AUDIT] hubtel_resolve_needs_review log insert failed:", auditErr.message)

  return { ok: true, state, callbackStatus, callbackNote }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/resolve.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Write the failing route test**

```ts
// app/api/admin/ussd-hubtel/resolve/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ auth: { isAdmin: true, userId: "admin-1" } as any, resolve: vi.fn() }))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/ussd-hubtel/resolve", () => ({ resolveNeedsReview: (...a: any[]) => h.resolve(...a) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { POST } from "./route"

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ussd-hubtel/resolve", { method: "POST", body: JSON.stringify(body) })
const good = { sessionId: "S1", outcome: "fulfilled", note: "Delivered manually" }

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.resolve.mockReset()
})

describe("POST /api/admin/ussd-hubtel/resolve", () => {
  it("refuses a caller with no admin user id (CRON bypass): the audit log needs one", async () => {
    h.auth = { isAdmin: true }
    const res = await POST(post(good))
    expect(res.status).toBe(403)
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("400 on a malformed body", async () => {
    for (const body of [{}, { ...good, outcome: "refunded" }, { ...good, note: 5 }, { ...good, sessionId: "" }]) {
      expect((await POST(post(body))).status).toBe(400)
    }
    expect(h.resolve).not.toHaveBeenCalled()
  })
  it("passes the admin id through and maps a refusal to its status", async () => {
    h.resolve.mockResolvedValue({ ok: false, status: 409, error: "changed" })
    const res = await POST(post(good))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "changed" })
    expect(h.resolve.mock.calls[0][0]).toMatchObject({ sessionId: "S1", outcome: "fulfilled", note: "Delivered manually", adminId: "admin-1" })
  })
  it("200 with the result on success", async () => {
    h.resolve.mockResolvedValue({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Success callback queued." })
    const res = await POST(post(good))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, callbackNote: "Success callback queued." })
  })
  it("500 when resolve throws", async () => {
    h.resolve.mockRejectedValue(new Error("db down"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await POST(post(good))
    err.mockRestore()
    expect(res.status).toBe(500)
  })
})
```

Run: `npx vitest run app/api/admin/ussd-hubtel/resolve`
Expected: FAIL with `Failed to resolve import "./route"`.

- [ ] **Step 7: Write the route**

```ts
// app/api/admin/ussd-hubtel/resolve/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { resolveNeedsReview, type ResolveOutcome } from "@/lib/ussd-hubtel/resolve"
import { createFailHandlers } from "@/lib/ussd-hubtel/order-handlers"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  // admin_audit_log.admin_id is NOT NULL: a resolution must be attributable to a signed-in admin.
  if (!userId) return NextResponse.json({ error: "A signed-in admin is required" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown; outcome?: unknown; note?: unknown }
  const valid =
    typeof body.sessionId === "string" && body.sessionId.length > 0 &&
    typeof body.note === "string" &&
    (body.outcome === "fulfilled" || body.outcome === "not_paid")
  if (!valid) {
    return NextResponse.json({ error: "sessionId, outcome (fulfilled | not_paid) and note are required" }, { status: 400 })
  }

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const result = await resolveNeedsReview({
      supabase,
      failHandlers: createFailHandlers(supabase),
      sessionId: body.sessionId as string,
      outcome: body.outcome as ResolveOutcome,
      note: body.note as string,
      adminId: userId,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (e) {
    console.error("[HUBTEL-ADMIN] resolve error:", e)
    return NextResponse.json({ error: "Failed to resolve" }, { status: 500 })
  }
}
```

Run: `npx vitest run app/api/admin/ussd-hubtel/resolve`
Expected: PASS (5 tests).

- [ ] **Step 8: Admin page: derived badges, resolution display, Mark resolved dialog**

All edits in `app/admin/ussd-hubtel/page.tsx`.

(a) Under `import { RefreshCw } from "lucide-react"` add:

```tsx
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { IMPLEMENTED_SERVICES } from "@/lib/ussd-hubtel/menus"
```

(b) Replace the `SERVICES` constant with:

```tsx
const SERVICES: { key: keyof HubtelUssdConfig["visibility"]; label: string }[] = [
  { key: "data", label: "Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]
```

and in the services list replace `{!s.live && <Badge variant="outline" className="ml-2">not built yet</Badge>}` with:

```tsx
{!IMPLEMENTED_SERVICES[s.key] && <Badge variant="outline" className="ml-2">not built yet</Badge>}
```

(c) After `const [filter, setFilter] = useState<TxFilter>("all")` add:

```tsx
  const [resolving, setResolving] = useState<HubtelTxRow | null>(null)
  const [outcome, setOutcome] = useState<"fulfilled" | "not_paid">("fulfilled")
  const [note, setNote] = useState("")
  // "Customer did not pay" is only possible while no payment is recorded and no callback is due.
  const canMarkNotPaid = (t: HubtelTxRow) => t.paid_at == null && t.callback_status === "not_due"
```

and after the `retry` function add:

```tsx
  const openResolve = (t: HubtelTxRow) => { setResolving(t); setOutcome("fulfilled"); setNote("") }

  const submitResolve = async () => {
    if (!resolving) return
    setBusy(`resolve:${resolving.session_id}`)
    try {
      const res = await authed("/api/admin/ussd-hubtel/resolve", {
        method: "POST",
        body: JSON.stringify({ sessionId: resolving.session_id, outcome, note }),
      })
      toast.success(`Resolved. ${res.callbackNote}`)
      setResolving(null)
      await load()
    } catch (e: any) { toast.error(e.message || "Resolve failed") } finally { setBusy(null) }
  }
```

(d) In the State cell, directly after the existing `{t.state === "needs_review" && t.callback_last_error && (…)}` block, add:

```tsx
                      {t.resolved_at && (
                        <div className="mt-1 max-w-[16rem] text-xs text-muted-foreground">
                          Resolved {new Date(t.resolved_at).toLocaleString()}: {t.resolution_note}
                        </div>
                      )}
```

(e) Replace the last cell of the row (the one holding the "Retry callback" button) with:

```tsx
                    <td className="p-2">
                      <div className="flex flex-col gap-1">
                        {(t.state === "fulfilled" || t.state === "needs_review") && (t.callback_status === "pending" || t.callback_status === "failed") && (
                          <Button size="sm" variant="outline" disabled={busy === t.session_id} onClick={() => retry(t.session_id)}>Retry callback</Button>
                        )}
                        {t.state === "needs_review" && (
                          <Button size="sm" variant="outline" onClick={() => openResolve(t)}>Mark resolved</Button>
                        )}
                      </div>
                    </td>
```

(f) Replace the final

```tsx
        </Card>
      </div>
    </DashboardLayout>
```

with:

```tsx
        </Card>

        <Dialog open={!!resolving} onOpenChange={open => { if (!open) setResolving(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Mark resolved</DialogTitle>
              <DialogDescription>
                Do this only after dealing with the order itself: delivered it manually, refunded it on /admin/refunds,
                or confirmed on the Hubtel dashboard that the customer did not pay.
              </DialogDescription>
            </DialogHeader>
            {resolving && (
              <div className="space-y-3 text-sm">
                <div className="text-muted-foreground">{resolving.order_table} / {resolving.session_id}</div>
                <Select value={outcome} onValueChange={v => setOutcome(v as "fulfilled" | "not_paid")}>
                  <SelectTrigger aria-label="Outcome"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fulfilled">Fulfilled manually (customer paid)</SelectItem>
                    <SelectItem value="not_paid" disabled={!canMarkNotPaid(resolving)}>Customer did not pay</SelectItem>
                  </SelectContent>
                </Select>
                {outcome === "fulfilled" && resolving.callback_status === "not_due" && !resolving.hubtel_order_id && (
                  <p className="text-xs text-amber-600">No Hubtel order id is on record, so no success callback can be sent for this row.</p>
                )}
                <Textarea
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="What you did (5-500 characters)"
                  maxLength={500}
                  aria-label="Resolution note"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button>
              <Button disabled={note.trim().length < 5 || !!busy?.startsWith("resolve:")} onClick={submitResolve}>Resolve</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
```

- [ ] **Step 9: Run the suites, typecheck and lint**

Run: `npx vitest run lib/ussd-hubtel app/api/admin/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`
Run: `npx eslint app/admin/ussd-hubtel app/api/admin/ussd-hubtel lib/ussd-hubtel`
Expected: 0 errors (pre-existing `no-explicit-any` warnings are acceptable).

- [ ] **Step 10: Commit**

```bash
git add migrations/0107_hubtel_resolution.sql lib/ussd-hubtel/types.ts lib/ussd-hubtel/resolve.ts lib/ussd-hubtel/resolve.test.ts app/api/admin/ussd-hubtel/resolve/route.ts app/api/admin/ussd-hubtel/resolve/route.test.ts app/admin/ussd-hubtel/page.tsx
git commit -m "feat(hubtel): admin mark-resolved for needs_review rows; derived service badges"
```

---

### Task 7: Simulator flows + Plan 2 runbook

No unit tests (project convention for scripts/docs, same as Plan 1 Task 12); verified by typecheck. The live simulator run stays a runbook item for the owner (Plan 1 ruling: never against production).

**Files:**
- Modify (rewrite): `scripts/hubtel-simulate.ts`
- Modify: `docs/hubtel-ussd-runbook.md`

**Interfaces:**
- Consumes: the menu labels and prompts produced by Tasks 1-5 ("Buy Data Bundle", "Buy Airtime", "Results Checker" → "Buy Vouchers" / "Check Results", "AFA Registration", "I have a voucher", "1. Pay now").
- Produces: `FLOW=data|airtime|rc|rccheck|afa` for `scripts/hubtel-simulate.ts`; env `MOBILE`, `RECIPIENT`, `AMOUNT`, `VOUCHER`, `GHCARD`, `REPLAY`.

- [ ] **Step 1: Rewrite the simulator with per-flow scripts**

```ts
// scripts/hubtel-simulate.ts
// Usage: BASE_URL=http://localhost:3000 FLOW=data npx tsx scripts/hubtel-simulate.ts [USSD|Webstore|Hubtel-App]
// FLOW = data (default) | airtime | rc | rccheck | afa
// Export HUBTEL_WEBHOOK_SECRET in your shell/environment first rather than typing it inline (shell history).
// The secret is sent in the x-hubtel-secret header. NEVER point BASE_URL at production (see
// docs/hubtel-ussd-runbook.md): the fulfilment step runs the REAL order handler (provider data,
// Digiwapy airtime, voucher SMS, AFA registration).
// REPLAY=1 posts the SAME fulfilment payload twice and prints both responses (duplicate-delivery check).
// Optional env: MOBILE (caller, 233...), RECIPIENT, AMOUNT (airtime), VOUCHER (PIN/Serial), GHCARD.
const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const SECRET = process.env.HUBTEL_WEBHOOK_SECRET ?? ""
const platform = process.argv[2] ?? "USSD"
const flow = process.env.FLOW ?? "data"
// AFA needs an MTN caller; the other flows default to the Plan 1 test number.
const mobile = process.env.MOBILE ?? (flow === "afa" ? "233244123456" : "233200585542")
const recipient = process.env.RECIPIENT ?? "0244123456"
const replay = process.env.REPLAY === "1"
const authHeaders = { "Content-Type": "application/json", "x-hubtel-secret": SECRET }
const sessionId = "sim" + Date.now().toString(16)

/** An input, or a function of the current screen returning the input ("" skips the step). */
type Step = string | ((screen: string) => string)

/** The digit of the numbered line whose label starts with `label`. */
const pick = (label: string) => (screen: string): string => {
  const line = screen.split("\n").find(l => /^\d+\.\s/.test(l) && l.replace(/^\d+\.\s*/, "").startsWith(label))
  if (!line) throw new Error(`"${label}" not offered on:\n${screen}`)
  return line.split(".")[0]
}

const FLOWS: Record<string, { menu: string; steps: Step[] }> = {
  // MTN, first package, recipient
  data: { menu: "Buy Data Bundle", steps: ["1", "1", recipient] },
  // recipient, amount the caller pays
  airtime: { menu: "Buy Airtime", steps: [recipient, process.env.AMOUNT ?? "1"] },
  // Buy Vouchers, first board in stock, quantity 1
  rc: { menu: "Results Checker", steps: [pick("Buy Vouchers"), "1", "1"] },
  // Check Results, WASSCE, School, own voucher (when combo is offered), PIN/serial, index, year, DOB, WhatsApp
  rccheck: {
    menu: "Results Checker",
    steps: [
      pick("Check Results"), "1", "1",
      screen => (screen.includes("I have a voucher") ? "2" : ""),
      process.env.VOUCHER ?? "012345678912/WGR1900112581",
      "0070202043", "2024", "15/06/2008", recipient,
    ],
  },
  // full name, Ghana Card, town, region
  afa: { menu: "AFA Registration", steps: ["Test Customer", process.env.GHCARD ?? "GHA-123456789-0", "Accra", "Greater Accra"] },
}

let seq = 1
async function interact(type: "Initiation" | "Response", message: string, clientState = "") {
  const res = await fetch(`${BASE}/api/ussd-hubtel/interaction`, {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ Type: type, Mobile: mobile, SessionId: sessionId, ServiceCode: "713", Message: message, Operator: "vodafone", Sequence: seq++, ClientState: clientState, Platform: platform }),
  })
  const json: any = await res.json()
  console.log(`> ${message}\n< [${json.Type}] ${json.Message}\n`)
  return json
}

async function main() {
  const f = FLOWS[flow]
  if (!f) throw new Error(`Unknown FLOW "${flow}". Use one of: ${Object.keys(FLOWS).join(", ")}`)
  const first = await interact("Initiation", "*713#")
  let reply = await interact("Response", pick(f.menu)(first.Message))
  for (const step of f.steps) {
    if (reply.Type !== "response") return console.log("Session ended early - stopping.")
    const input = typeof step === "string" ? step : step(reply.Message)
    if (!input) continue
    reply = await interact("Response", input)
  }
  if (reply.Type !== "response") return console.log("Session ended early - stopping.")
  const cart = await interact("Response", "1") // 1. Pay now
  if (cart.Type !== "AddToCart") return console.log("No AddToCart - stopping.")
  const price = cart.Item.Price
  const payload = JSON.stringify({
    SessionId: sessionId, OrderId: "simorder" + Date.now().toString(16), ExtraData: {},
    OrderInfo: { CustomerMobileNumber: mobile, Status: "Paid", Currency: "GHS", Subtotal: price + 1,
      Items: [{ Name: cart.Item.ItemName, Quantity: 1, UnitPrice: price }],
      Payment: { PaymentType: "mobilemoney", AmountPaid: price + 1, AmountAfterCharges: price, IsSuccessful: true } },
  })
  for (let i = 0; i < (replay ? 2 : 1); i++) {
    const res = await fetch(`${BASE}/api/ussd-hubtel/fulfillment`, { method: "POST", headers: authHeaders, body: payload })
    console.log(`fulfilment${replay ? " #" + (i + 1) : ""} →`, res.status, await res.json())
  }
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Typecheck the script**

Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 3: Update the runbook**

In `docs/hubtel-ussd-runbook.md`:

(a) Replace the title line with `# Hubtel USSD — go-live runbook (Plans 1-2: data, airtime, results checker, AFA)`.

(b) After the bullet that starts `- [ ] **Migration \`0106_hubtel_ussd.sql\` MUST be applied`, add:

```markdown
- [ ] **Migration `0107_hubtel_resolution.sql` MUST be applied to the PRODUCTION database BEFORE Plan 2 is deployed.** It adds `resolution_note`, `resolved_by`, `resolved_at` to `hubtel_transactions`; without it the "Mark resolved" action fails (the page itself still loads).
```

(c) In PHASE A step 2, after the paragraph that starts `Run \`BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts USSD\``, add:

```markdown
   Then run each Plan 2 flow on the same non-production server (`USSD` platform is enough; repeat one flow on `Webstore` and `Hubtel-App`):
   - `FLOW=airtime`: expect `AddToCart` "MTN Airtime to <RECIPIENT>" at the amount you entered (no fee added); after fulfilment the `airtime_orders` row is `payment_status=completed`. Make sure Digiwapy is OFF in that project (or has no live credentials) so no real airtime is sent.
   - `FLOW=rc`: needs at least one enabled board with vouchers in stock in that project. Expect "<BOARD> Checker x1"; after fulfilment the order is `status=completed` and the PIN SMS is attempted to the caller.
   - `FLOW=rccheck`: `MOBILE` must belong to a registered Datagod user in that project (the service requires an account). Expect "<BOARD> Results Check" at the check fee; after fulfilment the request is `payment_status=paid` and appears on `/admin/results-check-requests`.
   - `FLOW=afa`: `MOBILE` must be an MTN number (default `233244123456`). Run it only if that project has NO live AFA provider credentials (Sykes / Apex Prime), otherwise a real registration is submitted. Expect "AFA Registration" at the `afa_registration_prices` default price.
   - `REPLAY=1` with any flow: second delivery `outcome: "duplicate"`, handler ran once.
```

(d) In PHASE B, after step 5 (`If ANYTHING looks wrong, toggle the channel OFF…`), add:

```markdown
6. **Plan 2 services:** after the data purchase passes, make ONE small owner purchase per service and check the row on `/admin/ussd-hubtel` (state `fulfilled`, `callback_status=sent`, amounts match) plus the service's own record: airtime received (or the manual-airtime admin SMS if Digiwapy is off); results-checker PIN SMS received; check-results request listed on `/admin/results-check-requests`; AFA order `payment_status=completed` with a `fulfillment_status`. Turn any service you cannot verify OFF in the visibility toggles before widening the audience.
```

(e) In section 4 (Operate), add to the `needs_review` reasons list (after the "a non-payable order" bullet):

```markdown
  - **results-checker vouchers out of stock after payment** (`results_checker_orders` paid, `status=pending`): deliver the vouchers manually, then Mark resolved;
  - **a combo "Check Results" request paid with no voucher left**: assign a voucher to the request on `/admin/results-check-requests`, then Mark resolved;
  - **a shop-scoped AFA row** (should never happen on the main menu; shop mode is Plan 3): handle manually;
```

and replace the line that starts `- Clearing a worked \`needs_review\` row: there is no "mark resolved" button yet` with:

```markdown
- Clearing a worked `needs_review` row: use **Mark resolved** on `/admin/ussd-hubtel` (a short note is required; it is stored on the row and in `admin_audit_log`). "Fulfilled manually" marks the row fulfilled and, if a Hubtel order id is known but no callback was due yet, queues the success callback (the dialog says when no callback can be sent). "Customer did not pay" is only offered for rows with no recorded payment and no callback due (indeterminate-expiry rows you have checked on the Hubtel dashboard); it fails the order exactly like an expiry. A row that changed while you were resolving it is refused; reload and retry.
- Airtime: paid airtime goes to Digiwapy when enabled for the network, otherwise admins get the manual-airtime SMS (same as Uzo). Check-results requests are worked on `/admin/results-check-requests`. AFA registrations follow the normal AFA provider/sync flow.
```

(f) Replace section 5 (Known limitations) with:

```markdown
## 5. Known limitations (after Plan 2)
- Shop mode is not on the Hubtel channel yet (Plan 3); `mode=shop` answers "Service unavailable".
- Check Results requires a registered Datagod account (same rule as the Uzo code). AFA is only offered to MTN callers.
- Hubtel orders use `channel='ussd'` like Uzo orders; to report Hubtel separately, join `hubtel_transactions (order_table, order_id)`.
- The status-check cron handles at most 50 awaiting rows per run (oldest first); a large backlog drains over several runs.
- Still to do: live visual check of `/admin/ussd-hubtel` (incl. the Mark resolved dialog) and the live simulator runs on a non-production environment (Phase A).
```

- [ ] **Step 4: Full verification**

Run: `npx vitest run lib/ussd-hubtel app/api/admin/ussd-hubtel`
Expected: PASS.
Run: `npm run test:run`
Expected: everything passes except the 9 pre-existing, unrelated failures in `lib/order-health-service.test.ts` (Plan 1 Task 10 note). Any other failure must be fixed.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/hubtel-simulate.ts docs/hubtel-ussd-runbook.md
git commit -m "docs(hubtel): Plan 2 simulator flows and runbook"
```

---

## Self-Review (spec coverage)

| Requirement | Covered by |
|---|---|
| Spec §2 services (data, airtime, results checker, AFA), admin-selectable | Tasks 2-5 flip `IMPLEMENTED_SERVICES`; visibility toggle tested per flow ("is hidden when the admin turns … off") |
| Spec §5 same sub-flows as `lib/ussd` up to CONFIRM, then AddToCart; no PAYMENT_METHOD / OTP / wallet | Tasks 2-5 step tables; every confirm ends in `submitOrder` |
| Spec §5 field typing (`phone`, `decimal`, `number`, display) | Airtime recipient `phone`, amount `decimal`; RC WhatsApp `phone`; AFA text fields `text`; menus `number` |
| Spec §6 insert into the Uzo tables with a Hubtel marker + `hubtel_transactions` row | `submitOrder` (Task 1); marker = the tx row (D3) |
| Spec §8 always-success callback; failures loud | Handlers throw ⇒ `needs_review` (D5); `processFulfillment` unchanged |
| Spec §9 admin page: visibility, needs_review work | Task 6 (derived badges, Mark resolved) |
| Spec §14 Paystack webhook not extracted; reuse exported fulfil functions | Handlers call `markAirtimeOrderPaid`, `fulfillPaidResultsCheckerOrder`, `fulfillPaidResultsCheckRequest`, `fulfillUssdAfaOrder`; no Paystack/Uzo edits |
| Brief (a) flip flags + remove badges | Tasks 2, 3, 5 (flags); Task 6 (badges derived) |
| Brief (b) handlers + fail handlers for 4 tables, payable-state safe | Tasks 2-5 (+ registry-driven fail handlers, Task 1); D4 |
| Brief (c) generic replay + 23505 replay per flow | Task 1 `replaySubmittedOrder` / `submitOrder`; idempotent-CONFIRM tests in Tasks 2-5 |
| Brief (d) mark resolved: guarded, audited, needs_review only, callback rule | Task 6; D12; migration 0107 |
| Brief (e) step types, real network names, ported validation | Tasks 2-5 (types, `AIRTIME_NETWORKS`, validators from `results-check-validation` / `ghana-card` / `phone-format`) |
| Spec §11 simulator | Task 7 |
| Review Focus 1-7 | #1 Tasks 2-5 "idempotent CONFIRM"; #2 Tasks 2-4 stale-guard + handler stock tests; #3 Task 2 amount/prefix; #4 Task 5 card/MTN/price; #5 Tasks 2-5 handler + fail-handler tests; #6 Task 1 unknown table + Task 2 airtime replay; #7 Task 6 |

Gaps carried forward (not in scope for this plan): spec §4.2 "mode pinned into the session" (Plan 3, when shop mode can differ mid-session); Plan 1 deferred M3 (dialing_phone format vs Uzo) and M5 (callback double-send) remain open.

Placeholder scan: no TBD/TODO steps; every code step shows the code. Type consistency: `RouterDeps` grows only by `resolveDialer` (Task 2), `airtime` (Task 2), `rc` (Task 3, `checkSettings` added in Task 4), `afa` (Task 5), and `testing/fakes.ts` `makeDeps` gains the matching defaults in the same task; `HubtelOrderTable` grows one member per task and ends as the five-table union in Task 5; `ORDER_TABLES`, `submitOrder`, `replaySubmittedOrder`, `StepTable`, `MAIN_MENU_ENTRIES`, `createOrderHandlers`, `createFailHandlers`, `resolveNeedsReview` are named identically everywhere they are used.

