# Bulk SMS — Plan 2 of 5: Activation + Welcome Bonus + Tenant Dashboard Implementation Plan

> ### ⚠️ Cross-plan reconciliation (read first)
> One of 5 Bulk SMS milestone plans authored together; applied in order **M2 → M3 → M4 → M5**.
> - **Migration numbers are INDICATIVE.** At execution, use the next unused `NNNN_` prefix above the highest already in `migrations/` (latest is `0064`). Several plans were drafted assuming `0065` — don't trust the literal numbers; allocate sequentially across milestones.
> - The tenant page `app/dashboard/sms/page.tsx` you build here (activation card, bonus claim, balance/pending, bundle store) is **extended by Milestone 3** (which adds a composer tab). Structure it so a tab can be added later — don't treat it as final.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Complete each step fully — write the failing test, confirm it fails, implement, confirm it passes, then commit — before moving to the next.

**Goal:** Gate metered SMS (shop + sub_agent accounts) behind a one-time paid activation, provide a one-time welcome-bonus claim (solvency-gated via `credit_sms_units_if_solvent`), block bundle purchase + send while `inactive`, wire a Paystack activation path (webhook branch mirrors the existing `sms_bundle` branch), and grow the tenant SMS dashboard into a complete activation + bonus + bundle store UI. Platform (admin) accounts are exempt from the gate.

**Architecture:** Activation is a one-time payment event that flips `sms_accounts.status` from `inactive` to `active`. All state transitions live inside `SECURITY DEFINER` RPCs (`activate_sms_account`, `claim_sms_welcome_bonus`) so application code never raw-updates the `sms_accounts` table. The activation fee and welcome-bonus credit count are stored in a new `tenant_global_settings` table (not `admin_settings` — the existing `admin_settings` table has admin-only read policies and a UUID primary key that does not fit a lightweight key/value store for tenant-facing reads; a new `tenant_global_settings` with text PK and public-read policy is cleaner). The Paystack activation path reuses the existing `initializePayment` helper and is finalized in the existing Paystack webhook by a `metadata.type === "sms_activation"` branch inserted immediately after the existing `sms_bundle` branch (~line 76 of `app/api/webhooks/paystack/route.ts`). Activation-gate enforcement on bundle purchase lives in `lib/sms/bundle-service.ts` `purchaseBundleViaWallet` (and the Paystack init route), returning a typed `NOT_ACTIVATED` error.

