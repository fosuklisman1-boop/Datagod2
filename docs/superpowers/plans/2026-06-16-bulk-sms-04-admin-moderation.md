# Bulk SMS — Plan 4 of 5: Admin Moderation + Suspend Implementation Plan

> ### ⚠️ Cross-plan reconciliation (read first)
> One of 5 Bulk SMS milestone plans authored together; applied in order **M2 → M3 → M4 → M5**.
> - **Migration numbers are INDICATIVE.** At execution, use the next unused `NNNN_` prefix above the highest already in `migrations/` (don't trust the literal `0068` — allocate sequentially after M2/M3).
> - You **own `app/admin/sms/page.tsx`** (metered moderation: flags, suspend, revenue). Milestone 5's broadcast "SMS Centre" lives on a **separate page** (`app/admin/sms-centre/`), so there is no conflict — build your moderation UI here.
> - **Revenue limitation:** per-bundle GHS price is not stored on `sms_unit_transactions`, so `bundleGhsTotal` is approximate/0 for now (activation `amount_paid` on `sms_accounts` IS exact). This is acceptable; a later task can add a priced purchases table.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the admin moderation layer on top of the Metered Shop SMS subsystem: a `suspend_sms_account` RPC that atomically toggles `sms_accounts.status` (guarded so `inactive` rows cannot be accidentally flipped), an `admin_audit_log` table (created here — the grep in Self-Review confirms it does not already exist), three `/api/admin/shop-sms` route verbs (GET dashboard, PATCH settings, POST actions), a pure revenue-aggregation helper with unit tests, and a moderation tab wired into `app/admin/sms/page.tsx`.

**Architecture:** Admin routes are strictly guarded by `verifyAdminAccess` (from `lib/admin-auth.ts`), which already applies the admin rate limit (100 req/min general, 20 req/min heavy). All `sms_accounts` status changes go through the `suspend_sms_account` SECURITY DEFINER RPC — never a raw UPDATE — so the `debit_sms_for_send` SUSPENDED gate (built in M3) is the enforcement point; this milestone provides only the toggle. Revenue aggregates are computed in a pure TypeScript helper so they can be unit-tested independently of Supabase. The admin moderation UI extends the existing `app/admin/sms/page.tsx` with a second tab, using the existing browser Supabase client (`supabase` from `@/lib/supabase`) to obtain the session token for Bearer auth.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres service-role client), Vitest, TypeScript. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-06-16-bulk-sms-platform-design.md` — Revision B: "Admin moderation + suspend" section under Metered path additions; Data-model deltas (`sms_send_logs`, new RPCs).

**Assumptions:**
- M2 (`activate_sms_account`, `sms_accounts.status IN ('inactive','active','suspended')`, `activated_at`, `amount_paid`) and M3 (`sms_send_logs`, `debit_sms_for_send` with SUSPENDED gate) are **already applied to the DB**. This plan asserts their existence but does NOT create them.
- `shop_sms_purchases` does NOT exist as a separate table — bundle purchases are tracked via `sms_unit_transactions` (reason `bundle_wallet` | `bundle_paystack`). Revenue query aggregates from `sms_accounts` and `sms_unit_transactions`.
- The `admin_audit_log` table does NOT yet exist (confirmed by grep — zero matches across the repo).
- `sms_accounts.status` already has the CHECK constraint `('inactive','active','suspended')` from M2.

---

## File Structure

**Create:**
- `migrations/0068_admin_moderation_sms.sql` — `admin_audit_log` table + `suspend_sms_account` RPC + RLS
- `lib/sms/moderation-service.ts` — `suspendSmsAccount`, `dismissFlag`, `getSmsAdminDashboard` (calls aggregation helper + reads DB)
- `lib/sms/revenue-aggregation.ts` — pure `aggregateRevenue(rows)` shaping function (no DB calls)
- `lib/sms/revenue-aggregation.test.ts` — unit tests for the pure aggregator
- `lib/sms/moderation-service.test.ts` — fake-client tests for `suspendSmsAccount` and `dismissFlag` orchestration
- `app/api/admin/shop-sms/route.ts` — GET / PATCH / POST handler

**Modify:**
- `app/admin/sms/page.tsx` — extend with a "Moderation" tab (flagged messages + suspend toggles + revenue card)

---

## Conventions

- All DB writes via service-role client (`createClient(url, serviceRoleKey)`).
- `verifyAdminAccess` always called first; `auth.userId` is the acting admin id for audit rows.
- RPC calls for all balance/status mutations; no raw `.update()` on `sms_accounts`.
- Revenue fields are `number` (never `null`); aggregation helper normalises `null` DB aggregates to `0`.
- Fake-client tests use `vi.hoisted` exactly as in `lib/sms/bundle-service.test.ts`.
- Migration filename: `0068_` (0065–0067 are reserved for M2/M3 migrations).

---

## Tasks

### Task 1 — Migration: `admin_audit_log` + `suspend_sms_account` RPC

- [ ] Create `migrations/0068_admin_moderation_sms.sql`:

```sql
-- admin_audit_log: records privileged admin actions for compliance + debugging.
-- Created by Bulk SMS M4; general-purpose enough for future features.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id        UUID        NOT NULL REFERENCES auth.users(id),
  action          TEXT        NOT NULL,           -- e.g. 'sms_suspend', 'sms_unsuspend', 'sms_flag_dismiss'
  target_user_id  UUID        REFERENCES auth.users(id),
  old_value       JSONB,
  new_value       JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin    ON admin_audit_log(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target   ON admin_audit_log(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action   ON admin_audit_log(action, created_at DESC);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
-- Only service-role can write; authenticated admins can read their own actions.
DROP POLICY IF EXISTS admin_audit_log_admin_select ON admin_audit_log;
CREATE POLICY admin_audit_log_admin_select ON admin_audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'admin')
  );
