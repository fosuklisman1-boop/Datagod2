# Admin Order Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin-only `/admin/refunds` page that refunds paid-but-undelivered (`pending`) shop, USSD and USSD-shop orders through an admin-chosen gateway (Paystack, Moolre, wallet, pluggable), after atomically stripping every shop owner's cut (profit first, wallet fallback, block if short).

**Architecture:** Postgres RPCs own the money-critical, race-prone steps (reserve + clawback, complete, compensate, dispatch claim) inside single transactions serialized per order by an advisory lock. A TypeScript service orchestrates: load order → eligibility → reserve (RPC) → gateway adapter payout → complete/compensate (RPC). Gateways are adapters behind a registry. Pure modules (clawback plan, eligibility, amounts) are unit-tested; RPC behaviour is tested by a rolled-back SQL script.

**Tech Stack:** Next.js 15 route handlers, Supabase (Postgres + service-role client), Vitest, shadcn/ui, existing `lib/paystack.ts` and `lib/moolre-transfer.ts`.

**Spec:** `docs/superpowers/specs/2026-10-05-admin-order-refunds-design.md`

## Deviations from the spec (found while reading the real code — executors must follow THIS plan where they differ)

1. **Clawback is a ledger entry, not a balance decrement.** `shop_available_balance` is a trigger-maintained cache (`sync_shop_balance`: credited `shop_profits` minus approved/completed withdrawals). The clawback inserts a **negative `shop_profits` row** (`refund_id` set); the existing `after_shop_profits_change` trigger re-syncs the cache. Wallet fallback decrements `wallets.balance` directly and writes a `transactions` row.
2. **The cut comes from `shop_profits`, not order columns.** The authoritative record of what each owner was credited is the `shop_profits` rows keyed by `shop_order_id` / `ussd_order_id` / `ussd_shop_order_id`. This covers owner + parent automatically, including `ussd_orders` (which has no `profit_amount` column).
3. **Dispatch guard is keyed on order UUID, not a status flip.** `createMTNOrder` / `createNonMTNOrder` have ~12 call sites and do not know the order's table; orders stay `pending` during dispatch. A new `order_dispatch_claims` table plus `claim_order_dispatch` / `record_dispatch_outcome` RPCs, called at the top of those two functions, gives the mutual exclusion. The refund RPC and the claim RPC take the same per-order advisory lock.
4. **Paystack is two gateways, and the payout one has an OTP step (user decision).** `paystack` = native reversal of the original charge (only when the order was paid via Paystack). `paystack_payout` = MoMo transfer to the payer via `createRecipient` + `initiateTransfer` (`lib/paystack-transfer.ts`); Paystack returns `status:"otp"` and the admin must enter the code to finalize. That adds a ledger status `awaiting_otp`, a gateway outcome `otp`, a `submitRefundOtp` service function, and `/otp` + `/cancel` routes. A wrong OTP leaves the refund in `awaiting_otp` (never auto-compensated); only an explicit admin **Cancel** restores the clawback.
5. **"Pending" means `order_status='pending' AND payment_status='completed'`.** Wallet-paid `ussd_orders` are set to `processing` at payment (`lib/ussd/handlers/bundles.ts`), so they do not appear (matches "only pending orders").
6. **A partial refund still strips the owner's FULL cut.** The order is cancelled either way, so the owner earned nothing. The retained portion stays with the platform. (Business rule to confirm with the owner of the product before release.)
7. **A BEFORE UPDATE trigger protects `refunding`/`refunded` orders** from late webhooks/crons moving them to `completed`/`failed`; it silently keeps the status and records the attempt in `order_refunds.late_events`.
8. **Eligibility rule refined.** An order whose provider submission was accepted can still be refunded if every provider tracking row is terminally failed (`failed`/`error`/`abandoned`) — the provider confirmed failure. Accepted submission with NO tracking rows (CodeCraft direct path) is not provably failed, so it is blocked.

## Global Constraints

- Money is GHS, 2 decimals; do arithmetic in integer pesewas/cents in TS (`Math.round(n*100)`).
- All new tables/RPCs are service-role only: `REVOKE ALL ... FROM anon, authenticated`, RLS enabled, policy `TO service_role`. RPC `EXECUTE` revoked from `PUBLIC, anon, authenticated`.
- Every admin route starts with `const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request); if (!isAdmin) return errorResponse` (`lib/admin-auth.ts`).
- Any `.in()` with more than ~100 ids must be chunked (see `inChunks()` in the order download route; list page size is 50 so this plan stays under it).
- Never auto-compensate (restore the clawback) on an ambiguous gateway result, a wrong/failed OTP entry, or a pending payout; only on a definitive gateway failure or an explicit admin Cancel of an `awaiting_otp` refund.
- Payer number is never editable; payout destination = the payer's number recorded on the order.
- Applying migrations to the production database requires explicit user approval at execution time (see `reference-supabase-access` memory for the Management API SQL runner; never print tokens).
- Match surrounding code style: no unnecessary comments, `console.error("[REFUND] ...")` prefixes, Vitest with `vi.mock` for I/O edges.

## Review Focus

- Two admins click Refund on the same order at the same moment → exactly one wins, the other gets `ALREADY_REFUNDED`; no double payout. (Task 2 SQL test, Task 5 service test.)
- A fulfillment cron/webhook dispatches the order while the refund is reserving → exactly one of the two wins; a late `completed` update on a `refunded` order is ignored. (Task 2 SQL test, Task 6.)
- Gateway returns ambiguous/timeout → ledger stays `processing`, clawback is NOT restored, retry/reconcile cannot double-pay (Moolre `externalref` = refund id; wallet credit reference = refund id). (Task 3, Task 5.)
- Owner whose `available_balance` is negative or whose wallet is negative → treated as zero capacity, reported as shortfall, never silently refunded. (Task 1, Task 2.)
- Refund amount edges: 0, negative, NaN, more than paid, 3 decimals; partial refund still strips the full cut. (Task 1, Task 5.)
- Paystack payout OTP: wrong OTP keeps the refund in `awaiting_otp` with the clawback intact; admin Cancel restores it exactly once; a closed browser tab never loses the transfer code (it is stored on the ledger). (Task 3, Task 5, Task 7.)
- Sub-agent order where only the PARENT is short → whole refund blocked, nothing deducted from the sub-agent. (Task 1, Task 2.)

---

### Task 1: Pure refund logic (clawback plan, eligibility, amounts)

**Files:**
- Create: `lib/refunds/types.ts`
- Create: `lib/refunds/clawback.ts`
- Create: `lib/refunds/eligibility.ts`
- Create: `lib/refunds/amounts.ts`
- Test: `lib/refunds/clawback.test.ts`, `lib/refunds/eligibility.test.ts`, `lib/refunds/amounts.test.ts`

**Interfaces:**
- Produces: `OwnerCut`, `ClawbackLine`, `ClawbackPlan`, `planClawback(owners: OwnerCut[]): ClawbackPlan`; `EligibilityInput`, `Eligibility`, `evaluateEligibility(input): Eligibility`; `defaultRefundAmount(paid: number, fee: number): number`, `validateRefundAmount(amount: number, paid: number): string | null`; `OrderTable`, `RefundableOrder`, `GatewayOutcome`, `RefundGateway`, `RefundContext` (types.ts).

- [ ] **Step 1: Write `lib/refunds/types.ts`**

```ts
export type OrderTable = "shop_orders" | "ussd_orders" | "ussd_shop_orders"
export const ORDER_TABLES: OrderTable[] = ["shop_orders", "ussd_orders", "ussd_shop_orders"]

export interface OwnerCut {
  shopId: string
  ownerUserId: string | null
  credited: number
  pending: number
  availableBalance: number
  walletBalance: number
}

export type DispatchOutcome = "claimed" | "submitted" | "failed" | "unknown"

export interface PaymentSource {
  gateway: "paystack" | "wallet" | null
  reference: string | null
  payerPhone: string | null
  walletUserId: string | null
}

export interface RefundableOrder {
  table: OrderTable
  id: string
  orderStatus: string
  paymentStatus: string
  shopId: string | null
  shopName: string | null
  packageLabel: string
  network: string
  recipientPhone: string | null
  createdAt: string
  paid: number
  gatewayFee: number
  payment: PaymentSource
  owners: OwnerCut[]
  evidence: {
    hasActiveRefund: boolean
    dispatchOutcome: DispatchOutcome | null
    trackingStatuses: string[]
    externalOrderId: string | null
  }
}

export interface RefundContext {
  refundId: string
  order: RefundableOrder
  amount: number
  destinationPhone: string | null
}

export type GatewayOutcome =
  | { kind: "completed"; ref: string }
  | { kind: "pending"; ref: string }
  | { kind: "otp"; ref: string }          // payout created, waiting for the admin's OTP; ref = transfer code
  | { kind: "failed"; error: string }
  | { kind: "unknown"; error: string }

export type GatewaySupport = { ok: true } | { ok: false; reason: string }

export interface RefundGateway {
  id: string
  label: string
  supports(order: RefundableOrder): GatewaySupport
  refund(ctx: RefundContext): Promise<GatewayOutcome>
  checkStatus?(ctx: RefundContext, gatewayRef: string | null): Promise<GatewayOutcome>
  /** Only gateways whose payout needs a one-time code (Paystack payout). */
  finalizeOtp?(ctx: RefundContext, gatewayRef: string, otp: string): Promise<GatewayOutcome>
}
```

- [ ] **Step 2: Write the failing clawback test `lib/refunds/clawback.test.ts`**

```ts
import { planClawback, type OwnerCut } from "./clawback"

const owner = (o: Partial<OwnerCut> = {}): OwnerCut => ({
  shopId: "s1", ownerUserId: "u1", credited: 10, pending: 0,
  availableBalance: 100, walletBalance: 0, ...o,
})

describe("planClawback", () => {
  it("takes everything from profit when the available balance covers it", () => {
    const plan = planClawback([owner()])
    expect(plan.ok).toBe(true)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 10, fromWallet: 0, shortfall: 0 })
  })

  it("falls back to the wallet for the part profit cannot cover", () => {
    const plan = planClawback([owner({ availableBalance: 4, walletBalance: 20 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 4, fromWallet: 6, shortfall: 0 })
    expect(plan.ok).toBe(true)
  })

  it("reports a shortfall when profit + wallet together cannot cover it", () => {
    const plan = planClawback([owner({ availableBalance: 4, walletBalance: 2 })])
    expect(plan.ok).toBe(false)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 4, fromWallet: 6, shortfall: 4 })
  })

  it("treats a negative available balance and negative wallet as zero capacity", () => {
    const plan = planClawback([owner({ availableBalance: -5, walletBalance: -3 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0, fromWallet: 10, shortfall: 10 })
    expect(plan.ok).toBe(false)
  })

  it("blocks the whole plan when only the parent owner is short (sub-agent order)", () => {
    const plan = planClawback([
      owner({ shopId: "sub", credited: 5, availableBalance: 50 }),
      owner({ shopId: "parent", ownerUserId: "u2", credited: 3, availableBalance: 0, walletBalance: 0 }),
    ])
    expect(plan.ok).toBe(false)
    expect(plan.lines.find((l) => l.shopId === "sub")!.shortfall).toBe(0)
    expect(plan.lines.find((l) => l.shopId === "parent")!.shortfall).toBe(3)
  })

  it("does not need balance for the pending (not yet credited) portion", () => {
    const plan = planClawback([owner({ credited: 0, pending: 7, availableBalance: 0, walletBalance: 0 })])
    expect(plan.ok).toBe(true)
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0, fromWallet: 0, pending: 7 })
  })

  it("avoids floating point drift", () => {
    const plan = planClawback([owner({ credited: 0.3, availableBalance: 0.1, walletBalance: 0.2 })])
    expect(plan.lines[0]).toMatchObject({ fromProfit: 0.1, fromWallet: 0.2, shortfall: 0 })
  })

  it("orders lines by shop id so lock order is deterministic", () => {
    const plan = planClawback([owner({ shopId: "b" }), owner({ shopId: "a" })])
    expect(plan.lines.map((l) => l.shopId)).toEqual(["a", "b"])
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/refunds/clawback.test.ts`
Expected: FAIL — cannot resolve `./clawback`.

- [ ] **Step 4: Write `lib/refunds/clawback.ts`**

```ts
import type { OwnerCut } from "./types"

export type { OwnerCut }

export interface ClawbackLine {
  shopId: string
  ownerUserId: string | null
  credited: number
  pending: number
  fromProfit: number
  fromWallet: number
  shortfall: number
}

export interface ClawbackPlan {
  lines: ClawbackLine[]
  ok: boolean
}

const cents = (n: number) => Math.round(n * 100)
const money = (c: number) => c / 100

/**
 * Mirrors the arithmetic in the reserve_order_refund RPC (the RPC is authoritative;
 * this powers the preview). Per owner: strip the credited cut from the available
 * profit balance first, then the wallet. The pending (not yet credited) part is
 * simply cancelled and needs no balance. Negative balances count as zero capacity.
 */
export function planClawback(owners: OwnerCut[]): ClawbackPlan {
  const lines = [...owners]
    .sort((a, b) => (a.shopId < b.shopId ? -1 : a.shopId > b.shopId ? 1 : 0))
    .map((o) => {
      const credited = cents(o.credited)
      const available = Math.max(cents(o.availableBalance), 0)
      const wallet = Math.max(cents(o.walletBalance), 0)
      const fromProfit = Math.min(credited, available)
      const fromWallet = credited - fromProfit
      const shortfall = Math.max(fromWallet - wallet, 0)
      return {
        shopId: o.shopId,
        ownerUserId: o.ownerUserId,
        credited: money(credited),
        pending: o.pending,
        fromProfit: money(fromProfit),
        fromWallet: money(fromWallet),
        shortfall: money(shortfall),
      }
    })
  return { lines, ok: lines.every((l) => l.shortfall === 0) }
}
```

- [ ] **Step 5: Run clawback tests**

Run: `npx vitest run lib/refunds/clawback.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Write the failing amounts + eligibility tests**

`lib/refunds/amounts.test.ts`:

```ts
import { defaultRefundAmount, validateRefundAmount } from "./amounts"

describe("defaultRefundAmount", () => {
  it("is price minus gateway fee", () => expect(defaultRefundAmount(10, 0.15)).toBe(9.85))
  it("never goes below zero", () => expect(defaultRefundAmount(0.1, 0.5)).toBe(0))
  it("rounds to pesewas", () => expect(defaultRefundAmount(10.005, 0)).toBe(10.01))
})

describe("validateRefundAmount", () => {
  it("accepts a normal and a partial amount", () => {
    expect(validateRefundAmount(9.85, 10)).toBeNull()
    expect(validateRefundAmount(1, 10)).toBeNull()
  })
  it.each([0, -1, NaN, Infinity])("rejects %s", (v) => {
    expect(validateRefundAmount(v as number, 10)).not.toBeNull()
  })
  it("rejects more than was paid", () => expect(validateRefundAmount(10.01, 10)).not.toBeNull())
  it("rejects more than 2 decimals", () => expect(validateRefundAmount(1.005, 10)).not.toBeNull())
})
```

`lib/refunds/eligibility.test.ts`:

```ts
import { evaluateEligibility, type EligibilityInput } from "./eligibility"

const base: EligibilityInput = {
  orderStatus: "pending", paymentStatus: "completed", hasActiveRefund: false,
  dispatchOutcome: null, trackingStatuses: [], externalOrderId: null,
}
const code = (o: Partial<EligibilityInput>) => {
  const r = evaluateEligibility({ ...base, ...o })
  return r.eligible ? "ok" : r.code
}

describe("evaluateEligibility", () => {
  it("accepts a paid pending order never sent anywhere", () => expect(code({})).toBe("ok"))
  it("rejects non-pending orders", () => expect(code({ orderStatus: "processing" })).toBe("NOT_PENDING"))
  it("rejects unpaid orders", () => expect(code({ paymentStatus: "pending" })).toBe("NOT_PENDING"))
  it("rejects an order with an active refund", () => expect(code({ hasActiveRefund: true })).toBe("ALREADY_REFUNDED"))
  it("rejects while a dispatch is claimed (in flight)", () => expect(code({ dispatchOutcome: "claimed" })).toBe("DISPATCH_IN_PROGRESS"))
  it("rejects an unknown dispatch outcome", () => expect(code({ dispatchOutcome: "unknown" })).toBe("DISPATCH_UNKNOWN"))
  it("accepts when dispatch outcome is failed and there are no tracking rows", () => expect(code({ dispatchOutcome: "failed" })).toBe("ok"))
  it("accepts a submitted order whose every tracking row is terminally failed", () => {
    expect(code({ dispatchOutcome: "submitted", trackingStatuses: ["failed", "abandoned", "error"] })).toBe("ok")
  })
  it("rejects when any tracking row is still pending/retrying/completed", () => {
    expect(code({ trackingStatuses: ["failed", "pending"] })).toBe("PROVIDER_IN_PROGRESS")
    expect(code({ trackingStatuses: ["failed", "retrying"] })).toBe("PROVIDER_IN_PROGRESS")
    expect(code({ trackingStatuses: ["failed", "completed"] })).toBe("SENT_TO_PROVIDER")
  })
  it("rejects a submitted order with no tracking rows (cannot prove failure)", () => {
    expect(code({ dispatchOutcome: "submitted", trackingStatuses: [] })).toBe("SENT_TO_PROVIDER")
  })
  it("rejects an order with an external id and no tracking rows (pre-guard dispatch)", () => {
    expect(code({ externalOrderId: "12345" })).toBe("SENT_TO_PROVIDER")
  })
})
```

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run lib/refunds/amounts.test.ts lib/refunds/eligibility.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 8: Write `lib/refunds/amounts.ts` and `lib/refunds/eligibility.ts`**

`amounts.ts`:

```ts
const cents = (n: number) => Math.round(n * 100)