**Tech Stack:** Next.js 15 App Router (route handlers), Supabase (Postgres + RLS, service-role client), Vitest, TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-16-bulk-sms-platform-design.md` — Revision B section: "Activation gate", "Welcome bonus", "Data-model deltas", "Revised milestones 2".

---

## File Structure

**Create:**
- `migrations/0065_sms_activation_gate.sql` — ALTER `sms_accounts` (add activation columns, widen status CHECK, set default `inactive`, backfill existing rows); create `tenant_global_settings` table with seed rows; create `activate_sms_account` and `claim_sms_welcome_bonus` RPCs
- `lib/sms/activation-service.ts` — `activateViawallet(userId, accountId)`, `initActivationPaystack(userId, accountId, userEmail)`, `finalizeActivationPaystack(accountId, paystackRef, amountPaidGhs)`, `claimWelcomeBonus(accountId)`
- `lib/sms/activation-service.test.ts` — unit tests for activation + bonus service (fake-client pattern matching `bundle-service.test.ts`)
- `app/api/sms/activate/route.ts` — POST handler (wallet path: calls `activateViaWallet`; Paystack path: calls `initActivationPaystack`, returns `authorizationUrl`)
- `app/api/sms/claim-bonus/route.ts` — POST handler: calls `claimWelcomeBonus`

**Modify:**
- `migrations/0061_create_sms_foundation.sql` — no change needed (already applied); this note is here so future operators know the status baseline before 0065 runs
- `app/api/sms/account/route.ts` — extend GET response to include `activationStatus`, `bonusClaimed`, `bonusClaimedAt`, `activatedAt`, `activationFee`, `welcomeBonusCredits`
- `app/api/sms/units/purchase-wallet/route.ts` — add activation gate: return `{ error: "NOT_ACTIVATED" }` (400) when account is not `active` (unless `platform`)
- `app/api/sms/units/purchase-paystack/route.ts` — same activation gate
- `lib/sms/bundle-service.ts` — export `NOT_ACTIVATED` typed error from `purchaseBundleViaWallet` and `creditUnitsForPaystack` paths
- `app/api/webhooks/paystack/route.ts` — add `sms_activation` branch immediately after the existing `sms_bundle` branch
- `app/dashboard/sms/page.tsx` — replace minimal balance view with: activation card (fee, wallet/Paystack CTA), welcome-bonus claim button, balance panel (credits + pending), bundle store (existing)

---

## Conventions

- **No raw balance updates from app code.** All activation side-effects (status flip, `activated_at`, `amount_paid`) live in `activate_sms_account` RPC. Bonus units go through `credit_sms_units_if_solvent` called from within `claim_sms_welcome_bonus` RPC (or from the service layer after calling the RPC — see Task 3).
- **Gate check is inside the RPC.** `activate_sms_account` raises `ALREADY_ACTIVATED` if called twice; `claim_sms_welcome_bonus` uses a guarded `UPDATE … WHERE bonus_claimed = false RETURNING` so concurrent calls are safe.
- **Typed errors.** Service functions return `{ ok: false; error: "NOT_ACTIVATED" | "ALREADY_ACTIVATED" | "INSUFFICIENT_BALANCE" | "ALREADY_CLAIMED" | string }` — callers check `error` to distinguish user-facing messages from system errors.
- **Idempotent Paystack activation.** `finalizeActivationPaystack` uses the Paystack reference as a uniqueness check: if the account is already `active`, log and return `{ ok: true, alreadyDone: true }` (no double-credit, no error).
- **`tenant_global_settings` read policy.** Public readable (`TO authenticated USING (true)`), admin-write only. Service-role bypasses RLS for the RPCs.
- **`platform` accounts skip the gate.** Every activation check short-circuits when `owner_type = 'platform'`.
- **Money/units law.** Bonus credits use `credit_sms_units_if_solvent` (solvency-gated; can land `pending`). The activation fee debit uses `deduct_wallet` (wallet path) or is taken by Paystack directly (Paystack path). No direct `UPDATE unit_balance`.
- **Test pattern.** Follow `lib/sms/bundle-service.test.ts` exactly: `vi.hoisted` state + `vi.mock("@supabase/supabase-js")` fake client.
- **Migration execution.** Migrations are SQL files committed to `migrations/`. The operator applies them via the Supabase Management API or the Supabase dashboard SQL editor. Each task that creates a migration file ends with: "Operator applies migration via Supabase dashboard; verify with the query in the task."

---

## Tasks

### Task 1 — Write failing test for activation service

- [ ] Create `lib/sms/activation-service.test.ts` with the following content. Run `npm test -- activation-service` and confirm all tests fail (module does not exist yet).

```typescript
// lib/sms/activation-service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    accountStatus: "inactive" as string,  // current sms_accounts.status
    ownerType: "shop" as string,
    walletBalance: 0,
    wholesale: 1_000_000,
    activationFee: 20,
    welcomeBonus: 10,
    activationRpcError: null as string | null, // force activate_sms_account to error
    bonusRpcError: null as string | null,      // force claim_sms_welcome_bonus to error
    creditOutcome: "credited" as "credited" | "pending",
    paystackRef: null as string | null, // existing paystack ref already processed
    calls: [] as { fn: string; args: any }[],
  }
  const fake = {
    rpc: (fn: string, args: any) => {
      state.calls.push({ fn, args })
      if (fn === "activate_sms_account") {
        if (state.activationRpcError === "ALREADY_ACTIVATED") {
          return Promise.resolve({ data: null, error: { message: "ALREADY_ACTIVATED", code: "P0001" } })
        }
        if (state.activationRpcError === "INSUFFICIENT_BALANCE") {
          return Promise.resolve({ data: null, error: { message: "INSUFFICIENT_BALANCE", code: "P0001" } })
        }
        state.accountStatus = "active"
        return Promise.resolve({ data: [{ ok: true }], error: null })
      }
      if (fn === "claim_sms_welcome_bonus") {
        if (state.bonusRpcError === "ALREADY_CLAIMED") {
          return Promise.resolve({ data: null, error: { message: "ALREADY_CLAIMED", code: "P0001" } })
        }
        return Promise.resolve({ data: [{ units_credited: state.welcomeBonus, outcome: state.creditOutcome }], error: null })
      }
      if (fn === "deduct_wallet") {
        if (state.walletBalance >= args.p_amount) {
          state.walletBalance -= args.p_amount
          return Promise.resolve({ data: [{ new_balance: state.walletBalance }], error: null })
        }
        return Promise.resolve({ data: [], error: null }) // insufficient
      }
      if (fn === "credit_sms_units_if_solvent") {
        return Promise.resolve({ data: [{ outcome: state.creditOutcome }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => ({
      select: (cols?: string) => ({
        eq: (col: string, val: any) => ({
          single: () => {
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: { id: "acc1", status: state.accountStatus, owner_type: state.ownerType },
                error: null,
              })
            }
            if (table === "users") {
              return Promise.resolve({ data: { email: "test@example.com" }, error: null })
            }
            return Promise.resolve({ data: null, error: null })
          },
          maybeSingle: () => {
            if (table === "sms_accounts") {
              return Promise.resolve({
                data: { id: "acc1", status: state.accountStatus, owner_type: state.ownerType },
                error: null,
              })
            }
            return Promise.resolve({ data: null, error: null })
          },
          eq: (col2: string, val2: any) => ({
            maybeSingle: () => {
              // Paystack ref idempotency check
              if (table === "sms_accounts" && state.paystackRef === val2) {
                return Promise.resolve({ data: { id: "acc1", status: "active" }, error: null })
              }
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }),
      }),
    }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "u1", email: "test@example.com" } }, error: null }),
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.state.wholesale) }))
vi.mock("./notify", () => ({ notifyAdminSmsShortfall: () => Promise.resolve() }))

import { activateViaWallet, claimWelcomeBonus, finalizeActivationPaystack } from "./activation-service"

beforeEach(() => {
  h.state.calls.length = 0
  h.state.accountStatus = "inactive"
  h.state.ownerType = "shop"
  h.state.walletBalance = 0
  h.state.activationRpcError = null
  h.state.bonusRpcError = null
  h.state.creditOutcome = "credited"
  h.state.paystackRef = null
})

const rpcs = () => h.state.calls.filter((c) => "fn" in c).map((c) => c.fn)