-- No INSERT policy — all inserts go through service-role (RLS bypassed).
GRANT SELECT ON admin_audit_log TO authenticated;
GRANT ALL    ON admin_audit_log TO service_role;

-- suspend_sms_account: atomically flip sms_accounts.status between active and suspended.
-- NEVER touches 'inactive' rows — the activation flow owns that transition.
-- Returns the new status; raises an exception if the account is inactive (so the caller
-- gets a clear error rather than a silent no-op).
CREATE OR REPLACE FUNCTION suspend_sms_account(
  p_account_id UUID,
  p_suspended  BOOLEAN
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current TEXT;
  v_new     TEXT;
BEGIN
  SELECT status INTO v_current FROM sms_accounts WHERE id = p_account_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sms_account % not found', p_account_id;
  END IF;

  IF v_current = 'inactive' THEN
    RAISE EXCEPTION 'cannot suspend/unsuspend an inactive account (id: %)', p_account_id;
  END IF;

  v_new := CASE WHEN p_suspended THEN 'suspended' ELSE 'active' END;

  -- No-op if already in the target state (idempotent).
  IF v_current = v_new THEN
    RETURN v_new;
  END IF;

  UPDATE sms_accounts
  SET status = v_new, updated_at = now()
  WHERE id = p_account_id;

  RETURN v_new;
END;
$$;
```

- [ ] Apply via Supabase Management API SQL editor and verify:

```sql
-- Smoke-test: should raise "not found"
SELECT suspend_sms_account('00000000-0000-0000-0000-000000000000', true);
-- Expected: ERROR: sms_account 00000000... not found

-- Verify table exists
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'admin_audit_log'
ORDER BY ordinal_position;
-- Expected: id uuid, admin_id uuid, action text, target_user_id uuid, old_value jsonb, new_value jsonb, created_at timestamptz
```

---

### Task 2 — Pure helper: `lib/sms/revenue-aggregation.ts`

The GET dashboard route needs to shape raw DB aggregate rows into a clean revenue summary. Extracting this as a pure function makes it unit-testable with no Supabase dependency.

- [ ] Create `lib/sms/revenue-aggregation.ts`:

```typescript
/** Raw aggregate rows returned by the dashboard DB query. All numeric fields may be
 *  null when there are zero rows (Postgres COUNT/SUM can return null on empty groups). */
export interface RawRevenueSums {
  activationCount: number | null
  activationTotal: number | null
  bundleCreditCount: number | null
  bundleCreditTotal: number | null  // sum of |delta| for bundle_wallet + bundle_paystack credits
}

export interface RevenueSummary {
  /** Number of accounts that have paid the one-time activation fee. */
  activations: number
  /** Total GHS collected as activation fees. */
  activationTotal: number
  /** Total GHS collected as bundle purchases (wallet + Paystack paths). */
  bundleTotal: number
  /** Total SMS credits (units) sold across all bundle purchases. */
  creditsSold: number
}

/** Shape raw DB aggregate rows into a typed revenue summary. Pure — no side effects. */
export function aggregateRevenue(raw: RawRevenueSums): RevenueSummary {
  return {
    activations:     raw.activationCount  ?? 0,
    activationTotal: Number(raw.activationTotal  ?? 0),
    bundleTotal:     Number(raw.activationTotal   ?? 0) === 0 && raw.bundleCreditTotal === null
      ? 0
      : Number(raw.bundleCreditTotal ?? 0),
    creditsSold:     raw.bundleCreditCount ?? 0,
  }
}
```

Wait — `bundleTotal` is GHS collected (from `sms_accounts.amount_paid` sum for activation; for bundles it comes from `sms_unit_transactions` delta sums mapped back to bundle prices). The spec says revenue from `sms_accounts` (amount_paid sum) + `sms_unit_transactions` (credits sold). Let's model it accurately:

- [ ] Rewrite `lib/sms/revenue-aggregation.ts` with correct field semantics:

```typescript
/** Raw aggregate rows returned by the admin dashboard DB queries. Numerics may be null
 *  when there are no qualifying rows (Postgres SUM/COUNT on empty set returns null). */
export interface RawRevenueSums {
  /** COUNT of sms_accounts where amount_paid > 0 (paid activations). */
  activationCount: number | null
  /** SUM(amount_paid) across all activated sms_accounts. */
  activationTotal: number | null
  /** SUM(delta) for sms_unit_transactions with reason IN ('bundle_wallet','bundle_paystack').
   *  This is the total credits (units) sold via bundle purchases. */
  bundleUnitsSold: number | null
  /** Separately queried: total GHS collected for bundle purchases. Derived from
   *  sms_bundles price at purchase time — stored in sms_unit_transactions.ref chain
   *  or approximated from amount_paid. See moderation-service for the actual query. */
  bundleGhsTotal: number | null
}

export interface RevenueSummary {
  /** Count of paid activations. */
  activations: number
  /** Total GHS collected as activation fees. */
  activationTotal: number
  /** Total GHS collected as bundle purchases. */
  bundleTotal: number
  /** Total SMS credits (units) sold via bundle purchases. */
  creditsSold: number
}

/** Shape raw DB aggregate rows into a typed revenue summary. Pure — no side effects.
 *  All null/undefined inputs normalise to 0 so the UI never renders NaN. */
export function aggregateRevenue(raw: RawRevenueSums): RevenueSummary {
  return {
    activations:     raw.activationCount  != null ? Number(raw.activationCount)  : 0,
    activationTotal: raw.activationTotal  != null ? Number(raw.activationTotal)  : 0,
    bundleTotal:     raw.bundleGhsTotal   != null ? Number(raw.bundleGhsTotal)   : 0,
    creditsSold:     raw.bundleUnitsSold  != null ? Number(raw.bundleUnitsSold)  : 0,
  }
}
```

---

### Task 3 — Unit tests: `lib/sms/revenue-aggregation.test.ts`

- [ ] Create `lib/sms/revenue-aggregation.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { aggregateRevenue, type RawRevenueSums } from "./revenue-aggregation"

const zero: RawRevenueSums = {
  activationCount: null,
  activationTotal: null,
  bundleUnitsSold: null,
  bundleGhsTotal: null,
}

describe("aggregateRevenue", () => {
  it("all-null inputs → all zeros (no NaN)", () => {
    const out = aggregateRevenue(zero)
    expect(out).toEqual({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 })
  })

  it("maps populated fields correctly", () => {
    const raw: RawRevenueSums = {
      activationCount: 12,
      activationTotal: 240,
      bundleUnitsSold: 55000,
      bundleGhsTotal: 1650,
    }
    expect(aggregateRevenue(raw)).toEqual({
      activations: 12,
      activationTotal: 240,
      bundleTotal: 1650,
      creditsSold: 55000,
    })
  })

  it("numeric strings from Postgres coerce correctly", () => {
    // Supabase sometimes returns numeric columns as strings.
    const raw = {
      activationCount: 3,
      activationTotal: "75.00" as unknown as number,
      bundleUnitsSold: "5000" as unknown as number,
      bundleGhsTotal: "150.00" as unknown as number,
    }
    const out = aggregateRevenue(raw)
    expect(out.activationTotal).toBe(75)
    expect(out.creditsSold).toBe(5000)
    expect(out.bundleTotal).toBe(150)
  })

  it("zero counts are preserved (not collapsed to null)", () => {
    const raw: RawRevenueSums = { activationCount: 0, activationTotal: 0, bundleUnitsSold: 0, bundleGhsTotal: 0 }
    expect(aggregateRevenue(raw)).toEqual({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 })
  })
})
```

- [ ] Run tests and confirm pass:

```
npm test -- revenue-aggregation
```

Expected output:
```
✓ lib/sms/revenue-aggregation.test.ts (4 tests)
```

---

### Task 4 — Moderation service: `lib/sms/moderation-service.ts`

- [ ] Create `lib/sms/moderation-service.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { aggregateRevenue, type RawRevenueSums } from "./revenue-aggregation"
import type { Bundle } from "./bundle-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ---------- Types ----------

export interface SmsAccountRow {
  id: string
  user_id: string
  owner_type: string
  unit_balance: number
  status: string
  activated_at: string | null
  amount_paid: number | null
  created_at: string
}

export interface FlaggedLogRow {
  id: string
  sms_account_id: string
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  status: string
  flagged: boolean
  flag_reason: string | null
  created_at: string
}

export interface SmsAdminDashboard {
  settings: Record<string, unknown>
  bundles: Bundle[]
  revenue: {
    activations: number
    activationTotal: number
    bundleTotal: number
    creditsSold: number
  }
  flagged: FlaggedLogRow[]
  accounts: SmsAccountRow[]
  suspendedAccountIds: string[]
}

// ---------- Helpers ----------

/** Fetch the current admin_settings rows for SMS-related keys as a plain key→value map. */
async function fetchSmsSettings(): Promise<Record<string, unknown>> {
  const SMS_KEYS = [
    "sms_activation_fee",
    "sms_welcome_bonus_credits",
    "sms_blocked_keywords",
    "sms_allowed_link_domains",
    "sms_feature_enabled",
  ]
  const { data } = await supabaseAdmin
    .from("admin_settings")
    .select("key, value")
    .in("key", SMS_KEYS)
  if (!data) return {}
  return Object.fromEntries(data.map((r: { key: string; value: unknown }) => [r.key, r.value]))
}

/** Write one admin_audit_log row. Fire-and-forget — never throws to the caller. */
async function writeAuditLog(
  adminId: string,
  action: string,
  targetUserId: string | null,
  oldValue: unknown,
  newValue: unknown
): Promise<void> {
  await supabaseAdmin.from("admin_audit_log").insert({
    admin_id: adminId,
    action,
    target_user_id: targetUserId ?? null,
    old_value: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
    new_value: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
  })
}

// ---------- Public API ----------

/** Full admin dashboard snapshot: settings, bundles, revenue, flagged logs, all accounts. */
export async function getSmsAdminDashboard(): Promise<SmsAdminDashboard> {
  const [settings, bundles, accounts, flagged, revRow] = await Promise.all([
    fetchSmsSettings(),
    supabaseAdmin.from("sms_bundles").select("*").order("price_ghs", { ascending: true }),
    supabaseAdmin.from("sms_accounts").select("*").order("created_at", { ascending: false }),
    supabaseAdmin
      .from("sms_send_logs")
      .select("*")
      .eq("flagged", true)
      .order("created_at", { ascending: false })
      .limit(100),
    // Revenue aggregation query
    supabaseAdmin.rpc("get_sms_revenue_summary"),
  ])

  const rawSums: RawRevenueSums = revRow.data?.[0] ?? {
    activationCount: null,
    activationTotal: null,
    bundleUnitsSold: null,
    bundleGhsTotal: null,
  }

  const allAccounts = (accounts.data ?? []) as SmsAccountRow[]
  const suspendedAccountIds = allAccounts
    .filter((a) => a.status === "suspended")
    .map((a) => a.id)

  return {
    settings,
    bundles: (bundles.data ?? []) as Bundle[],
    revenue: aggregateRevenue(rawSums),
    flagged: (flagged.data ?? []) as FlaggedLogRow[],
    accounts: allAccounts,
    suspendedAccountIds,
  }
}

/**
 * Toggle an SMS account's status between active and suspended.
 * Calls the suspend_sms_account RPC (atomically guards against touching inactive accounts),
 * then writes an admin_audit_log row. Returns the new status string.
 */
export async function suspendSmsAccount(
  adminId: string,
  accountId: string,
  suspended: boolean
): Promise<{ ok: true; newStatus: string } | { ok: false; error: string }> {
  // Fetch old status for audit log
  const { data: acct, error: fetchErr } = await supabaseAdmin
    .from("sms_accounts")
    .select("status, user_id")
    .eq("id", accountId)
    .maybeSingle()
  if (fetchErr || !acct) return { ok: false, error: "SMS account not found" }

  const { data: newStatus, error: rpcErr } = await supabaseAdmin.rpc("suspend_sms_account", {
    p_account_id: accountId,
    p_suspended: suspended,
  })
  if (rpcErr) return { ok: false, error: rpcErr.message }

  const action = suspended ? "sms_suspend" : "sms_unsuspend"
  await writeAuditLog(
    adminId,
    action,
    (acct as { status: string; user_id: string }).user_id,
    { status: (acct as { status: string; user_id: string }).status },
    { status: newStatus }
  ).catch((err) => console.error("[SMS-AUDIT] writeAuditLog failed:", err))

  return { ok: true, newStatus: newStatus as string }
}

/**
 * Dismiss a flagged send-log row by clearing its flagged column.
 * Returns 404 if the row does not exist or is already unflagged.
 * Writes an admin_audit_log row.
 */
export async function dismissFlag(
  adminId: string,
  logId: string
): Promise<{ ok: true } | { ok: false; error: string; status: 400 | 404 }> {
  const { data: row, error: fetchErr } = await supabaseAdmin
    .from("sms_send_logs")
    .select("id, sms_account_id, flagged, flag_reason")
    .eq("id", logId)
    .maybeSingle()

  if (fetchErr || !row) return { ok: false, error: "Log entry not found", status: 404 }
  if (!(row as { flagged: boolean }).flagged)
    return { ok: false, error: "Log entry is not flagged", status: 404 }

  const { error: updateErr } = await supabaseAdmin
    .from("sms_send_logs")
    .update({ flagged: false, flag_reason: null })
    .eq("id", logId)
  if (updateErr) return { ok: false, error: updateErr.message, status: 400 }

  await writeAuditLog(
    adminId,
    "sms_flag_dismiss",
    null,
    { flagged: true, flag_reason: (row as { flag_reason: string | null }).flag_reason },
    { flagged: false }
  ).catch((err) => console.error("[SMS-AUDIT] writeAuditLog failed:", err))

  return { ok: true }
}
```

**Note:** `getSmsAdminDashboard` calls a `get_sms_revenue_summary` RPC — this is added in Task 5 (migration). The RPC avoids shipping a multi-join query inline in TypeScript.

---

### Task 5 — Migration: `get_sms_revenue_summary` RPC

Add a pure read function so the service layer can call one RPC instead of three separate aggregation queries. Append to the existing migration or add as `migrations/0068_admin_moderation_sms.sql` (append block after the `suspend_sms_account` function).

- [ ] Append to `migrations/0068_admin_moderation_sms.sql`:

```sql
-- get_sms_revenue_summary: aggregate revenue numbers for the admin dashboard.
-- Returns one row with four fields matching RawRevenueSums in revenue-aggregation.ts.
-- Reads only; no lock needed.
CREATE OR REPLACE FUNCTION get_sms_revenue_summary()
RETURNS TABLE(
  "activationCount"  BIGINT,
  "activationTotal"  NUMERIC,
  "bundleUnitsSold"  BIGINT,
  "bundleGhsTotal"   NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    -- Activations: accounts that have a non-null, non-zero amount_paid (paid the activation fee)
    COUNT(*)                                    FILTER (WHERE amount_paid IS NOT NULL AND amount_paid > 0)  AS "activationCount",
    COALESCE(SUM(amount_paid) FILTER (WHERE amount_paid IS NOT NULL AND amount_paid > 0), 0)               AS "activationTotal",
    -- Bundle credits sold: sum of positive deltas for bundle purchase transactions
    COUNT(*)::BIGINT                            -- placeholder; real credit count from sms_unit_transactions below
      * 0,                                      -- overridden by JOIN below
    0::NUMERIC
  FROM sms_accounts;
  -- NOTE: The above is intentionally replaced by the correct multi-source query:
$$;

-- Replace with the correct multi-source implementation:
CREATE OR REPLACE FUNCTION get_sms_revenue_summary()
RETURNS TABLE(
  "activationCount"  BIGINT,
  "activationTotal"  NUMERIC,
  "bundleUnitsSold"  BIGINT,
  "bundleGhsTotal"   NUMERIC
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  WITH activation_agg AS (
    SELECT
      COUNT(*)                                                    AS act_count,
      COALESCE(SUM(amount_paid), 0)                               AS act_total
    FROM sms_accounts
    WHERE amount_paid IS NOT NULL AND amount_paid > 0
  ),
  bundle_agg AS (
    SELECT
      COALESCE(SUM(delta), 0)                                     AS units_sold,
      -- GHS total: approximate from unit_transactions delta.
      -- bundle_wallet and bundle_paystack credits have positive deltas; map units → GHS
      -- via the matching sms_bundles row. Since we don't store price-per-unit inline,
      -- we sum amount_paid separately — for bundles, amount_paid IS the bundle price
      -- recorded on the sms_accounts row at activation. Bundle purchases after activation
      -- are not yet stored with a GHS amount in sms_unit_transactions, so we approximate
      -- bundleGhsTotal as 0 here until M3 stores it explicitly.
      0::NUMERIC                                                  AS ghs_total
    FROM sms_unit_transactions
    WHERE reason IN ('bundle_wallet', 'bundle_paystack')
      AND delta > 0
  )
  SELECT
    act_count::BIGINT   AS "activationCount",
    act_total           AS "activationTotal",
    units_sold::BIGINT  AS "bundleUnitsSold",
    ghs_total           AS "bundleGhsTotal"
  FROM activation_agg, bundle_agg;
$$;
```

- [ ] Apply and smoke-test:

```sql
SELECT * FROM get_sms_revenue_summary();
-- Expected: one row with (0, 0.00, 0, 0.00) on a fresh dev DB
-- (or real numbers if M2 activations have been done)
```

---

### Task 6 — Fake-client tests: `lib/sms/moderation-service.test.ts`

Test `suspendSmsAccount` and `dismissFlag` orchestration (RPC call, audit-log write, error paths) using the `vi.hoisted` fake-client pattern.

- [ ] Create `lib/sms/moderation-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type Row = { id: string; status: string; user_id: string; flagged: boolean; flag_reason: string | null }

  const state = {
    account: null as Row | null,
    logRow: null as Row | null,
    rpcError: false,
    updateError: false,
    auditRows: [] as unknown[],
    rpcCallArgs: null as unknown,
  }

  const fake = {
    from: (table: string) => ({
      select: (_cols?: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => {
            if (table === "sms_accounts")
              return Promise.resolve({ data: state.account, error: state.account ? null : { message: "not found" } })
            if (table === "sms_send_logs")
              return Promise.resolve({ data: state.logRow, error: state.logRow ? null : { message: "not found" } })
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }),
      insert: (row: unknown) => {
        if (table === "admin_audit_log") state.auditRows.push(row)
        return Promise.resolve({ data: null, error: null })
      },
      update: (_patch: unknown) => ({
        eq: (_c: string, _v: string) => Promise.resolve({ data: null, error: state.updateError ? { message: "update failed" } : null }),
      }),
    }),
    rpc: (fn: string, args: unknown) => {
      state.rpcCallArgs = { fn, args }
      if (fn === "suspend_sms_account") {
        if (state.rpcError) return Promise.resolve({ data: null, error: { message: "inactive account" } })
        const suspended = (args as { p_suspended: boolean }).p_suspended
        return Promise.resolve({ data: suspended ? "suspended" : "active", error: null })
      }
      return Promise.resolve({ data: [{ activationCount: 0, activationTotal: 0, bundleUnitsSold: 0, bundleGhsTotal: 0 }], error: null })
    },
  }

  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("./revenue-aggregation", () => ({
  aggregateRevenue: (raw: unknown) => ({ activations: 0, activationTotal: 0, bundleTotal: 0, creditsSold: 0 }),
}))

import { suspendSmsAccount, dismissFlag } from "./moderation-service"

beforeEach(() => {
  h.state.account = null
  h.state.logRow = null
  h.state.rpcError = false
  h.state.updateError = false
  h.state.auditRows.length = 0
  h.state.rpcCallArgs = null
})

describe("suspendSmsAccount", () => {
  it("account not found → error", async () => {
    const res = await suspendSmsAccount("admin1", "acc-missing", true)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/not found/)
    expect(h.state.auditRows).toHaveLength(0)
  })

  it("active account → RPC called with p_suspended=true, audit log written", async () => {
    h.state.account = { id: "acc1", status: "active", user_id: "u1", flagged: false, flag_reason: null }
    const res = await suspendSmsAccount("admin1", "acc1", true)
    expect(res.ok).toBe(true)
    expect((res as { newStatus: string }).newStatus).toBe("suspended")
    expect((h.state.rpcCallArgs as { fn: string }).fn).toBe("suspend_sms_account")
    expect(h.state.auditRows).toHaveLength(1)
  })

  it("RPC errors (e.g. inactive account) → error propagated, no audit log", async () => {
    h.state.account = { id: "acc1", status: "active", user_id: "u1", flagged: false, flag_reason: null }
    h.state.rpcError = true
    const res = await suspendSmsAccount("admin1", "acc1", true)
    expect(res.ok).toBe(false)
    expect(h.state.auditRows).toHaveLength(0)
  })

  it("unsuspend → p_suspended=false, audit action is sms_unsuspend", async () => {
    h.state.account = { id: "acc1", status: "suspended", user_id: "u1", flagged: false, flag_reason: null }
    await suspendSmsAccount("admin1", "acc1", false)
    expect((h.state.rpcCallArgs as { args: { p_suspended: boolean } }).args.p_suspended).toBe(false)
    const auditRow = h.state.auditRows[0] as { action: string }
    expect(auditRow.action).toBe("sms_unsuspend")
  })
})

describe("dismissFlag", () => {
  it("log not found → 404", async () => {
    const res = await dismissFlag("admin1", "log-missing")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(404)
  })

  it("log exists but not flagged → 404", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: false, flag_reason: null }
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(404)
  })

  it("flagged log → cleared, audit row written", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "keyword:loan" }
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(true)
    expect(h.state.auditRows).toHaveLength(1)
    const auditRow = h.state.auditRows[0] as { action: string; old_value: { flagged: boolean } }
    expect(auditRow.action).toBe("sms_flag_dismiss")
    expect(auditRow.old_value.flagged).toBe(true)
  })

  it("update error → 400 returned", async () => {
    h.state.logRow = { id: "l1", status: "sent", user_id: "u1", flagged: true, flag_reason: "test" }
    h.state.updateError = true
    const res = await dismissFlag("admin1", "l1")
    expect(res.ok).toBe(false)
    expect((res as { status: number }).status).toBe(400)
    expect(h.state.auditRows).toHaveLength(0) // audit not written on failure
  })
})
```

- [ ] Run tests:

```
npm test -- moderation-service
```

Expected:
```
✓ lib/sms/moderation-service.test.ts (8 tests)
```

---

### Task 7 — API route: `app/api/admin/shop-sms/route.ts`

- [ ] Create `app/api/admin/shop-sms/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getSmsAdminDashboard, suspendSmsAccount, dismissFlag } from "@/lib/sms/moderation-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/admin/shop-sms — full dashboard snapshot
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  try {
    const data = await getSmsAdminDashboard()
    return NextResponse.json({ success: true, data })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal error"
    console.error("[ADMIN-SHOP-SMS-GET]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/shop-sms — upsert metered SMS settings into admin_settings
// Body: { sms_activation_fee?: number; sms_welcome_bonus_credits?: number;
//         sms_blocked_keywords?: string[]; sms_allowed_link_domains?: string[];
//         sms_feature_enabled?: boolean }
export async function PATCH(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const body = await request.json()
  const ALLOWED_KEYS = new Set([
    "sms_activation_fee",
    "sms_welcome_bonus_credits",
    "sms_blocked_keywords",
    "sms_allowed_link_domains",
    "sms_feature_enabled",
  ])

  const updates = Object.entries(body).filter(([k]) => ALLOWED_KEYS.has(k))
  if (updates.length === 0) {
    return NextResponse.json({ error: "No valid settings keys provided" }, { status: 400 })
  }

  const upsertRows = updates.map(([key, value]) => ({
    key,
    value: typeof value === "object" ? value : value,
    updated_at: new Date().toISOString(),
    updated_by: auth.userId ?? null,
  }))

  const { error } = await supabaseAdmin
    .from("admin_settings")
    .upsert(upsertRows, { onConflict: "key" })

  if (error) {
    console.error("[ADMIN-SHOP-SMS-PATCH]", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, updated: updates.map(([k]) => k) })
}

// POST /api/admin/shop-sms — moderation actions
// Body (dismiss): { action: "dismiss_flag"; logId: string }
// Body (suspend): { action: "set_suspended"; accountId: string; suspended: boolean }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const body = await request.json()

  if (body.action === "dismiss_flag") {
    const { logId } = body
    if (!logId) return NextResponse.json({ error: "logId required" }, { status: 400 })

    const result = await dismissFlag(auth.userId!, logId)
    if (!result.ok) {
      return NextResponse.json({ error: (result as { error: string }).error }, {
        status: (result as { status: 400 | 404 }).status,
      })
    }
    return NextResponse.json({ success: true })
  }

  if (body.action === "set_suspended") {
    const { accountId, suspended } = body
    if (!accountId || typeof suspended !== "boolean") {
      return NextResponse.json({ error: "accountId (string) and suspended (boolean) required" }, { status: 400 })
    }

    const result = await suspendSmsAccount(auth.userId!, accountId, suspended)
    if (!result.ok) {
      // If the error is "not found" surface it as 404; everything else is 400
      const isNotFound = (result as { error: string }).error.toLowerCase().includes("not found")
      return NextResponse.json({ error: (result as { error: string }).error }, {
        status: isNotFound ? 404 : 400,
      })
    }
    return NextResponse.json({ success: true, newStatus: (result as { newStatus: string }).newStatus })
  }

  return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
}
```

- [ ] Verify manually via curl (dev server running):

```bash
# GET — should return the full dashboard JSON
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:3000/api/admin/shop-sms | jq '.data | keys'
# Expected: ["accounts","bundles","flagged","revenue","settings","suspendedAccountIds"]

# PATCH — upsert sms_feature_enabled
curl -s -XPATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"sms_feature_enabled": true}' http://localhost:3000/api/admin/shop-sms | jq .
# Expected: {"success":true,"updated":["sms_feature_enabled"]}

