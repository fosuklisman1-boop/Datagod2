# Bulk SMS — Plan 1 of 5: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tenancy + prepaid-units billing foundation for the Bulk SMS platform: an `sms_account` per user (admin / shop owner / sub-agent), an atomic SMS-units ledger, admin-defined bundle tiers, and three unit top-up paths (cash wallet, admin manual, Paystack).

**Architecture:** A single `sms_accounts` row per `user_id` is the tenant boundary; every later table (sender IDs, contacts, campaigns) will reference `sms_account_id`. Unit balance changes go through one race-safe `SECURITY DEFINER` SQL function (`adjust_sms_units`) that updates the balance and writes the ledger row in one transaction — mirroring the existing `deduct_wallet` pattern. Pure decision logic (owner-type derivation, bundle-purchase eligibility) is extracted into dependency-free modules so it is unit-testable without Supabase.

**Tech Stack:** Next.js 15 App Router (route handlers), Supabase (Postgres + RLS, service-role client), Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-16-bulk-sms-platform-design.md` (Sections: Tenancy spine, Data model, Component 4 — SMS Units & Bundles).

---

## File Structure

**Create:**
- `migrations/0061_create_sms_foundation.sql` — tables, indexes, RLS for `sms_accounts`, `sms_unit_transactions`, `sms_bundles`
- `migrations/0062_create_sms_units_functions.sql` — `adjust_sms_units`, `get_or_create_sms_account` SQL functions
- `migrations/0063_create_sms_pending_credits.sql` — **(Revision A, applied)** pending-credits table + `credit_sms_units_if_solvent` + `settle_pending_sms_credits`
- `migrations/0064_seed_sms_bundles.sql` — initial bundle tiers (was 0063 — renumbered by Revision A)
- `app/api/cron/sms-pending-credits/route.ts` — **(Revision A)** settle pending credits after wholesale top-up
- `lib/sms/foundation-rules.ts` — pure logic: `deriveOwnerType`, `canPurchaseBundle`
- `lib/sms/foundation-rules.test.ts` — unit tests for the above
- `lib/sms/account-service.ts` — `getOrCreateAccountForUser`, `getAccountByUser`, `listUnitTransactions`
- `lib/sms/bundle-service.ts` — `listActiveBundles`, `purchaseBundleViaWallet`, `allocateUnits`, `creditUnitsForPaystack`
- `lib/sms/bundle-service.test.ts` — fake-client test for the wallet-purchase orchestration
- `app/api/sms/account/route.ts` — GET caller's account + balance
- `app/api/sms/bundles/route.ts` — GET active bundles for caller
- `app/api/sms/units/purchase-wallet/route.ts` — POST buy bundle via wallet
- `app/api/sms/units/purchase-paystack/route.ts` — POST init Paystack purchase
- `app/api/admin/sms/bundles/route.ts` — admin GET/POST/PATCH bundle tiers
- `app/api/admin/sms/allocate/route.ts` — admin POST manual unit allocation
- `app/dashboard/sms/page.tsx` — minimal balance + buy-bundle UI (shop/sub-agent)
- `app/admin/sms/page.tsx` — minimal admin balance + bundle management UI

**Modify:**
- `app/api/webhooks/paystack/route.ts` — credit SMS units when a paystack tx is an SMS bundle purchase
- `lib/sms-service.ts` — **(Revision A)** add `queryMoolreSmsBalance()` (Moolre `type:2` wholesale balance) + `notifyAdminSmsShortfall()`

---

## Revision A — Fully-Backed Units (added 2026-06-16, after Tasks 1–2 shipped)

Internal units must never exceed the Moolre **wholesale** balance (one shared pool, Moolre `type:2`). Every credit path is routed through an **issuance-time solvency gate**; if the wholesale can't back a purchase, the buyer still pays but units land as **pending credits** ("Pending" in the UI), admin is notified, and a cron settles them once admin tops up the wholesale. See the spec's "SMS Units & Bundles (fully backed)" section. This supersedes the simple "always credit" flow in the original Tasks 7, 8, 10, 11, 13.

**DB (migration 0063 — DONE, applied + smoke-tested):** `sms_pending_credits` table; `credit_sms_units_if_solvent(p_account_id, p_units, p_reason, p_wholesale, p_ref)` → `(outcome 'credited'|'pending'|'duplicate', balance_after)` (advisory-locked, idempotent on `p_ref`); `settle_pending_sms_credits(p_wholesale)` → `(credited_count, credited_units)` (oldest-first).

**Revised credit-path contract (Tasks 7, 10, 11):** after taking payment, fetch `const wholesale = await queryMoolreSmsBalance()`, then call `supabaseAdmin.rpc("credit_sms_units_if_solvent", { p_account_id, p_units, p_reason, p_wholesale: wholesale, p_ref })`. Read `data[0].outcome`:
- `credited` → success, units added.
- `pending` → success but pending; call `notifyAdminSmsShortfall(units)` and return `{ ok: true, pending: true }`.
- `duplicate` → already processed (idempotent) → treat as success.
On the wallet path, if the rpc throws (not pending — an actual error), refund the cash via `deduct_wallet(p_user_id, -price)`.

**`queryMoolreSmsBalance()` (add to `lib/sms-service.ts`):** `POST https://api.moolre.com/open/sms/query` with header `X-API-VASKEY: <MOOLRE_API_KEY>` and body `{ type: 2 }`; return `Number(resp.data?.data?.balance ?? 0)`. On any error return `0` (fail-closed → everything goes pending rather than over-crediting).

