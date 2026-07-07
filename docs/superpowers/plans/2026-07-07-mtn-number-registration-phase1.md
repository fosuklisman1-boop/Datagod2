# MTN Number Registration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateful MTN number registry (pending → submitted → registered) that auto-captures every new MTN data-order beneficiary, seeds from all known MTN numbers, and gives admins a delta "Download new numbers" page to hand the provider only numbers not yet submitted.

**Architecture:** One migration creates `mtn_number_registry` + `mtn_registration_batches`, a `gh_is_mtn()` helper, a `SECURITY DEFINER` `AFTER INSERT` capture trigger on the 5 data-order tables (MTN-only, `ON CONFLICT DO NOTHING`), an atomic claim RPC `claim_mtn_registration_batch()` (race-safe delta export in one transaction), and an idempotent seed backfill. Thin admin routes (export / list / mark-registered / batch re-download) call the RPC or simple queries; a small pure TS helper shapes the xlsx rows; a new `/admin/mtn-registration` page + sidebar link complete it.

**Tech Stack:** Next.js 15 App Router, Supabase Postgres (service-role + PostgREST RPC), `xlsx`, Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-07-mtn-number-registration-phase1-design.md`

**Refinement vs spec (intent-preserving):** the spec sketched "claim in the route with `.eq('status','pending')`". This plan moves claim + batch-insert into a single Postgres function so two admins clicking at once can never double-claim or create a phantom batch. Same behavior, strictly safer.

---

## Verified environment facts (rely on these)

- `normalize_gh_phone(text)` and view `all_order_phones` already exist in prod (applied 2026-07-07 from `migrations/20260707_all_order_phones.sql`). `all_order_phones.phone` is already canonical `0XXXXXXXXX` or NULL; `network_raw='MTN'` identifies MTN data orders.
- MTN prefixes (mirror `detectGhanaNetwork` in `lib/phone-format.ts:55`): significant digits starting `24,25,53,54,55,59`.
- The 5 data tables + beneficiary columns: `orders.phone_number`, `shop_orders.customer_phone`, `api_orders.recipient_phone`, `ussd_orders.recipient_phone`, `ussd_shop_orders.recipient_phone` — all have a `network` column.
- Seed sources (all verified to exist): `users.phone_number`, `whatsapp_conversations.phone_number`, `sms_contacts.phone_number`, `sms_messages.phone`, `broadcast_recipients.phone`, `phone_otp_verifications.phone`, `phone_verification_results.phone_number` (+ its `network` column).
- Trigger/RLS conventions to mirror: `migrations/20260615_wa_delivery_outbox.sql` (SECURITY DEFINER capture fn, best-effort EXCEPTION handler, service-role-only RLS + REVOKEs, claim RPC locked to service_role).
- Admin auth: `verifyAdminAccess(request)` from `@/lib/admin-auth` returns `{ isAdmin, userId, userEmail, errorResponse }`.
- Audit insert shape (match `app/api/admin/update-balance/route.ts:131-140`): `admin_audit_log(admin_id, action, target_user_id?, old_value?, new_value, created_at)`.
- Admin page conventions: `useAdminProtected()` from `@/hooks/use-admin`; `getToken()` = `supabase.auth.getSession()` → `access_token` (see `app/admin/phone-verification/page.tsx:58-61`); `<DashboardLayout>`; sonner `toast`.
- Sidebar: clone the `/admin/phone-verification` block at `components/layout/sidebar.tsx:801-822`; the `Smartphone` icon is ALREADY imported (line ~37) — no new imports.
- Tests co-located (`lib/*.test.ts`), run `npx vitest run <file>`; `npx tsc --noEmit` is currently clean.
- **DB access this session:** Management API SQL endpoint works. Recreate the temp helper below for Task 1, then delete it. It reads the PAT from gitignored `.mcp.json` — never print the token.

Temp helper `_supabase_sql.js` (repo root; delete after Task 1):

```js
// Temp helper: run SQL against the DATAGOD Supabase DB via the Management API,
// reading the PAT from .mcp.json so the token is never printed. Deleted after use.
// Usage: node _supabase_sql.js "<SQL string>"   OR   node _supabase_sql.js path/to/file.sql
const fs = require("fs")
const path = require("path")
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, ".mcp.json"), "utf8"))
const s = cfg.mcpServers.supabase
const token = s.env.SUPABASE_ACCESS_TOKEN
const args = (s.args || []).join(" ")
const ref = (args.match(/project-ref[=\s]([a-z0-9]+)/i) || [])[1]
const arg = process.argv[2]
if (!token || !ref) { console.error("Could not resolve token/ref from .mcp.json"); process.exit(1) }
const sql = arg && fs.existsSync(arg) ? fs.readFileSync(arg, "utf8") : arg
;(async () => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  console.log("HTTP", res.status)
  console.log(text)
  if (!res.ok) process.exit(2)
})().catch((e) => { console.error("ERR", e.message); process.exit(1) })
```

---

## File structure

- **Create** `migrations/20260707_mtn_number_registry.sql` — tables, helper fn, capture trigger ×5, claim RPC, seed, RLS/grants.
- **Create** `lib/mtn-registration.ts` — pure helpers: `buildMtnRegistrationRows`, `parseClaimResult` + types.
- **Create** `lib/mtn-registration.test.ts` — co-located unit tests.
- **Create** `app/api/admin/mtn-registration/export/route.ts` — delta export (claims via RPC).
- **Create** `app/api/admin/mtn-registration/list/route.ts` — status counts + batch history.
- **Create** `app/api/admin/mtn-registration/mark-registered/route.ts` — flip a batch to registered.
- **Create** `app/api/admin/mtn-registration/batch/[id]/download/route.ts` — re-download a past batch.
- **Create** `app/admin/mtn-registration/page.tsx` — the admin page.
- **Modify** `components/layout/sidebar.tsx` — one nav block after phone-verification (line ~822).

---

## Task 1: Migration — registry, capture trigger, claim RPC, seed (+ apply & verify)

**Files:**
- Create: `migrations/20260707_mtn_number_registry.sql`
- Create then delete: `_supabase_sql.js` (helper above)

- [ ] **Step 1: Write the migration file**

Create `migrations/20260707_mtn_number_registry.sql`:

```sql
-- MTN number registration pipeline (Phase 1).
-- MTN only fulfills data to pre-registered numbers. This creates a stateful
-- registry (pending -> submitted -> registered), auto-captures every new MTN
-- data-order beneficiary via AFTER INSERT triggers (all channels, incl. the
-- place_api_order SECURITY DEFINER path that code hooks would miss), seeds it
-- from every MTN number we already know, and provides an atomic claim RPC for
-- the admin delta export. Conventions mirror 20260615_wa_delivery_outbox.sql.
-- Depends on: normalize_gh_phone(text) from 20260707_all_order_phones.sql.

-- 1. Registry ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mtn_number_registry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text NOT NULL UNIQUE,          -- canonical 0XXXXXXXXX
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','submitted','registered','rejected')),
  source          text,                          -- 'order:<table>' | 'seed:<source>'
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz,
  submitted_batch uuid,
  registered_at   timestamptz,
  notes           text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mtn_number_registry_status_idx ON mtn_number_registry (status);

ALTER TABLE mtn_number_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mtn_registry_service_only ON mtn_number_registry;
CREATE POLICY mtn_registry_service_only ON mtn_number_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON mtn_number_registry FROM anon, authenticated;
GRANT ALL ON mtn_number_registry TO service_role;

-- 2. Batches ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mtn_registration_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_time          timestamptz NOT NULL DEFAULT now(),
  phones              jsonb NOT NULL,            -- ["0XXXXXXXXX", ...] for re-download
  number_count        integer NOT NULL,
  status              text NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','registered')),
  downloaded_by       uuid,
  downloaded_by_email text,
  registered_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mtn_registration_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mtn_batches_service_only ON mtn_registration_batches;
CREATE POLICY mtn_batches_service_only ON mtn_registration_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON mtn_registration_batches FROM anon, authenticated;
GRANT ALL ON mtn_registration_batches TO service_role;

-- 3. MTN prefix helper (mirrors detectGhanaNetwork in lib/phone-format.ts) ---
CREATE OR REPLACE FUNCTION gh_is_mtn(raw text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    substring(normalize_gh_phone(raw) FROM 2 FOR 2) IN ('24','25','53','54','55','59'),
    false
  );
$$;
REVOKE ALL ON FUNCTION gh_is_mtn(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gh_is_mtn(text) TO service_role;

-- 4. Capture trigger: every new MTN data order enrolls its beneficiary ------
CREATE OR REPLACE FUNCTION capture_mtn_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER                 -- insert succeeds regardless of writer's role
SET search_path = public
AS $$
DECLARE
  j    jsonb := to_jsonb(NEW);
  raw  text;
  norm text;
BEGIN
  IF lower(COALESCE(j->>'network','')) <> 'mtn' THEN
    RETURN NEW;
  END IF;
  raw := CASE TG_TABLE_NAME
    WHEN 'orders'      THEN j->>'phone_number'
    WHEN 'shop_orders' THEN j->>'customer_phone'
    ELSE                    j->>'recipient_phone'   -- api_orders / ussd_orders / ussd_shop_orders
  END;
  norm := normalize_gh_phone(raw);
  IF norm IS NULL THEN
    RETURN NEW;
  END IF;
  -- Never revives a registered/rejected row; idempotent on repeat orders.
  INSERT INTO mtn_number_registry (phone, source)
  VALUES (norm, 'order:' || TG_TABLE_NAME)
  ON CONFLICT (phone) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;                    -- best-effort: never break the order write
END;
$$;
REVOKE ALL ON FUNCTION capture_mtn_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_capture_mtn_orders            ON orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_shop_orders       ON shop_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_api_orders        ON api_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_ussd_orders       ON ussd_orders;
DROP TRIGGER IF EXISTS trg_capture_mtn_ussd_shop_orders  ON ussd_shop_orders;
CREATE TRIGGER trg_capture_mtn_orders           AFTER INSERT ON orders           FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_shop_orders      AFTER INSERT ON shop_orders      FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_api_orders       AFTER INSERT ON api_orders       FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_ussd_orders      AFTER INSERT ON ussd_orders      FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();
CREATE TRIGGER trg_capture_mtn_ussd_shop_orders AFTER INSERT ON ussd_shop_orders FOR EACH ROW EXECUTE FUNCTION capture_mtn_number();

-- 5. Atomic claim RPC for the delta export ----------------------------------
-- Claims ALL currently-pending numbers into a new batch in one transaction.
-- Two concurrent admins can never double-claim (row updates serialize) or
-- create a phantom batch (0 claimed -> no batch row).
CREATE OR REPLACE FUNCTION claim_mtn_registration_batch(p_admin_id uuid, p_admin_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid := gen_random_uuid();
  v_phones   jsonb;
  v_count    integer;
BEGIN
  WITH claimed AS (
    UPDATE mtn_number_registry
    SET status = 'submitted',
        submitted_at = now(),
        submitted_batch = v_batch_id,
        updated_at = now()
    WHERE status = 'pending'
    RETURNING phone, first_seen_at
  )
  SELECT COALESCE(jsonb_agg(phone ORDER BY first_seen_at), '[]'::jsonb), COUNT(*)
  INTO v_phones, v_count
  FROM claimed;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('batch_id', NULL, 'count', 0, 'phones', '[]'::jsonb);
  END IF;

  INSERT INTO mtn_registration_batches (id, phones, number_count, status, downloaded_by, downloaded_by_email)
  VALUES (v_batch_id, v_phones, v_count, 'submitted', p_admin_id, p_admin_email);

  RETURN jsonb_build_object('batch_id', v_batch_id, 'count', v_count, 'phones', v_phones);
END;
$$;
REVOKE ALL ON FUNCTION claim_mtn_registration_batch(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_mtn_registration_batch(uuid, text) TO service_role;

-- 6. Seed / backfill (idempotent; safe to re-run) ----------------------------
-- 6a. Order buyers with an explicit MTN order (definite MTN).
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT phone, 'seed:orders'
FROM all_order_phones
WHERE network_raw = 'MTN' AND phone IS NOT NULL
ON CONFLICT (phone) DO NOTHING;

-- 6b. Phone-verification results marked MTN (verified network).
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:phone_verify'
FROM phone_verification_results
WHERE UPPER(COALESCE(network,'')) = 'MTN'
  AND normalize_gh_phone(phone_number) IS NOT NULL
ON CONFLICT (phone) DO NOTHING;

-- 6c. Prefix-MTN numbers from every other contact source we hold.
--     (Heuristic: portability means a few may not be MTN; MTN simply won't
--      register those. Order-capture above is exact.)
INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:users'
FROM users
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:whatsapp'
FROM whatsapp_conversations
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone_number), 'seed:sms_contacts'
FROM sms_contacts
WHERE gh_is_mtn(phone_number)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:sms_messages'
FROM sms_messages
WHERE gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:broadcast'
FROM broadcast_recipients
WHERE phone IS NOT NULL AND gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;

INSERT INTO mtn_number_registry (phone, source)
SELECT DISTINCT normalize_gh_phone(phone), 'seed:otp'
FROM phone_otp_verifications
WHERE gh_is_mtn(phone)
ON CONFLICT (phone) DO NOTHING;
```

- [ ] **Step 2: Recreate the temp SQL helper**

Write `_supabase_sql.js` at repo root with the exact content from "Verified environment facts" above. Do NOT commit it.

- [ ] **Step 3: Preflight — confirm seed-source tables/columns exist**

Run:
```bash
node _supabase_sql.js "SELECT table_name||'.'||column_name AS col FROM information_schema.columns WHERE table_schema='public' AND ((table_name='users' AND column_name='phone_number') OR (table_name='whatsapp_conversations' AND column_name='phone_number') OR (table_name='sms_contacts' AND column_name='phone_number') OR (table_name='sms_messages' AND column_name='phone') OR (table_name='broadcast_recipients' AND column_name='phone') OR (table_name='phone_otp_verifications' AND column_name='phone') OR (table_name='phone_verification_results' AND column_name IN ('phone_number','network'))) ORDER BY 1;"
```
Expected: 8 rows (all listed columns). If any is missing, REMOVE that seed block from the migration (report it) rather than letting apply fail.

- [ ] **Step 4: Apply the migration**

Run: `node _supabase_sql.js migrations/20260707_mtn_number_registry.sql`
Expected: `HTTP 201` and `[]`.

- [ ] **Step 5: Verify objects, helper truth-table, and seed counts**

Run:
```bash
node _supabase_sql.js "SELECT to_regclass('public.mtn_number_registry')::text AS registry, to_regclass('public.mtn_registration_batches')::text AS batches, to_regprocedure('public.claim_mtn_registration_batch(uuid,text)')::text AS claim_fn, gh_is_mtn('0241234567') AS mtn_true, gh_is_mtn('0201112223') AS telecel_false, gh_is_mtn('junk') AS junk_false, (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_capture_mtn_%') AS trigger_count;"
node _supabase_sql.js "SELECT status, count(*) FROM mtn_number_registry GROUP BY 1; "
node _supabase_sql.js "SELECT source, count(*) FROM mtn_number_registry GROUP BY 1 ORDER BY 2 DESC;"
```
Expected: registry/batches/claim_fn non-null; `mtn_true=true`, `telecel_false=false`, `junk_false=false`; `trigger_count=5`; a `pending` count > 0; per-source counts (report them).

- [ ] **Step 6: Verify lockdown**

Run:
```bash
node _supabase_sql.js "SELECT has_table_privilege('anon','public.mtn_number_registry','SELECT') AS anon_reg, has_table_privilege('authenticated','public.mtn_number_registry','SELECT') AS auth_reg, has_table_privilege('service_role','public.mtn_number_registry','SELECT') AS svc_reg, has_function_privilege('authenticated','public.claim_mtn_registration_batch(uuid,text)','EXECUTE') AS auth_claim, has_function_privilege('service_role','public.claim_mtn_registration_batch(uuid,text)','EXECUTE') AS svc_claim;"
```
Expected: `anon_reg=false, auth_reg=false, svc_reg=true, auth_claim=false, svc_claim=true`.

- [ ] **Step 7: Trigger + delta smoke test (transactional, leaves no trace in prod)**

Run (single request; DO blocks RAISE on failure → HTTP error; ROLLBACK discards everything):
```bash
node _supabase_sql.js "BEGIN; INSERT INTO orders (user_id, network, phone_number, size, price, status) SELECT id, 'MTN', '0599999991', '1GB', 1, 'pending' FROM users LIMIT 1; DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM mtn_number_registry WHERE phone='0599999991' AND status='pending') THEN RAISE EXCEPTION 'capture trigger did not fire'; END IF; END \$\$; DO \$\$ DECLARE r1 jsonb; r2 jsonb; BEGIN r1 := claim_mtn_registration_batch(NULL,'smoke@test'); r2 := claim_mtn_registration_batch(NULL,'smoke@test'); IF (r1->>'count')::int = 0 THEN RAISE EXCEPTION 'first claim got 0'; END IF; IF (r2->>'count')::int <> 0 THEN RAISE EXCEPTION 'delta broken: second claim got %', r2->>'count'; END IF; END \$\$; ROLLBACK;"
```
Expected: `HTTP 201`. If the `orders` insert fails on a NOT NULL column, inspect `SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND is_nullable='NO'` and extend the insert's column list with minimal placeholder values — the assertions are the point, the row is rolled back.
NOTE: after this step the LIVE pending set is untouched (rollback) — confirm with `SELECT count(*) FROM mtn_number_registry WHERE status='submitted';` → expected `0`.

- [ ] **Step 8: Delete the helper and commit**

```bash
rm _supabase_sql.js
git add migrations/20260707_mtn_number_registry.sql
git commit -m "feat(db): MTN number registry, capture triggers, claim RPC, seed backfill"
```

---

## Task 2: Pure TS helpers (`lib/mtn-registration.ts`) — TDD

**Files:**
- Create: `lib/mtn-registration.ts`
- Test: `lib/mtn-registration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/mtn-registration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildMtnRegistrationRows, parseClaimResult } from './mtn-registration'

describe('buildMtnRegistrationRows', () => {
  it('shapes phones into single-column sheet rows', () => {
    expect(buildMtnRegistrationRows(['0241234567', '0551112223'])).toEqual([
      { Phone: '0241234567' },
      { Phone: '0551112223' },
    ])
  })
  it('returns empty array for no phones', () => {
    expect(buildMtnRegistrationRows([])).toEqual([])
  })
})

describe('parseClaimResult', () => {
  it('parses a successful claim payload', () => {
    const r = parseClaimResult({ batch_id: 'b1', count: 2, phones: ['0241234567', '0551112223'] })
    expect(r).toEqual({ batchId: 'b1', count: 2, phones: ['0241234567', '0551112223'] })
  })
  it('parses the empty-claim payload (null batch_id)', () => {
    const r = parseClaimResult({ batch_id: null, count: 0, phones: [] })
    expect(r).toEqual({ batchId: null, count: 0, phones: [] })
  })
  it('is defensive about malformed input', () => {
    expect(parseClaimResult(null)).toEqual({ batchId: null, count: 0, phones: [] })
    expect(parseClaimResult({})).toEqual({ batchId: null, count: 0, phones: [] })
    expect(parseClaimResult({ batch_id: 'b', count: '3', phones: 'nope' }))
      .toEqual({ batchId: 'b', count: 3, phones: [] })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/mtn-registration.test.ts`
Expected: FAIL — cannot find module `./mtn-registration`.

- [ ] **Step 3: Implement the module**

Create `lib/mtn-registration.ts`:

```ts
// Pure, DB-free helpers for the MTN registration admin feature.
// Consumes the jsonb payload of claim_mtn_registration_batch() and shapes
// xlsx rows for the provider file (single Phone column, local 0XXXXXXXXX).

export interface ClaimResult {
  batchId: string | null
  count: number
  phones: string[]
}

/** Defensive parse of the claim RPC's jsonb result. */
export function parseClaimResult(raw: unknown): ClaimResult {
  const o = (raw ?? {}) as Record<string, unknown>
  const phones = Array.isArray(o.phones) ? (o.phones as unknown[]).map(String) : []
  return {
    batchId: typeof o.batch_id === 'string' ? o.batch_id : null,
    count: Number(o.count) || 0,
    phones,
  }
}