describe("activateViaWallet", () => {
  it("sufficient wallet → activates and returns ok", async () => {
    h.state.walletBalance = 50
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("deduct_wallet")
    expect(rpcs()).toContain("activate_sms_account")
  })

  it("insufficient wallet → NOT_ACTIVATED error, no RPC called", async () => {
    h.state.walletBalance = 5
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("INSUFFICIENT_BALANCE")
    expect(rpcs()).not.toContain("activate_sms_account")
  })

  it("already activated → ALREADY_ACTIVATED error", async () => {
    h.state.walletBalance = 50
    h.state.activationRpcError = "ALREADY_ACTIVATED"
    const res = await activateViaWallet("u1", "acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("ALREADY_ACTIVATED")
  })

  it("platform account → skips wallet debit, returns ok without gate", async () => {
    h.state.ownerType = "platform"
    h.state.walletBalance = 0
    const res = await activateViaWallet("u1", "acc1")
    // Platform accounts are pre-active; activation is a no-op
    expect(res.ok).toBe(true)
    expect(rpcs()).not.toContain("deduct_wallet")
  })
})

describe("finalizeActivationPaystack", () => {
  it("new reference → calls activate_sms_account RPC", async () => {
    const res = await finalizeActivationPaystack("acc1", "ps-ref-123", 20)
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("activate_sms_account")
  })

  it("duplicate reference (account already active) → returns ok, alreadyDone=true", async () => {
    h.state.accountStatus = "active"
    h.state.activationRpcError = "ALREADY_ACTIVATED"
    const res = await finalizeActivationPaystack("acc1", "ps-ref-dup", 20)
    expect(res.ok).toBe(true)
    expect(res.alreadyDone).toBe(true)
  })
})

describe("claimWelcomeBonus", () => {
  it("active account, unclaimed → credits bonus and returns ok", async () => {
    h.state.accountStatus = "active"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(true)
    expect(rpcs()).toContain("claim_sms_welcome_bonus")
  })

  it("already claimed → ALREADY_CLAIMED error", async () => {
    h.state.accountStatus = "active"
    h.state.bonusRpcError = "ALREADY_CLAIMED"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("ALREADY_CLAIMED")
  })

  it("bonus outcome pending → returns ok with pending=true", async () => {
    h.state.accountStatus = "active"
    h.state.creditOutcome = "pending"
    const res = await claimWelcomeBonus("acc1")
    expect(res.ok).toBe(true)
    expect(res.pending).toBe(true)
  })
})
```

Expected output: `FAIL lib/sms/activation-service.test.ts` (cannot find module `./activation-service`).

---

### Task 2 — Write failing test for activation gate on bundle purchase

- [ ] Append to `lib/sms/bundle-service.test.ts` a new `describe("activation gate")` block. Run `npm test -- bundle-service` and confirm the new tests fail (the gate does not exist yet).

```typescript
// Append inside lib/sms/bundle-service.test.ts — after the last closing `})` of the
// existing "purchaseBundleViaWallet" describe block.

describe("purchaseBundleViaWallet — activation gate", () => {
  it("inactive account → NOT_ACTIVATED error, no wallet debit", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    // Override the fake's from() to return an inactive account
    ;(h.fake as any)._accountStatus = "inactive"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("NOT_ACTIVATED")
    expect(h.state.calls.filter((c) => c.fn === "deduct_wallet")).toHaveLength(0)
  })

  it("platform account → bypasses gate, proceeds normally", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    ;(h.fake as any)._accountStatus = "active"
    ;(h.fake as any)._ownerType = "platform"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(true)
  })

  it("suspended account → NOT_ACTIVATED error", async () => {
    h.state.walletBalance = 200
    h.state.wholesale = 1_000_000
    ;(h.fake as any)._accountStatus = "suspended"
    const res = await purchaseBundleViaWallet("u1", "acc1", "b1")
    expect(res.ok).toBe(false)
    expect(res.error).toBe("NOT_ACTIVATED")
  })
})
```

Note: The existing fake client's `from("sms_accounts")` path must be extended to read `_accountStatus` / `_ownerType` from the fake object in Task 6 when the gate is wired. For now the tests will fail because `purchaseBundleViaWallet` does not yet check status.

Expected output: new tests fail — `NOT_ACTIVATED` is not returned.

---

### Task 3 — Write and commit migration 0065

- [ ] Create `migrations/0065_sms_activation_gate.sql` with the following content, then commit it. **Do not apply it to the database yet** — the operator applies it via the Supabase dashboard or Management API.

```sql
-- migrations/0065_sms_activation_gate.sql
-- Adds activation gate columns to sms_accounts, creates tenant_global_settings table,
-- and creates activate_sms_account + claim_sms_welcome_bonus RPCs.
-- Apply via Supabase dashboard SQL editor or Management API.

-- ── 1. Widen the status CHECK and add activation columns ───────────────────
ALTER TABLE sms_accounts
  DROP CONSTRAINT IF EXISTS sms_accounts_status_check;

ALTER TABLE sms_accounts
  ADD CONSTRAINT sms_accounts_status_check
    CHECK (status IN ('inactive', 'active', 'suspended'));

ALTER TABLE sms_accounts
  ADD COLUMN IF NOT EXISTS activated_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amount_paid     NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS paid_from       TEXT,
  ADD COLUMN IF NOT EXISTS bonus_claimed   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bonus_claimed_at TIMESTAMPTZ;

-- Change default for new rows to 'inactive' (metered accounts must activate).
-- Platform accounts will be set active below and via the get_or_create RPC logic.
ALTER TABLE sms_accounts ALTER COLUMN status SET DEFAULT 'inactive';

-- ── 2. Reconcile existing rows ──────────────────────────────────────────────
-- No live metered sending exists yet, so all shop/sub_agent rows go to inactive.
-- Platform (admin) rows keep active status.
UPDATE sms_accounts SET status = 'inactive'
WHERE owner_type IN ('shop', 'sub_agent') AND status = 'active';

UPDATE sms_accounts SET status = 'active'
WHERE owner_type = 'platform' AND status = 'inactive';

-- ── 3. tenant_global_settings ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_global_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

ALTER TABLE tenant_global_settings ENABLE ROW LEVEL SECURITY;

-- Public read (tenants need the activation fee without being admin)
DROP POLICY IF EXISTS tgs_authenticated_read ON tenant_global_settings;
CREATE POLICY tgs_authenticated_read ON tenant_global_settings
  FOR SELECT TO authenticated USING (true);

-- Admin write only
DROP POLICY IF EXISTS tgs_admin_write ON tenant_global_settings;
CREATE POLICY tgs_admin_write ON tenant_global_settings
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
        AND raw_user_meta_data->>'role' = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM auth.users
      WHERE auth.users.id = auth.uid()
        AND raw_user_meta_data->>'role' = 'admin'
    )
  );

GRANT SELECT ON tenant_global_settings TO authenticated;
GRANT ALL ON tenant_global_settings TO service_role;

-- Seed defaults (idempotent)
INSERT INTO tenant_global_settings (key, value)
VALUES
  ('sms_activation_fee',        '{"amount": 20}'),
  ('sms_welcome_bonus_credits', '{"units":  10}')
ON CONFLICT (key) DO NOTHING;