export function defaultRefundAmount(paid: number, fee: number): number {
  return Math.max(cents(paid) - cents(fee), 0) / 100
}

export function validateRefundAmount(amount: number, paid: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Refund amount must be greater than zero"
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return "Refund amount can have at most 2 decimal places"
  if (cents(amount) > cents(paid)) return "Refund amount cannot exceed what the customer paid"
  return null
}
```

`eligibility.ts`:

```ts
import type { DispatchOutcome } from "./types"

export interface EligibilityInput {
  orderStatus: string
  paymentStatus: string
  hasActiveRefund: boolean
  dispatchOutcome: DispatchOutcome | null
  trackingStatuses: string[]
  externalOrderId: string | null
}

export type EligibilityCode =
  | "NOT_PENDING" | "ALREADY_REFUNDED" | "DISPATCH_IN_PROGRESS" | "DISPATCH_UNKNOWN"
  | "PROVIDER_IN_PROGRESS" | "SENT_TO_PROVIDER"

export type Eligibility = { eligible: true } | { eligible: false; code: EligibilityCode; reason: string }

const TERMINAL_FAILED = new Set(["failed", "error", "abandoned"])
const IN_FLIGHT = new Set(["pending", "processing", "retrying"])

const no = (code: EligibilityCode, reason: string): Eligibility => ({ eligible: false, code, reason })