export interface MtnSheetRow {
  Phone: string
}

/** One row per phone; single `Phone` column in local 0XXXXXXXXX format. */
export function buildMtnRegistrationRows(phones: string[]): MtnSheetRow[] {
  return phones.map(phone => ({ Phone: phone }))
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/mtn-registration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-registration.ts lib/mtn-registration.test.ts
git commit -m "feat: MTN registration pure helpers (claim parse + sheet rows)"
```

---

## Task 3: Export route (delta download)

**Files:**
- Create: `app/api/admin/mtn-registration/export/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/admin/mtn-registration/export/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { buildMtnRegistrationRows, parseClaimResult } from "@/lib/mtn-registration"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, userEmail: adminEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    // Atomic claim: flips ALL pending -> submitted and records the batch in
    // one DB transaction (race-safe across concurrent admins).
    const { data, error } = await supabase.rpc("claim_mtn_registration_batch", {
      p_admin_id: adminId ?? null,
      p_admin_email: adminEmail ?? null,
    })
    if (error) {
      console.error("[MTN-REG-EXPORT] claim rpc error:", error)
      return NextResponse.json({ error: "Failed to claim new numbers" }, { status: 500 })
    }

    const claim = parseClaimResult(data)

    const workbook = XLSX.utils.book_new()
    const rows = buildMtnRegistrationRows(claim.phones)
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.json_to_sheet([], { header: ["Phone"] })
    XLSX.utils.book_append_sheet(workbook, ws, "MTN Numbers")

    // Audit trail: bulk PII export. Awaited so the record is durably written
    // before the serverless function freezes; best-effort (never fails the download).
    if (claim.count > 0) {
      try {
        const { error: auditErr } = await supabase
          .from("admin_audit_log")
          .insert([{
            admin_id: adminId || null,
            action: "export_mtn_registration",
            new_value: { batch_id: claim.batchId, number_count: claim.count },
            created_at: new Date().toISOString(),
          }])
        if (auditErr) console.warn("[MTN-REG-EXPORT] audit insert failed:", auditErr.message)
      } catch (auditErr) {
        console.warn("[MTN-REG-EXPORT] audit insert threw:", auditErr)
      }
    }

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const fileName = `mtn-register-${new Date().toISOString().split("T")[0]}.xlsx`
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-New-Count": String(claim.count),
      },
    })
  } catch (error) {
    console.error("[MTN-REG-EXPORT] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors (project is currently clean; any new error is yours).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/mtn-registration/export/route.ts
git commit -m "feat(api): MTN registration delta export route (atomic claim, xlsx)"
```

---

## Task 4: List, mark-registered, and batch re-download routes

**Files:**
- Create: `app/api/admin/mtn-registration/list/route.ts`
- Create: `app/api/admin/mtn-registration/mark-registered/route.ts`
- Create: `app/api/admin/mtn-registration/batch/[id]/download/route.ts`

- [ ] **Step 1: Write the list route**

Create `app/api/admin/mtn-registration/list/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const STATUSES = ["pending", "submitted", "registered", "rejected"] as const

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const counts: Record<string, number> = {}
    for (const status of STATUSES) {
      const { count, error } = await supabase
        .from("mtn_number_registry")
        .select("*", { count: "exact", head: true })
        .eq("status", status)
      if (error) throw error
      counts[status] = count ?? 0
    }

    const { data: batches, error: batchErr } = await supabase
      .from("mtn_registration_batches")
      .select("id, batch_time, number_count, status, registered_at, downloaded_by_email")
      .order("batch_time", { ascending: false })
      .limit(20)
    if (batchErr) throw batchErr

    return NextResponse.json({ counts, batches: batches ?? [] })
  } catch (error) {
    console.error("[MTN-REG-LIST] error:", error)
    return NextResponse.json({ error: "Failed to load registration status" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the mark-registered route**

Create `app/api/admin/mtn-registration/mark-registered/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { batchId } = await request.json()
    if (typeof batchId !== "string" || !/^[0-9a-f-]{36}$/i.test(batchId)) {
      return NextResponse.json({ error: "Invalid batchId" }, { status: 400 })
    }

    const now = new Date().toISOString()

    // Flip the batch first (guarded), so a wrong/already-registered id is a no-op.
    const { data: batchRows, error: batchErr } = await supabase
      .from("mtn_registration_batches")
      .update({ status: "registered", registered_at: now })
      .eq("id", batchId)
      .eq("status", "submitted")
      .select("id, number_count")
    if (batchErr) throw batchErr
    if (!batchRows || batchRows.length === 0) {
      return NextResponse.json({ error: "Batch not found or already registered" }, { status: 404 })
    }

    const { data: numRows, error: numErr } = await supabase
      .from("mtn_number_registry")
      .update({ status: "registered", registered_at: now, updated_at: now })
      .eq("submitted_batch", batchId)
      .eq("status", "submitted")
      .select("id")
    if (numErr) throw numErr

    // Audit: registration state change (awaited, best-effort).
    try {
      const { error: auditErr } = await supabase
        .from("admin_audit_log")
        .insert([{
          admin_id: adminId || null,
          action: "mtn_registration_mark_registered",
          new_value: { batch_id: batchId, numbers_registered: numRows?.length ?? 0 },
          created_at: now,
        }])
      if (auditErr) console.warn("[MTN-REG-MARK] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[MTN-REG-MARK] audit insert threw:", auditErr)
    }

    return NextResponse.json({ ok: true, numbersRegistered: numRows?.length ?? 0 })
  } catch (error) {
    console.error("[MTN-REG-MARK] error:", error)
    return NextResponse.json({ error: "Failed to mark batch registered" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Write the batch re-download route**

Create `app/api/admin/mtn-registration/batch/[id]/download/route.ts` (Next 15: `params` is a Promise):

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { buildMtnRegistrationRows } from "@/lib/mtn-registration"

export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: "Invalid batch id" }, { status: 400 })
    }

    const { data: batch, error } = await supabase
      .from("mtn_registration_batches")
      .select("id, batch_time, phones, number_count")
      .eq("id", id)
      .single()
    if (error || !batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    const phones: string[] = Array.isArray(batch.phones) ? batch.phones.map(String) : []
    const workbook = XLSX.utils.book_new()
    const rows = buildMtnRegistrationRows(phones)
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows)
      : XLSX.utils.json_to_sheet([], { header: ["Phone"] })
    XLSX.utils.book_append_sheet(workbook, ws, "MTN Numbers")

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const day = String(batch.batch_time).split("T")[0]
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="mtn-register-batch-${day}.xlsx"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("[MTN-REG-BATCH-DL] error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/mtn-registration/list/route.ts app/api/admin/mtn-registration/mark-registered/route.ts "app/api/admin/mtn-registration/batch/[id]/download/route.ts"
git commit -m "feat(api): MTN registration list, mark-registered, batch re-download"
```

---

## Task 5: Admin page + sidebar link

**Files:**
- Create: `app/admin/mtn-registration/page.tsx`
- Modify: `components/layout/sidebar.tsx` (insert after the phone-verification block ending at line ~822)

- [ ] **Step 1: Write the page**

Create `app/admin/mtn-registration/page.tsx`:

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, CheckCircle2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"

interface BatchRow {
  id: string
  batch_time: string
  number_count: number
  status: "submitted" | "registered"
  registered_at: string | null
  downloaded_by_email: string | null
}

interface ListPayload {
  counts: Record<string, number>
  batches: BatchRow[]
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const element = document.createElement("a")
  element.setAttribute("href", url)
  element.setAttribute("download", filename)
  element.style.display = "none"
  document.body.appendChild(element)
  element.click()
  document.body.removeChild(element)
  window.URL.revokeObjectURL(url)
}

export default function MtnRegistrationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [payload, setPayload] = useState<ListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/list", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error("Failed to load")
      setPayload(await res.json())
    } catch {
      toast.error("Failed to load MTN registration status")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin && !adminLoading) loadStatus()
  }, [isAdmin, adminLoading, loadStatus])

  const handleExport = async () => {
    setExporting(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/export", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Export failed")
      }
      const newCount = Number(res.headers.get("X-New-Count") || "0")
      if (newCount === 0) {
        toast.info("No new numbers to register — everything pending has already been submitted.")
        return
      }
      const blob = await res.blob()
      triggerBlobDownload(blob, `mtn-register-${new Date().toISOString().split("T")[0]}.xlsx`)
      toast.success(`Downloaded ${newCount} new number${newCount === 1 ? "" : "s"} for registration.`)
      await loadStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const handleMarkRegistered = async (batchId: string) => {
    setMarkingId(batchId)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/mark-registered", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to mark registered")
      toast.success(`Marked ${data.numbersRegistered} numbers as registered.`)
      await loadStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to mark registered")
    } finally {
      setMarkingId(null)
    }
  }

  const handleRedownload = async (batchId: string, batchTime: string) => {
    setRedownloadingId(batchId)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/mtn-registration/batch/${batchId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Re-download failed")
      }
      const blob = await res.blob()
      triggerBlobDownload(blob, `mtn-register-batch-${batchTime.split("T")[0]}.xlsx`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Re-download failed")
    } finally {
      setRedownloadingId(null)
    }
  }

  if (adminLoading) return null

  const counts = payload?.counts ?? {}

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">MTN Registration</h1>
            <p className="text-muted-foreground mt-1">
              Download new numbers to hand to the provider for MTN registration.
            </p>
          </div>
          <Button onClick={handleExport} disabled={exporting || loading}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {exporting ? "Exporting…" : "Download new numbers"}
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(["pending", "submitted", "registered"] as const).map(status => (
            <Card key={status}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                  {status}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : (counts[status] ?? 0).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Registration batches</CardTitle>
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </CardHeader>
          <CardContent>
            {(payload?.batches ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No batches yet. Click “Download new numbers” to create the first one.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Numbers</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">By</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(payload?.batches ?? []).map(b => (
                      <tr key={b.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {new Date(b.batch_time).toLocaleString()}
                        </td>
                        <td className="py-2 pr-4">{b.number_count.toLocaleString()}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={b.status === "registered" ? "default" : "secondary"}>
                            {b.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">{b.downloaded_by_email ?? "—"}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRedownload(b.id, b.batch_time)}
                              disabled={redownloadingId === b.id}
                            >
                              {redownloadingId === b.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                            </Button>
                            {b.status === "submitted" && (
                              <Button
                                size="sm"
                                onClick={() => handleMarkRegistered(b.id)}
                                disabled={markingId === b.id}
                              >
                                {markingId === b.id ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4 mr-1" />
                                )}
                                Mark registered
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 2: Add the sidebar link**

In `components/layout/sidebar.tsx`, directly AFTER the `/admin/phone-verification` `</Link>` block (ends line ~822), insert (uses the already-imported `Smartphone` icon — do NOT add imports):

```tsx
              <Link href="/admin/mtn-registration" onClick={() => handleNavigation("/admin/mtn-registration")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/mtn-registration" ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" : "text-primary hover:bg-card/10")
                      : (pathname === "/admin/mtn-registration" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/mtn-registration" && "opacity-70"
                  )}
                  title={!isOpen ? "MTN Registration" : undefined}
                  disabled={loadingPath === "/admin/mtn-registration"}
                >
                  {loadingPath === "/admin/mtn-registration" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Smartphone className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "MTN Registration"}
                </Button>
              </Link>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: zero errors. (Also confirm `components/ui/card` exports `Card, CardContent, CardHeader, CardTitle` and `components/ui/badge` exports `Badge` — both are standard shadcn files present in this repo; if an import differs, match the actual export.)

- [ ] **Step 4: Commit**

```bash
git add app/admin/mtn-registration/page.tsx components/layout/sidebar.tsx
git commit -m "feat(admin): MTN registration page + sidebar link"
```

---

## Task 6: Full verification + memory update

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:run`
Expected: all pass (267 pre-existing + 5 new = 272).

- [ ] **Step 2: Final type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Operator smoke test (needs deployed/dev app)**

As an admin: open `/admin/mtn-registration` → counts show (pending = seeded count) → click "Download new numbers" → file downloads with all pending numbers, counts flip to submitted → click again → "No new numbers" toast, NO new batch row → "Mark registered" on the batch → registered count rises → re-download icon returns the same file.

- [ ] **Step 4: Update project memory**

Per `feedback-memory-hygiene`, update the memory file `project-order-phone-export.md`'s neighbor: create/extend a memory for the MTN registration pipeline (tables, trigger, RPC, routes, page, seeding counts, Phase 2 pending) and add a `MEMORY.md` pointer line.

---

## Self-review notes (author)

- **Spec coverage:** registry+batches tables (Task 1 §1-2) ↔ spec data model; `gh_is_mtn` (Task 1 §3) ↔ helper; capture trigger ×5 (Task 1 §4) ↔ capture; claim RPC (Task 1 §5) ↔ delta export + race-safety (refinement noted in header); seed 6a-6c (Task 1 §6) ↔ all seed sources incl. OTP; export/list/mark-registered/batch-download routes (Tasks 3-4) ↔ spec routes 1-4 incl. `X-New-Count` both branches, empty→no batch (RPC returns null batch), audit logs; page + sidebar (Task 5) ↔ spec page; tests: pure helpers TDD (Task 2), SQL truth-table/trigger/delta smoke (Task 1 §5-7), delta correctness (Task 1 §7 second-claim-zero + Task 6 §3 operator check).
- **Type consistency:** `parseClaimResult`/`buildMtnRegistrationRows` names match across Tasks 2-4; RPC param names `p_admin_id`/`p_admin_email` match route call; jsonb keys `batch_id`/`count`/`phones` match parser; batch columns in list/mark/download routes match Task 1 DDL.
- **Prod safety:** trigger smoke + delta test run inside `BEGIN…ROLLBACK` and assert via `DO` blocks (failure → HTTP error), leaving live data untouched; the first real claim is left to the admin.
```