**`notifyAdminSmsShortfall(unitsPending)` (add to `lib/sms-service.ts` or a small helper):** insert an in-app notification for admins + best-effort push; throttle to avoid spam (skip if an unread shortfall notification was created in the last 30 min). Non-blocking (`.catch(() => {})`).

**Pending-credits cron (`app/api/cron/sms-pending-credits/route.ts`):** auth via `verifyAdminAccess` (CRON_SECRET bypass); `const w = await queryMoolreSmsBalance(); const { data } = await supabaseAdmin.rpc("settle_pending_sms_credits", { p_wholesale: w });` return the counts. Register in `vercel.json` every minute.

**Account/UI (Tasks 5, 13):** `GET /api/sms/account` also returns `pendingUnits` = `SUM(units) FROM sms_pending_credits WHERE status='pending'` for the account; the dashboard shows a "Pending: N units" line.

---

## Conventions (read before starting)

- **Service-role client** (server-only):
  ```ts
  import { createClient } from "@supabase/supabase-js"
  const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  ```
- **User auth in a route** (non-admin): read `Authorization: Bearer <token>`, then `supabaseAdmin.auth.getUser(token)`. 401 if missing/invalid.
- **Admin auth:** `const auth = await verifyAdminAccess(request); if (!auth.isAdmin) return auth.errorResponse` (`lib/admin-auth.ts`).
- **Migrations** are plain `.sql` files applied to the live DB via the Supabase Management API (see `reference-supabase-access` memory). Use `CREATE TABLE IF NOT EXISTS`, inline `-- comments`, and `CREATE INDEX IF NOT EXISTS`.
- **Tests:** `npm run test:run` (once) / `npm test` (watch). Pure logic → dependency-free module + colocated `*.test.ts`.
- **Money/units law:** all balance changes go through `adjust_sms_units`. Never `UPDATE sms_accounts.unit_balance` directly from app code. **Issuing** units (any credit) must go through `credit_sms_units_if_solvent` (Revision A), never raw `adjust_sms_units` with a positive delta, so the wholesale-backing invariant holds.

---

## Task 1: Create foundation tables + RLS

**Files:**
- Create: `migrations/0061_create_sms_foundation.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Bulk SMS foundation: tenant accounts, units ledger, bundle tiers.
-- One sms_account per user (admin = platform, shop owner = shop, sub-agent = sub_agent).
-- All balance mutations go through adjust_sms_units() (migration 0062) — never update
-- unit_balance directly.

CREATE TABLE IF NOT EXISTS sms_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('platform','shop','sub_agent')),
  owner_id      UUID,                       -- shop_id / sub_agent id; null for platform
  unit_balance  INT  NOT NULL DEFAULT 0 CHECK (unit_balance >= 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_unit_transactions (
  id             BIGSERIAL PRIMARY KEY,
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  delta          INT  NOT NULL,             -- +credit / -debit (in units = SMS segments)
  reason         TEXT NOT NULL,             -- bundle_wallet | bundle_paystack | admin_alloc | campaign_send | campaign_refund
  balance_after  INT  NOT NULL,
  ref            TEXT,                       -- idempotency / external ref (paystack ref, campaign id)
  campaign_id    UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sms_bundles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  units            INT  NOT NULL CHECK (units > 0),
  price_ghs        NUMERIC(10,2) NOT NULL CHECK (price_ghs >= 0),
  owner_type_scope TEXT NOT NULL DEFAULT 'all' CHECK (owner_type_scope IN ('all','shop','sub_agent','platform')),
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_unit_tx_account ON sms_unit_transactions(sms_account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_unit_tx_ref ON sms_unit_transactions(ref) WHERE ref IS NOT NULL;

-- RLS: owners read their own account + ledger; everyone reads active bundles.
-- Writes happen only via service-role (RLS-bypassing) routes/functions.
ALTER TABLE sms_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_unit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_bundles           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_accounts_owner_select ON sms_accounts;
CREATE POLICY sms_accounts_owner_select ON sms_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS sms_unit_tx_owner_select ON sms_unit_transactions;
CREATE POLICY sms_unit_tx_owner_select ON sms_unit_transactions
  FOR SELECT TO authenticated USING (
    sms_account_id IN (SELECT id FROM sms_accounts WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS sms_bundles_read_active ON sms_bundles;
CREATE POLICY sms_bundles_read_active ON sms_bundles
  FOR SELECT TO authenticated USING (active = true);
```

- [ ] **Step 2: Apply the migration to the live DB**

Apply `migrations/0061_create_sms_foundation.sql` via the Supabase Management API SQL endpoint (per `reference-supabase-access` memory). 
Expected: success, three tables created.

- [ ] **Step 3: Verify the tables exist**

Run this SQL via the Management API:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('sms_accounts','sms_unit_transactions','sms_bundles')
ORDER BY table_name;
```
Expected: three rows — `sms_accounts`, `sms_bundles`, `sms_unit_transactions`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0061_create_sms_foundation.sql
git commit -m "feat(sms): foundation tables + RLS for accounts, units ledger, bundles"
```