export function evaluateEligibility(i: EligibilityInput): Eligibility {
  if (i.orderStatus !== "pending" || i.paymentStatus !== "completed") return no("NOT_PENDING", "Order is not a paid, pending order")
  if (i.hasActiveRefund) return no("ALREADY_REFUNDED", "A refund already exists for this order")
  if (i.dispatchOutcome === "claimed") return no("DISPATCH_IN_PROGRESS", "Being sent to a provider right now")
  if (i.dispatchOutcome === "unknown") return no("DISPATCH_UNKNOWN", "A provider call ended with an unknown result — investigate before refunding")

  const live = i.trackingStatuses.filter((s) => !TERMINAL_FAILED.has(s))
  if (live.some((s) => IN_FLIGHT.has(s))) return no("PROVIDER_IN_PROGRESS", "Provider order is still in progress")
  if (live.length > 0) return no("SENT_TO_PROVIDER", "Provider reports the order was delivered/accepted")

  const hasTracking = i.trackingStatuses.length > 0
  if (!hasTracking && (i.dispatchOutcome === "submitted" || i.externalOrderId)) {
    return no("SENT_TO_PROVIDER", "Sent to a provider and failure cannot be confirmed")
  }
  return { eligible: true }
}
```

- [ ] **Step 9: Run all three test files**

Run: `npx vitest run lib/refunds`
Expected: PASS (all). Then `npx tsc --noEmit -p .` Expected: no errors in `lib/refunds/**`.

- [ ] **Step 10: Commit**

```bash
git add lib/refunds
git commit -m "feat(refunds): pure clawback, eligibility and amount logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Database migration — ledger, dispatch claims, RPCs, status guard

**Files:**
- Create: `migrations/20261005_order_refunds.sql`
- Create: `migrations/tests/20261005_order_refunds_rpc_test.sql`

**Interfaces:**
- Produces (RPCs, all `service_role` only):
  - `claim_order_dispatch(p_order_id uuid) returns boolean`
  - `record_dispatch_outcome(p_order_id uuid, p_outcome text) returns void`
  - `reserve_order_refund(p_order_table text, p_order_id uuid, p_gateway text, p_paid numeric, p_fee numeric, p_amount numeric, p_destination text, p_wallet_user uuid, p_admin uuid) returns jsonb` → `{ refund_id, clawbacks: [{shop_id, owner_user_id, credited, pending, from_profit, from_wallet}] }`; raises `ORDER_NOT_FOUND | ORDER_NOT_PENDING | ALREADY_REFUNDED | DISPATCH_ACTIVE | BAD_AMOUNT | BAD_TABLE | SHORTFALL:<shop_id>:<amount>`
  - `mark_refund_processing(p_refund_id uuid, p_gateway_ref text, p_note text, p_status text default 'processing') returns void` (`p_status` ∈ `processing | awaiting_otp`)
  - `complete_order_refund(p_refund_id uuid, p_gateway_ref text) returns void`
  - `fail_order_refund(p_refund_id uuid, p_error text) returns void` (compensates; idempotent)
- Tables: `order_refunds`, `order_dispatch_claims`; column `shop_profits.refund_id`.

- [ ] **Step 1: Discover blocking CHECK constraints on `order_status`** (read-only SQL via the Management API runner; see `reference-supabase-access` memory)

```sql
select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint
where contype = 'c'
  and conrelid in ('shop_orders'::regclass, 'ussd_orders'::regclass, 'ussd_shop_orders'::regclass)
  and pg_get_constraintdef(oid) ilike '%order_status%';
```

Expected: zero rows (the repo's `CREATE TABLE`s define none). **If any row is returned**, the migration in Step 2 must first widen that constraint: for each returned `conname`, add to the top of the migration
`ALTER TABLE <tbl> DROP CONSTRAINT <conname>;` then `ALTER TABLE <tbl> ADD CONSTRAINT <conname> CHECK (<def's value list> + 'refunding','refunded');` using the exact value list printed in `def`.

- [ ] **Step 2: Write `migrations/20261005_order_refunds.sql`**

```sql
-- Admin order refunds: ledger, dispatch claims, atomic RPCs, status guard.
-- Additive. Safe to apply before the app deploy (app code fails open if RPCs are missing).

-- ───────────────────────── tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.order_refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_table      text NOT NULL CHECK (order_table IN ('shop_orders','ussd_orders','ussd_shop_orders')),
  order_id         uuid NOT NULL,
  gateway          text NOT NULL,
  paid_amount      numeric(10,2) NOT NULL,
  gateway_fee      numeric(10,2) NOT NULL DEFAULT 0,
  amount           numeric(10,2) NOT NULL CHECK (amount > 0),
  destination_phone text,
  wallet_user_id   uuid,
  status           text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','processing','awaiting_otp','completed','failed')),
  gateway_ref      text,
  error            text,
  clawbacks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  late_events      jsonb NOT NULL DEFAULT '[]'::jsonb,
  admin_id         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

-- The double-refund guard: at most one non-failed refund per order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_refunds_active
  ON public.order_refunds (order_table, order_id) WHERE status <> 'failed';
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id ON public.order_refunds (order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_status_created ON public.order_refunds (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.order_dispatch_claims (
  order_id        uuid PRIMARY KEY,
  attempts        integer NOT NULL DEFAULT 0,
  last_outcome    text NOT NULL DEFAULT 'claimed' CHECK (last_outcome IN ('claimed','submitted','failed','unknown')),
  last_claimed_at timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_dispatch_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all_order_refunds" ON public.order_refunds;
CREATE POLICY "service_role_all_order_refunds" ON public.order_refunds
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service_role_all_order_dispatch_claims" ON public.order_dispatch_claims;
CREATE POLICY "service_role_all_order_dispatch_claims" ON public.order_dispatch_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.order_refunds FROM anon, authenticated;
REVOKE ALL ON public.order_dispatch_claims FROM anon, authenticated;

ALTER TABLE public.shop_profits
  ADD COLUMN IF NOT EXISTS refund_id uuid REFERENCES public.order_refunds(id);
CREATE INDEX IF NOT EXISTS idx_shop_profits_refund_id ON public.shop_profits (refund_id) WHERE refund_id IS NOT NULL;

-- ───────────────────── dispatch claim RPCs ─────────────────────
CREATE OR REPLACE FUNCTION public.claim_order_dispatch(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  IF EXISTS (SELECT 1 FROM order_refunds WHERE order_id = p_order_id AND status <> 'failed') THEN
    RETURN false;
  END IF;
  INSERT INTO order_dispatch_claims (order_id, attempts, last_outcome, last_claimed_at, updated_at)
  VALUES (p_order_id, 1, 'claimed', now(), now())
  ON CONFLICT (order_id) DO UPDATE
    SET attempts = order_dispatch_claims.attempts + 1,
        last_outcome = 'claimed', last_claimed_at = now(), updated_at = now();
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.record_dispatch_outcome(p_order_id uuid, p_outcome text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_outcome NOT IN ('submitted','failed','unknown') THEN
    RAISE EXCEPTION 'BAD_OUTCOME';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  UPDATE order_dispatch_claims SET last_outcome = p_outcome, updated_at = now() WHERE order_id = p_order_id;
END $$;

-- ───────────────────── reserve + clawback ─────────────────────
CREATE OR REPLACE FUNCTION public.reserve_order_refund(
  p_order_table text, p_order_id uuid, p_gateway text,
  p_paid numeric, p_fee numeric, p_amount numeric,
  p_destination text, p_wallet_user uuid, p_admin uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fk text;
  v_status text; v_pay text;
  v_outcome text;
  v_refund_id uuid := gen_random_uuid();
  v_lines jsonb := '[]'::jsonb;
  r record;
  v_owner uuid; v_avail numeric; v_from_profit numeric; v_from_wallet numeric; v_new_bal numeric;
BEGIN
  IF p_order_table NOT IN ('shop_orders','ussd_orders','ussd_shop_orders') THEN RAISE EXCEPTION 'BAD_TABLE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_paid IS NULL OR p_amount > p_paid THEN RAISE EXCEPTION 'BAD_AMOUNT'; END IF;
  v_fk := CASE p_order_table
            WHEN 'shop_orders' THEN 'shop_order_id'
            WHEN 'ussd_orders' THEN 'ussd_order_id'
            ELSE 'ussd_shop_order_id' END;

  -- Same lock the dispatch claim takes: exactly one of refund/dispatch wins.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  EXECUTE format('SELECT order_status, payment_status FROM %I WHERE id = $1 FOR UPDATE', p_order_table)
    INTO v_status, v_pay USING p_order_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_status <> 'pending' OR v_pay <> 'completed' THEN RAISE EXCEPTION 'ORDER_NOT_PENDING'; END IF;
  IF EXISTS (SELECT 1 FROM order_refunds WHERE order_id = p_order_id AND status <> 'failed') THEN
    RAISE EXCEPTION 'ALREADY_REFUNDED';
  END IF;
  SELECT last_outcome INTO v_outcome FROM order_dispatch_claims WHERE order_id = p_order_id;
  IF v_outcome IN ('claimed','unknown') THEN RAISE EXCEPTION 'DISPATCH_ACTIVE'; END IF;

  -- refund row first: shop_profits.refund_id references it
  INSERT INTO order_refunds (id, order_table, order_id, gateway, paid_amount, gateway_fee, amount,
                             destination_phone, wallet_user_id, status, admin_id)
  VALUES (v_refund_id, p_order_table, p_order_id, p_gateway, p_paid, COALESCE(p_fee,0), p_amount,
          p_destination, p_wallet_user, 'reserved', p_admin);

  -- Owners in fixed (shop_id) order => deterministic lock order, no deadlocks.
  FOR r IN EXECUTE format(
    'SELECT shop_id,
            COALESCE(SUM(profit_amount) FILTER (WHERE status = ''credited''), 0) AS credited,
            COALESCE(SUM(profit_amount) FILTER (WHERE status = ''pending''), 0)  AS pending
       FROM shop_profits WHERE %I = $1 AND refund_id IS NULL
      GROUP BY shop_id ORDER BY shop_id', v_fk) USING p_order_id
  LOOP
    CONTINUE WHEN r.credited = 0 AND r.pending = 0;
    SELECT user_id INTO v_owner FROM user_shops WHERE id = r.shop_id;
    v_from_profit := 0; v_from_wallet := 0;

    IF r.credited > 0 THEN
      PERFORM sync_shop_balance(r.shop_id);
      SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = r.shop_id FOR UPDATE;
      v_from_profit := LEAST(r.credited, GREATEST(COALESCE(v_avail, 0), 0));
      v_from_wallet := r.credited - v_from_profit;

      IF v_from_wallet > 0 THEN
        UPDATE wallets SET balance = balance - v_from_wallet, updated_at = now()
         WHERE user_id = v_owner AND balance >= v_from_wallet
        RETURNING balance INTO v_new_bal;
        IF NOT FOUND OR v_owner IS NULL THEN
          RAISE EXCEPTION 'SHORTFALL:%:%', r.shop_id, v_from_wallet;
        END IF;
        INSERT INTO transactions (user_id, amount, type, status, description, reference_id, source,
                                  balance_before, balance_after, created_at)
        VALUES (v_owner, v_from_wallet, 'debit', 'completed', 'Order refund clawback',
                'REFUND_CLAWBACK_' || v_refund_id || '_' || r.shop_id, 'refund_clawback',
                v_new_bal + v_from_wallet, v_new_bal, now());
      END IF;

      IF v_from_profit > 0 THEN
        INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, description, created_at, updated_at)
        VALUES (r.shop_id, -v_from_profit, 'credited', v_refund_id, 'Order refund reversal', now(), now());
      END IF;
    END IF;

    IF r.pending <> 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, description, created_at, updated_at)
      VALUES (r.shop_id, -r.pending, 'pending', v_refund_id, 'Order refund reversal (pending portion)', now(), now());
    END IF;

    v_lines := v_lines || jsonb_build_object(
      'shop_id', r.shop_id, 'owner_user_id', v_owner,
      'credited', r.credited, 'pending', r.pending,
      'from_profit', v_from_profit, 'from_wallet', v_from_wallet);
  END LOOP;

  UPDATE order_refunds SET clawbacks = v_lines, updated_at = now() WHERE id = v_refund_id;

  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''refunding'', updated_at = now() WHERE id = $1', p_order_table)
    USING p_order_id;

  RETURN jsonb_build_object('refund_id', v_refund_id, 'clawbacks', v_lines);
END $$;

-- ───────────────────── settle / compensate ─────────────────────
CREATE OR REPLACE FUNCTION public.mark_refund_processing(
  p_refund_id uuid, p_gateway_ref text, p_note text, p_status text DEFAULT 'processing')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('processing','awaiting_otp') THEN RAISE EXCEPTION 'BAD_STATUS'; END IF;
  UPDATE order_refunds
     SET status = p_status, gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = p_note, updated_at = now()
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp');
END $$;

CREATE OR REPLACE FUNCTION public.complete_order_refund(p_refund_id uuid, p_gateway_ref text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_table text; v_order uuid;
BEGIN
  SELECT order_table, order_id INTO v_table, v_order FROM order_refunds
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp') FOR UPDATE;
  IF v_table IS NULL THEN RETURN; END IF;
  UPDATE order_refunds SET status = 'completed', gateway_ref = COALESCE(p_gateway_ref, gateway_ref),
         error = NULL, completed_at = now(), updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''refunded'', updated_at = now() WHERE id = $1', v_table) USING v_order;
END $$;

CREATE OR REPLACE FUNCTION public.fail_order_refund(p_refund_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_table text; v_order uuid; v_lines jsonb;
  l jsonb; v_wallet_new numeric;
BEGIN
  SELECT order_table, order_id, clawbacks INTO v_table, v_order, v_lines FROM order_refunds
   WHERE id = p_refund_id AND status IN ('reserved','processing','awaiting_otp') FOR UPDATE;
  IF v_table IS NULL THEN RETURN; END IF;   -- already failed/completed: idempotent

  FOR l IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    IF (l->>'from_profit')::numeric > 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, description, created_at, updated_at)
      VALUES ((l->>'shop_id')::uuid, (l->>'from_profit')::numeric, 'credited', p_refund_id,
              'Order refund reversal undone', now(), now());
    END IF;
    IF (l->>'pending')::numeric <> 0 THEN
      INSERT INTO shop_profits (shop_id, profit_amount, status, refund_id, description, created_at, updated_at)
      VALUES ((l->>'shop_id')::uuid, (l->>'pending')::numeric, 'pending', p_refund_id,
              'Order refund reversal undone (pending portion)', now(), now());
    END IF;
    IF (l->>'from_wallet')::numeric > 0 THEN
      UPDATE wallets SET balance = balance + (l->>'from_wallet')::numeric, updated_at = now()
       WHERE user_id = (l->>'owner_user_id')::uuid RETURNING balance INTO v_wallet_new;
      INSERT INTO transactions (user_id, amount, type, status, description, reference_id, source,
                                balance_before, balance_after, created_at)
      VALUES ((l->>'owner_user_id')::uuid, (l->>'from_wallet')::numeric, 'credit', 'completed',
              'Order refund clawback restored', 'REFUND_CLAWBACK_UNDO_' || p_refund_id || '_' || (l->>'shop_id'),
              'refund_clawback_undo', v_wallet_new - (l->>'from_wallet')::numeric, v_wallet_new, now());
    END IF;
  END LOOP;

  UPDATE order_refunds SET status = 'failed', error = p_error, updated_at = now() WHERE id = p_refund_id;
  PERFORM set_config('app.refund_rpc', 'on', true);
  EXECUTE format('UPDATE %I SET order_status = ''pending'', updated_at = now() WHERE id = $1', v_table) USING v_order;
END $$;

-- ───────────────────── status guard trigger ─────────────────────
-- A late provider webhook / cron must not move a refunding/refunded order.
CREATE OR REPLACE FUNCTION public.guard_refund_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.order_status IN ('refunding','refunded')
     AND NEW.order_status IS DISTINCT FROM OLD.order_status
     AND COALESCE(current_setting('app.refund_rpc', true), '') <> 'on' THEN
    UPDATE public.order_refunds
       SET late_events = late_events || jsonb_build_object('at', now(), 'attempted_status', NEW.order_status)
     WHERE order_id = OLD.id AND status IN ('reserved','processing','awaiting_otp','completed');
    RAISE WARNING 'refund guard: blocked % -> % on %.%', OLD.order_status, NEW.order_status, TG_TABLE_NAME, OLD.id;
    NEW.order_status := OLD.order_status;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.shop_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.shop_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.ussd_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.ussd_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();
DROP TRIGGER IF EXISTS trg_00_refund_status_guard ON public.ussd_shop_orders;
CREATE TRIGGER trg_00_refund_status_guard BEFORE UPDATE ON public.ussd_shop_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_refund_status();

-- ───────────────────── privileges ─────────────────────
REVOKE EXECUTE ON FUNCTION public.claim_order_dispatch(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_dispatch_outcome(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_refund_processing(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_dispatch(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_dispatch_outcome(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_order_refund(text, uuid, text, numeric, numeric, numeric, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_refund_processing(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_order_refund(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_order_refund(uuid, text) TO service_role;
```

- [ ] **Step 3: Write the rollback-safe SQL test `migrations/tests/20261005_order_refunds_rpc_test.sql`**

It runs inside one transaction and always rolls back. Any failed `ASSERT` aborts the run (non-zero result from the runner).

```sql
BEGIN;
DO $$
DECLARE
  v_shop uuid; v_owner uuid; v_order uuid; v_order2 uuid; v_res jsonb; v_rid uuid;
  v_avail numeric; v_wallet numeric; v_status text; v_claim boolean; v_err text;
BEGIN
  SELECT id, user_id INTO v_shop, v_owner FROM user_shops WHERE user_id IS NOT NULL LIMIT 1;
  ASSERT v_shop IS NOT NULL, 'need at least one shop to run this test';

  INSERT INTO wallets (user_id, balance) VALUES (v_owner, 0)
    ON CONFLICT (user_id) DO UPDATE SET balance = 0;

  -- order 1: owner credited 10, available covers it
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000001','0240000001','MTN','mtn', 12, 'pending', 'completed') RETURNING id INTO v_order;
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order, 10, 'credited');
  SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_avail >= 10, 'sync trigger should have credited the available balance';

  -- (1) happy path: profit covers the cut
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  ASSERT (v_res->'clawbacks'->0->>'from_profit')::numeric = 10, 'cut taken from profit';
  ASSERT (v_res->'clawbacks'->0->>'from_wallet')::numeric = 0, 'no wallet needed';
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'refunding', 'order locked as refunding';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail - 10, 'available balance reduced by the cut';

  -- (2) second reserve on the same order is rejected
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'second reserve must fail';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err IN ('ORDER_NOT_PENDING','ALREADY_REFUNDED'), 'got: ' || v_err;
  END;

  -- (3) dispatch claim is refused while a refund is active
  v_claim := claim_order_dispatch(v_order);
  ASSERT v_claim = false, 'dispatch must be refused for an order being refunded';

  -- (4) late webhook cannot move a refunding order
  UPDATE ussd_orders SET order_status = 'completed' WHERE id = v_order;
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'refunding', 'guard keeps refunding status';
  ASSERT jsonb_array_length((SELECT late_events FROM order_refunds WHERE id = v_rid)) = 1, 'late event recorded';

  -- (5) compensation restores balance and order
  PERFORM fail_order_refund(v_rid, 'gateway said no');
  PERFORM fail_order_refund(v_rid, 'second call is a no-op');
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order;
  ASSERT v_status = 'pending', 'order back to pending';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail, 'available balance fully restored';

  -- (5b) awaiting_otp keeps the clawback; compensation still works from that state
  v_res := reserve_order_refund('ussd_orders', v_order, 'paystack_payout', 12, 0, 12, '0240000001', NULL, NULL);
  v_rid := (v_res->>'refund_id')::uuid;
  PERFORM mark_refund_processing(v_rid, 'TRF_TEST', 'Waiting for the payout OTP', 'awaiting_otp');
  ASSERT (SELECT status FROM order_refunds WHERE id = v_rid) = 'awaiting_otp', 'status awaiting_otp';
  ASSERT (SELECT gateway_ref FROM order_refunds WHERE id = v_rid) = 'TRF_TEST', 'transfer code persisted';
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail - 10, 'clawback still in place while awaiting OTP';
  BEGIN
    PERFORM mark_refund_processing(v_rid, NULL, 'x', 'bogus');
    ASSERT false, 'bad status must be rejected';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'BAD_STATUS', 'got: ' || v_err;
  END;
  PERFORM fail_order_refund(v_rid, 'cancelled before OTP');
  SELECT available_balance INTO v_wallet FROM shop_available_balance WHERE shop_id = v_shop;
  ASSERT v_wallet = v_avail, 'cancel from awaiting_otp restores the balance';

  -- (6) dispatch in flight blocks a refund
  ASSERT claim_order_dispatch(v_order) = true, 'claim allowed after failed refund';
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
    ASSERT false, 'reserve must fail while claimed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err = 'DISPATCH_ACTIVE', 'got: ' || v_err;
  END;
  PERFORM record_dispatch_outcome(v_order, 'failed');
  v_res := reserve_order_refund('ussd_orders', v_order, 'wallet', 12, 0, 12, NULL, NULL, NULL);
  ASSERT v_res->>'refund_id' IS NOT NULL, 'refund allowed once dispatch outcome is failed';
  PERFORM fail_order_refund((v_res->>'refund_id')::uuid, 'cleanup');

  -- (7) shortfall: cut larger than available + wallet is blocked and leaves no trace
  INSERT INTO ussd_orders (dialing_phone, recipient_phone, network, paystack_provider, amount, order_status, payment_status)
    VALUES ('0240000002','0240000002','MTN','mtn', 100000, 'pending', 'completed') RETURNING id INTO v_order2;
  INSERT INTO shop_profits (shop_id, ussd_order_id, profit_amount, status) VALUES (v_shop, v_order2, 99999, 'credited');
  UPDATE shop_profits SET status = 'withdrawn' WHERE ussd_order_id = v_order2 AND false;  -- keep credited
  SELECT available_balance INTO v_avail FROM shop_available_balance WHERE shop_id = v_shop;
  UPDATE wallets SET balance = 0 WHERE user_id = v_owner;
  -- force available to zero by recording a large completed withdrawal
  INSERT INTO withdrawal_requests (shop_id, user_id, amount, withdrawal_method, status)
    VALUES (v_shop, v_owner, v_avail, 'wallet', 'completed');
  BEGIN
    PERFORM reserve_order_refund('ussd_orders', v_order2, 'wallet', 100000, 0, 100000, NULL, NULL, NULL);
    ASSERT false, 'shortfall must block';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    ASSERT v_err LIKE 'SHORTFALL:%', 'got: ' || v_err;
  END;
  EXECUTE 'SELECT order_status FROM ussd_orders WHERE id = $1' INTO v_status USING v_order2;
  ASSERT v_status = 'pending', 'order untouched after shortfall';
  ASSERT NOT EXISTS (SELECT 1 FROM order_refunds WHERE order_id = v_order2), 'no refund row after shortfall';
END $$;
ROLLBACK;
```

- [ ] **Step 4: Get user approval, then apply and test**

Ask the user: "Apply `migrations/20261005_order_refunds.sql` to the production database?" On approval, run the migration with the Management API SQL runner, then run the test file through the same runner.
Expected: migration succeeds; test file returns no error. On any `ASSERT` failure, fix the RPC and re-apply (`CREATE OR REPLACE` is idempotent).

- [ ] **Step 5: Verify the privilege lockdown**

Run via the SQL runner:
```sql
select has_function_privilege('anon', 'public.reserve_order_refund(text,uuid,text,numeric,numeric,numeric,text,uuid,uuid)', 'execute') as anon_exec,
       has_function_privilege('authenticated', 'public.fail_order_refund(uuid,text)', 'execute') as auth_exec,
       has_function_privilege('service_role', 'public.reserve_order_refund(text,uuid,text,numeric,numeric,numeric,text,uuid,uuid)', 'execute') as svc_exec;
```
Expected: `false | false | true`.

- [ ] **Step 6: Commit**

```bash
git add migrations/20261005_order_refunds.sql migrations/tests/20261005_order_refunds_rpc_test.sql
git commit -m "feat(refunds): refund ledger, dispatch claims, atomic RPCs and status guard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Gateway adapters and registry

**Files:**
- Create: `lib/refunds/gateways/paystack.ts`, `lib/refunds/gateways/paystack-payout.ts`, `lib/refunds/gateways/moolre.ts`, `lib/refunds/gateways/wallet.ts`, `lib/refunds/gateways/index.ts`
- Test: `lib/refunds/gateways/gateways.test.ts`

**Interfaces:**
- Consumes: `RefundGateway`, `RefundContext`, `GatewayOutcome`, `RefundableOrder` (Task 1); `refundTransaction(reference, amountGhs?)` from `lib/paystack.ts`; `initiateTransfer`, `getTransferStatus` from `lib/moolre-transfer.ts`; `detectGhanaNetwork` from `lib/phone-format.ts`; RPC `credit_wallet_safely`.
- Also consumes `createRecipient`, `initiateTransfer`, `finalizeTransfer`, `getTransferStatus`, `mapNetworkToPaystackBankCode` from `lib/paystack-transfer.ts`.
- Produces: `paystackGateway`, `paystackPayoutGateway`, `moolreGateway`, `walletGateway`, `getGateway(id): RefundGateway | undefined`, `listGateways(): RefundGateway[]`, `momoNetworkForMoolre(phone): "MTN"|"TELECEL"|"AT"|null`.

- [ ] **Step 1: Write the failing tests `lib/refunds/gateways/gateways.test.ts`**

```ts
import type { RefundableOrder, RefundContext } from "../types"

const refundTransaction = vi.fn()
const moolreTransfer = vi.fn()
const moolreStatus = vi.fn()
const rpc = vi.fn()

vi.mock("@/lib/paystack", () => ({ refundTransaction: (...a: unknown[]) => refundTransaction(...a) }))
vi.mock("@/lib/moolre-transfer", () => ({
  initiateTransfer: (...a: unknown[]) => moolreTransfer(...a),
  getTransferStatus: (...a: unknown[]) => moolreStatus(...a),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }))

const createRecipient = vi.fn()
const psTransfer = vi.fn()
const psFinalize = vi.fn()
const psStatus = vi.fn()
vi.mock("@/lib/paystack-transfer", () => ({
  createRecipient: (...a: unknown[]) => createRecipient(...a),
  initiateTransfer: (...a: unknown[]) => psTransfer(...a),
  finalizeTransfer: (...a: unknown[]) => psFinalize(...a),
  getTransferStatus: (...a: unknown[]) => psStatus(...a),
  mapNetworkToPaystackBankCode: (n: string) => ({ MTN: "MTN", TELECEL: "VOD", AT: "ATL" } as Record<string, string>)[n.toUpperCase()],
}))

import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway, momoNetworkForMoolre } from "./moolre"
import { walletGateway } from "./wallet"
import { getGateway, listGateways } from "./index"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: null, shopName: null, packageLabel: "2", network: "MTN", recipientPhone: "0241112222",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0,
  payment: { gateway: "paystack", reference: "ref-1", payerPhone: "0241112222", walletUserId: null },
  owners: [], evidence: { hasActiveRefund: false, dispatchOutcome: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})
const ctx = (o: Partial<RefundableOrder> = {}, amount = 9.5): RefundContext => ({
  refundId: "rf-1", order: order(o), amount, destinationPhone: "0241112222",
})

beforeEach(() => vi.clearAllMocks())

describe("registry", () => {
  it("lists every adapter and resolves by id", () => {
    expect(listGateways().map((g) => g.id).sort()).toEqual(["moolre", "paystack", "paystack_payout", "wallet"])
    expect(getGateway("moolre")).toBe(moolreGateway)
    expect(getGateway("nope")).toBeUndefined()
  })
})

describe("paystackGateway", () => {
  it("is only supported for orders paid via Paystack with a reference", () => {
    expect(paystackGateway.supports(order()).ok).toBe(true)
    expect(paystackGateway.supports(order({ payment: { gateway: "wallet", reference: null, payerPhone: null, walletUserId: "u" } })).ok).toBe(false)
    expect(paystackGateway.supports(order({ payment: { gateway: null, reference: null, payerPhone: null, walletUserId: null } })).ok).toBe(false)
  })
  it("refunds the original reference with the chosen amount", async () => {
    refundTransaction.mockResolvedValue({ id: 99, status: "pending" })
    const out = await paystackGateway.refund(ctx())
    expect(refundTransaction).toHaveBeenCalledWith("ref-1", 9.5)
    expect(out).toEqual({ kind: "completed", ref: "99" })
  })
  it("maps an API rejection to failed", async () => {
    refundTransaction.mockRejectedValue(new Error("Transaction has already been fully reversed"))
    expect(await paystackGateway.refund(ctx())).toEqual({ kind: "failed", error: "Transaction has already been fully reversed" })
  })
  it("maps a network failure to unknown (money may have moved)", async () => {
    refundTransaction.mockRejectedValue(new TypeError("fetch failed"))
    expect((await paystackGateway.refund(ctx())).kind).toBe("unknown")
  })
})

describe("paystackPayoutGateway", () => {
  it("needs a payer number on a recognised MoMo network", () => {
    expect(paystackPayoutGateway.supports(order()).ok).toBe(true)
    expect(paystackPayoutGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } })).ok).toBe(false)
    expect(paystackPayoutGateway.supports(order({ payment: { gateway: null, reference: null, payerPhone: "0111112222", walletUserId: null } })).ok).toBe(false)
  })

  it("creates a mobile_money recipient, then a transfer keyed by the refund id, and returns otp", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    psTransfer.mockResolvedValue({ status: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    const out = await paystackPayoutGateway.refund(ctx())
    expect(createRecipient).toHaveBeenCalledWith(expect.objectContaining({ accountNumber: "0241112222", bankCode: "MTN", type: "mobile_money" }))
    expect(psTransfer).toHaveBeenCalledWith(expect.objectContaining({ recipientCode: "RCP_1", amount: 9.5, reference: "rf-1" }))
    expect(out).toEqual({ kind: "otp", ref: "TRF_1" })
  })

  it("maps the other transfer statuses", async () => {
    createRecipient.mockResolvedValue({ recipientCode: "RCP_1" })
    psTransfer.mockResolvedValue({ status: "success", transferCode: "TRF_2", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "completed", ref: "TRF_2" })
    psTransfer.mockResolvedValue({ status: "pending", transferCode: "TRF_3", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "pending", ref: "TRF_3" })
    psTransfer.mockResolvedValue({ status: "failed", transferCode: "", transactionReference: "rf-1", fee: 0, errorMessage: "Insufficient balance" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Insufficient balance" })
    psTransfer.mockResolvedValue(null)
    expect((await paystackPayoutGateway.refund(ctx())).kind).toBe("unknown")
  })

  it("fails definitively (nothing sent) when the recipient cannot be created", async () => {
    createRecipient.mockResolvedValue({ error: "Invalid bank code" })
    expect(await paystackPayoutGateway.refund(ctx())).toEqual({ kind: "failed", error: "Invalid bank code" })
    expect(psTransfer).not.toHaveBeenCalled()
  })

  it("finalizes with the admin's OTP; a rejected OTP stays awaiting (never failed)", async () => {
    psFinalize.mockResolvedValue({ status: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "completed", ref: "TRF_1" })
    expect(psFinalize).toHaveBeenCalledWith("TRF_1", "123456")

    psFinalize.mockResolvedValue({ status: "failed", transferCode: "TRF_1", transactionReference: "", fee: 0, errorMessage: "Invalid OTP" })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "000000")).toEqual({ kind: "otp", ref: "TRF_1" })

    psFinalize.mockResolvedValue({ status: "pending", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).toEqual({ kind: "pending", ref: "TRF_1" })
    psFinalize.mockResolvedValue(null)
    expect((await paystackPayoutGateway.finalizeOtp!(ctx(), "TRF_1", "123456")).kind).toBe("unknown")
  })

  it("reconciles by transfer reference (the refund id)", async () => {
    psStatus.mockResolvedValue({ status: "success", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect(await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).toEqual({ kind: "completed", ref: "TRF_1" })
    psStatus.mockResolvedValue({ status: "otp", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0 })
    expect((await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).kind).toBe("otp")
    psStatus.mockResolvedValue({ status: "failed", transferCode: "TRF_1", transactionReference: "rf-1", fee: 0, errorMessage: "reversed" })
    expect(await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).toEqual({ kind: "failed", error: "reversed" })
    psStatus.mockResolvedValue(null)
    expect((await paystackPayoutGateway.checkStatus!(ctx(), "TRF_1")).kind).toBe("unknown")
  })
})

describe("moolreGateway", () => {
  it("maps phone prefixes to Moolre networks", () => {
    expect(momoNetworkForMoolre("0241112222")).toBe("MTN")
    expect(momoNetworkForMoolre("0201112222")).toBe("TELECEL")
    expect(momoNetworkForMoolre("0271112222")).toBe("AT")
    expect(momoNetworkForMoolre("0111112222")).toBeNull()
  })
  it("is unsupported when there is no usable payer number", () => {
    expect(moolreGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: null, walletUserId: null } })).ok).toBe(false)
  })
  it("uses the refund id as the idempotency reference and maps txstatus", async () => {
    moolreTransfer.mockResolvedValue({ txstatus: 1, transactionId: "T1", externalref: "rf-1", fee: 0 })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "completed", ref: "T1" })
    expect(moolreTransfer).toHaveBeenCalledWith(expect.objectContaining({ externalref: "rf-1", phone: "0241112222", network: "MTN", amount: 9.5 }))

    moolreTransfer.mockResolvedValue({ txstatus: 0, transactionId: "T2", externalref: "rf-1", fee: 0 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("pending")
    moolreTransfer.mockResolvedValue({ txstatus: 2, transactionId: "", externalref: "rf-1", fee: 0, errorMessage: "rejected" })
    expect(await moolreGateway.refund(ctx())).toEqual({ kind: "failed", error: "rejected" })
    moolreTransfer.mockResolvedValue({ txstatus: 3, transactionId: "", externalref: "rf-1", fee: 0 })
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
    moolreTransfer.mockResolvedValue(null)
    expect((await moolreGateway.refund(ctx())).kind).toBe("unknown")
  })
  it("reconciles by external reference", async () => {
    moolreStatus.mockResolvedValue({ txstatus: 1, transactionId: "T9", externalref: "rf-1" })
    expect(await moolreGateway.checkStatus!(ctx(), null)).toEqual({ kind: "completed", ref: "T9" })
    moolreStatus.mockResolvedValue(null)
    expect((await moolreGateway.checkStatus!(ctx(), null)).kind).toBe("unknown")
  })
})

describe("walletGateway", () => {
  const walletOrder = { payment: { gateway: "wallet" as const, reference: null, payerPhone: null, walletUserId: "u1" } }
  it("requires a resolvable wallet owner", () => {
    expect(walletGateway.supports(order(walletOrder)).ok).toBe(true)
    expect(walletGateway.supports(order({ payment: { gateway: "paystack", reference: "r", payerPhone: "024", walletUserId: null } })).ok).toBe(false)
  })
  it("credits idempotently by refund id", async () => {
    rpc.mockResolvedValue({ data: [{ new_balance: 20, already_processed: false }], error: null })
    const out = await walletGateway.refund({ ...ctx(walletOrder), destinationPhone: null })
    expect(rpc).toHaveBeenCalledWith("credit_wallet_safely", expect.objectContaining({
      p_user_id: "u1", p_amount: 9.5, p_reference_id: "REFUND_rf-1",
    }))
    expect(out).toEqual({ kind: "completed", ref: "REFUND_rf-1" })
  })
  it("treats an RPC error as unknown (the credit is idempotent so a re-check is safe)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "timeout" } })
    expect((await walletGateway.refund({ ...ctx(walletOrder), destinationPhone: null })).kind).toBe("unknown")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/refunds/gateways`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the adapters**

`lib/refunds/gateways/paystack.ts`:

```ts
import { refundTransaction } from "@/lib/paystack"
import type { RefundGateway } from "../types"

export const paystackGateway: RefundGateway = {
  id: "paystack",
  label: "Paystack (reverse original charge)",
  supports(order) {
    if (order.payment.gateway === "paystack" && order.payment.reference) return { ok: true }
    return { ok: false, reason: "Order was not paid through Paystack" }
  },
  async refund(ctx) {
    try {
      const data = await refundTransaction(ctx.order.payment.reference!, ctx.amount)
      return { kind: "completed", ref: String(data?.id ?? ctx.order.payment.reference) }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Paystack refund failed"
      // fetch() throws TypeError when the request never got an answer: the refund may or may not exist.
      if (err instanceof TypeError) return { kind: "unknown", error: message }
      return { kind: "failed", error: message }
    }
  },
}
```

`lib/refunds/gateways/paystack-payout.ts` (the OTP-enabled MoMo payout; reuses `lib/refunds/gateways/moolre.ts`'s `momoNetworkForMoolre` for prefix → network):

```ts
import {
  createRecipient, initiateTransfer, finalizeTransfer, getTransferStatus,
  mapNetworkToPaystackBankCode, type PaystackTransferResult,
} from "@/lib/paystack-transfer"
import { momoNetworkForMoolre } from "./moolre"
import type { GatewayOutcome, RefundGateway } from "../types"

function toOutcome(r: PaystackTransferResult | null, fallbackRef: string): GatewayOutcome {
  if (!r) return { kind: "unknown", error: "Paystack did not answer — check status before retrying" }
  const ref = r.transferCode || fallbackRef
  switch (r.status) {
    case "success": return { kind: "completed", ref }
    case "pending": return { kind: "pending", ref }
    case "otp": return { kind: "otp", ref }
    default: return { kind: "failed", error: r.errorMessage || "Paystack rejected the transfer" }
  }
}

export const paystackPayoutGateway: RefundGateway = {
  id: "paystack_payout",
  label: "Paystack (MoMo payout, needs OTP)",
  supports(order) {
    const phone = order.payment.payerPhone
    if (!phone) return { ok: false, reason: "No payer number on the order" }
    const network = momoNetworkForMoolre(phone)
    if (!network || !mapNetworkToPaystackBankCode(network)) return { ok: false, reason: "Payer number is not a recognised MoMo network" }
    return { ok: true }
  },
  async refund(ctx) {
    const phone = ctx.destinationPhone
    const network = phone ? momoNetworkForMoolre(phone) : null
    const bankCode = network ? mapNetworkToPaystackBankCode(network) : undefined
    if (!phone || !bankCode) return { kind: "failed", error: "No valid MoMo number to pay out to" }

    const recipient = await createRecipient({ name: "Datagod customer refund", accountNumber: phone, bankCode, type: "mobile_money" })
    if (!recipient.recipientCode) return { kind: "failed", error: recipient.error ?? "Could not create Paystack recipient" }

    // reference = refund id: Paystack rejects a duplicate reference, so a double click cannot pay twice.
    const result = await initiateTransfer({
      recipientCode: recipient.recipientCode, amount: ctx.amount, reference: ctx.refundId,
      reason: `Datagod refund ${ctx.refundId.slice(0, 8)}`,
    })
    return toOutcome(result, ctx.refundId)
  },
  async finalizeOtp(_ctx, gatewayRef, otp) {
    const result = await finalizeTransfer(gatewayRef, otp)
    // finalizeTransfer reports every non-2xx (including a mistyped OTP) as "failed". A bad code does
    // NOT cancel the transfer — it stays awaiting OTP — so never treat it as a definitive failure.
    if (result && result.status === "failed") return { kind: "otp", ref: gatewayRef }
    return toOutcome(result, gatewayRef)
  },
  async checkStatus(ctx, gatewayRef) {
    return toOutcome(await getTransferStatus(ctx.refundId), gatewayRef ?? ctx.refundId)
  },
}
```

`lib/refunds/gateways/moolre.ts`:

```ts
import { initiateTransfer, getTransferStatus } from "@/lib/moolre-transfer"
import { detectGhanaNetwork } from "@/lib/phone-format"
import type { GatewayOutcome, RefundGateway } from "../types"

export function momoNetworkForMoolre(phone: string): "MTN" | "TELECEL" | "AT" | null {
  const n = detectGhanaNetwork(phone)
  return n === "UNKNOWN" ? null : n
}

function fromTxStatus(txstatus: number, ref: string, error?: string): GatewayOutcome {
  if (txstatus === 1) return { kind: "completed", ref }
  if (txstatus === 0) return { kind: "pending", ref }
  if (txstatus === 2) return { kind: "failed", error: error || "Moolre rejected the transfer" }
  return { kind: "unknown", error: "Moolre returned an unknown transfer status" }
}

export const moolreGateway: RefundGateway = {
  id: "moolre",
  label: "Moolre (MoMo payout to payer)",
  supports(order) {
    const phone = order.payment.payerPhone
    if (!phone) return { ok: false, reason: "No payer number on the order" }
    if (!momoNetworkForMoolre(phone)) return { ok: false, reason: "Payer number is not a recognised MoMo network" }
    return { ok: true }
  },
  async refund(ctx) {
    const phone = ctx.destinationPhone
    const network = phone ? momoNetworkForMoolre(phone) : null
    if (!phone || !network) return { kind: "failed", error: "No valid MoMo number to pay out to" }
    const result = await initiateTransfer({
      phone, network, amount: ctx.amount, externalref: ctx.refundId,
      reference: `Datagod refund ${ctx.refundId.slice(0, 8)}`,
    })
    if (!result) return { kind: "unknown", error: "Moolre did not answer — check status before retrying" }
    return fromTxStatus(result.txstatus, result.transactionId, result.errorMessage)
  },
  async checkStatus(ctx) {
    const result = await getTransferStatus(ctx.refundId)
    if (!result) return { kind: "unknown", error: "Could not reach Moolre to check status" }
    return fromTxStatus(result.txstatus, result.transactionId)
  },
}
```

`lib/refunds/gateways/wallet.ts`:

```ts
import { createClient } from "@supabase/supabase-js"
import type { RefundContext, RefundGateway, GatewayOutcome } from "../types"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// credit_wallet_safely is idempotent on (user, reference), so calling it again after an
// ambiguous result can never double-credit — which is why errors here are "unknown", not "failed".
async function credit(ctx: RefundContext): Promise<GatewayOutcome> {
  const reference = `REFUND_${ctx.refundId}`
  const { error } = await supabase.rpc("credit_wallet_safely", {
    p_user_id: ctx.order.payment.walletUserId,
    p_amount: ctx.amount,
    p_reference_id: reference,
    p_description: "Order refund",
    p_source: "order_refund",
  })
  if (error) return { kind: "unknown", error: error.message }
  return { kind: "completed", ref: reference }
}

export const walletGateway: RefundGateway = {
  id: "wallet",
  label: "Customer wallet",
  supports(order) {
    if (order.payment.walletUserId) return { ok: true }
    return { ok: false, reason: "Payer has no Datagod account/wallet" }
  },
  refund: credit,
  checkStatus: (ctx) => credit(ctx),
}
```

`lib/refunds/gateways/index.ts`:

```ts
import type { RefundGateway } from "../types"
import { paystackGateway } from "./paystack"
import { paystackPayoutGateway } from "./paystack-payout"
import { moolreGateway } from "./moolre"
import { walletGateway } from "./wallet"

// To add a gateway: implement RefundGateway in its own file and append it here.
const GATEWAYS: RefundGateway[] = [paystackGateway, paystackPayoutGateway, moolreGateway, walletGateway]

export const listGateways = (): RefundGateway[] => GATEWAYS
export const getGateway = (id: string): RefundGateway | undefined => GATEWAYS.find((g) => g.id === id)
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/refunds/gateways`
Expected: PASS. Then `npx tsc --noEmit -p .` — no errors in `lib/refunds/**`.

- [ ] **Step 5: Commit**

```bash
git add lib/refunds/gateways
git commit -m "feat(refunds): pluggable gateway adapters (Paystack, Moolre, wallet)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Order loader (payment source, owners, provider evidence)

**Files:**
- Create: `lib/refunds/orders.ts`
- Test: `lib/refunds/orders.test.ts`

**Interfaces:**
- Consumes: `RefundableOrder`, `OrderTable`, `OwnerCut`, `PaymentSource` (Task 1).
- Produces:
  - `loadRefundableOrders(db: SupabaseClient, refs: { table: OrderTable; id: string }[]): Promise<RefundableOrder[]>` (chunked by 100 internally)
  - `listPendingOrderRefs(db, opts: { table?: OrderTable; shopId?: string; q?: string; pageSize: number; page: number }): Promise<{ table: OrderTable; id: string }[]>` — pending + paid orders across the three tables, newest first (merged page).
  - `resolveWalletUser(db, { phone, email }): Promise<string | null>`

Table facts the code relies on (verified in the repo): order columns — `shop_orders(id, shop_id, customer_phone, customer_email, network, volume_gb, total_price, order_status, payment_status, external_order_id, created_at)`; `ussd_orders(id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at)`; `ussd_shop_orders(` same plus `shop_id)`. Profit FK columns: `shop_order_id`, `ussd_order_id`, `ussd_shop_order_id`. Tracking: `mtn_fulfillment_tracking.shop_order_id` for shop orders, `.order_id` (varchar) for the USSD tables. Paystack evidence: `wallet_payments(order_id, reference, amount, status)` for shop orders; `paystack_reference` (which equals the order id for USSD) for USSD tables. Wallet evidence: `transactions(reference_id, user_id, type='debit')` where `reference_id` = USSD order id. Fee: `payment_attempts(reference, fee)`. Wallet owner lookup: `users.phone_number` (local `0XXXXXXXXX` format) / `users.email`.

- [ ] **Step 1: Write the failing test `lib/refunds/orders.test.ts`** using a fake client with canned per-table results.

```ts
import { loadRefundableOrders } from "./orders"

type Rows = Record<string, unknown[]>

// Minimal chainable fake: every query builder is thenable and returns the canned rows for its table.
function fakeDb(rows: Rows) {
  const make = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, is: () => q, neq: () => q,
      order: () => q, range: () => q, ilike: () => q, or: () => q,
      maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res),
    }
    return q
  }
  return { from: (t: string) => make(t) } as any
}

describe("loadRefundableOrders", () => {
  it("builds a ussd_shop order with a paystack payment, sub-agent owners and failed tracking", async () => {
    const db = fakeDb({
      ussd_shop_orders: [{
        id: "o1", shop_id: "shopA", dialing_phone: "0241112222", recipient_phone: "0243334444",
        network: "MTN", package_size: "2", amount: 12, order_status: "pending", payment_status: "completed",
        paystack_reference: "o1", created_at: "2026-10-05T00:00:00Z",
      }],
      user_shops: [{ id: "shopA", shop_name: "Alpha", user_id: "uA" }, { id: "shopP", shop_name: "Parent", user_id: "uP" }],
      shop_profits: [
        { ussd_shop_order_id: "o1", shop_id: "shopA", profit_amount: 3, status: "credited" },
        { ussd_shop_order_id: "o1", shop_id: "shopP", profit_amount: 2, status: "credited" },
      ],
      shop_available_balance: [{ shop_id: "shopA", available_balance: 10 }, { shop_id: "shopP", available_balance: 0 }],
      wallets: [{ user_id: "uA", balance: 0 }, { user_id: "uP", balance: 5 }],
      transactions: [],
      payment_attempts: [{ reference: "o1", fee: 0.18 }],
      mtn_fulfillment_tracking: [{ order_id: "o1", status: "failed" }],
      order_dispatch_claims: [{ order_id: "o1", last_outcome: "submitted" }],
      order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_shop_orders", id: "o1" }])
    expect(o.payment).toMatchObject({ gateway: "paystack", reference: "o1", payerPhone: "0241112222" })
    expect(o.paid).toBe(12)
    expect(o.gatewayFee).toBe(0.18)
    expect(o.owners.map((x) => [x.shopId, x.credited, x.availableBalance, x.walletBalance])).toEqual([
      ["shopA", 3, 10, 0], ["shopP", 2, 0, 5],
    ])
    expect(o.evidence).toMatchObject({ trackingStatuses: ["failed"], dispatchOutcome: "submitted", hasActiveRefund: false })
  })

  it("detects a wallet-paid ussd order from the wallet debit transaction", async () => {
    const db = fakeDb({
      ussd_orders: [{
        id: "o2", dialing_phone: "0241112222", recipient_phone: "0241112222", network: "MTN", package_size: "1",
        amount: 6, order_status: "pending", payment_status: "completed", paystack_reference: null, created_at: "2026-10-05T00:00:00Z",
      }],
      transactions: [{ reference_id: "o2", user_id: "uW", type: "debit" }],
      user_shops: [], shop_profits: [], shop_available_balance: [], wallets: [],
      payment_attempts: [], mtn_fulfillment_tracking: [], order_dispatch_claims: [], order_refunds: [],
    })
    const [o] = await loadRefundableOrders(db, [{ table: "ussd_orders", id: "o2" }])
    expect(o.payment).toMatchObject({ gateway: "wallet", walletUserId: "uW" })
    expect(o.owners).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/refunds/orders.test.ts`
Expected: FAIL — `./orders` not found.

- [ ] **Step 3: Write `lib/refunds/orders.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { DispatchOutcome, OrderTable, OwnerCut, PaymentSource, RefundableOrder } from "./types"

const CHUNK = 100
const PROFIT_FK: Record<OrderTable, string> = {
  shop_orders: "shop_order_id",
  ussd_orders: "ussd_order_id",
  ussd_shop_orders: "ussd_shop_order_id",
}
const TRACKING_COL: Record<OrderTable, string> = {
  shop_orders: "shop_order_id",
  ussd_orders: "order_id",
  ussd_shop_orders: "order_id",
}

const SELECT: Record<OrderTable, string> = {
  shop_orders:
    "id, shop_id, customer_phone, customer_email, network, volume_gb, total_price, order_status, payment_status, external_order_id, created_at",
  ussd_orders:
    "id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
  ussd_shop_orders:
    "id, shop_id, dialing_phone, recipient_phone, network, package_size, amount, order_status, payment_status, paystack_reference, created_at",
}

const chunk = <T,>(arr: T[], n = CHUNK): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

async function inRows<T>(db: SupabaseClient, table: string, select: string, col: string, ids: string[], extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  for (const part of chunk(ids)) {
    let q: any = db.from(table).select(select).in(col, part)
    if (extra) q = extra(q)
    const { data, error } = await q
    if (error) throw new Error(`[REFUND] ${table} lookup failed: ${error.message}`)
    out.push(...((data ?? []) as T[]))
  }
  return out
}

export async function resolveWalletUser(
  db: SupabaseClient,
  who: { phone?: string | null; email?: string | null }
): Promise<string | null> {
  if (who.phone) {
    const d = who.phone.replace(/\D/g, "").slice(-9)
    if (d.length === 9) {
      const { data } = await db.from("users").select("id").eq("phone_number", "0" + d).maybeSingle()
      if (data?.id) return data.id as string
    }
  }
  if (who.email) {
    const { data } = await db.from("users").select("id").eq("email", who.email.toLowerCase()).maybeSingle()
    if (data?.id) return data.id as string
  }
  return null
}

export async function loadRefundableOrders(
  db: SupabaseClient,
  refs: { table: OrderTable; id: string }[]
): Promise<RefundableOrder[]> {
  const out: RefundableOrder[] = []
  for (const table of Object.keys(SELECT) as OrderTable[]) {
    const ids = refs.filter((r) => r.table === table).map((r) => r.id)
    if (ids.length === 0) continue
    const rows = await inRows<any>(db, table, SELECT[table], "id", ids)
    out.push(...(await enrich(db, table, rows)))
  }
  return out
}

async function enrich(db: SupabaseClient, table: OrderTable, rows: any[]): Promise<RefundableOrder[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)

  const [profits, tracking, claims, refunds, walletDebits, walletPayments] = await Promise.all([
    inRows<any>(db, "shop_profits", `shop_id, profit_amount, status, ${PROFIT_FK[table]}`, PROFIT_FK[table], ids, (q) => q.is("refund_id", null)),
    inRows<any>(db, "mtn_fulfillment_tracking", `status, ${TRACKING_COL[table]}`, TRACKING_COL[table], ids),
    inRows<any>(db, "order_dispatch_claims", "order_id, last_outcome", "order_id", ids),
    inRows<any>(db, "order_refunds", "order_id, status", "order_id", ids, (q) => q.neq("status", "failed")),
    table === "shop_orders" ? Promise.resolve([] as any[]) : inRows<any>(db, "transactions", "reference_id, user_id, type", "reference_id", ids, (q) => q.eq("type", "debit")),
    table === "shop_orders" ? inRows<any>(db, "wallet_payments", "order_id, reference, amount, status", "order_id", ids) : Promise.resolve([] as any[]),
  ])

  const shopIds = [...new Set([
    ...profits.map((p) => p.shop_id as string),
    ...rows.map((r) => r.shop_id as string | undefined).filter(Boolean) as string[],
  ])]
  const [shops, balances] = await Promise.all([
    shopIds.length ? inRows<any>(db, "user_shops", "id, shop_name, user_id", "id", shopIds) : Promise.resolve([] as any[]),
    shopIds.length ? inRows<any>(db, "shop_available_balance", "shop_id, available_balance", "shop_id", shopIds) : Promise.resolve([] as any[]),
  ])
  const ownerIds = [...new Set(shops.map((s) => s.user_id as string).filter(Boolean))]
  const wallets = ownerIds.length ? await inRows<any>(db, "wallets", "user_id, balance", "user_id", ownerIds) : []

  const paymentRefs = [
    ...walletPayments.map((w) => w.reference as string),
    ...rows.map((r) => (table === "shop_orders" ? null : (r.paystack_reference ?? r.id)) as string | null).filter(Boolean) as string[],
  ]
  const attempts = paymentRefs.length ? await inRows<any>(db, "payment_attempts", "reference, fee", "reference", paymentRefs) : []

  const shopById = new Map(shops.map((s) => [s.id as string, s]))
  const balanceByShop = new Map(balances.map((b) => [b.shop_id as string, Number(b.available_balance)]))
  const walletByUser = new Map(wallets.map((w) => [w.user_id as string, Number(w.balance)]))
  const feeByRef = new Map(attempts.map((a) => [a.reference as string, Number(a.fee ?? 0)]))

  const result: RefundableOrder[] = []
  for (const r of rows) {
    const id = r.id as string
    const orderProfits = profits.filter((p) => p[PROFIT_FK[table]] === id)
    const byShop = new Map<string, { credited: number; pending: number }>()
    for (const p of orderProfits) {
      const cur = byShop.get(p.shop_id) ?? { credited: 0, pending: 0 }
      if (p.status === "credited") cur.credited += Number(p.profit_amount)
      else if (p.status === "pending") cur.pending += Number(p.profit_amount)
      byShop.set(p.shop_id, cur)
    }
    const owners: OwnerCut[] = [...byShop.entries()]
      .filter(([, v]) => v.credited !== 0 || v.pending !== 0)
      .map(([shopId, v]) => {
        const ownerUserId = (shopById.get(shopId)?.user_id as string | undefined) ?? null
        return {
          shopId, ownerUserId, credited: v.credited, pending: v.pending,
          availableBalance: balanceByShop.get(shopId) ?? 0,
          walletBalance: ownerUserId ? walletByUser.get(ownerUserId) ?? 0 : 0,
        }
      })

    let payment: PaymentSource
    let paid: number
    let fee = 0
    if (table === "shop_orders") {
      const wp = walletPayments.find((w) => w.order_id === id && w.status === "completed")
      paid = Number(wp?.amount ?? r.total_price)
      fee = wp ? feeByRef.get(wp.reference) ?? 0 : 0
      payment = {
        gateway: wp ? "paystack" : null,
        reference: wp?.reference ?? null,
        payerPhone: r.customer_phone ?? null,
        walletUserId: await resolveWalletUser(db, { phone: r.customer_phone, email: r.customer_email }),
      }
    } else {
      paid = Number(r.amount)
      const debit = walletDebits.find((t) => t.reference_id === id)
      const reference = (r.paystack_reference as string | null) ?? null
      fee = reference ? feeByRef.get(reference) ?? 0 : 0
      payment = debit
        ? { gateway: "wallet", reference: null, payerPhone: r.dialing_phone, walletUserId: debit.user_id }
        : {
            gateway: reference ? "paystack" : null,
            reference,
            payerPhone: r.dialing_phone ?? null,
            walletUserId: await resolveWalletUser(db, { phone: r.dialing_phone }),
          }
    }

    const claim = claims.find((c) => c.order_id === id)
    result.push({
      table, id,
      orderStatus: r.order_status, paymentStatus: r.payment_status,
      shopId: (r.shop_id as string | undefined) ?? null,
      shopName: r.shop_id ? (shopById.get(r.shop_id)?.shop_name as string | undefined) ?? null : null,
      packageLabel: table === "shop_orders" ? `${r.volume_gb}GB` : String(r.package_size ?? ""),
      network: r.network,
      recipientPhone: (r.recipient_phone ?? r.customer_phone ?? null) as string | null,
      createdAt: r.created_at,
      paid, gatewayFee: fee, payment, owners,
      evidence: {
        hasActiveRefund: refunds.some((x) => x.order_id === id),
        dispatchOutcome: (claim?.last_outcome as DispatchOutcome | undefined) ?? null,
        trackingStatuses: tracking.filter((t) => t[TRACKING_COL[table]] === id).map((t) => t.status as string),
        externalOrderId: (r.external_order_id as string | null | undefined) ?? null,
      },
    })
  }
  return result
}

export interface PendingQuery {
  table?: OrderTable
  shopId?: string
  q?: string
  pageSize: number
  page: number
}

/** Newest-first merged page of paid+pending orders. Each table's top (page*pageSize) rows contain the global top. */
export async function listPendingOrderRefs(db: SupabaseClient, opts: PendingQuery): Promise<{ table: OrderTable; id: string; createdAt: string }[]> {
  const tables = (opts.table ? [opts.table] : (Object.keys(SELECT) as OrderTable[]))
  const need = opts.pageSize * opts.page
  const all: { table: OrderTable; id: string; createdAt: string }[] = []
  for (const table of tables) {
    let q: any = db.from(table).select("id, created_at").eq("order_status", "pending").eq("payment_status", "completed")
    if (opts.shopId && table !== "ussd_orders") q = q.eq("shop_id", opts.shopId)
    if (opts.q) {
      const term = opts.q.replace(/[^0-9a-zA-Z-]/g, "")
      if (term) {
        const cols = table === "shop_orders" ? ["customer_phone"] : ["dialing_phone", "recipient_phone"]
        q = q.or(cols.map((c) => `${c}.ilike.%${term}%`).join(",") + (/^[0-9a-f-]{36}$/i.test(term) ? `,id.eq.${term}` : ""))
      }
    }
    const { data, error } = await q.order("created_at", { ascending: false }).range(0, need - 1)
    if (error) throw new Error(`[REFUND] pending list failed for ${table}: ${error.message}`)
    for (const row of data ?? []) all.push({ table, id: row.id, createdAt: row.created_at })
  }
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return all.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize)
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/refunds/orders.test.ts`
Expected: PASS (2 tests). Then `npx tsc --noEmit -p .` — clean for `lib/refunds/**`.

- [ ] **Step 5: Commit**

```bash
git add lib/refunds/orders.ts lib/refunds/orders.test.ts
git commit -m "feat(refunds): load refundable orders with payment source, owners and provider evidence

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Refund service (preview, execute, retry, reconcile) + notifications + audit

**Files:**
- Create: `lib/refunds/service.ts`, `lib/refunds/notify.ts`
- Test: `lib/refunds/service.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4. RPC names/errors from Task 2.
- Produces:
  - `class RefundError extends Error { code: RefundErrorCode; detail?: unknown }`, `RefundErrorCode = "NOT_FOUND"|"NOT_ELIGIBLE"|"GATEWAY_UNSUPPORTED"|"BAD_AMOUNT"|"SHORTFALL"|"ALREADY_REFUNDED"|"ORDER_NOT_PENDING"|"DISPATCH_ACTIVE"|"RESERVE_FAILED"`
  - `mapReserveError(message: string): RefundError`
  - `interface RefundDeps { rpc(name: string, args: Record<string, unknown>): Promise<{ data: any; error: { message: string } | null }>; loadOrder(table: OrderTable, id: string): Promise<RefundableOrder | null>; getGateway(id: string): RefundGateway | undefined; notify(event: RefundNotification): Promise<void> }`
  - `previewRefund(deps, ref): Promise<RefundPreview>` where `RefundPreview = { order: RefundableOrder; eligibility: Eligibility; defaultAmount: number; gateways: { id: string; label: string; ok: boolean; reason?: string }[]; clawback: ClawbackPlan }`
  - `executeRefund(deps, input: { table: OrderTable; orderId: string; gateway: string; amount: number; adminId: string | null }): Promise<{ refundId: string; status: "completed" | "processing" | "awaiting_otp" | "failed"; message?: string }>`
  - `reconcileRefund(deps, stored: StoredRefund): Promise<Settled>` (accepts `processing` and `awaiting_otp`)
  - `submitRefundOtp(deps, stored: StoredRefund, otp: string): Promise<Settled>` (wrong code → stays `awaiting_otp`, writes nothing)
  - `cancelRefund(deps, stored: StoredRefund): Promise<Settled>` (only `awaiting_otp`; asks the gateway first, refuses if the payout may have gone out)
  - `Settled = { status: "completed" | "processing" | "awaiting_otp" | "failed"; message?: string }`; `StoredRefund` = an `order_refunds` row incl. `clawbacks`; new error code `BAD_OTP`
  - `defaultDeps(db): RefundDeps` wiring the real client + `getGateway` + `notifyRefund`.

- [ ] **Step 1: Write the failing service tests `lib/refunds/service.test.ts`**

```ts
import {
  executeRefund, previewRefund, submitRefundOtp, cancelRefund, reconcileRefund,
  RefundError, mapReserveError, type RefundDeps, type StoredRefund,
} from "./service"
import type { RefundableOrder, RefundGateway, GatewayOutcome } from "./types"

const order = (o: Partial<RefundableOrder> = {}): RefundableOrder => ({
  table: "ussd_shop_orders", id: "o1", orderStatus: "pending", paymentStatus: "completed",
  shopId: "sA", shopName: "Alpha", packageLabel: "2", network: "MTN", recipientPhone: "0243334444",
  createdAt: "2026-10-05", paid: 10, gatewayFee: 0.2,
  payment: { gateway: "paystack", reference: "o1", payerPhone: "0241112222", walletUserId: null },
  owners: [{ shopId: "sA", ownerUserId: "uA", credited: 3, pending: 0, availableBalance: 10, walletBalance: 0 }],
  evidence: { hasActiveRefund: false, dispatchOutcome: null, trackingStatuses: [], externalOrderId: null },
  ...o,
})

function setup(outcome: GatewayOutcome, ord: RefundableOrder | null = order(), reserve?: { data?: any; error?: { message: string } | null }) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = {
    id: "paystack", label: "Paystack", supports: () => ({ ok: true }),
    refund: vi.fn(async () => outcome),
  }
  const deps: RefundDeps = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === "reserve_order_refund") return reserve ? { data: reserve.data ?? null, error: reserve.error ?? null } : { data: { refund_id: "rf1", clawbacks: [] }, error: null }
      return { data: null, error: null }
    },
    loadOrder: async () => ord,
    getGateway: (id) => (id === "paystack" ? gateway : undefined),
    notify: vi.fn(async () => {}),
  }
  return { deps, calls, gateway }
}
const input = { table: "ussd_shop_orders" as const, orderId: "o1", gateway: "paystack", amount: 9.8, adminId: "admin1" }
const names = (calls: { name: string }[]) => calls.map((c) => c.name)

describe("executeRefund", () => {
  it("reserves, pays out, then completes", async () => {
    const { deps, calls, gateway } = setup({ kind: "completed", ref: "R1" })
    const res = await executeRefund(deps, input)
    expect(res).toMatchObject({ refundId: "rf1", status: "completed" })
    expect(names(calls)).toEqual(["reserve_order_refund", "complete_order_refund"])
    expect(calls[0].args).toMatchObject({ p_order_table: "ussd_shop_orders", p_order_id: "o1", p_gateway: "paystack", p_paid: 10, p_amount: 9.8, p_destination: "0241112222", p_admin: "admin1" })
    expect(gateway.refund).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalled()
  })

  it("compensates (fail_order_refund) on a definitive gateway failure", async () => {
    const { deps, calls } = setup({ kind: "failed", error: "declined" })
    const res = await executeRefund(deps, input)
    expect(res).toMatchObject({ status: "failed", message: "declined" })
    expect(names(calls)).toEqual(["reserve_order_refund", "fail_order_refund"])
  })

  it("does NOT compensate on an ambiguous result — stays processing", async () => {
    const { deps, calls } = setup({ kind: "unknown", error: "timeout" })
    const res = await executeRefund(deps, input)
    expect(res.status).toBe("processing")
    expect(names(calls)).toEqual(["reserve_order_refund", "mark_refund_processing"])
    expect(names(calls)).not.toContain("fail_order_refund")
  })

  it("keeps an accepted-but-async payout (pending) in processing", async () => {
    const { deps, calls } = setup({ kind: "pending", ref: "T2" })
    expect((await executeRefund(deps, input)).status).toBe("processing")
    expect(calls[1]).toMatchObject({ name: "mark_refund_processing", args: { p_gateway_ref: "T2" } })
  })

  it("parks an OTP-gated payout in awaiting_otp, keeping the transfer code and the clawback", async () => {
    const { deps, calls } = setup({ kind: "otp", ref: "TRF_1" })
    const res = await executeRefund(deps, input)
    expect(res.status).toBe("awaiting_otp")
    expect(calls[1]).toMatchObject({ name: "mark_refund_processing", args: { p_refund_id: "rf1", p_gateway_ref: "TRF_1", p_status: "awaiting_otp" } })
    expect(names(calls)).not.toContain("fail_order_refund")
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it("treats a thrown adapter error as unknown, not failed", async () => {
    const { deps, calls, gateway } = setup({ kind: "completed", ref: "x" })
    ;(gateway.refund as any).mockRejectedValue(new Error("boom"))
    expect((await executeRefund(deps, input)).status).toBe("processing")
    expect(names(calls)).not.toContain("fail_order_refund")
  })

  it("never calls the gateway when the reserve fails (shortfall)", async () => {
    const { deps, gateway } = setup({ kind: "completed", ref: "x" }, order(), { error: { message: "SHORTFALL:sA:3.00" } })
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "SHORTFALL" })
    expect(gateway.refund).not.toHaveBeenCalled()
  })

  it("rejects ineligible orders before touching the database", async () => {
    const { deps, calls } = setup({ kind: "completed", ref: "x" }, order({ evidence: { hasActiveRefund: false, dispatchOutcome: "submitted", trackingStatuses: ["completed"], externalOrderId: null } }))
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "NOT_ELIGIBLE" })
    expect(calls).toEqual([])
  })

  it.each([0, -1, NaN, 10.01])("rejects bad amount %s", async (amount) => {
    const { deps, calls } = setup({ kind: "completed", ref: "x" })
    await expect(executeRefund(deps, { ...input, amount })).rejects.toMatchObject({ code: "BAD_AMOUNT" })
    expect(calls).toEqual([])
  })

  it("rejects an unsupported or unknown gateway", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" })
    await expect(executeRefund(deps, { ...input, gateway: "nope" })).rejects.toMatchObject({ code: "GATEWAY_UNSUPPORTED" })
  })

  it("maps a missing order to NOT_FOUND", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" }, null)
    await expect(executeRefund(deps, input)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a notify failure never fails a completed refund", async () => {
    const { deps } = setup({ kind: "completed", ref: "R1" })
    ;(deps.notify as any).mockRejectedValue(new Error("sms down"))
    expect((await executeRefund(deps, input)).status).toBe("completed")
  })
})

const stored = (o: Partial<StoredRefund> = {}): StoredRefund => ({
  id: "rf1", order_table: "ussd_shop_orders", order_id: "o1", gateway: "paystack_payout",
  amount: 9.8, destination_phone: "0241112222", gateway_ref: "TRF_1", status: "awaiting_otp", clawbacks: [], ...o,
})

function otpSetup(over: Partial<RefundGateway>) {
  const calls: { name: string; args: any }[] = []
  const gateway: RefundGateway = {
    id: "paystack_payout", label: "Paystack payout", supports: () => ({ ok: true }),
    refund: vi.fn(), ...over,
  }
  const deps: RefundDeps = {
    rpc: async (name, args) => { calls.push({ name, args }); return { data: null, error: null } },
    loadOrder: async () => order(),
    getGateway: (id) => (id === "paystack_payout" ? gateway : undefined),
    notify: vi.fn(async () => {}),
  }
  return { deps, calls }
}

describe("submitRefundOtp", () => {
  it("completes the refund when Paystack accepts the code", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await submitRefundOtp(deps, stored(), "123456")
    expect(res.status).toBe("completed")
    expect(calls.map((c) => c.name)).toEqual(["complete_order_refund"])
    expect(deps.notify).toHaveBeenCalled()
  })

  it("keeps awaiting_otp and writes nothing when the code is wrong", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await submitRefundOtp(deps, stored(), "000000")
    expect(res.status).toBe("awaiting_otp")
    expect(res.message).toMatch(/try again/i)
    expect(calls).toEqual([])
  })

  it("moves to processing when Paystack reports the transfer pending", async () => {
    const { deps, calls } = otpSetup({ finalizeOtp: vi.fn(async () => ({ kind: "pending", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await submitRefundOtp(deps, stored(), "123456")).status).toBe("processing")
    expect(calls[0].name).toBe("mark_refund_processing")
  })

  it.each(["", " ", "12", "abcdef", "1234567890123"])("rejects a malformed otp %j before calling the gateway", async (otp) => {
    const finalizeOtp = vi.fn()
    const { deps } = otpSetup({ finalizeOtp })
    await expect(submitRefundOtp(deps, stored(), otp)).rejects.toMatchObject({ code: "BAD_OTP" })
    expect(finalizeOtp).not.toHaveBeenCalled()
  })

  it("only works on awaiting_otp refunds that have a transfer code", async () => {
    const { deps } = otpSetup({ finalizeOtp: vi.fn() })
    await expect(submitRefundOtp(deps, stored({ status: "processing" }), "123456")).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
    await expect(submitRefundOtp(deps, stored({ gateway_ref: null }), "123456")).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
  })
})

describe("cancelRefund", () => {
  it("restores the clawback when the transfer is still waiting for its OTP", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "otp", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("failed")
    expect(calls.map((c) => c.name)).toEqual(["fail_order_refund"])
  })

  it("refuses to cancel (and settles instead) if the transfer actually went through", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("completed")
    expect(calls.map((c) => c.name)).toEqual(["complete_order_refund"])
  })

  it("refuses to cancel when the status cannot be confirmed", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "unknown", error: "timeout" } as GatewayOutcome)) })
    const res = await cancelRefund(deps, stored())
    expect(res.status).toBe("awaiting_otp")
    expect(calls.map((c) => c.name)).not.toContain("fail_order_refund")
  })

  it("only works on awaiting_otp refunds", async () => {
    const { deps } = otpSetup({ checkStatus: vi.fn() })
    await expect(cancelRefund(deps, stored({ status: "completed" }))).rejects.toMatchObject({ code: "ORDER_NOT_PENDING" })
  })
})

describe("reconcileRefund", () => {
  it("settles an awaiting_otp refund whose transfer later succeeded", async () => {
    const { deps, calls } = otpSetup({ checkStatus: vi.fn(async () => ({ kind: "completed", ref: "TRF_1" } as GatewayOutcome)) })
    expect((await reconcileRefund(deps, stored())).status).toBe("completed")
    expect(calls[0].name).toBe("complete_order_refund")
  })
})

describe("mapReserveError", () => {
  it.each([
    ["ALREADY_REFUNDED", "ALREADY_REFUNDED"], ["ORDER_NOT_PENDING", "ORDER_NOT_PENDING"],
    ["DISPATCH_ACTIVE", "DISPATCH_ACTIVE"], ["SHORTFALL:abc:3.5", "SHORTFALL"], ["weird", "RESERVE_FAILED"],
  ])("%s → %s", (msg, code) => expect(mapReserveError(msg).code).toBe(code))
  it("keeps shortfall detail", () => {
    expect(mapReserveError("SHORTFALL:shop-1:3.5").detail).toEqual({ shopId: "shop-1", amount: 3.5 })
  })
})

describe("previewRefund", () => {
  it("returns eligibility, default amount, gateway support and the clawback plan", async () => {
    const { deps } = setup({ kind: "completed", ref: "x" })
    const p = await previewRefund(deps, { table: "ussd_shop_orders", id: "o1" })
    expect(p.eligibility.eligible).toBe(true)
    expect(p.defaultAmount).toBe(9.8)
    expect(p.clawback.ok).toBe(true)
    expect(p.gateways.find((g) => g.id === "paystack")).toMatchObject({ ok: true })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/refunds/service.test.ts`
Expected: FAIL — `./service` not found.

- [ ] **Step 3: Write `lib/refunds/service.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { planClawback, type ClawbackPlan } from "./clawback"
import { evaluateEligibility, type Eligibility } from "./eligibility"
import { defaultRefundAmount, validateRefundAmount } from "./amounts"
import { loadRefundableOrders } from "./orders"
import { getGateway, listGateways } from "./gateways"
import { notifyRefund, type RefundNotification } from "./notify"
import type { GatewayOutcome, OrderTable, RefundContext, RefundGateway, RefundableOrder } from "./types"

export type RefundErrorCode =
  | "NOT_FOUND" | "NOT_ELIGIBLE" | "GATEWAY_UNSUPPORTED" | "BAD_AMOUNT" | "BAD_OTP" | "SHORTFALL"
  | "ALREADY_REFUNDED" | "ORDER_NOT_PENDING" | "DISPATCH_ACTIVE" | "RESERVE_FAILED"

export class RefundError extends Error {
  constructor(public code: RefundErrorCode, message: string, public detail?: unknown) {
    super(message)
    this.name = "RefundError"
  }
}

export function mapReserveError(message: string): RefundError {
  const short = message.match(/SHORTFALL:([0-9a-f-]+):([0-9.]+)/i)
  if (short) return new RefundError("SHORTFALL", `Shop owner cannot cover their cut (short by GHS ${short[2]})`, { shopId: short[1], amount: Number(short[2]) })
  if (message.includes("ALREADY_REFUNDED")) return new RefundError("ALREADY_REFUNDED", "This order already has a refund")
  if (message.includes("ORDER_NOT_PENDING")) return new RefundError("ORDER_NOT_PENDING", "Order is no longer a paid, pending order")
  if (message.includes("DISPATCH_ACTIVE")) return new RefundError("DISPATCH_ACTIVE", "Order is being sent to a provider right now")
  return new RefundError("RESERVE_FAILED", message)
}

export interface RefundDeps {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: any; error: { message: string } | null }>
  loadOrder(table: OrderTable, id: string): Promise<RefundableOrder | null>
  getGateway(id: string): RefundGateway | undefined
  notify(event: RefundNotification): Promise<void>
}

export function defaultDeps(db: SupabaseClient): RefundDeps {
  return {
    rpc: (name, args) => db.rpc(name, args) as any,
    loadOrder: async (table, id) => (await loadRefundableOrders(db, [{ table, id }]))[0] ?? null,
    getGateway,
    notify: (e) => notifyRefund(db, e),
  }
}

const eligibilityOf = (o: RefundableOrder): Eligibility =>
  evaluateEligibility({
    orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, hasActiveRefund: o.evidence.hasActiveRefund,
    dispatchOutcome: o.evidence.dispatchOutcome, trackingStatuses: o.evidence.trackingStatuses,
    externalOrderId: o.evidence.externalOrderId,
  })

export interface RefundPreview {
  order: RefundableOrder
  eligibility: Eligibility
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: ClawbackPlan
}

export async function previewRefund(deps: RefundDeps, ref: { table: OrderTable; id: string }): Promise<RefundPreview> {
  const order = await deps.loadOrder(ref.table, ref.id)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  return {
    order,
    eligibility: eligibilityOf(order),
    defaultAmount: defaultRefundAmount(order.paid, order.gatewayFee),
    gateways: listGateways().map((g) => {
      const s = g.supports(order)
      return { id: g.id, label: g.label, ok: s.ok, reason: s.ok ? undefined : s.reason }
    }),
    clawback: planClawback(order.owners),
  }
}

type Settled = { status: "completed" | "processing" | "awaiting_otp" | "failed"; message?: string }

async function settle(deps: RefundDeps, refundId: string, outcome: GatewayOutcome): Promise<Settled> {
  switch (outcome.kind) {
    case "completed": {
      await deps.rpc("complete_order_refund", { p_refund_id: refundId, p_gateway_ref: outcome.ref })
      return { status: "completed" }
    }
    case "pending": {
      await deps.rpc("mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: outcome.ref, p_note: "Accepted by gateway, awaiting confirmation", p_status: "processing" })
      return { status: "processing", message: "Payout accepted — awaiting gateway confirmation" }
    }
    case "otp": {
      // The transfer code is persisted on the ledger so a closed tab never loses it.
      await deps.rpc("mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: outcome.ref, p_note: "Waiting for the payout OTP", p_status: "awaiting_otp" })
      return { status: "awaiting_otp", message: "Enter the OTP to release the payout" }
    }
    case "failed": {
      await deps.rpc("fail_order_refund", { p_refund_id: refundId, p_error: outcome.error })
      return { status: "failed", message: outcome.error }
    }
    default: {
      // Ambiguous: the money may have left. Keep the clawback in place; an admin reconciles.
      await deps.rpc("mark_refund_processing", { p_refund_id: refundId, p_gateway_ref: null, p_note: outcome.error, p_status: "processing" })
      return { status: "processing", message: `Result unknown (${outcome.error}) — use "Check status" before retrying` }
    }
  }
}

export interface ExecuteInput {
  table: OrderTable
  orderId: string
  gateway: string
  amount: number
  adminId: string | null
}

export async function executeRefund(deps: RefundDeps, input: ExecuteInput): Promise<{ refundId: string } & Settled> {
  const order = await deps.loadOrder(input.table, input.orderId)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")

  const elig = eligibilityOf(order)
  if (!elig.eligible) throw new RefundError("NOT_ELIGIBLE", elig.reason, { code: elig.code })

  const gateway = deps.getGateway(input.gateway)
  if (!gateway) throw new RefundError("GATEWAY_UNSUPPORTED", `Unknown gateway "${input.gateway}"`)
  const support = gateway.supports(order)
  if (!support.ok) throw new RefundError("GATEWAY_UNSUPPORTED", support.reason)

  const amountError = validateRefundAmount(input.amount, order.paid)
  if (amountError) throw new RefundError("BAD_AMOUNT", amountError)

  const destination = order.payment.payerPhone
  const { data, error } = await deps.rpc("reserve_order_refund", {
    p_order_table: input.table, p_order_id: input.orderId, p_gateway: gateway.id,
    p_paid: order.paid, p_fee: order.gatewayFee, p_amount: input.amount,
    p_destination: destination, p_wallet_user: order.payment.walletUserId, p_admin: input.adminId,
  })
  if (error) throw mapReserveError(error.message)
  const refundId = data.refund_id as string

  const ctx: RefundContext = { refundId, order, amount: input.amount, destinationPhone: destination }
  let outcome: GatewayOutcome
  try {
    outcome = await gateway.refund(ctx)
  } catch (err) {
    console.error("[REFUND] gateway threw — treating as unknown:", err)
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "gateway error" }
  }

  const settled = await settle(deps, refundId, outcome)
  if (settled.status === "completed") {
    deps.notify({ refundId, order, amount: input.amount, gateway: gateway.id, clawbacks: data.clawbacks ?? [] })
      .catch((e) => console.error("[REFUND] notification failed (non-fatal):", e))
  }
  return { refundId, ...settled }
}

export interface StoredRefund {
  id: string
  order_table: OrderTable
  order_id: string
  gateway: string
  amount: number
  destination_phone: string | null
  gateway_ref: string | null
  status: string
  clawbacks: RefundNotification["clawbacks"]
}

async function contextFor(deps: RefundDeps, stored: StoredRefund): Promise<RefundContext> {
  const order = await deps.loadOrder(stored.order_table, stored.order_id)
  if (!order) throw new RefundError("NOT_FOUND", "Order not found")
  return { refundId: stored.id, order, amount: Number(stored.amount), destinationPhone: stored.destination_phone }
}

async function settleStored(deps: RefundDeps, stored: StoredRefund, ctx: RefundContext, outcome: GatewayOutcome): Promise<Settled> {
  const settled = await settle(deps, stored.id, outcome)
  if (settled.status === "completed") {
    deps.notify({ refundId: stored.id, order: ctx.order, amount: ctx.amount, gateway: stored.gateway, clawbacks: stored.clawbacks ?? [] })
      .catch((e) => console.error("[REFUND] notification failed (non-fatal):", e))
  }
  return settled
}

/** Re-checks a refund stuck in `processing` / `awaiting_otp` against its gateway and settles it. */
export async function reconcileRefund(deps: RefundDeps, stored: StoredRefund): Promise<Settled> {
  if (stored.status !== "processing" && stored.status !== "awaiting_otp") {
    throw new RefundError("ORDER_NOT_PENDING", "Only processing refunds can be reconciled")
  }
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.checkStatus) return { status: "processing", message: "This gateway cannot be re-checked automatically" }
  const ctx = await contextFor(deps, stored)
  let outcome: GatewayOutcome
  try {
    outcome = await gateway.checkStatus(ctx, stored.gateway_ref)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "status check failed" }
  }
  return settleStored(deps, stored, ctx, outcome)
}