-- ── 4. activate_sms_account RPC ────────────────────────────────────────────
-- Sets status='active', records activated_at/amount_paid/paid_from.
-- Raises ALREADY_ACTIVATED (P0001) if account is already active/suspended-active.
-- p_paid_from: 'wallet' | 'paystack'
-- Caller must have already debited the payment (wallet debit or Paystack webhook).
CREATE OR REPLACE FUNCTION activate_sms_account(
  p_account_id UUID,
  p_paid_from  TEXT
)
RETURNS TABLE(ok BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fee     NUMERIC(10,2);
  v_status  TEXT;
BEGIN
  -- Read fee from settings
  SELECT (value->>'amount')::NUMERIC INTO v_fee
  FROM tenant_global_settings
  WHERE key = 'sms_activation_fee';

  IF v_fee IS NULL THEN
    RAISE EXCEPTION 'sms_activation_fee not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Check current status
  SELECT status INTO v_status FROM sms_accounts WHERE id = p_account_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = 'P0003';
  END IF;

  IF v_status = 'active' THEN
    RAISE EXCEPTION 'ALREADY_ACTIVATED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sms_accounts
  SET
    status       = 'active',
    activated_at  = now(),
    amount_paid   = v_fee,
    paid_from     = p_paid_from,
    updated_at    = now()
  WHERE id = p_account_id;

  ok := true;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION activate_sms_account(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_sms_account(UUID, TEXT) TO service_role;

-- ── 5. claim_sms_welcome_bonus RPC ──────────────────────────────────────────
-- Single-claim guarded via UPDATE … WHERE bonus_claimed = false RETURNING.
-- Raises ALREADY_CLAIMED (P0001) if bonus already taken.
-- Credits units through credit_sms_units_if_solvent (caller passes wholesale).
-- Returns: (units_credited INT, outcome TEXT)
CREATE OR REPLACE FUNCTION claim_sms_welcome_bonus(
  p_account_id UUID,
  p_wholesale  NUMERIC
)
RETURNS TABLE(units_credited INT, outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bonus_units INT;
  v_claimed_id  UUID;
  v_result      TEXT;
BEGIN
  -- Read bonus from settings
  SELECT (value->>'units')::INT INTO v_bonus_units
  FROM tenant_global_settings
  WHERE key = 'sms_welcome_bonus_credits';

  IF v_bonus_units IS NULL THEN
    RAISE EXCEPTION 'sms_welcome_bonus_credits not configured' USING ERRCODE = 'P0002';
  END IF;

  -- Single-claim guard: atomically flip bonus_claimed=true only if currently false.
  UPDATE sms_accounts
  SET bonus_claimed    = true,
      bonus_claimed_at = now(),
      updated_at       = now()
  WHERE id = p_account_id
    AND bonus_claimed = false
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NULL THEN
    RAISE EXCEPTION 'ALREADY_CLAIMED' USING ERRCODE = 'P0001';
  END IF;

  -- Issue units through solvency gate (same function all credit paths use).
  SELECT cr.outcome INTO v_result
  FROM credit_sms_units_if_solvent(
    p_account_id,
    v_bonus_units,
    'welcome_bonus',
    p_wholesale,
    'welcome-bonus-' || p_account_id::TEXT
  ) cr;

  units_credited := v_bonus_units;
  outcome := COALESCE(v_result, 'pending');
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sms_welcome_bonus(UUID, NUMERIC) TO service_role;
```

- [ ] Commit: `git add migrations/0065_sms_activation_gate.sql && git commit -m "feat(sms): migration 0065 — activation gate columns, tenant_global_settings, activate/bonus RPCs"`.
- [ ] **Operator action:** Apply `migrations/0065_sms_activation_gate.sql` to the live Supabase project via the SQL editor or Management API.
- [ ] Verify with:
```sql
-- Verify 0065 applied correctly
SELECT
  (SELECT COUNT(*) FROM sms_accounts WHERE status = 'inactive' AND owner_type IN ('shop','sub_agent')) AS inactive_metered,
  (SELECT COUNT(*) FROM sms_accounts WHERE status = 'active'   AND owner_type = 'platform')           AS active_platform,
  (SELECT value FROM tenant_global_settings WHERE key = 'sms_activation_fee')                          AS activation_fee,
  (SELECT value FROM tenant_global_settings WHERE key = 'sms_welcome_bonus_credits')                   AS welcome_bonus,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'activate_sms_account')                                AS activate_rpc,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'claim_sms_welcome_bonus')                             AS bonus_rpc;
-- Expected: inactive_metered >= 0, active_platform >= 0, activation_fee = {"amount":20},
--           welcome_bonus = {"units":10}, activate_rpc = 1, bonus_rpc = 1
```

---

### Task 4 — Implement activation-service (make Task 1 tests pass)

- [ ] Create `lib/sms/activation-service.ts` with the following content:

```typescript
// lib/sms/activation-service.ts
import { createClient } from "@supabase/supabase-js"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { notifyAdminSmsShortfall } from "./notify"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface ActivationResult {
  ok: boolean
  error?: string
  alreadyDone?: boolean
}

export interface BonusResult {
  ok: boolean
  error?: string
  pending?: boolean
  unitsCredited?: number
}

/** Fetch the activation fee from tenant_global_settings. Returns 0 on error (fail-open
 *  for reads — the gate enforcement is inside the SQL RPC, not here). */
async function fetchActivationFee(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("tenant_global_settings")
    .select("value")
    .eq("key", "sms_activation_fee")
    .single()
  return Number((data?.value as { amount?: number })?.amount ?? 0)
}

/** Fetch account row. Returns null if not found. */
async function fetchAccount(accountId: string): Promise<{ id: string; status: string; owner_type: string } | null> {
  const { data } = await supabaseAdmin
    .from("sms_accounts")
    .select("id, status, owner_type")
    .eq("id", accountId)
    .maybeSingle()
  return data as { id: string; status: string; owner_type: string } | null
}

/** Activate via cash wallet. Debits the activation fee then calls the RPC.
 *  Platform accounts are skipped (they are always active). */
export async function activateViaWallet(userId: string, accountId: string): Promise<ActivationResult> {
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }

  // Platform accounts are pre-active — activation is a no-op.
  if (account.owner_type === "platform") return { ok: true }

  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }

  const fee = await fetchActivationFee()
  if (fee <= 0) return { ok: false, error: "Activation fee not configured" }

  // Debit wallet first — the RPC then sets the account active.
  const { data: debit, error: debitErr } = await supabaseAdmin.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: fee,
  })
  if (debitErr) return { ok: false, error: "Wallet debit failed" }
  if (!debit || (debit as unknown[]).length === 0) return { ok: false, error: "INSUFFICIENT_BALANCE" }

  const { error: rpcErr } = await supabaseAdmin.rpc("activate_sms_account", {
    p_account_id: accountId,
    p_paid_from: "wallet",
  })

  if (rpcErr) {
    // Classify the RPC error for the caller.
    if (rpcErr.message?.includes("ALREADY_ACTIVATED")) return { ok: false, error: "ALREADY_ACTIVATED" }
    // Unexpected error — refund wallet to avoid money loss.
    await supabaseAdmin.rpc("deduct_wallet", { p_user_id: userId, p_amount: -fee }).catch(() => {})
    return { ok: false, error: "Activation failed (refunded)" }
  }

  return { ok: true }
}