---

## Task 2: Atomic units + account functions

**Files:**
- Create: `migrations/0062_create_sms_units_functions.sql`

- [ ] **Step 1: Write the functions**

```sql
-- adjust_sms_units: the ONLY way to change a unit balance. Race-safe (the WHERE guard
-- prevents going negative under concurrency) and atomic (balance update + ledger row in
-- one statement). Returns the new balance; returns NO rows if the account is missing or
-- a debit would overdraw — callers treat "no rows" as "insufficient units".

CREATE OR REPLACE FUNCTION adjust_sms_units(
  p_account_id  UUID,
  p_delta       INT,
  p_reason      TEXT,
  p_ref         TEXT DEFAULT NULL,
  p_campaign_id UUID DEFAULT NULL
)
RETURNS TABLE(balance_after INT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new INT;
BEGIN
  UPDATE sms_accounts
  SET unit_balance = unit_balance + p_delta,
      updated_at = now()
  WHERE id = p_account_id
    AND unit_balance + p_delta >= 0
  RETURNING unit_balance INTO v_new;

  IF NOT FOUND THEN
    RETURN; -- missing account or would overdraw
  END IF;

  INSERT INTO sms_unit_transactions (sms_account_id, delta, reason, balance_after, ref, campaign_id)
  VALUES (p_account_id, p_delta, p_reason, v_new, p_ref, p_campaign_id);

  balance_after := v_new;
  RETURN NEXT;
END;
$$;

-- get_or_create_sms_account: idempotently resolves a user's single SMS account.
CREATE OR REPLACE FUNCTION get_or_create_sms_account(
  p_user_id    UUID,
  p_owner_type TEXT,
  p_owner_id   UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO sms_accounts (user_id, owner_type, owner_id)
  VALUES (p_user_id, p_owner_type, p_owner_id)
  ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
```

- [ ] **Step 2: Apply the migration to the live DB**

Apply `migrations/0062_create_sms_units_functions.sql` via the Management API.
Expected: success, two functions created.

- [ ] **Step 3: Verify behavior with a smoke test (SQL)**

Run via the Management API (uses a throwaway auth user id you control, then cleans up):
```sql
-- create a temp account, credit 100, try to debit 150 (should fail), debit 40 (should pass)
DO $$
DECLARE a UUID; b INT;
BEGIN
  INSERT INTO sms_accounts (user_id, owner_type) VALUES (gen_random_uuid(), 'platform') RETURNING id INTO a;
  PERFORM adjust_sms_units(a, 100, 'admin_alloc');
  SELECT balance_after INTO b FROM adjust_sms_units(a, -150, 'campaign_send'); -- expect NULL (no row)
  RAISE NOTICE 'overdraw balance_after = %', b;       -- NULL
  SELECT balance_after INTO b FROM adjust_sms_units(a, -40, 'campaign_send');  -- expect 60
  RAISE NOTICE 'after debit 40 = %', b;               -- 60
  DELETE FROM sms_accounts WHERE id = a;              -- cascades ledger rows
END $$;
```
Expected NOTICES: `overdraw balance_after = <NULL>` then `after debit 40 = 60`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0062_create_sms_units_functions.sql
git commit -m "feat(sms): atomic adjust_sms_units + get_or_create_sms_account functions"
```

---

## Task 3: Pure foundation rules (TDD)

**Files:**
- Create: `lib/sms/foundation-rules.ts`
- Test: `lib/sms/foundation-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest"
import { deriveOwnerType, canPurchaseBundle } from "./foundation-rules"

describe("deriveOwnerType", () => {
  it("admin → platform", () => {
    expect(deriveOwnerType({ role: "admin", ownsShop: false, isSubAgent: false }))
      .toEqual({ ownerType: "platform", ownerId: null })
  })
  it("shop owner → shop with shopId", () => {
    expect(deriveOwnerType({ role: "dealer", ownsShop: true, isSubAgent: false, shopId: "s1" }))
      .toEqual({ ownerType: "shop", ownerId: "s1" })
  })
  it("sub-agent → sub_agent with subAgentId", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: true, subAgentId: "a1" }))
      .toEqual({ ownerType: "sub_agent", ownerId: "a1" })
  })
  it("admin who also owns a shop still resolves to platform", () => {
    expect(deriveOwnerType({ role: "admin", ownsShop: true, isSubAgent: false, shopId: "s1" }).ownerType)
      .toBe("platform")
  })
  it("plain user with no shop/sub-agent → null (no SMS account)", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: false })).toBeNull()
  })
})