const OTP_PATTERN = /^\d{4,10}$/

/** Releases an OTP-gated payout. A rejected code changes nothing: the refund stays awaiting_otp. */
export async function submitRefundOtp(deps: RefundDeps, stored: StoredRefund, otp: string): Promise<Settled> {
  if (stored.status !== "awaiting_otp" || !stored.gateway_ref) {
    throw new RefundError("ORDER_NOT_PENDING", "This refund is not waiting for an OTP")
  }
  const code = otp.trim()
  if (!OTP_PATTERN.test(code)) throw new RefundError("BAD_OTP", "Enter the numeric OTP code")
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.finalizeOtp) throw new RefundError("GATEWAY_UNSUPPORTED", "This gateway does not use an OTP")
  const ctx = await contextFor(deps, stored)

  let outcome: GatewayOutcome
  try {
    outcome = await gateway.finalizeOtp(ctx, stored.gateway_ref, code)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "OTP submission failed" }
  }
  if (outcome.kind === "otp") {
    return { status: "awaiting_otp", message: "Paystack did not accept that code. Check it and try again, or cancel the refund." }
  }
  return settleStored(deps, stored, ctx, outcome)
}

/**
 * Abandons an unfinalized payout and restores the owner's clawback. Safe only if the transfer
 * did not actually go out, so the gateway is asked first: if it succeeded or is pending we
 * settle that instead of cancelling, and if we cannot confirm we refuse.
 */