/** Initialize a Paystack activation payment. Returns the Paystack authorizationUrl.
 *  The webhook finalizes activation when the payment lands. */
export async function initActivationPaystack(
  userId: string,
  accountId: string,
  userEmail: string
): Promise<{ ok: boolean; authorizationUrl?: string; reference?: string; error?: string }> {
  const account = await fetchAccount(accountId)
  if (!account) return { ok: false, error: "Account not found" }
  if (account.owner_type === "platform") return { ok: false, error: "Platform accounts do not require activation" }
  if (account.status === "active") return { ok: false, error: "ALREADY_ACTIVATED" }

  const fee = await fetchActivationFee()
  if (fee <= 0) return { ok: false, error: "Activation fee not configured" }

  const { initializePayment } = await import("@/lib/paystack")
  const reference = `smsactivate-${accountId}-${Date.now()}`
  const init = await initializePayment({
    email: userEmail,
    amount: fee,
    reference,
    purpose: "SMS Account Activation",
    metadata: {
      type: "sms_activation",
      sms_account_id: accountId,
      fee,
    },
  })

  return { ok: true, authorizationUrl: init.authorizationUrl, reference: init.reference }
}

/** Finalize activation from the Paystack webhook. Idempotent on paystackRef.
 *  Mirrors the sms_bundle branch: checks underpayment, then calls the RPC. */
export async function finalizeActivationPaystack(
  accountId: string,
  paystackRef: string,
  amountPaidGhs: number
): Promise<ActivationResult> {
  const fee = await fetchActivationFee()
  // Underpayment guard (same tolerance used across the webhook — 0.01 GHS).
  if (amountPaidGhs < fee - 0.01) {
    return { ok: false, error: `Underpayment: paid ${amountPaidGhs} < fee ${fee}` }
  }

  const { error: rpcErr } = await supabaseAdmin.rpc("activate_sms_account", {
    p_account_id: accountId,
    p_paid_from: "paystack",
  })

  if (rpcErr) {
    if (rpcErr.message?.includes("ALREADY_ACTIVATED")) {
      return { ok: true, alreadyDone: true }
    }
    return { ok: false, error: rpcErr.message }
  }

  return { ok: true }
}

/** Claim the one-time welcome bonus. Solvency-gated via claim_sms_welcome_bonus RPC
 *  (which internally calls credit_sms_units_if_solvent). */
export async function claimWelcomeBonus(accountId: string): Promise<BonusResult> {
  const wholesale = await queryMoolreSmsBalance()
  const { data, error: rpcErr } = await supabaseAdmin.rpc("claim_sms_welcome_bonus", {
    p_account_id: accountId,
    p_wholesale: wholesale,
  })

  if (rpcErr) {
    if (rpcErr.message?.includes("ALREADY_CLAIMED")) return { ok: false, error: "ALREADY_CLAIMED" }
    return { ok: false, error: "Failed to claim bonus" }
  }

  const row = (data as Array<{ units_credited: number; outcome: string }>)?.[0]
  const pending = row?.outcome === "pending"
  if (pending) notifyAdminSmsShortfall(row?.units_credited ?? 0).catch(() => {})

  return { ok: true, pending, unitsCredited: row?.units_credited ?? 0 }
}
```

- [ ] Run `npm test -- activation-service`. Expected: all 9 tests pass.

---

### Task 5 — Commit activation service + run full SMS test suite

- [ ] Run `npm test -- lib/sms` (all SMS test files) and confirm all tests pass.
- [ ] Commit: `git add lib/sms/activation-service.ts lib/sms/activation-service.test.ts && git commit -m "feat(sms): activation service — activateViaWallet, initActivationPaystack, finalizeActivationPaystack, claimWelcomeBonus"`.

---

### Task 6 — Wire activation gate in bundle-service + make Task 2 tests pass

- [ ] Edit `lib/sms/bundle-service.ts`. Add an account-status check at the top of `purchaseBundleViaWallet` (after the bundle lookup, before the wallet debit). Add a helper `requireActiveAccount` used by both `purchaseBundleViaWallet` and exported for the Paystack init route.

Replace the beginning of `purchaseBundleViaWallet` (after the bundle lookup and cast) with:

```typescript
// Insert immediately after `const b = bundle as Bundle` in purchaseBundleViaWallet:

  // Activation gate: metered accounts must be active. Platform is exempt.
  const { data: acct } = await supabaseAdmin
    .from("sms_accounts").select("status, owner_type").eq("id", accountId).maybeSingle()
  if (acct && acct.owner_type !== "platform" && acct.status !== "active") {
    return { ok: false, error: "NOT_ACTIVATED" }
  }
```

Also export a standalone helper for the route layer:

```typescript
// Add near the bottom of lib/sms/bundle-service.ts (before the final export):