describe("canPurchaseBundle", () => {
  const base = { id: "b1", active: true, owner_type_scope: "all" as const }
  it("active 'all' bundle is purchasable by any owner", () => {
    expect(canPurchaseBundle(base, "shop").ok).toBe(true)
  })
  it("inactive bundle is rejected", () => {
    expect(canPurchaseBundle({ ...base, active: false }, "shop"))
      .toEqual({ ok: false, reason: "Bundle is not available" })
  })
  it("scoped bundle rejects a mismatched owner type", () => {
    expect(canPurchaseBundle({ ...base, owner_type_scope: "sub_agent" }, "shop"))
      .toEqual({ ok: false, reason: "Bundle not available for this account type" })
  })
  it("scoped bundle accepts the matching owner type", () => {
    expect(canPurchaseBundle({ ...base, owner_type_scope: "shop" }, "shop").ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- lib/sms/foundation-rules.test.ts`
Expected: FAIL — "Cannot find module './foundation-rules'".

- [ ] **Step 3: Write minimal implementation**

```ts
export type OwnerType = "platform" | "shop" | "sub_agent"
export type BundleScope = "all" | OwnerType

export interface OwnerInput {
  role: string
  ownsShop: boolean
  isSubAgent: boolean
  shopId?: string
  subAgentId?: string
}

export interface OwnerContext {
  ownerType: OwnerType
  ownerId: string | null
}

/** Decide which SMS-account tenant a user belongs to. Admin wins over shop/sub-agent. */
export function deriveOwnerType(input: OwnerInput): OwnerContext | null {
  if (input.role === "admin") return { ownerType: "platform", ownerId: null }
  if (input.ownsShop) return { ownerType: "shop", ownerId: input.shopId ?? null }
  if (input.isSubAgent) return { ownerType: "sub_agent", ownerId: input.subAgentId ?? null }
  return null
}

export interface BundleLike {
  id: string
  active: boolean
  owner_type_scope: BundleScope
}

export function canPurchaseBundle(
  bundle: BundleLike,
  ownerType: OwnerType
): { ok: true } | { ok: false; reason: string } {
  if (!bundle.active) return { ok: false, reason: "Bundle is not available" }
  if (bundle.owner_type_scope !== "all" && bundle.owner_type_scope !== ownerType) {
    return { ok: false, reason: "Bundle not available for this account type" }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- lib/sms/foundation-rules.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/foundation-rules.ts lib/sms/foundation-rules.test.ts
git commit -m "feat(sms): pure owner-type + bundle-eligibility rules with tests"
```

---

## Task 4: Account service

**Files:**
- Create: `lib/sms/account-service.ts`

- [ ] **Step 1: Write the service**

```ts
import { createClient } from "@supabase/supabase-js"
import { deriveOwnerType, type OwnerContext } from "./foundation-rules"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface SmsAccount {
  id: string
  user_id: string
  owner_type: string
  owner_id: string | null
  unit_balance: number
  status: string
}

/** Look up role + shop/sub-agent membership and resolve the owner context. */
async function resolveOwnerContext(userId: string): Promise<OwnerContext | null> {
  const { data: u } = await supabaseAdmin.from("users").select("role").eq("id", userId).maybeSingle()
  const { data: shop } = await supabaseAdmin
    .from("user_shops").select("id").eq("user_id", userId).maybeSingle()
  const { data: sub } = await supabaseAdmin
    .from("sub_agents").select("id").eq("user_id", userId).maybeSingle()

  return deriveOwnerType({
    role: u?.role ?? "user",
    ownsShop: !!shop,
    isSubAgent: !!sub,
    shopId: shop?.id,
    subAgentId: sub?.id,
  })
}

/** Idempotently create (or fetch) the caller's SMS account. Returns null if the user
 *  is not entitled (plain user with no shop/sub-agent and not admin). */
export async function getOrCreateAccountForUser(userId: string): Promise<SmsAccount | null> {
  const ctx = await resolveOwnerContext(userId)
  if (!ctx) return null

  const { data: id, error } = await supabaseAdmin.rpc("get_or_create_sms_account", {
    p_user_id: userId,
    p_owner_type: ctx.ownerType,
    p_owner_id: ctx.ownerId,
  })
  if (error || !id) return null

  const { data: account } = await supabaseAdmin
    .from("sms_accounts").select("*").eq("id", id).single()
  return (account as SmsAccount) ?? null
}

export async function listUnitTransactions(accountId: string, limit = 50) {
  const { data } = await supabaseAdmin
    .from("sms_unit_transactions")
    .select("*")
    .eq("sms_account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(limit)
  return data ?? []
}
```

> **Note:** if the `sub_agents` table name differs in this repo, adjust the `.from("sub_agents")` call. Verify with: `git grep -l "sub_agent" lib/ migrations/ | head`.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors referencing `lib/sms/account-service.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/sms/account-service.ts
git commit -m "feat(sms): account-service get-or-create + unit transaction listing"
```

---

## Task 5: GET /api/sms/account route

**Files:**
- Create: `app/api/sms/account/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser, listUnitTransactions } from "@/lib/sms/account-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }
  const transactions = await listUnitTransactions(account.id, 20)
  return NextResponse.json({
    account: { id: account.id, ownerType: account.owner_type, unitBalance: account.unit_balance, status: account.status },
    transactions,
  })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors for this file.

- [ ] **Step 3: Manual smoke test**

Start the dev server (`npm run dev`), sign in as a shop owner in the browser, copy the access token from the Supabase session, and:
```bash
curl -s http://localhost:3000/api/sms/account -H "Authorization: Bearer <token>" | jq
```
Expected: JSON with `account.unitBalance: 0` and `transactions: []`.

- [ ] **Step 4: Commit**

```bash
git add app/api/sms/account/route.ts
git commit -m "feat(sms): GET /api/sms/account returns balance + recent unit transactions"
```

---

## Task 6: Bundle service + GET /api/sms/bundles

**Files:**
- Create: `lib/sms/bundle-service.ts`
- Create: `app/api/sms/bundles/route.ts`

- [ ] **Step 1: Write `listActiveBundles` in the bundle service**

```ts
import { createClient } from "@supabase/supabase-js"
import { canPurchaseBundle, type OwnerType } from "./foundation-rules"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface Bundle {
  id: string
  name: string
  units: number
  price_ghs: number
  owner_type_scope: "all" | OwnerType
  active: boolean
}

/** Active bundles this owner type is allowed to buy. */
export async function listActiveBundles(ownerType: OwnerType): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*").eq("active", true)
    .order("price_ghs", { ascending: true })
  return ((data as Bundle[]) ?? []).filter((b) => canPurchaseBundle(b, ownerType).ok)
}
```

- [ ] **Step 2: Write the route**

```ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { listActiveBundles } from "@/lib/sms/bundle-service"
import type { OwnerType } from "@/lib/sms/foundation-rules"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  const bundles = await listActiveBundles(account.owner_type as OwnerType)
  return NextResponse.json({ bundles })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors for these two files.

- [ ] **Step 4: Commit**

```bash
git add lib/sms/bundle-service.ts app/api/sms/bundles/route.ts
git commit -m "feat(sms): list purchasable bundles per owner type + GET /api/sms/bundles"
```

---

## Task 7: Wallet purchase orchestration (TDD with fake client)

**Files:**
- Modify: `lib/sms/bundle-service.ts`
- Test: `lib/sms/bundle-service.test.ts`

- [ ] **Step 1: Write the failing test (fake Supabase client)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

// Hand-rolled chainable fake. Records rpc calls; deduct_wallet returns rows only when funded.
const calls: any[] = []
let walletBalance = 0
const fake = {
  rpc: (fn: string, args: any) => {
    calls.push({ fn, args })
    if (fn === "deduct_wallet") {
      if (walletBalance >= args.p_amount) {
        walletBalance -= args.p_amount
        return Promise.resolve({ data: [{ new_balance: walletBalance, old_balance: walletBalance + args.p_amount }], error: null })
      }
      return Promise.resolve({ data: [], error: null }) // insufficient
    }
    if (fn === "adjust_sms_units") {
      return Promise.resolve({ data: [{ balance_after: args.p_delta }], error: null })
    }
    return Promise.resolve({ data: null, error: null })
  },
  from: (_t: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: "b1", name: "5k", units: 5000, price_ghs: 150, owner_type_scope: "all", active: true }, error: null }) }) }),
  }),
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => fake }))

import { purchaseBundleViaWallet } from "./bundle-service"

beforeEach(() => { calls.length = 0 })

describe("purchaseBundleViaWallet", () => {
  it("debits wallet then credits units when funded", async () => {
    walletBalance = 200
    const res = await purchaseBundleViaWallet("user-1", "acc-1", "b1")
    expect(res.ok).toBe(true)
    const fns = calls.map((c) => c.fn)
    expect(fns).toEqual(["deduct_wallet", "adjust_sms_units"])
    expect(calls[1].args).toMatchObject({ p_account_id: "acc-1", p_delta: 5000, p_reason: "bundle_wallet" })
  })

  it("does NOT credit units when the wallet is short", async () => {
    walletBalance = 50
    const res = await purchaseBundleViaWallet("user-1", "acc-1", "b1")
    expect(res.ok).toBe(false)
    expect(calls.map((c) => c.fn)).toEqual(["deduct_wallet"]) // never reached adjust_sms_units
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- lib/sms/bundle-service.test.ts`
Expected: FAIL — `purchaseBundleViaWallet is not a function`.

- [ ] **Step 3: Add `purchaseBundleViaWallet` to the service**

Append to `lib/sms/bundle-service.ts`:
```ts
import { canPurchaseBundle as _checkBundle } from "./foundation-rules"

export interface PurchaseResult { ok: boolean; error?: string; unitsCredited?: number }

/** Atomic: debit cash wallet (race-safe via deduct_wallet), then credit SMS units.
 *  If the wallet debit returns no rows (insufficient), units are never credited. */
export async function purchaseBundleViaWallet(
  userId: string,
  accountId: string,
  bundleId: string
): Promise<PurchaseResult> {
  const { data: bundle } = await supabaseAdmin
    .from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle) return { ok: false, error: "Bundle not found" }

  const { data: debit, error: debitErr } = await supabaseAdmin.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: (bundle as Bundle).price_ghs,
  })
  if (debitErr) return { ok: false, error: "Wallet debit failed" }
  if (!debit || (debit as any[]).length === 0) return { ok: false, error: "Insufficient wallet balance" }

  const { data: credit, error: creditErr } = await supabaseAdmin.rpc("adjust_sms_units", {
    p_account_id: accountId,
    p_delta: (bundle as Bundle).units,
    p_reason: "bundle_wallet",
    p_ref: `wallet-${userId}-${bundleId}-${(debit as any[])[0]?.new_balance}`,
  })
  if (creditErr || !credit || (credit as any[]).length === 0) {
    // Compensating refund: put the cash back so money isn't lost on a units-credit failure.
    await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: -(bundle as Bundle).price_ghs })
    return { ok: false, error: "Failed to credit units (refunded)" }
  }
  return { ok: true, unitsCredited: (bundle as Bundle).units }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- lib/sms/bundle-service.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/bundle-service.ts lib/sms/bundle-service.test.ts
git commit -m "feat(sms): wallet bundle purchase (debit-then-credit, refund on failure)"
```

---

## Task 8: POST /api/sms/units/purchase-wallet

**Files:**
- Create: `app/api/sms/units/purchase-wallet/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { purchaseBundleViaWallet } from "@/lib/sms/bundle-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { bundleId } = await request.json()
  if (!bundleId) return NextResponse.json({ error: "bundleId required" }, { status: 400 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  const result = await purchaseBundleViaWallet(user.id, account.id, bundleId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, unitsCredited: result.unitsCredited })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors for this file.

- [ ] **Step 3: Commit**

```bash
git add app/api/sms/units/purchase-wallet/route.ts
git commit -m "feat(sms): POST /api/sms/units/purchase-wallet"
```

---

## Task 9: Admin bundle management

**Files:**
- Modify: `lib/sms/bundle-service.ts`
- Create: `app/api/admin/sms/bundles/route.ts`

- [ ] **Step 1: Add admin bundle CRUD helpers to the service**

Append to `lib/sms/bundle-service.ts`:
```ts
export async function listAllBundles(): Promise<Bundle[]> {
  const { data } = await supabaseAdmin.from("sms_bundles").select("*").order("price_ghs", { ascending: true })
  return (data as Bundle[]) ?? []
}

export async function createBundle(input: { name: string; units: number; price_ghs: number; owner_type_scope?: string }) {
  const { data, error } = await supabaseAdmin.from("sms_bundles").insert({
    name: input.name, units: input.units, price_ghs: input.price_ghs,
    owner_type_scope: input.owner_type_scope ?? "all",
  }).select("*").single()
  if (error) throw error
  return data as Bundle
}

export async function updateBundle(id: string, patch: Partial<{ name: string; units: number; price_ghs: number; active: boolean; owner_type_scope: string }>) {
  const { data, error } = await supabaseAdmin.from("sms_bundles")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single()
  if (error) throw error
  return data as Bundle
}
```

- [ ] **Step 2: Write the admin route**

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listAllBundles, createBundle, updateBundle } from "@/lib/sms/bundle-service"

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  return NextResponse.json({ bundles: await listAllBundles() })
}

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const body = await request.json()
  if (!body.name || !body.units || body.price_ghs == null) {
    return NextResponse.json({ error: "name, units, price_ghs required" }, { status: 400 })
  }
  return NextResponse.json({ bundle: await createBundle(body) })
}

export async function PATCH(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const body = await request.json()
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const { id, ...patch } = body
  return NextResponse.json({ bundle: await updateBundle(id, patch) })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors for these files.

- [ ] **Step 4: Commit**

```bash
git add lib/sms/bundle-service.ts app/api/admin/sms/bundles/route.ts
git commit -m "feat(sms): admin bundle CRUD service + /api/admin/sms/bundles"
```

---

## Task 10: Admin manual unit allocation

**Files:**
- Modify: `lib/sms/bundle-service.ts`
- Create: `app/api/admin/sms/allocate/route.ts`

- [ ] **Step 1: Add `allocateUnits` to the service**

Append to `lib/sms/bundle-service.ts`:
```ts
/** Admin grants units to any account (e.g. offline payment). Positive units only. */
export async function allocateUnits(accountId: string, units: number, note?: string): Promise<PurchaseResult> {
  if (!Number.isInteger(units) || units <= 0) return { ok: false, error: "units must be a positive integer" }
  const { data, error } = await supabaseAdmin.rpc("adjust_sms_units", {
    p_account_id: accountId, p_delta: units, p_reason: "admin_alloc", p_ref: note ?? null,
  })
  if (error || !data || (data as any[]).length === 0) return { ok: false, error: "Allocation failed (unknown account?)" }
  return { ok: true, unitsCredited: units }
}
```

- [ ] **Step 2: Write the admin route**

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { allocateUnits } from "@/lib/sms/bundle-service"

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { accountId, units, note } = await request.json()
  if (!accountId || !units) return NextResponse.json({ error: "accountId and units required" }, { status: 400 })
  const result = await allocateUnits(accountId, Number(units), note)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, unitsCredited: result.unitsCredited })
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors for these files.

- [ ] **Step 4: Commit**

```bash
git add lib/sms/bundle-service.ts app/api/admin/sms/allocate/route.ts
git commit -m "feat(sms): admin manual unit allocation + /api/admin/sms/allocate"
```

---

## Task 11: Paystack top-up path

**Files:**
- Modify: `lib/sms/bundle-service.ts`
- Create: `app/api/sms/units/purchase-paystack/route.ts`
- Modify: `app/api/webhooks/paystack/route.ts`

- [ ] **Step 1: Add `creditUnitsForPaystack` to the service (idempotent on paystack ref)**

Append to `lib/sms/bundle-service.ts`:
```ts
/** Credit units after a confirmed Paystack SMS-bundle payment. Idempotent: the unique
 *  index on sms_unit_transactions.ref makes a repeated webhook a no-op (no double credit). */
export async function creditUnitsForPaystack(accountId: string, units: number, paystackRef: string): Promise<PurchaseResult> {
  const { data, error } = await supabaseAdmin.rpc("adjust_sms_units", {
    p_account_id: accountId, p_delta: units, p_reason: "bundle_paystack", p_ref: paystackRef,
  })
  // Unique-ref violation surfaces as a Postgres error → treat as already-credited success.
  if (error) {
    if ((error as any).code === "23505") return { ok: true, unitsCredited: 0 }
    return { ok: false, error: "Credit failed" }
  }
  if (!data || (data as any[]).length === 0) return { ok: false, error: "Unknown account" }
  return { ok: true, unitsCredited: units }
}
```

- [ ] **Step 2: Write the Paystack init route**

```ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { initializePaystackTransaction } from "@/lib/paystack" // existing helper

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { bundleId } = await request.json()
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  const { data: bundle } = await supabaseAdmin.from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle || !bundle.active) return NextResponse.json({ error: "Bundle not available" }, { status: 400 })

  const reference = `smsbundle-${account.id}-${bundleId}-${user.id.slice(0, 8)}`
  const init = await initializePaystackTransaction({
    email: user.email!,
    amount: Math.round(Number(bundle.price_ghs) * 100), // pesewas
    reference,
    metadata: { purpose: "sms_bundle", sms_account_id: account.id, units: bundle.units, bundle_id: bundleId },
  })
  return NextResponse.json({ authorizationUrl: init.authorization_url, reference })
}
```

> **Verify** the exact name/signature of the Paystack init helper before wiring: `git grep -n "authorization_url\|initialize" lib/paystack.ts`. Match the existing wallet top-up call in `app/api/payments/initialize/route.ts`.

- [ ] **Step 3: Hook the webhook to credit units**

In `app/api/webhooks/paystack/route.ts`, inside the verified `charge.success` handler, BEFORE the existing wallet-credit logic, add a branch on the metadata purpose:
```ts
// SMS bundle purchase — credit units instead of wallet cash.
if (event.data?.metadata?.purpose === "sms_bundle") {
  const { creditUnitsForPaystack } = await import("@/lib/sms/bundle-service")
  await creditUnitsForPaystack(
    event.data.metadata.sms_account_id,
    Number(event.data.metadata.units),
    event.data.reference
  )
  return NextResponse.json({ received: true })
}
```

> Place this guard so it `return`s before the wallet top-up path runs — an SMS bundle payment must not also credit the cash wallet.

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no new errors. If the Paystack helper name differs, fix the import per the Step 2 note.

- [ ] **Step 5: Commit**

```bash
git add lib/sms/bundle-service.ts app/api/sms/units/purchase-paystack/route.ts app/api/webhooks/paystack/route.ts
git commit -m "feat(sms): Paystack bundle purchase init + idempotent webhook unit credit"
```

---

## Task 12: Seed default bundles

**Files:**
- Create: `migrations/0063_seed_sms_bundles.sql`

- [ ] **Step 1: Write the seed migration**

```sql
-- Initial SMS bundle tiers (admin can edit/add via the UI later).
INSERT INTO sms_bundles (name, units, price_ghs, owner_type_scope, active) VALUES
  ('Starter — 1,000 SMS',  1000,  35.00, 'all', true),
  ('Growth — 5,000 SMS',   5000, 150.00, 'all', true),
  ('Scale — 20,000 SMS',  20000, 520.00, 'all', true)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: Apply via the Management API and verify**

```sql
SELECT name, units, price_ghs FROM sms_bundles ORDER BY price_ghs;
```
Expected: three rows.

- [ ] **Step 3: Commit**

```bash
git add migrations/0063_seed_sms_bundles.sql
git commit -m "feat(sms): seed default SMS bundle tiers"
```

---

## Task 13: Minimal UI — balance + buy bundle

**Files:**
- Create: `app/dashboard/sms/page.tsx`
- Create: `app/admin/sms/page.tsx`

> These are intentionally minimal — a balance card, a bundle list with a "Buy with wallet" button, and (admin) an allocate form. The full console UI is built in later plans. Match the existing dashboard/admin page shells (client components using the browser Supabase client for the access token).

- [ ] **Step 1: Write the dashboard SMS page**

```tsx
"use client"
import { useEffect, useState } from "react"
import { createClientComponentClient } from "@/lib/supabase-browser" // match existing browser-client helper

export default function SmsDashboardPage() {
  const supabase = createClientComponentClient()
  const [balance, setBalance] = useState<number | null>(null)
  const [bundles, setBundles] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }
  async function load() {
    const t = await token()
    const acc = await fetch("/api/sms/account", { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json())
    setBalance(acc.account?.unitBalance ?? 0)
    const bun = await fetch("/api/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json())
    setBundles(bun.bundles ?? [])
  }
  useEffect(() => { load() }, [])

  async function buy(bundleId: string) {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then(r => r.json())
    setBusy(false)
    if (res.error) alert(res.error); else await load()
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">SMS Units</h1>
      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Balance</div>
        <div className="text-3xl font-bold">{balance ?? "…"} units</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {bundles.map((b) => (
          <div key={b.id} className="rounded-lg border p-4 space-y-2">
            <div className="font-semibold">{b.name}</div>
            <div className="text-sm">{b.units.toLocaleString()} units · GHS {Number(b.price_ghs).toFixed(2)}</div>
            <button disabled={busy} onClick={() => buy(b.id)} className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">
              Buy with wallet
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
```

> **Verify** the browser-client import path: `git grep -n "createClientComponentClient\|supabase-browser\|createBrowserClient" lib/ | head`. Use whatever the rest of `app/dashboard/**` uses.

- [ ] **Step 2: Write the admin SMS page (balance overview + allocate form)**

```tsx
"use client"
import { useEffect, useState } from "react"
import { createClientComponentClient } from "@/lib/supabase-browser"

export default function AdminSmsPage() {
  const supabase = createClientComponentClient()
  const [bundles, setBundles] = useState<any[]>([])
  const [accountId, setAccountId] = useState("")
  const [units, setUnits] = useState("")
  const [msg, setMsg] = useState("")

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }
  async function load() {
    const t = await token()
    const res = await fetch("/api/admin/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then(r => r.json())
    setBundles(res.bundles ?? [])
  }
  useEffect(() => { load() }, [])

  async function allocate() {
    const t = await token()
    const res = await fetch("/api/admin/sms/allocate", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, units: Number(units) }),
    }).then(r => r.json())
    setMsg(res.error ? `Error: ${res.error}` : `Credited ${res.unitsCredited} units`)
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">SMS Admin</h1>
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">Allocate units</h2>
        <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="sms_account id" className="w-full rounded border px-2 py-1" />
        <input value={units} onChange={(e) => setUnits(e.target.value)} placeholder="units" className="w-full rounded border px-2 py-1" />
        <button onClick={allocate} className="rounded bg-primary px-3 py-2 text-primary-foreground">Allocate</button>
        {msg && <div className="text-sm">{msg}</div>}
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="font-semibold mb-2">Bundles</h2>
        <ul className="text-sm space-y-1">
          {bundles.map((b) => (
            <li key={b.id}>{b.name} — {b.units} units — GHS {Number(b.price_ghs).toFixed(2)} {b.active ? "" : "(inactive)"}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: Verify the app builds**

Run: `npm run build`
Expected: build succeeds; `/dashboard/sms` and `/admin/sms` compile.

- [ ] **Step 4: Manual smoke test**

`npm run dev`, sign in as a shop owner, visit `/dashboard/sms`: balance shows 0, three bundles list. Top up the cash wallet, click "Buy with wallet" → balance jumps by the bundle's units. As admin, visit `/admin/sms`, paste the account id, allocate 100 → owner's balance grows by 100.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/sms/page.tsx app/admin/sms/page.tsx
git commit -m "feat(sms): minimal units balance + buy-bundle + admin allocate UI"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** Tenancy spine → Tasks 1–4. Units ledger + atomic law → Task 2. Three top-up paths → cash (7–8), admin manual (10), Paystack (11). Bundle tiers → Tasks 1, 9, 12. RLS → Task 1. Owner-type-per-user model → Task 3. Minimal surfaces → Task 13.
- **Out of scope for this plan (later milestones):** sender IDs, contacts/groups, segments, composer/preview, campaign queue, supply guard, reports. Reserve/settle of units lands in Plan 4 (campaign engine) — the `campaign_send`/`campaign_refund` reasons are already allowed by the ledger here.
- **Type consistency:** `OwnerType` and `canPurchaseBundle` shared from `foundation-rules.ts`; `adjust_sms_units(p_account_id, p_delta, p_reason, p_ref, p_campaign_id)` signature is identical across Tasks 2, 7, 10, 11; `PurchaseResult` reused across all purchase paths.
- **Known verification points flagged inline:** `sub_agents` table name (Task 4), Paystack init helper signature (Task 11), browser Supabase client import (Task 13). Each has a `git grep` to confirm before coding.

---

## Post-review status (2026-06-16)

Foundation implemented, independently reviewed (no Critical issues), 55 tests pass, production build green. Two Important findings fixed: Paystack webhook amount-paid guard + DB-authoritative unit count; wallet refund idempotency guard (`refLanded`) to prevent free-units-plus-refund on a lost RPC response.

**Deferred Minor follow-ups** (acceptable for foundation, revisit before scale):
- Wallet purchase has no server-side in-flight/dedupe guard — rapid double-clicks buy twice (distinct refs). Add an idempotency key if accidental double-purchase becomes a concern.
- `/api/cron/sms-pending-credits` silently no-ops (401) if `CRON_SECRET` is unset; peer crons log-and-deny visibly. Match that for ops visibility.
- `settle_pending_sms_credits` flips `status='credited'` without checking `adjust_sms_units` returned a row — unreachable today (`sms_pending_credits.sms_account_id` is `ON DELETE CASCADE`), but worth a guard for robustness.

---

## Next plans (written after Foundation lands)

2. **Sender IDs** — submit → Moolre create (type 3) → poll status (type 1) cron → `active` gating.
3. **Contacts & groups** — CSV/paste import, dedupe, M:N groups.
4. **Composer + engine** — segments, live preview/cost meter, `sms_messages`, batched Moolre `messages[]` drain, reserve/settle units.
5. **Supply guard + reports + scheduling** — master-balance gate + auto-pause/resume, delivery aggregation, scheduled sends.