export async function cancelRefund(deps: RefundDeps, stored: StoredRefund): Promise<Settled> {
  if (stored.status !== "awaiting_otp") throw new RefundError("ORDER_NOT_PENDING", "Only refunds waiting for an OTP can be cancelled")
  const gateway = deps.getGateway(stored.gateway)
  if (!gateway?.checkStatus) throw new RefundError("GATEWAY_UNSUPPORTED", "This gateway cannot confirm the payout state")
  const ctx = await contextFor(deps, stored)

  let outcome: GatewayOutcome
  try {
    outcome = await gateway.checkStatus(ctx, stored.gateway_ref)
  } catch (err) {
    outcome = { kind: "unknown", error: err instanceof Error ? err.message : "status check failed" }
  }
  if (outcome.kind === "otp" || outcome.kind === "failed") {
    await deps.rpc("fail_order_refund", { p_refund_id: stored.id, p_error: "Cancelled by admin before the payout OTP was entered" })
    return { status: "failed", message: "Refund cancelled and the owner's cut restored" }
  }
  if (outcome.kind === "unknown") {
    return { status: "awaiting_otp", message: "Could not confirm the payout state with the gateway — not cancelled. Try again shortly." }
  }
  return settleStored(deps, stored, ctx, outcome)
}
```

- [ ] **Step 4: Write `lib/refunds/notify.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { sendSMS } from "@/lib/sms-service"
import type { RefundableOrder } from "./types"