# POST unknown action → 400
curl -s -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"noop"}' http://localhost:3000/api/admin/shop-sms | jq .
# Expected: {"error":"Unknown action: noop"}
```

---

### Task 8 — Admin UI: extend `app/admin/sms/page.tsx` with Moderation tab

- [ ] Rewrite `app/admin/sms/page.tsx` to add a tabbed layout: existing "Overview" content stays in the first tab; a new "Moderation" tab shows flagged messages, per-account suspend toggles, and a revenue card.

```tsx
"use client"
import { useEffect, useState, useCallback } from "react"
import { supabase } from "@/lib/supabase"

type Tab = "overview" | "moderation"

interface RevenueData {
  activations: number
  activationTotal: number
  bundleTotal: number
  creditsSold: number
}

interface FlaggedLog {
  id: string
  sms_account_id: string
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  flag_reason: string | null
  created_at: string
}

interface AccountRow {
  id: string
  user_id: string
  owner_type: string
  unit_balance: number
  status: string
  amount_paid: number | null
}

interface DashboardData {
  settings: Record<string, unknown>
  bundles: { id: string; name: string; units: number; price_ghs: number; active: boolean }[]
  revenue: RevenueData
  flagged: FlaggedLog[]
  accounts: AccountRow[]
  suspendedAccountIds: string[]
}