/** Returns true if the account may purchase bundles or initiate sends. */
export async function isAccountActive(accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("sms_accounts").select("status, owner_type").eq("id", accountId).maybeSingle()
  if (!data) return false
  if (data.owner_type === "platform") return true
  return data.status === "active"
}
```

- [ ] Update the fake in `lib/sms/bundle-service.test.ts` so the `from("sms_accounts")` path reads `_accountStatus` and `_ownerType` from the fake object. Add at the top of the `from` factory (after `const fake = {`):

```typescript
// Inside fake.from(), add an sms_accounts branch to the select().eq() chain:
// (The existing fake only handles sms_bundles, sms_unit_transactions, sms_pending_credits.)
// Add to the if-chain inside maybeSingle():
if (table === "sms_accounts") {
  return Promise.resolve({
    data: {
      status: (fake as any)._accountStatus ?? "active",
      owner_type: (fake as any)._ownerType ?? "shop",
    },
    error: null,
  })
}
```

- [ ] Run `npm test -- bundle-service`. Expected: all existing tests + all 3 new gate tests pass.
- [ ] Commit: `git add lib/sms/bundle-service.ts lib/sms/bundle-service.test.ts && git commit -m "feat(sms): activation gate on bundle purchase — NOT_ACTIVATED error for inactive/suspended accounts"`.

---

### Task 7 — Add activation API routes

- [ ] Create `app/api/sms/activate/route.ts`:

```typescript
// app/api/sms/activate/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { activateViaWallet, initActivationPaystack } from "@/lib/sms/activation-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  const body = await request.json()
  const paidFrom: string = body?.paidFrom ?? "wallet"

  if (paidFrom === "wallet") {
    const result = await activateViaWallet(user.id, account.id)
    if (!result.ok) {
      const status = result.error === "INSUFFICIENT_BALANCE" ? 402 : 400
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json({ success: true })
  }

  if (paidFrom === "paystack") {
    if (!user.email) return NextResponse.json({ error: "Account email required for Paystack" }, { status: 400 })
    const result = await initActivationPaystack(user.id, account.id, user.email)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ authorizationUrl: result.authorizationUrl, reference: result.reference })
  }

  return NextResponse.json({ error: "paidFrom must be 'wallet' or 'paystack'" }, { status: 400 })
}
```

- [ ] Create `app/api/sms/claim-bonus/route.ts`:

```typescript
// app/api/sms/claim-bonus/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { claimWelcomeBonus } from "@/lib/sms/activation-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })

  // Only active accounts may claim the bonus.
  if (account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }

  const result = await claimWelcomeBonus(account.id)
  if (!result.ok) {
    const status = result.error === "ALREADY_CLAIMED" ? 409 : 400
    return NextResponse.json({ error: result.error }, { status })
  }

  return NextResponse.json({
    success: true,
    pending: result.pending ?? false,
    unitsCredited: result.unitsCredited ?? 0,
  })
}
```

- [ ] Commit: `git add app/api/sms/activate/route.ts app/api/sms/claim-bonus/route.ts && git commit -m "feat(sms): activation + claim-bonus API routes"`.

---

### Task 8 — Extend Paystack webhook with sms_activation branch

- [ ] Edit `app/api/webhooks/paystack/route.ts`. Insert the `sms_activation` branch **immediately after** the closing `}` of the `sms_bundle` branch (after line ~91, before the `const { data: shopTokenPurchase` lookup). The insertion point is:

```
      // SMS bundle purchase block ends:
      return NextResponse.json({ received: true, type: "sms_bundle" })
      }
      // ← INSERT HERE
      // Handle USSD shop token purchases...
```

Insert:

```typescript
      // SMS account activation payment — finalize activation on confirmed payment.
      // metadata.type === "sms_activation" is set by initActivationPaystack().
      if (metadata?.type === "sms_activation" && metadata?.sms_account_id) {
        const paidGhs = amount / 100
        const { finalizeActivationPaystack } = await import("@/lib/sms/activation-service")
        const result = await finalizeActivationPaystack(
          metadata.sms_account_id as string,
          reference,
          paidGhs
        )
        if (!result.ok && !result.alreadyDone) {
          console.error("[WEBHOOK] SMS activation finalize failed:", result.error)
        } else {
          console.log("[WEBHOOK] ✓ SMS account activated:", metadata.sms_account_id, result.alreadyDone ? "(already done)" : "")
        }
        return NextResponse.json({ received: true, type: "sms_activation" })
      }
```

- [ ] Commit: `git add app/api/webhooks/paystack/route.ts && git commit -m "feat(sms): Paystack webhook — sms_activation branch (mirror sms_bundle pattern)"`.

---

### Task 9 — Extend GET /api/sms/account with activation fields

- [ ] Edit `app/api/sms/account/route.ts`. Extend the `SmsAccount` select and response shape.

Replace the `account` select call:
```typescript
// OLD
const { data: account } = await supabaseAdmin
  .from("sms_accounts").select("*").eq("id", id).single()
```
with the same call (already `select("*")`) — no change needed there since `select("*")` already returns new columns once the migration is applied.

Replace the response body's `account` shape from:
```typescript
    account: {
      id: account.id,
      ownerType: account.owner_type,
      unitBalance: account.unit_balance,
      pendingUnits,
      status: account.status,
    },
```
with:
```typescript
    account: {
      id: account.id,
      ownerType: account.owner_type,
      unitBalance: account.unit_balance,
      pendingUnits,
      status: account.status,
      activatedAt: account.activated_at ?? null,
      amountPaid: account.amount_paid ?? null,
      paidFrom: account.paid_from ?? null,
      bonusClaimed: account.bonus_claimed ?? false,
      bonusClaimedAt: account.bonus_claimed_at ?? null,
    },
```

Also fetch activation fee + welcome bonus from `tenant_global_settings` and include in the response so the UI does not need a separate call:

```typescript
// Add after the existing Promise.all for transactions + pendingUnits:
  const [transactions, pendingUnits, settings] = await Promise.all([
    listUnitTransactions(account.id, 20),
    getPendingUnits(account.id),
    supabaseAdmin
      .from("tenant_global_settings")
      .select("key, value")
      .in("key", ["sms_activation_fee", "sms_welcome_bonus_credits"])
      .then(({ data }) => {
        const map: Record<string, number> = {}
        for (const row of (data ?? [])) {
          const r = row as { key: string; value: { amount?: number; units?: number } }
          if (r.key === "sms_activation_fee") map.activationFee = Number(r.value.amount ?? 0)
          if (r.key === "sms_welcome_bonus_credits") map.welcomeBonusCredits = Number(r.value.units ?? 0)
        }
        return map
      }),
  ])
```

And add `activationFee` + `welcomeBonusCredits` to the response:
```typescript
      activationFee: settings.activationFee ?? 20,
      welcomeBonusCredits: settings.welcomeBonusCredits ?? 10,
```

- [ ] Commit: `git add app/api/sms/account/route.ts && git commit -m "feat(sms): account API — expose activation status, bonus_claimed, fee, and welcome bonus credits"`.

---

### Task 10 — Gate Paystack bundle-init route behind activation

- [ ] Edit `app/api/sms/units/purchase-paystack/route.ts`. Add activation gate after the account lookup:

```typescript
// Add after `if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })`
  if (account.owner_type !== "platform" && account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }
```

- [ ] Edit `app/api/sms/units/purchase-wallet/route.ts`. Add the same guard after its account check:

```typescript
// Add after `if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })`
  if (account.owner_type !== "platform" && account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }
```

- [ ] Commit: `git add app/api/sms/units/purchase-paystack/route.ts app/api/sms/units/purchase-wallet/route.ts && git commit -m "feat(sms): gate bundle purchase routes behind activation status"`.

---

### Task 11 — Rebuild tenant SMS dashboard

- [ ] Replace the entire content of `app/dashboard/sms/page.tsx` with the following:

```tsx
// app/dashboard/sms/page.tsx
"use client"
import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

interface AccountData {
  id: string
  ownerType: string
  unitBalance: number
  pendingUnits: number
  status: string // 'inactive' | 'active' | 'suspended'
  bonusClaimed: boolean
  bonusClaimedAt: string | null
  activatedAt: string | null
  activationFee: number
  welcomeBonusCredits: number
}

interface Bundle {
  id: string
  name: string
  units: number
  price_ghs: number
}

export default function SmsDashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null)
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)

  const notice = (text: string, ok = true) => setMsg({ text, ok })

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const load = useCallback(async () => {
    const t = await token()
    const headers = { Authorization: `Bearer ${t}` }
    const [accRes, bunRes] = await Promise.all([
      fetch("/api/sms/account", { headers }).then((r) => r.json()),
      fetch("/api/sms/bundles", { headers }).then((r) => r.json()),
    ])
    setAccount(accRes.account ?? null)
    setBundles(bunRes.bundles ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  async function activate(paidFrom: "wallet" | "paystack") {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/activate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ paidFrom }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "INSUFFICIENT_BALANCE"
        ? "Insufficient wallet balance. Top up your wallet first or pay with Paystack."
        : res.error, false)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else {
      notice("Account activated! Welcome to SMS.")
      await load()
    }
  }

  async function claimBonus() {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/claim-bonus", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "ALREADY_CLAIMED" ? "Bonus already claimed." : res.error, false)
    } else if (res.pending) {
      notice(`${res.unitsCredited} bonus SMS credits queued — awaiting SMS supply top-up.`)
    } else {
      notice(`${res.unitsCredited} bonus SMS credits added to your account!`)
      await load()
    }
  }

  async function buyBundle(bundleId: string) {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "NOT_ACTIVATED"
        ? "Activate your account before buying bundles."
        : res.error, false)
    } else if (res.pending) {
      notice("Payment received — SMS credits are pending SMS supply top-up.")
    } else {
      notice(`${res.unitsCredited} SMS credits added.`)
      await load()
    }
  }

  if (!account) {
    return <div className="p-6 text-muted-foreground">Loading SMS dashboard…</div>
  }

  const isActive = account.status === "active"
  const isPlatform = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive
  const showBonus = isActive && !account.bonusClaimed

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">SMS</h1>

      {msg && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${msg.ok ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800"}`}>
          {msg.text}
        </div>
      )}

      {/* Activation card */}
      {showActivation && (
        <div className="rounded-lg border p-5 space-y-3 bg-amber-50 border-amber-200">
          <div className="font-semibold text-amber-900">Activate SMS</div>
          <p className="text-sm text-amber-800">
            A one-time activation fee of <strong>GHS {account.activationFee.toFixed(2)}</strong> unlocks
            SMS credits, bundle purchases, and campaign sending.
          </p>
          <div className="flex gap-2 flex-wrap">
            <button
              disabled={busy}
              onClick={() => activate("wallet")}
              className="rounded bg-amber-700 px-4 py-2 text-sm text-white hover:bg-amber-800 disabled:opacity-50"
            >
              Pay with Wallet (GHS {account.activationFee.toFixed(2)})
            </button>
            <button
              disabled={busy}
              onClick={() => activate("paystack")}
              className="rounded border border-amber-700 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              Pay with Paystack
            </button>
          </div>
        </div>
      )}

      {/* Welcome bonus claim */}
      {showBonus && (
        <div className="rounded-lg border p-5 space-y-3 bg-blue-50 border-blue-200">
          <div className="font-semibold text-blue-900">Welcome Bonus</div>
          <p className="text-sm text-blue-800">
            Claim your free <strong>{account.welcomeBonusCredits} SMS credits</strong> — a one-time gift to get started.
          </p>
          <button
            disabled={busy}
            onClick={claimBonus}
            className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
          >
            Claim {account.welcomeBonusCredits} Free SMS Credits
          </button>
        </div>
      )}

      {/* Balance panel */}
      <div className="rounded-lg border p-5">
        <div className="text-sm text-muted-foreground">SMS Credits</div>
        <div className="text-3xl font-bold">{account.unitBalance.toLocaleString()}</div>
        {account.pendingUnits > 0 && (
          <div className="mt-1 text-sm text-amber-600">
            + {account.pendingUnits.toLocaleString()} pending (awaiting SMS supply top-up)
          </div>
        )}
        {isActive && account.activatedAt && (
          <div className="mt-1 text-xs text-muted-foreground">
            Active since {new Date(account.activatedAt).toLocaleDateString()}
          </div>
        )}
      </div>

      {/* Bundle store */}
      {isActive && bundles.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-semibold">Buy SMS Credits</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {bundles.map((b) => (
              <div key={b.id} className="rounded-lg border p-4 space-y-2">
                <div className="font-semibold">{b.name}</div>
                <div className="text-sm text-muted-foreground">
                  {Number(b.units).toLocaleString()} credits · GHS {Number(b.price_ghs).toFixed(2)}
                </div>
                <button
                  disabled={busy}
                  onClick={() => buyBundle(b.id)}
                  className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Buy with wallet
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inactive state — bundle store hidden */}
      {showActivation && bundles.length > 0 && (
        <div className="rounded-lg border p-4 opacity-50">
          <p className="text-sm text-center text-muted-foreground">
            Bundle store unlocks after activation.
          </p>
        </div>
      )}
    </div>
  )
}
```

- [ ] Run `npm run build` (type-check only) and confirm no TypeScript errors in the modified files. Expected: build succeeds.
- [ ] Commit: `git add app/dashboard/sms/page.tsx && git commit -m "feat(sms): tenant dashboard — activation card, welcome bonus, credit balance, bundle store"`.

---

### Task 12 — Run full test suite + integration smoke-check

- [ ] Run `npm test -- lib/sms` and confirm all tests pass.
- [ ] Run `npm run build` to catch any remaining type errors across all modified files. Expected: no errors.
- [ ] (Optional, if dev DB is accessible) Manual smoke-check sequence against a staging/dev environment:
  1. `GET /api/sms/account` → verify response includes `status`, `bonusClaimed`, `activationFee: 20`, `welcomeBonusCredits: 10`.
  2. `POST /api/sms/units/purchase-wallet` with an inactive account → expect `{ error: "NOT_ACTIVATED" }` 403.
  3. `POST /api/sms/activate` with `{ paidFrom: "wallet" }` and sufficient wallet balance → expect `{ success: true }`.
  4. `GET /api/sms/account` → `status: "active"`.
  5. `POST /api/sms/claim-bonus` → expect `{ success: true, unitsCredited: 10, pending: false }`.
  6. `POST /api/sms/claim-bonus` again → expect 409 `ALREADY_CLAIMED`.
  7. `POST /api/sms/units/purchase-wallet` with a valid bundleId and sufficient balance → expect `{ success: true }`.
- [ ] Commit: `git commit --allow-empty -m "test(sms): full suite green — activation gate, bonus, dashboard"` (only if no code changes remain; otherwise fold into Task 11 commit).

---

### Task 13 — Update memory files

- [ ] Update `docs/memory/project-withdrawal-flow.md` or a dedicated `project-sms-activation.md` entry (whichever the memory index points to for this feature) with:
  - Migration `0065_sms_activation_gate.sql` applied
  - New table: `tenant_global_settings` (keys: `sms_activation_fee`, `sms_welcome_bonus_credits`)
  - New RPCs: `activate_sms_account(account_id, paid_from)`, `claim_sms_welcome_bonus(account_id, wholesale)`
  - New service: `lib/sms/activation-service.ts`
  - New routes: `POST /api/sms/activate`, `POST /api/sms/claim-bonus`
  - Modified routes: `GET /api/sms/account` (extended), `POST /api/sms/units/purchase-wallet` (gate), `POST /api/sms/units/purchase-paystack` (gate)
  - Webhook: `sms_activation` branch added to `app/api/webhooks/paystack/route.ts`
  - Dashboard: `app/dashboard/sms/page.tsx` rebuilt with activation card + bonus + bundle store

---

## Self-Review

| Spec requirement | Task(s) | Notes |
|---|---|---|
| `sms_accounts.status` ∈ `inactive\|active\|suspended` | Task 3 migration | CHECK widened; default set to `inactive` |
| ADD COLUMN `activated_at`, `amount_paid`, `paid_from`, `bonus_claimed`, `bonus_claimed_at` | Task 3 migration | `bonus_claimed BOOLEAN NOT NULL DEFAULT false` matches spec |
| Existing rows reconciled (metered→inactive, platform→active) | Task 3 migration | No live metered sending yet; safe as documented in spec |
| `tenant_global_settings` vs `admin_settings` | Task 3 migration | Decision: NEW `tenant_global_settings`. `admin_settings` has UUID PK + admin-only read — unsuitable for public-read fee display. New table with text PK + `TO authenticated USING(true)` read policy. |
| `activate_sms_account` RPC (SECURITY DEFINER, service-role only) | Task 3 migration | Reads fee from settings, raises `ALREADY_ACTIVATED`, updates status/timestamps |
| `claim_sms_welcome_bonus` RPC (single-claim guarded) | Task 3 migration | `UPDATE … WHERE bonus_claimed=false RETURNING` + calls `credit_sms_units_if_solvent` |
| Wallet activation path | Tasks 4, 7 | `deduct_wallet` debit → `activate_sms_account` RPC; refund on unexpected RPC error |
| Paystack activation path (`initializePayment` + webhook) | Tasks 4, 7, 8 | `initActivationPaystack` → webhook `sms_activation` branch → `finalizeActivationPaystack` |
| Webhook insertion anchor | Task 8 | Inserted immediately after the `sms_bundle` branch closing `return` (~line 91), before `shopTokenPurchase` lookup |
| Activation gate on bundle purchase | Tasks 2, 6, 10 | `purchaseBundleViaWallet`, wallet route, Paystack route all return `NOT_ACTIVATED` |
| Welcome bonus through solvency gate | Task 3 (RPC), Task 4 (service) | Bonus `credit_sms_units_if_solvent` call inside `claim_sms_welcome_bonus` RPC; over-wholesale → pending |
| `GET /api/sms/account` extended | Task 9 | Returns `activationStatus`, `bonusClaimed`, `activationFee`, `welcomeBonusCredits` |
| Tenant dashboard: activation card + bonus + credits + bundle store | Task 11 | Labels use "SMS credits" (UI); column stays `unit_balance` |
| Platform accounts exempt from gate | Tasks 4, 6, 10 | `owner_type === "platform"` short-circuits every check |
| No send pipeline, no composer | (excluded) | M3 scope |
| No segment calculator, content filter | (excluded) | M3 scope |

**Type consistency:**
- `amount_paid NUMERIC(10,2)` matches `price_ghs NUMERIC(10,2)` in `sms_bundles`.
- `unit_balance INT` remains; UI surfaces it as "SMS credits".
- `activationFee` and `welcomeBonusCredits` returned as `number` from the API.

**Inline verification points:**
1. Confirm `tenant_global_settings` does not already exist before applying 0065 (the `CREATE TABLE IF NOT EXISTS` guard makes it idempotent, but the seed `ON CONFLICT DO NOTHING` means re-running is safe).
2. Confirm the Paystack webhook insertion anchor: search for `return NextResponse.json({ received: true, type: "sms_bundle" })` — the `sms_activation` block goes on the very next line.
3. After migration: verify `SELECT conname, consrc FROM pg_constraint WHERE conrelid = 'sms_accounts'::regclass AND contype='c' AND conname LIKE '%status%'` returns the widened check `(status = ANY (ARRAY['inactive'::text, 'active'::text, 'suspended'::text]))`.
4. The `claim_sms_welcome_bonus` RPC passes `p_wholesale` as `NUMERIC` — confirm `credit_sms_units_if_solvent` signature accepts `NUMERIC` for the `p_wholesale` parameter (it does: see migration 0063 which defined `p_wholesale NUMERIC`).