export interface RefundNotification {
  refundId: string
  order: RefundableOrder
  amount: number
  gateway: string
  clawbacks: { shop_id: string; owner_user_id: string | null; from_profit: number; from_wallet: number; credited: number }[]
}

/** Customer SMS + in-app notice to each affected owner. Callers treat failures as non-fatal. */
export async function notifyRefund(db: SupabaseClient, e: RefundNotification): Promise<void> {
  const phone = e.order.payment.payerPhone
  if (phone) {
    await sendSMS({
      phone,
      message: `Your order of ${e.order.packageLabel} ${e.order.network} could not be completed. GHS ${e.amount.toFixed(2)} has been refunded to you.`,
      type: "order_refund",
      reference: e.order.id,
    })
  }
  for (const line of e.clawbacks) {
    if (!line.owner_user_id || Number(line.credited) <= 0) continue
    const { error } = await db.from("notifications").insert({
      user_id: line.owner_user_id,
      title: "Order refunded",
      message: `An order was refunded to the customer. GHS ${Number(line.credited).toFixed(2)} was removed from your earnings${Number(line.from_wallet) > 0 ? ` (GHS ${Number(line.from_wallet).toFixed(2)} from your wallet)` : ""}.`,
      type: "balance_updated",
      read: false,
      reference_id: e.order.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (error) console.error("[REFUND] owner notification failed:", error.message)
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/refunds`
Expected: PASS (all refunds tests). `npx tsc --noEmit -p .` clean for `lib/refunds/**`.

- [ ] **Step 6: Commit**

```bash
git add lib/refunds/service.ts lib/refunds/service.test.ts lib/refunds/notify.ts
git commit -m "feat(refunds): refund service with reserve/payout/settle flow, reconcile and notifications

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Dispatch guard wired into `createMTNOrder` and `createNonMTNOrder`

**Files:**
- Create: `lib/refunds/dispatch-guard.ts`
- Modify: `lib/mtn-fulfillment.ts:341` (wrap `createMTNOrder`), `lib/non-mtn-fulfillment.ts:51` (wrap `createNonMTNOrder`)
- Modify: `lib/mtn-fulfillment.test.ts`, `lib/non-mtn-fulfillment.test.ts` (mock the guard)
- Test: `lib/refunds/dispatch-guard.test.ts`

**Interfaces:**
- Consumes: RPCs `claim_order_dispatch`, `record_dispatch_outcome` (Task 2).
- Produces: `withDispatchGuard<T extends { success: boolean }>(orderId: string | undefined, run: () => Promise<T>, blocked: T): Promise<T>`.

Behavior: claim fails closed ONLY when the RPC answers `false` (an active refund exists). RPC/network errors fail OPEN (log loudly, run the dispatch) — the guard must never become a new point of fulfillment failure (same convention as the MTN registration gate). Outcome mapping: `success` → `submitted`; `!success` → `failed`; thrown → `unknown` (then rethrow).

- [ ] **Step 1: Write the failing test `lib/refunds/dispatch-guard.test.ts`**

```ts
const rpc = vi.fn()
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }))
import { withDispatchGuard } from "./dispatch-guard"

const blocked = { success: false, message: "refunded" }
beforeEach(() => rpc.mockReset())

describe("withDispatchGuard", () => {
  it("skips the guard entirely when there is no order id", async () => {
    const run = vi.fn(async () => ({ success: true, message: "ok" }))
    expect(await withDispatchGuard(undefined, run, blocked)).toEqual({ success: true, message: "ok" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("does not run the dispatch when the claim is refused", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null })
    const run = vi.fn()
    expect(await withDispatchGuard("o1", run, blocked)).toBe(blocked)
    expect(run).not.toHaveBeenCalled()
  })

  it("records submitted on success and failed on a clean failure", async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await withDispatchGuard("o1", async () => ({ success: true, message: "" }), blocked)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "submitted" })
    await withDispatchGuard("o1", async () => ({ success: false, message: "" }), blocked)
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "failed" })
  })

  it("records unknown and rethrows when the dispatch throws", async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(withDispatchGuard("o1", async () => { throw new Error("boom") }, blocked)).rejects.toThrow("boom")
    expect(rpc).toHaveBeenLastCalledWith("record_dispatch_outcome", { p_order_id: "o1", p_outcome: "unknown" })
  })

  it("fails open when the claim RPC errors", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "function does not exist" } })
    rpc.mockResolvedValue({ data: null, error: null })
    const run = vi.fn(async () => ({ success: true, message: "" }))
    await withDispatchGuard("o1", run, blocked)
    expect(run).toHaveBeenCalled()
  })

  it("never lets an outcome-recording failure break the dispatch result", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null })
    rpc.mockRejectedValueOnce(new Error("network"))
    expect(await withDispatchGuard("o1", async () => ({ success: true, message: "ok" }), blocked)).toEqual({ success: true, message: "ok" })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/refunds/dispatch-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lib/refunds/dispatch-guard.ts`**

```ts
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function claim(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("claim_order_dispatch", { p_order_id: orderId })
    if (error) {
      console.error("[DISPATCH-GUARD] claim failed — failing OPEN:", error.message)
      return true
    }
    return data !== false
  } catch (err) {
    console.error("[DISPATCH-GUARD] claim threw — failing OPEN:", err)
    return true
  }
}

async function record(orderId: string, outcome: "submitted" | "failed" | "unknown"): Promise<void> {
  try {
    const { error } = await supabase.rpc("record_dispatch_outcome", { p_order_id: orderId, p_outcome: outcome })
    if (error) console.error("[DISPATCH-GUARD] could not record outcome:", error.message)
  } catch (err) {
    console.error("[DISPATCH-GUARD] could not record outcome:", err)
  }
}

/**
 * Serializes provider dispatch against an admin refund of the same order (see
 * claim_order_dispatch / reserve_order_refund: same per-order advisory lock).
 * `blocked` is returned, without dispatching, when a refund already owns the order.
 */
export async function withDispatchGuard<T extends { success: boolean }>(
  orderId: string | undefined,
  run: () => Promise<T>,
  blocked: T
): Promise<T> {
  if (!orderId) return run()
  if (!(await claim(orderId))) {
    console.warn(`[DISPATCH-GUARD] order ${orderId} is being refunded — dispatch refused`)
    return blocked
  }
  try {
    const result = await run()
    await record(orderId, result.success ? "submitted" : "failed")
    return result
  } catch (err) {
    await record(orderId, "unknown")
    throw err
  }
}
```

- [ ] **Step 4: Run guard tests**

Run: `npx vitest run lib/refunds/dispatch-guard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into `createMTNOrder`** — in `lib/mtn-fulfillment.ts`, rename the existing function and add a guarded wrapper with the original name.

Replace the line `export async function createMTNOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {` (line 341) with:

```ts
export async function createMTNOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
  const { withDispatchGuard } = await import("@/lib/refunds/dispatch-guard")
  return withDispatchGuard(order.client_ref, () => createMTNOrderUnguarded(order), {
    success: false,
    message: "Order is being refunded",
    traceId: order.traceId,
    error_type: "ORDER_REFUNDED",
  })
}

async function createMTNOrderUnguarded(order: MTNOrderRequest): Promise<MTNOrderResponse> {
```

(The existing body stays under `createMTNOrderUnguarded`. The internal recursive call near line 1460, `result = await createMTNOrder(order)`, keeps working: it simply claims again.)

- [ ] **Step 6: Wire it into `createNonMTNOrder`** — in `lib/non-mtn-fulfillment.ts`, same pattern. Replace `export async function createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult> {` with:

```ts
export async function createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult> {
  const { withDispatchGuard } = await import("@/lib/refunds/dispatch-guard")
  return withDispatchGuard(params.orderId, () => createNonMTNOrderUnguarded(params), {
    success: false,
    message: "Order is being refunded",
    provider: "refund-guard",
  } as NonMTNOrderResult)
}

async function createNonMTNOrderUnguarded(params: NonMTNOrderParams): Promise<NonMTNOrderResult> {
```

Run `npx tsc --noEmit -p .` and, if `NonMTNOrderResult.provider` is a narrower union than string, change the blocked literal's `provider` to a member of that union (read the `NonMTNOrderResult` type at the top of the file first).

- [ ] **Step 7: Mock the guard in the existing fulfillment tests** so they never touch a client

Add to the top of `lib/mtn-fulfillment.test.ts` and `lib/non-mtn-fulfillment.test.ts` (alongside the other `vi.mock` calls):

```ts
vi.mock("@/lib/refunds/dispatch-guard", () => ({
  withDispatchGuard: async (_id: unknown, run: () => Promise<unknown>) => run(),
}))
```

- [ ] **Step 8: Run the whole suite**

Run: `npm run test:run`
Expected: all green (existing MTN / non-MTN fulfillment tests unaffected). Then `npx tsc --noEmit -p .` clean.

- [ ] **Step 9: Commit**

```bash
git add lib/refunds/dispatch-guard.ts lib/refunds/dispatch-guard.test.ts lib/mtn-fulfillment.ts lib/non-mtn-fulfillment.ts lib/mtn-fulfillment.test.ts lib/non-mtn-fulfillment.test.ts
git commit -m "feat(refunds): serialize provider dispatch against refunds via per-order claim

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Admin API routes

**Files:**
- Create: `app/api/admin/refunds/pending/route.ts`, `app/api/admin/refunds/history/route.ts`, `app/api/admin/refunds/preview/route.ts`, `app/api/admin/refunds/route.ts`, `app/api/admin/refunds/[id]/retry/route.ts`, `app/api/admin/refunds/[id]/reconcile/route.ts`, `app/api/admin/refunds/[id]/otp/route.ts`, `app/api/admin/refunds/[id]/cancel/route.ts`
- Create: `lib/refunds/http.ts` (shared client + error → response mapping)
- Test: `lib/refunds/http.test.ts`

**Interfaces:**
- Consumes: `verifyAdminAccess`, Task 4–5 exports.
- Produces (HTTP):
  - `GET /api/admin/refunds/pending?type=&shopId=&q=&page=` → `{ rows: PendingRow[], page, pageSize }` where `PendingRow = { order: RefundableOrder, eligibility: Eligibility, defaultAmount: number }`
  - `GET /api/admin/refunds/history?status=&page=` → `{ rows: order_refunds[] , page, pageSize }`
  - `POST /api/admin/refunds/preview` `{ table, orderId }` → `RefundPreview`
  - `POST /api/admin/refunds` `{ table, orderId, gateway, amount }` → `{ refundId, status, message? }`
  - `POST /api/admin/refunds/[id]/retry` `{ gateway?, amount? }` (only for a `failed` refund) → same as above
  - `POST /api/admin/refunds/[id]/reconcile` → `{ status, message? }`
  - `POST /api/admin/refunds/[id]/otp` `{ otp }` → `{ status, message? }` (wrong code → 200 with `status: "awaiting_otp"` and a message)
  - `POST /api/admin/refunds/[id]/cancel` → `{ status, message? }`

- [ ] **Step 1: Write the failing test `lib/refunds/http.test.ts`** for the error mapping

```ts
import { refundErrorResponse } from "./http"
import { RefundError } from "./service"

describe("refundErrorResponse", () => {
  it.each([
    ["NOT_FOUND", 404], ["NOT_ELIGIBLE", 409], ["ALREADY_REFUNDED", 409], ["ORDER_NOT_PENDING", 409],
    ["DISPATCH_ACTIVE", 409], ["SHORTFALL", 422], ["BAD_AMOUNT", 400], ["BAD_OTP", 400], ["GATEWAY_UNSUPPORTED", 400], ["RESERVE_FAILED", 500],
  ] as const)("%s → %i", async (code, status) => {
    const res = refundErrorResponse(new RefundError(code, "msg", { x: 1 }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: "msg", code, detail: { x: 1 } })
  })
  it("hides unexpected errors behind a 500", async () => {
    const res = refundErrorResponse(new Error("secret db detail"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret db detail")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/refunds/http.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write `lib/refunds/http.ts`**

```ts
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { RefundError, type RefundErrorCode } from "./service"

export const refundDb = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const STATUS: Record<RefundErrorCode, number> = {
  NOT_FOUND: 404, NOT_ELIGIBLE: 409, ALREADY_REFUNDED: 409, ORDER_NOT_PENDING: 409,
  DISPATCH_ACTIVE: 409, SHORTFALL: 422, BAD_AMOUNT: 400, BAD_OTP: 400, GATEWAY_UNSUPPORTED: 400, RESERVE_FAILED: 500,
}

export function refundErrorResponse(err: unknown): NextResponse {
  if (err instanceof RefundError) {
    return NextResponse.json({ error: err.message, code: err.code, detail: err.detail }, { status: STATUS[err.code] })
  }
  console.error("[REFUND] unexpected error:", err)
  return NextResponse.json({ error: "Refund request failed" }, { status: 500 })
}
```

- [ ] **Step 4: Run test** — `npx vitest run lib/refunds/http.test.ts` → PASS.

- [ ] **Step 5: Write the routes**

`app/api/admin/refunds/pending/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { listPendingOrderRefs, loadRefundableOrders } from "@/lib/refunds/orders"
import { evaluateEligibility } from "@/lib/refunds/eligibility"
import { defaultRefundAmount } from "@/lib/refunds/amounts"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

const PAGE_SIZE = 50

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const sp = new URL(request.url).searchParams
    const type = sp.get("type") as OrderTable | null
    const page = Math.max(parseInt(sp.get("page") || "1", 10) || 1, 1)
    const db = refundDb()

    const refs = await listPendingOrderRefs(db, {
      table: type && ORDER_TABLES.includes(type) ? type : undefined,
      shopId: sp.get("shopId") || undefined,
      q: sp.get("q") || undefined,
      pageSize: PAGE_SIZE,
      page,
    })
    const orders = await loadRefundableOrders(db, refs)
    const order = new Map(refs.map((r, i) => [`${r.table}:${r.id}`, i]))
    orders.sort((a, b) => (order.get(`${a.table}:${a.id}`) ?? 0) - (order.get(`${b.table}:${b.id}`) ?? 0))

    const rows = orders.map((o) => ({
      order: o,
      eligibility: evaluateEligibility({
        orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, hasActiveRefund: o.evidence.hasActiveRefund,
        dispatchOutcome: o.evidence.dispatchOutcome, trackingStatuses: o.evidence.trackingStatuses,
        externalOrderId: o.evidence.externalOrderId,
      }),
      defaultAmount: defaultRefundAmount(o.paid, o.gatewayFee),
    }))
    return NextResponse.json({ rows, page, pageSize: PAGE_SIZE })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/history/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"

const PAGE_SIZE = 50

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const sp = new URL(request.url).searchParams
    const page = Math.max(parseInt(sp.get("page") || "1", 10) || 1, 1)
    const status = sp.get("status")
    let q = refundDb().from("order_refunds").select("*").order("created_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (status && ["reserved", "processing", "awaiting_otp", "completed", "failed"].includes(status)) q = q.eq("status", status)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return NextResponse.json({ rows: data ?? [], page, pageSize: PAGE_SIZE })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/preview/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, previewRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { table, orderId } = await request.json()
    if (!ORDER_TABLES.includes(table as OrderTable) || typeof orderId !== "string") {
      return NextResponse.json({ error: "table and orderId are required" }, { status: 400 })
    }
    return NextResponse.json(await previewRefund(defaultDeps(refundDb()), { table, id: orderId }))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/route.ts` (execute + admin audit):

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, executeRefund } from "@/lib/refunds/service"
import { ORDER_TABLES, type OrderTable } from "@/lib/refunds/types"

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { table, orderId, gateway, amount } = await request.json()
    if (!ORDER_TABLES.includes(table as OrderTable) || typeof orderId !== "string" || typeof gateway !== "string") {
      return NextResponse.json({ error: "table, orderId and gateway are required" }, { status: 400 })
    }
    const db = refundDb()
    const result = await executeRefund(defaultDeps(db), { table, orderId, gateway, amount: Number(amount), adminId: userId ?? null })

    await db.from("admin_audit_log").insert({
      admin_id: userId ?? null, action: "order_refund", target_user_id: null,
      old_value: null, new_value: { table, orderId, gateway, amount: Number(amount), ...result },
    }).then(({ error }) => { if (error) console.error("[REFUND] audit log failed (non-fatal):", error.message) })

    return NextResponse.json(result, { status: result.status === "failed" ? 502 : 200 })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/[id]/retry/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, executeRefund, RefundError } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const db = refundDb()
    const { data: prev, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
    if (error || !prev) throw new RefundError("NOT_FOUND", "Refund not found")
    if (prev.status !== "failed") throw new RefundError("NOT_ELIGIBLE", "Only failed refunds can be retried")

    // A retry is a brand-new reserve: eligibility, balances and the gateway are all re-checked.
    const result = await executeRefund(defaultDeps(db), {
      table: prev.order_table, orderId: prev.order_id,
      gateway: typeof body.gateway === "string" ? body.gateway : prev.gateway,
      amount: body.amount !== undefined ? Number(body.amount) : Number(prev.amount),
      adminId: userId ?? null,
    })
    return NextResponse.json(result, { status: result.status === "failed" ? 502 : 200 })
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/[id]/reconcile/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, reconcileRefund, RefundError } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    const db = refundDb()
    const { data: stored, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
    if (error || !stored) throw new RefundError("NOT_FOUND", "Refund not found")
    return NextResponse.json(await reconcileRefund(defaultDeps(db), stored))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/[id]/otp/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { defaultDeps, submitRefundOtp, RefundError } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    const { otp } = await request.json().catch(() => ({ otp: "" }))
    const db = refundDb()
    const { data: stored, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
    if (error || !stored) throw new RefundError("NOT_FOUND", "Refund not found")
    return NextResponse.json(await submitRefundOtp(defaultDeps(db), stored, String(otp ?? "")))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

`app/api/admin/refunds/[id]/cancel/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { refundDb, refundErrorResponse } from "@/lib/refunds/http"
import { cancelRefund, defaultDeps, RefundError } from "@/lib/refunds/service"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const { id } = await params
    const db = refundDb()
    const { data: stored, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
    if (error || !stored) throw new RefundError("NOT_FOUND", "Refund not found")
    return NextResponse.json(await cancelRefund(defaultDeps(db), stored))
  } catch (err) {
    return refundErrorResponse(err)
  }
}
```

- [ ] **Step 6: Typecheck and run the suite**

Run: `npx tsc --noEmit -p .` then `npm run test:run`
Expected: clean / all green. (If this project's Next version types `params` as a plain object rather than a Promise, match the signature used by an existing dynamic route such as `app/api/admin/mtn-registration/batch/[id]/download/route.ts`.)

- [ ] **Step 7: Commit**

```bash
git add app/api/admin/refunds lib/refunds/http.ts lib/refunds/http.test.ts
git commit -m "feat(refunds): admin API for listing, previewing, executing, retrying and reconciling refunds

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Admin Refunds page + sidebar entry

**Files:**
- Create: `app/admin/refunds/page.tsx`, `components/admin/refunds/refund-dialog.tsx`
- Modify: `components/layout/sidebar.tsx` (add a nav link after the `/admin/mtn-registration` block, ~line 767-790)

**Interfaces:**
- Consumes: the HTTP contracts from Task 7.
- Produces: page at `/admin/refunds` (Pending + History tabs).

- [ ] **Step 1: Confirm the shadcn primitives exist**

Run: `ls components/ui | grep -E "^(tabs|dialog|select|input|table|badge|button|card)\.tsx$"`
Expected: all eight listed. If any is missing, add it with `npx shadcn@latest add <name>` before continuing.

- [ ] **Step 2: Write `components/admin/refunds/refund-dialog.tsx`**

```tsx
"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface PreviewPayload {
  order: { table: string; id: string; paid: number; gatewayFee: number; packageLabel: string; network: string; payment: { payerPhone: string | null } }
  eligibility: { eligible: boolean; reason?: string }
  defaultAmount: number
  gateways: { id: string; label: string; ok: boolean; reason?: string }[]
  clawback: { ok: boolean; lines: { shopId: string; credited: number; pending: number; fromProfit: number; fromWallet: number; shortfall: number }[] }
}

interface Props {
  target: { table: string; id: string } | null
  getToken: () => Promise<string>
  onClose: () => void
  onDone: (result: { refundId: string; status: string }) => void
}

export function RefundDialog({ target, getToken, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<PreviewPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [gateway, setGateway] = useState("")
  const [amount, setAmount] = useState("")

  useEffect(() => {
    if (!target) { setPreview(null); return }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch("/api/admin/refunds/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
          body: JSON.stringify({ table: target.table, orderId: target.id }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || "Preview failed")
        if (cancelled) return
        setPreview(json)
        setAmount(json.defaultAmount.toFixed(2))
        setGateway(json.gateways.find((g: PreviewPayload["gateways"][number]) => g.ok)?.id ?? "")
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Preview failed")
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [target, getToken, onClose])

  const submit = async () => {
    if (!target) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify({ table: target.table, orderId: target.id, gateway, amount: Number(amount) }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || json.message || "Refund failed")
      if (json.status === "completed") toast.success("Refund completed")
      else if (json.status === "awaiting_otp") toast.info("Enter the OTP to release the payout")
      else toast.warning(json.message || "Refund is processing — check its status in History")
      onDone({ refundId: json.refundId, status: json.status })
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refund failed")
    } finally {
      setSubmitting(false)
    }
  }

  const blocked = !preview || !preview.eligibility.eligible || !preview.clawback.ok || !gateway || submitting

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Refund order</DialogTitle>
          <DialogDescription>
            Moves real money. The shop owner&apos;s cut is removed first, then the customer is paid.
          </DialogDescription>
        </DialogHeader>

        {loading || !preview ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-md border p-3">
              <div className="font-medium">{preview.order.packageLabel} {preview.order.network}</div>
              <div className="text-muted-foreground">
                Paid GHS {preview.order.paid.toFixed(2)} · gateway fee GHS {preview.order.gatewayFee.toFixed(2)} · payer {preview.order.payment.payerPhone ?? "unknown"}
              </div>
            </div>

            {!preview.eligibility.eligible && (
              <div className="rounded-md border border-destructive/50 p-3 text-destructive">{preview.eligibility.reason}</div>
            )}

            <div className="space-y-1.5">
              <label className="font-medium">Gateway</label>
              <div className="space-y-1">
                {preview.gateways.map((g) => (
                  <label key={g.id} className={`flex items-start gap-2 rounded-md border p-2 ${g.ok ? "cursor-pointer" : "opacity-50"}`}>
                    <input type="radio" name="gateway" disabled={!g.ok} checked={gateway === g.id} onChange={() => setGateway(g.id)} className="mt-1" />
                    <span>
                      {g.label}
                      {!g.ok && <span className="block text-xs text-muted-foreground">{g.reason}</span>}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="refund-amount" className="font-medium">Amount to refund (GHS)</label>
              <Input id="refund-amount" type="number" step="0.01" min="0.01" max={preview.order.paid} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <p className="text-xs text-muted-foreground">Default is the price minus the gateway fee. Lower it to keep part. The owner&apos;s full cut is removed either way.</p>
            </div>

            <div className="space-y-1.5">
              <label className="font-medium">Owner cuts to remove</label>
              {preview.clawback.lines.length === 0 ? (
                <p className="text-muted-foreground">No shop earnings are attached to this order.</p>
              ) : (
                preview.clawback.lines.map((l) => (
                  <div key={l.shopId} className="flex items-center justify-between rounded-md border p-2">
                    <span>GHS {l.credited.toFixed(2)} <span className="text-muted-foreground">(profit {l.fromProfit.toFixed(2)} + wallet {l.fromWallet.toFixed(2)})</span></span>
                    {l.shortfall > 0 ? <Badge variant="destructive">Short by GHS {l.shortfall.toFixed(2)}</Badge> : <Badge variant="secondary">Covered</Badge>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={blocked}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Write `app/admin/refunds/page.tsx`**

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"
import { RefundDialog } from "@/components/admin/refunds/refund-dialog"

interface PendingRow {
  order: {
    table: string; id: string; shopName: string | null; packageLabel: string; network: string
    recipientPhone: string | null; createdAt: string; paid: number; gatewayFee: number
    payment: { gateway: string | null; payerPhone: string | null }
    owners: { shopId: string; credited: number; pending: number }[]
  }
  eligibility: { eligible: boolean; reason?: string }
  defaultAmount: number
}

interface HistoryRow {
  id: string; order_table: string; order_id: string; gateway: string; amount: number
  status: "reserved" | "processing" | "awaiting_otp" | "completed" | "failed"; error: string | null
  created_at: string; late_events: unknown[]
}

const TABLE_LABEL: Record<string, string> = { shop_orders: "Storefront", ussd_orders: "USSD", ussd_shop_orders: "USSD shop" }

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function AdminRefundsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [pending, setPending] = useState<PendingRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [target, setTarget] = useState<{ table: string; id: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [otpFor, setOtpFor] = useState<string | null>(null)
  const [otp, setOtp] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const headers = { Authorization: `Bearer ${await getToken()}` }
      const [p, h] = await Promise.all([
        fetch(`/api/admin/refunds/pending?q=${encodeURIComponent(q)}`, { headers }),
        fetch("/api/admin/refunds/history", { headers }),
      ])
      if (!p.ok || !h.ok) throw new Error("Failed to load")
      setPending((await p.json()).rows)
      setHistory((await h.json()).rows)
    } catch {
      toast.error("Failed to load refunds")
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => { if (isAdmin) void load() }, [isAdmin, load])

  const act = async (id: string, path: "retry" | "reconcile" | "cancel" | "otp", body: Record<string, unknown> = {}) => {
    setBusyId(id)
    try {
      const res = await fetch(`/api/admin/refunds/${id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || json.message || "Request failed")
      toast[json.status === "completed" ? "success" : "warning"](json.message || `Refund ${json.status}`)
      if (path === "otp" && json.status === "awaiting_otp") return   // wrong code: keep the OTP box open
      setOtpFor(null)
      setOtp("")
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed")
    } finally {
      setBusyId(null)
    }
  }

  if (adminLoading || !isAdmin) return null

  return (
    <DashboardLayout>
      <PageHeaderBanner title="Refunds" subtitle="Refund paid orders that have not been delivered" />
      <Tabs defaultValue="pending" className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="pending">Pending orders ({pending.length})</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <div className="flex gap-2">
            <Input placeholder="Search phone or order id" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} className="w-56" />
            <Button variant="outline" size="icon" onClick={load} disabled={loading} aria-label="Refresh">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <TabsContent value="pending">
          <Card>
            <CardHeader><CardTitle>Pending, paid orders</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead><TableHead>Shop</TableHead><TableHead>Package</TableHead>
                    <TableHead>Recipient</TableHead><TableHead>Paid</TableHead><TableHead>Paid via</TableHead>
                    <TableHead>Owner cut</TableHead><TableHead>Placed</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map(({ order, eligibility }) => (
                    <TableRow key={`${order.table}:${order.id}`} className={eligibility.eligible ? "" : "opacity-60"}>
                      <TableCell>{TABLE_LABEL[order.table]}</TableCell>
                      <TableCell>{order.shopName ?? "—"}</TableCell>
                      <TableCell>{order.packageLabel} {order.network}</TableCell>
                      <TableCell>{order.recipientPhone ?? "—"}</TableCell>
                      <TableCell>GHS {order.paid.toFixed(2)}</TableCell>
                      <TableCell>{order.payment.gateway ?? "unknown"}</TableCell>
                      <TableCell>{order.owners.length ? `GHS ${order.owners.reduce((s, o) => s + o.credited + o.pending, 0).toFixed(2)}` : "—"}</TableCell>
                      <TableCell>{new Date(order.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        {eligibility.eligible ? (
                          <Button size="sm" onClick={() => setTarget({ table: order.table, id: order.id })}>Refund</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground" title={eligibility.reason}>{eligibility.reason}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && pending.length === 0 && (
                    <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No pending paid orders.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history">
          <Card>
            <CardHeader><CardTitle>Refund history</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead><TableHead>Type</TableHead><TableHead>Gateway</TableHead>
                    <TableHead>Amount</TableHead><TableHead>Status</TableHead><TableHead>Notes</TableHead><TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{new Date(r.created_at).toLocaleString()}</TableCell>
                      <TableCell>{TABLE_LABEL[r.order_table]}</TableCell>
                      <TableCell>{r.gateway}</TableCell>
                      <TableCell>GHS {Number(r.amount).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "completed" ? "secondary" : r.status === "failed" ? "destructive" : "outline"}>{r.status}</Badge>
                        {r.late_events.length > 0 && <Badge variant="destructive" className="ml-1">late update blocked</Badge>}
                      </TableCell>
                      <TableCell className="max-w-xs truncate" title={r.error ?? ""}>{r.error ?? ""}</TableCell>
                      <TableCell className="text-right">
                        {r.status === "processing" && (
                          <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => act(r.id, "reconcile")}>Check status</Button>
                        )}
                        {r.status === "awaiting_otp" && (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => { setOtp(""); setOtpFor(r.id) }}>Enter OTP</Button>
                            <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => act(r.id, "reconcile")}>Check status</Button>
                            <Button size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => act(r.id, "cancel")}>Cancel refund</Button>
                          </div>
                        )}
                        {r.status === "failed" && (
                          <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => act(r.id, "retry")}>Retry</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && history.length === 0 && (
                    <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No refunds yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <RefundDialog
        target={target}
        getToken={getToken}
        onClose={() => setTarget(null)}
        onDone={(result) => {
          void load()
          if (result.status === "awaiting_otp") { setOtp(""); setOtpFor(result.refundId) }
        }}
      />

      <Dialog open={!!otpFor} onOpenChange={(o) => !o && busyId === null && setOtpFor(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Enter payout OTP</DialogTitle>
            <DialogDescription>Paystack sent a one-time code to release this refund payout. The shop owner&apos;s cut stays removed until you finish or cancel.</DialogDescription>
          </DialogHeader>
          <Input inputMode="numeric" autoComplete="one-time-code" placeholder="OTP code" value={otp} onChange={(e) => setOtp(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOtpFor(null)} disabled={busyId !== null}>Later</Button>
            <Button disabled={busyId !== null || otp.trim().length < 4} onClick={() => otpFor && act(otpFor, "otp", { otp })}>
              {busyId !== null ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Release payout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
```

(If `PageHeaderBanner`'s prop names differ, copy them from `app/admin/mtn-registration/page.tsx`'s usage.)

- [ ] **Step 4: Add the sidebar link** — in `components/layout/sidebar.tsx`, import `RotateCcw` from `lucide-react` (extend the existing lucide import), then insert directly after the closing `</Link>` of the `/admin/mtn-registration` block a new block that is a copy of it with `/admin/refunds`, title `"Refunds"`, label text `Refunds` and the `RotateCcw` icon in place of `Smartphone`.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit -p .` and `npx next lint --dir app/admin/refunds --dir components/admin/refunds`
Expected: clean.

- [ ] **Step 6: Manual UI check** (use the `run`/`webapp-testing` skill; app on port 3000)

Log in as an admin, open `/admin/refunds`. Verify: the Pending tab lists only paid+pending orders; an order with a `completed` tracking row is greyed with a reason; opening Refund shows the gateway list with unsupported gateways disabled, a default amount of price minus fee, and per-owner cuts; a shop with insufficient profit+wallet shows "Short by" and a disabled Refund button; History shows empty state; the gateway list shows both "Paystack (reverse original charge)" and "Paystack (MoMo payout, needs OTP)". Do NOT submit a real refund against production data in this check.

- [ ] **Step 7: Commit**

```bash
git add app/admin/refunds components/admin/refunds components/layout/sidebar.tsx
git commit -m "feat(refunds): admin refunds page with pending list, refund dialog and history

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Whole-flow verification, rollout notes and memory

**Files:**
- Modify: `C:\Users\User2\.claude\projects\c--Users-User2--gemini-antigravity-ide-scratch-Datagod2\memory\` (new `project-admin-order-refunds.md` + one line in `MEMORY.md`)

- [ ] **Step 1: Full automated verification**

Run: `npm run test:run` and `npx tsc --noEmit -p .` and `npx next build`
Expected: tests green, no type errors, build succeeds.

- [ ] **Step 2: Confirm the three concurrency invariants against the live schema** (rolled-back SQL via the Management API runner; re-run `migrations/tests/20261005_order_refunds_rpc_test.sql`)

Expected: no error. This proves: double-reserve rejected, dispatch refused during a refund, reserve refused during a dispatch, late status update ignored, compensation restores balances, shortfall leaves no trace.

- [ ] **Step 3: Staged real-money smoke test (needs the user)**

Ask the user for one throwaway pending, paid order of a shop they own (or have them create one). Refund GHS 1.00 via the wallet gateway first (no external money moves), then verify in SQL: `order_refunds.status='completed'`, order `refunded`, the owner's `shop_available_balance` dropped by the cut, a negative `shop_profits` row with `refund_id`, and a `transactions` credit for the customer. Only after that, with explicit user go-ahead, repeat once each with Moolre, Paystack reversal and Paystack payout for a small amount. For the Paystack payout, exercise the OTP path end to end: first enter a deliberately wrong code (expect the refund to stay `awaiting_otp` with the clawback intact), then the right one (expect `completed`); on a second throwaway order, use **Cancel refund** and verify the owner's cut is restored exactly once.

- [ ] **Step 4: Audit the dispatch entry points** (spec requirement)

Run: `grep -rn "createMTNOrder\|createNonMTNOrder\|atishareService.fulfillOrder\|provider.createOrder(" app lib --include=*.ts | grep -v test`
Expected: every provider submission for the three refundable order types goes through `createMTNOrder` / `createNonMTNOrder`. Any direct provider call that bypasses them (note especially `lib/fulfillment-service.ts` and the cron retry paths) must be wrapped with `withDispatchGuard(orderId, ...)` in this task, with a test, before release.

- [ ] **Step 5: Save the memory note**

Create `project-admin-order-refunds.md` (type: project) summarizing: what shipped, the 8 spec deviations above, that clawback = negative `shop_profits` rows, the dispatch-claim lease design, Paystack native-only, partial refund strips full cut, and any open follow-ups found in Steps 3–4. Add the one-line pointer to `MEMORY.md`.

- [ ] **Step 6: Commit**

```bash
git add -A docs memory 2>/dev/null; git status --short
git commit -m "docs(refunds): rollout notes" --allow-empty
```
(Only commit files that belong to this feature; leave the unrelated working-tree changes alone.)

---

## Self-Review

**Spec coverage:** dedicated page with pending-only list and greyed-out provider-sent orders (Task 8); History tab with retry (Tasks 7–8); admin-picked gateway with pluggable adapters (Task 3); amount default = price − fee, editable down (Tasks 1, 5, 8); payer-number-only destination (Task 4 `payerPhone`, Task 5 `destination`); clawback profit → wallet, all-or-nothing across owner + parent (Tasks 1, 2); eligibility incl. failed-tracking refundable (Task 1); concurrency — double refund, dispatch race, balance locks, lock ordering, retry exclusion, idempotent payouts, late webhook guard (Tasks 2, 3, 6); notifications + audit (Tasks 5, 7); admin-only (Task 7).

**Placeholder scan:** none; every code step has code. Two conditional branches are explicit (Task 2 Step 1 constraint widening; Task 6 Step 6 `provider` literal) with the instruction to read the real type first.

**Type consistency:** `RefundableOrder`/`OwnerCut`/`GatewayOutcome`/`RefundGateway` defined once in Task 1 and used unchanged in Tasks 3–5. RPC argument names (`p_order_table`, `p_gateway`, `p_paid`, `p_fee`, `p_amount`, `p_destination`, `p_wallet_user`, `p_admin`) match between Task 2 SQL and Task 5 service/tests. `clawbacks` JSON keys (`shop_id`, `owner_user_id`, `credited`, `pending`, `from_profit`, `from_wallet`) match between the RPC and `RefundNotification`.

**Known residuals (documented, accepted):** a withdrawal request created by service code between our balance read and commit can leave the balance negative (the codebase already permits negative balances and recovers from future profits); a pre-guard order dispatched via the CodeCraft direct path with no tracking row and no `external_order_id` looks undispatched; the gateway "fee" is taken from `payment_attempts.fee` and should be confirmed against what Paystack actually charged.