export default function AdminSmsPage() {
  const [tab, setTab] = useState<Tab>("overview")
  const [bundles, setBundles] = useState<DashboardData["bundles"]>([])
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [accountId, setAccountId] = useState("")
  const [units, setUnits] = useState("")
  const [msg, setMsg] = useState("")
  const [loading, setLoading] = useState(false)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const loadDashboard = useCallback(async () => {
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    if (res.data) setDashboard(res.data)
    setBundles(res.data?.bundles ?? [])
  }, [])

  useEffect(() => {
    // Legacy bundle load for overview tab
    token().then((t) =>
      fetch("/api/admin/sms/bundles", { headers: { Authorization: `Bearer ${t}` } })
        .then((r) => r.json())
        .then((d) => setBundles(d.bundles ?? []))
    )
    // Full dashboard for moderation tab
    loadDashboard()
  }, [loadDashboard])

  async function allocate() {
    const t = await token()
    const res = await fetch("/api/admin/sms/allocate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, units: Number(units) }),
    }).then((r) => r.json())
    setMsg(
      res.error
        ? `Error: ${res.error}`
        : res.pending
        ? "Allocated (pending — top up Moolre wholesale)"
        : `Credited ${res.unitsCredited} units`
    )
  }

  async function handleDismiss(logId: string) {
    setLoading(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss_flag", logId }),
    }).then((r) => r.json())
    if (res.error) alert(`Error: ${res.error}`)
    else await loadDashboard()
    setLoading(false)
  }

  async function handleSuspendToggle(acct: AccountRow) {
    const willSuspend = acct.status !== "suspended"
    const label = willSuspend ? "suspend" : "unsuspend"
    if (!confirm(`${label} account ${acct.id}?`)) return
    setLoading(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_suspended", accountId: acct.id, suspended: willSuspend }),
    }).then((r) => r.json())
    if (res.error) alert(`Error: ${res.error}`)
    else await loadDashboard()
    setLoading(false)
  }

  const rev = dashboard?.revenue

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">SMS Admin</h1>

      {/* Tab bar */}
      <div className="flex gap-2 border-b pb-1">
        {(["overview", "moderation"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-t text-sm font-medium capitalize ${
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      {tab === "overview" && (
        <div className="space-y-4">
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">Allocate units</h2>
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="sms_account id"
              className="w-full rounded border px-2 py-1"
            />
            <input
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              placeholder="units"
              className="w-full rounded border px-2 py-1"
            />
            <button
              onClick={allocate}
              className="rounded bg-primary px-3 py-2 text-primary-foreground"
            >
              Allocate
            </button>
            {msg && <div className="text-sm">{msg}</div>}
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">Bundles</h2>
            <ul className="text-sm space-y-1">
              {bundles.map((b) => (
                <li key={b.id}>
                  {b.name} — {Number(b.units).toLocaleString()} units — GHS{" "}
                  {Number(b.price_ghs).toFixed(2)} {b.active ? "" : "(inactive)"}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ── Moderation tab ── */}
      {tab === "moderation" && (
        <div className="space-y-6">
          {/* Revenue card */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-3">Revenue Summary</h2>
            {rev ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Activations</dt>
                  <dd className="font-medium">{rev.activations}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Activation fees (GHS)</dt>
                  <dd className="font-medium">{rev.activationTotal.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Bundle revenue (GHS)</dt>
                  <dd className="font-medium">{rev.bundleTotal.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Credits sold</dt>
                  <dd className="font-medium">{rev.creditsSold.toLocaleString()}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
          </section>

          {/* Flagged messages */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">
              Flagged Messages ({dashboard?.flagged.length ?? 0})
            </h2>
            {!dashboard?.flagged.length ? (
              <p className="text-sm text-muted-foreground">No flagged messages.</p>
            ) : (
              <div className="space-y-2">
                {dashboard.flagged.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-start justify-between gap-4 rounded border px-3 py-2 text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {log.sms_account_id}
                      </p>
                      <p className="mt-0.5">{log.message}</p>
                      <p className="text-xs text-destructive mt-0.5">{log.flag_reason}</p>
                      <p className="text-xs text-muted-foreground">
                        {log.recipients_count} recipient(s) · {log.segments} seg · {log.credits_used} credits
                      </p>
                    </div>
                    <button
                      disabled={loading}
                      onClick={() => handleDismiss(log.id)}
                      className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      Dismiss
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Accounts */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">
              SMS Accounts ({dashboard?.accounts.length ?? 0})
            </h2>
            {!dashboard?.accounts.length ? (
              <p className="text-sm text-muted-foreground">No accounts yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-1 pr-4">Account ID</th>
                      <th className="pb-1 pr-4">Type</th>
                      <th className="pb-1 pr-4">Balance</th>
                      <th className="pb-1 pr-4">Status</th>
                      <th className="pb-1">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.accounts.map((acct) => (
                      <tr key={acct.id} className="border-b last:border-0">
                        <td className="py-1 pr-4 font-mono text-xs">{acct.id.slice(0, 8)}…</td>
                        <td className="py-1 pr-4">{acct.owner_type}</td>
                        <td className="py-1 pr-4">{acct.unit_balance.toLocaleString()}</td>
                        <td className="py-1 pr-4">
                          <span
                            className={
                              acct.status === "suspended"
                                ? "text-destructive font-medium"
                                : acct.status === "inactive"
                                ? "text-muted-foreground"
                                : "text-green-600 font-medium"
                            }
                          >
                            {acct.status}
                          </span>
                        </td>
                        <td className="py-1">
                          {acct.status === "inactive" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <button
                              disabled={loading}
                              onClick={() => handleSuspendToggle(acct)}
                              className={`rounded border px-2 py-0.5 text-xs ${
                                acct.status === "suspended"
                                  ? "border-green-500 text-green-600 hover:bg-green-50"
                                  : "border-destructive text-destructive hover:bg-red-50"
                              }`}
                            >
                              {acct.status === "suspended" ? "Unsuspend" : "Suspend"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
```

- [ ] Open `http://localhost:3000/admin/sms` in browser, switch to the "Moderation" tab, and confirm:
  - Revenue card renders (shows zeros on a fresh dev DB — no NaN, no crash).
  - "No flagged messages" placeholder when `sms_send_logs` has no flagged rows.
  - Accounts table renders; "inactive" rows show `—` in the Action column; active rows show a red "Suspend" button.

---

### Task 9 — Integration smoke-test: suspend + audit trail end-to-end

This task is manual (no running dev server in plan execution) but documents the exact verification steps.

- [ ] Precondition: at least one `sms_accounts` row with `status='active'` exists in the dev DB.

- [ ] Suspend via API:

```bash
curl -s -XPOST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set_suspended\",\"accountId\":\"$ACCT_ID\",\"suspended\":true}" \
  http://localhost:3000/api/admin/shop-sms
# Expected: {"success":true,"newStatus":"suspended"}
```

- [ ] Verify DB state:

```sql
SELECT id, status FROM sms_accounts WHERE id = '<ACCT_ID>';
-- Expected: status = 'suspended'

SELECT action, old_value, new_value
FROM admin_audit_log
WHERE action = 'sms_suspend'
ORDER BY created_at DESC LIMIT 1;
-- Expected: old_value = {"status":"active"}, new_value = {"status":"suspended"}
```

- [ ] Verify idempotency (suspend again — should return `suspended` with no error):

```bash
curl -s -XPOST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set_suspended\",\"accountId\":\"$ACCT_ID\",\"suspended\":true}" \
  http://localhost:3000/api/admin/shop-sms
# Expected: {"success":true,"newStatus":"suspended"}
```

- [ ] Unsuspend and verify the account returns to `active`:

```bash
curl -s -XPOST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set_suspended\",\"accountId\":\"$ACCT_ID\",\"suspended\":false}" \
  http://localhost:3000/api/admin/shop-sms
# Expected: {"success":true,"newStatus":"active"}
```

- [ ] Attempt to suspend an `inactive` account (should fail gracefully):

```bash
# Find an inactive account id first
curl -s -XPOST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"set_suspended\",\"accountId\":\"$INACTIVE_ACCT_ID\",\"suspended\":true}" \
  http://localhost:3000/api/admin/shop-sms
# Expected: {"error":"cannot suspend/unsuspend an inactive account (id: ...)"}  status 400
```

---

### Task 10 — Run all SMS tests

- [ ] Run the full SMS test suite and confirm all pass:

```
npm test -- lib/sms/
```

Expected output:
```
✓ lib/sms/foundation-rules.test.ts       (5 tests)
✓ lib/sms/bundle-service.test.ts         (5 tests)
✓ lib/sms/revenue-aggregation.test.ts    (4 tests)
✓ lib/sms/moderation-service.test.ts     (8 tests)

Test Files  4 passed (4)
Tests       22 passed (22)
```

---

## Self-Review

### Spec → Task Coverage

| Spec requirement | Task(s) |
|---|---|
| `suspend_sms_account(p_account_id, p_suspended)` SECURITY DEFINER RPC | Task 1 |
| Flips `active ↔ suspended`, never touches `inactive` | Task 1 (RAISE EXCEPTION guard) |
| `admin_audit_log` table (id, admin_id, action, target_user_id, old_value, new_value, created_at) | Task 1 |
| Record suspend/unsuspend + flag-dismiss with acting admin id | Task 4 (`suspendSmsAccount`, `dismissFlag`) |
| `GET /api/admin/shop-sms` → settings, bundles, revenue, flagged, accounts, suspendedAccountIds | Tasks 4, 5, 7 |
| `PATCH /api/admin/shop-sms` → upsert metered settings | Task 7 |
| `POST /api/admin/shop-sms` → dismiss_flag OR set_suspended | Tasks 4, 7 |
| 404 on unknown/stale ids | Tasks 4, 7 (moderation-service returns 404 status, route propagates) |
| Revenue aggregates (activations, activationTotal, bundleTotal, creditsSold) | Tasks 2, 3, 5 |
| Admin moderation UI (flagged list + dismiss, suspend toggle, revenue card) | Task 8 |
| Unit-test pure revenue aggregation | Task 3 |
| Fake-client tests for orchestration | Task 6 |
| Rate limit note | verifyAdminAccess already applies 100/min admin rate limit (noted in route conventions; no extra code needed) |

### Type Consistency

- `RawRevenueSums` in `revenue-aggregation.ts` has `number | null` fields matching what Postgres COUNT/SUM returns via Supabase (which can coerce to string for NUMERIC — handled by `Number()` in `aggregateRevenue`).
- `SmsAccountRow` in `moderation-service.ts` adds `activated_at` and `amount_paid` — both from M2's ALTER migration; the plan assumes those columns exist.
- `FlaggedLogRow` matches the `sms_send_logs` schema from M3: `id, sms_account_id, message, recipients_count, segments, credits_used, status, flagged, flag_reason, created_at`.
- The `suspend_sms_account` RPC returns `TEXT` (the new status string); the TS call receives `data: string`.

### Inline Verification Points

1. **`admin_audit_log` does NOT already exist** — `grep -r "admin_audit_log"` across the repo returns zero matches. Safe to create.
2. **`sms_send_logs` is READ-ONLY for this milestone** — the plan never creates or structurally alters it. M3 owns it.
3. **`get_sms_revenue_summary` bundle GHS total is 0** — the current schema does not store the GHS price on `sms_unit_transactions` rows (only delta in units). The RPC returns 0 for `bundleGhsTotal` with a clear comment. This is accurate rather than misleading; M3 can add a `price_ghs` column to `sms_unit_transactions` to fill it.
4. **`inactive` guard in the RPC** — the RAISE EXCEPTION path ensures that if M2 hasn't set `status='active'` for a new account, an accidental suspend call fails loudly (not silently).
5. **Audit-log fire-and-forget `.catch()`** — audit writes are non-fatal to the primary action (consistent with the notify pattern in `lib/sms/notify.ts`).
6. **Migration number `0068`** — 0065–0067 are reserved for M2 (activation gate, 2 migrations) and M3 (sms_send_logs, debit_sms_for_send). If M2/M3 use different numbers the operator should adjust; it does not affect the SQL correctness.
