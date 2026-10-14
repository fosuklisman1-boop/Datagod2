# USSD Shop Free Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove USSD/WhatsApp shop session tokens everywhere, and make shops open by default while the admin-set activation fee is GHS 0 (shops already open are grandfathered when a fee is set later).

**Architecture:** Every channel's entry check becomes `status === 'active'` (plus `whatsappActivated` on WhatsApp), and every token deduction is deleted. A new `BEFORE INSERT` trigger on `ussd_shop_codes` writes new codes as active and fee-waived while the fee is 0. A one-off backfill opens existing unpaid codes. Grandfathering needs no code, because the status is written once and never re-derived from the fee.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase Postgres (plpgsql), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-ussd-shop-free-sessions-design.md`

## Global Constraints

- Hubtel routing is unchanged: the admin keeps the main/shop mode toggle on `/admin/ussd-hubtel`. No direct dial and no "Visit a shop" item.
- Leftover `token_balance` values are ignored: no refunds and no money movement.
- The DB objects `token_balance`, `ussd_shop_token_purchases`, `deduct_ussd_shop_token()`, `increment_ussd_token_balance()` and `hubtel_shop_billing_claims` stay. Nothing new may read or write `token_balance`.
- `ResolvedShopCode.tokenBalance` stays in the type, unread.
- The Paystack webhook branches that credit Paystack-paid `ussd_shop_token_purchases` (around `route.ts:199-260` and `:1050-1110`) stay as they are, so a payment already in flight still settles.
- Suspended codes stay closed on every channel. The admin suspend/unsuspend is unchanged.
- Fee reads in SQL use `COALESCE(fee, 0)`. A missing settings row means fee 0, which means open.
- Edit files with the Edit/Write tools only, never with sed or other shell edits (memory: feedback-no-sed-for-code-edits).
- Navy `#1b388b` / `--primary` accent and the `lg:` desktop layout rules apply to edited UI.
- Migration number: **0121** (0120 is the latest on main). Before applying, check that `migrations/0121_*` doesn't already exist. If it does, use the next free number.
- Run a real `next build` with placeholder env before pushing main (memory: feedback-run-next-build-before-pushing-main).

## Review Focus

1. **A WhatsApp session started before the deploy and confirmed after it.** The customer's order must go through at CONFIRM with no "no sessions left" reply, even at `token_balance = 0`. *Pinned in Task 4: the CONFIRM test at balance 0 expects the order to be created.*
2. **A Hubtel shop customer whose reply was lost re-sends the code.** They must see the product menu again, not an error (the billing guard used to make this work). *Pinned in Task 2: the "same code re-sent" test.*
3. **The admin later sets a fee above 0.** Codes opened earlier must stay `active`, and only new inserts start `inactive`. *Pinned in Task 1: the verification SQL checks both.*
4. **A WhatsApp-free / USSD-paid config** (WhatsApp fee 0, USSD fee > 0). A new code gets `whatsapp_activated = true` but `status = 'inactive'`, and every channel still refuses it until the USSD fee is paid. *Pinned in Task 1 verification SQL (case C) and Task 4's suspended/inactive test.*
5. **Storefront card / dashboard for a shop at balance 0.** The shop must show as Active, with no "No Sessions" / "Depleted" text. *Pinned in Task 6: a grep check and a visual check; Task 7 changes the storefront API.*

---

### Task 1: Migration 0121, free activation trigger and backfill

**Files:**
- Create: `migrations/0121_ussd_shop_free_activation.sql`
- Create: `migrations/0121_verify.sql` (rollback-only verification, never applied)

**Interfaces:**
- Consumes: the `app_settings` singleton row (`key IS NULL`) with columns `ussd_shop_activation_fee`, `whatsapp_shop_activation_fee`, and the `ussd_shop_codes` columns `status`, `activation_fee_paid`, `activation_paid_at`, `whatsapp_activated`, `whatsapp_activated_at`.
- Produces: the columns `ussd_shop_codes.activation_fee_waived`, `ussd_shop_codes.whatsapp_activation_waived` (boolean, default false), the function `ussd_shop_code_apply_free_activation()`, and the trigger `trigger_ussd_shop_code_free_activation`.

- [ ] **Step 1: Write the migration**

```sql
-- 0121_ussd_shop_free_activation.sql
-- USSD/WhatsApp shop session tokens are retired (spec 2026-10-14-ussd-shop-free-sessions-design.md).
-- A shop is open when its code is status='active'. While the admin's activation fee is 0, every
-- new code is written open (fee waived). Raising the fee later only affects codes inserted after
-- that: already-open codes keep status='active' (grandfathered), because status is written once.
-- BEFORE INSERT on ussd_shop_codes covers every insert path: auto_assign_ussd_shop_code(), the
-- admin "New Shop Code" route and the dealer activate route's fallback insert.

ALTER TABLE ussd_shop_codes
  ADD COLUMN IF NOT EXISTS activation_fee_waived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_activation_waived boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION ussd_shop_code_apply_free_activation()
RETURNS TRIGGER AS $$
DECLARE
  v_ussd_fee numeric := 0;
  v_wa_fee   numeric := 0;
BEGIN
  SELECT COALESCE(ussd_shop_activation_fee, 0), COALESCE(whatsapp_shop_activation_fee, 0)
    INTO v_ussd_fee, v_wa_fee
    FROM app_settings
   WHERE key IS NULL
   LIMIT 1;
  -- No settings row: SELECT INTO leaves NULLs, so treat as fee 0 (open), as the app's `?? 0` reads do.
  v_ussd_fee := COALESCE(v_ussd_fee, 0);
  v_wa_fee   := COALESCE(v_wa_fee, 0);

  IF v_ussd_fee = 0 AND NEW.status = 'inactive' AND COALESCE(NEW.activation_fee_paid, false) = false THEN
    NEW.status                := 'active';
    NEW.activation_fee_paid   := true;
    NEW.activation_paid_at    := now();
    NEW.activation_fee_waived := true;
  END IF;

  IF v_wa_fee = 0 AND COALESCE(NEW.whatsapp_activated, false) = false AND NEW.status <> 'suspended' THEN
    NEW.whatsapp_activated         := true;
    NEW.whatsapp_activated_at      := now();
    NEW.whatsapp_activation_waived := true;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trigger_ussd_shop_code_free_activation ON ussd_shop_codes;
CREATE TRIGGER trigger_ussd_shop_code_free_activation
  BEFORE INSERT ON ussd_shop_codes
  FOR EACH ROW
  EXECUTE FUNCTION ussd_shop_code_apply_free_activation();

-- One-off backfill: open existing unpaid codes when the matching fee is 0. Suspended codes are untouched.
DO $$
DECLARE
  v_ussd_fee numeric := 0;
  v_wa_fee   numeric := 0;
BEGIN
  SELECT COALESCE(ussd_shop_activation_fee, 0), COALESCE(whatsapp_shop_activation_fee, 0)
    INTO v_ussd_fee, v_wa_fee
    FROM app_settings WHERE key IS NULL LIMIT 1;
  v_ussd_fee := COALESCE(v_ussd_fee, 0);
  v_wa_fee   := COALESCE(v_wa_fee, 0);

  IF v_ussd_fee = 0 THEN
    UPDATE ussd_shop_codes
       SET status = 'active', activation_fee_paid = true, activation_paid_at = now(),
           activation_fee_waived = true, updated_at = now()
     WHERE status = 'inactive' AND activation_fee_paid = false;
  END IF;

  IF v_wa_fee = 0 THEN
    UPDATE ussd_shop_codes
       SET whatsapp_activated = true, whatsapp_activated_at = now(),
           whatsapp_activation_waived = true, updated_at = now()
     WHERE COALESCE(whatsapp_activated, false) = false AND status <> 'suspended';
  END IF;
END $$;
```

- [ ] **Step 2: Write the rollback-only verification script**

`migrations/0121_verify.sql` runs the migration body inside a transaction, checks the four cases, and rolls everything back. Steps 1–4 below assume the migration's statements are pasted between `BEGIN;` and the checks. To avoid duplicating them, the script starts with the sentence `-- Paste the full body of 0121_ussd_shop_free_activation.sql here before running.` followed by:

```sql
BEGIN;
-- (paste 0121 body here)

-- Case A: fee 0 -> new code is open + waived on both channels
UPDATE app_settings SET ussd_shop_activation_fee = 0, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999901' FROM user_shops LIMIT 1;
SELECT 'A' AS case_, status, activation_fee_paid, activation_fee_waived, whatsapp_activated, whatsapp_activation_waived
  FROM ussd_shop_codes WHERE code = '99999901';
-- expect: active, true, true, true, true
DELETE FROM ussd_shop_codes WHERE code = '99999901';

-- Case B: fee > 0 -> new code is inactive, earlier open codes unchanged (grandfathered)
UPDATE app_settings SET ussd_shop_activation_fee = 20, whatsapp_shop_activation_fee = 20 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999902' FROM user_shops LIMIT 1;
SELECT 'B' AS case_, status, activation_fee_paid, activation_fee_waived, whatsapp_activated
  FROM ussd_shop_codes WHERE code = '99999902';
-- expect: inactive, false, false, false
SELECT 'B-grandfathered' AS case_, count(*) FILTER (WHERE status <> 'active') AS not_active
  FROM ussd_shop_codes WHERE activation_fee_waived = true;
-- expect: not_active = 0
DELETE FROM ussd_shop_codes WHERE code = '99999902';

-- Case C: WhatsApp fee 0, USSD fee > 0 -> WhatsApp waived but code stays inactive
UPDATE app_settings SET ussd_shop_activation_fee = 20, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code) SELECT id, '99999903' FROM user_shops LIMIT 1;
SELECT 'C' AS case_, status, whatsapp_activated FROM ussd_shop_codes WHERE code = '99999903';
-- expect: inactive, true

-- Case D: an insert as 'suspended' is never opened
UPDATE app_settings SET ussd_shop_activation_fee = 0, whatsapp_shop_activation_fee = 0 WHERE key IS NULL;
INSERT INTO ussd_shop_codes (shop_id, code, status) SELECT id, '99999904', 'suspended' FROM user_shops LIMIT 1;
SELECT 'D' AS case_, status, activation_fee_paid, whatsapp_activated FROM ussd_shop_codes WHERE code = '99999904';
-- expect: suspended, false, false

-- Backfill effect
SELECT 'backfill' AS case_, status, count(*) FROM ussd_shop_codes GROUP BY status;

ROLLBACK;
```

Note: `ussd_shop_codes.shop_id` is unique per shop only by convention (the auto-assign trigger is idempotent per shop), not by a constraint, so inserting a second code for an existing shop is allowed inside the rolled-back transaction. If the insert fails with a unique violation on `shop_id`, replace `SELECT id ... LIMIT 1` with a shop that has no code: `SELECT id FROM user_shops WHERE id NOT IN (SELECT shop_id FROM ussd_shop_codes) LIMIT 1`. If no such shop exists, run cases A–D on a non-prod database instead.

- [ ] **Step 3: Pre-check counts (read-only)**

Run against prod via the Supabase Management API SQL endpoint (pattern in memory `reference-supabase-access`):

```sql
SELECT
  (SELECT COALESCE(ussd_shop_activation_fee,0) FROM app_settings WHERE key IS NULL) AS ussd_fee,
  (SELECT COALESCE(whatsapp_shop_activation_fee,0) FROM app_settings WHERE key IS NULL) AS wa_fee,
  count(*) FILTER (WHERE status='inactive' AND activation_fee_paid=false) AS ussd_to_open,
  count(*) FILTER (WHERE COALESCE(whatsapp_activated,false)=false AND status<>'suspended') AS wa_to_open,
  count(*) FILTER (WHERE status='suspended') AS suspended_untouched
FROM ussd_shop_codes;
```

Record the numbers in the task report. **Do not apply** the migration in this task: applying happens in Task 8 after the user sees these numbers.

- [ ] **Step 4: Run the verification script**

Only after the user approves running it against prod (it's fully rolled back): paste the 0121 body into `0121_verify.sql` locally (don't commit the pasted copy), POST it to the Management API, and check that each `-- expect:` line matches. On any mismatch, fix `0121_ussd_shop_free_activation.sql` and re-run. If the user declines, run it on a non-prod database.

- [ ] **Step 5: Commit**

```bash
git add migrations/0121_ussd_shop_free_activation.sql migrations/0121_verify.sql
git commit -m "feat(ussd-shop): migration 0121 free activation trigger + backfill"
```

---

### Task 2: Hubtel shop mode, remove token billing

**Files:**
- Modify: `lib/ussd-hubtel/flows/shop.ts` (header comment lines 1-5, imports 11-12, constants 22-25, `recoverShopCodeEntry` doc 68-74, `enterCode` 88-156)
- Modify: `lib/ussd-hubtel/shop-services.ts` (header 1-5, lines 18-19, interface 30-39, `notifyLowTokens` 78-93, `defaultShopServices` 108-116)
- Modify: `lib/ussd-hubtel/flow-kit.ts` (import line 12, `shopBilling` field line 34)
- Modify: `lib/ussd-hubtel/router.ts` (import line 9, `shopBilling` line 45)
- Modify: `lib/ussd-hubtel/testing/fakes.ts` (import line 7, `shopBilling` line 92, `deductToken`/`notifyLowTokens` lines 147-148, delete `fakeShopBilling` lines 159-175, comment on `SHOP_CODE`)
- Delete: `lib/ussd-hubtel/billing-guard.ts`, `lib/ussd-hubtel/billing-guard.test.ts`
- Test: `lib/ussd-hubtel/flows/shop.test.ts`, `lib/ussd-hubtel/flows/shop-airtime.test.ts`, `lib/ussd-hubtel/flows/shop-data.test.ts`, `lib/ussd-hubtel/flows/shop-rc.test.ts`, `lib/ussd-hubtel/router.test.ts`, `lib/ussd-hubtel/shop-services.test.ts`

**Interfaces:**
- Consumes: `ResolvedShopCode` from `lib/shop-commerce/shop-code.ts` (unchanged; `tokenBalance` is ignored).
- Produces: `ShopServices` **without** `deductToken` and `notifyLowTokens`. `RouterDeps` **without** `shopBilling`. `LOW_TOKEN_ALERT_AT` and `notifyLowTokens` are no longer exported.

- [ ] **Step 1: Write the failing tests**

In `lib/ussd-hubtel/flows/shop.test.ts`, change the import on line 4 to:

```ts
import { fakeShop, makeDeps, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"
```

Delete the constants `UNAVAILABLE_RETRY` and `NO_SESSIONS_RETRY` (lines 7-8) and add:

```ts
const INVALID_RETRY = "Invalid code. Try again.\nEnter shop code:\n0. Exit"
```

Replace the whole `describe("shop mode: token billing per Hubtel session (review focus #1)", ...)` block (starts line 297, ends just before `describe("shop mode: product menu"`) with:

```ts
describe("shop mode: no session billing (spec 2026-10-14)", () => {
  it("a shop at token balance 0 is accepted: product menu, shop stored", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: 0 }) }) })
    const r = await enterShop(deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopCodeId: "code-1", shopId: "shop-1" })
  })
  it("a negative / NaN balance is ignored too", async () => {
    for (const tokenBalance of [-3, Number.NaN]) {
      const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance }) }) })
      expect((await enterShop(deps)).Message, `balance ${tokenBalance}`).toBe(PRODUCT_MENU)
    }
  })
  it("the same code re-sent after acceptance (lost reply): product menu again", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await enterShop(deps)
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
  })
  it("two concurrent deliveries of the code: both see the product menu", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const [a, b] = await Promise.all([hubtelRouter(req({ Message: "1234" }), deps), hubtelRouter(req({ Message: "1234" }), deps)])
    expect(a.Message).toBe(PRODUCT_MENU)
    expect(b.Message).toBe(PRODUCT_MENU)
  })
  it("inactive and suspended codes are still refused as wrong codes", async () => {
    for (const status of ["inactive", "suspended"]) {
      const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, status, tokenBalance: 99 }) }) })
      const r = await enterShop(deps)
      expect(r.Message, status).toBe(INVALID_RETRY)
      expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
    }
  })
})
```

- [ ] **Step 2: Remove the billing-only tests and assertions**

In `lib/ussd-hubtel/flows/shop.test.ts`, delete these `it` blocks completely (by title):
- `"zero tokens before the RPC: 'no sessions left', no deduction, marker released (a top-up then works in the same session)"`
- `"negative / NaN balance is treated as no tokens (fail closed)"` (this is the `it.each`-style loop over `tokenBalance` near line 153)
- `"claimed + RPC false (balance hit 0 concurrently): 'no sessions left', marker released, a retry may deduct"`
- `"claimed + RPC THROWS: generic 'Shop unavailable', marker KEPT, a retry is accepted without a second deduction"`
- `"marker 'already' held (this session paid for this code): accepted WITHOUT deducting, no low-session push"`
- `"billing marker store error: 'Shop unavailable' and NO deduction"`
- `"low-session push only when the deduction leaves exactly 10"`
- `"'no sessions left' / 'unavailable' are not wrong codes: they do not count"`

In the remaining tests of this file, plus `flows/shop-airtime.test.ts`, `flows/shop-data.test.ts`, `flows/shop-rc.test.ts` and `router.test.ts`:
- delete every `const deductToken = vi.fn(...)` line and every `expect(deductToken)...` line
- delete every `const billing = fakeShopBilling()`, `const claim = vi.spyOn(billing, "claim")`, `expect(claim)...` and `expect(billing.claimed)...` line
- remove `deductToken` / `notifyLowTokens` keys from `fakeShop({...})` arguments (`fakeShop({ deductToken })` becomes `fakeShop()`, `fakeShop({ resolveCode, deductToken })` becomes `fakeShop({ resolveCode })`)
- remove `shopBilling: ...` keys from `makeDeps({...})` arguments
- delete the shop-airtime test `"no shop token is deducted at confirm (billed once, at the code step)"` and the shop-rc test `"no token is billed after the code step (one deduction for the whole purchase)"`. Both only assert deduction counts.
- rename test titles that mention billing:
  - `"valid code (claimed + deducted): ONE token, product menu, shop stored with sorted networks, marker kept"` becomes `"valid code: product menu, shop stored with sorted networks"`
  - `` `${name}: "Invalid code", no claim, no deduction, stays on the code step` `` becomes `` `${name}: "Invalid code", stays on the code step` ``
  - `"two wrong codes then the right one: accepted and billed once"` becomes `"two wrong codes then the right one: accepted"`
  - describe `"shop mode: networks() failing after the deduction (final wave M4)"` becomes `"shop mode: networks() failing after code acceptance (final wave M4)"`, and its `it` `"logs ids only and still shows the product menu (empty network list); the token stays spent once"` becomes `"logs ids only and still shows the product menu (empty network list)"`
  - `"an unknown pick re-shows the menu without billing again"` becomes `"an unknown pick re-shows the menu"`
  - `"a redelivered code after the loss never pays twice in the same Hubtel session"` becomes `"a redelivered code after the loss shows the product menu"`
  - router.test `"kill switch releases an in-flight shop session and bills nothing more (review focus #8)"` becomes `"kill switch releases an in-flight shop session (review focus #8)"`
  - shop.test `"every shop service hidden for this caller: released before any code (no token can be spent)"` becomes `"every shop service hidden for this caller: released before any code"`
- delete the tests `"session lost after acceptance (Redis miss), ENTER_SHOP_CODE restarted, same code: no second deduction even at balance 0"`, `"two different shops' codes in one session: each billed exactly once, re-entry of either bills nothing more"` and `"separate Hubtel sessions are billed separately"` if they still exist outside the replaced describe block.

In `lib/ussd-hubtel/shop-services.test.ts`, delete the `describe("deductToken (deduct_ussd_shop_token)", ...)` and `describe("notifyLowTokens", ...)` blocks, and remove `notifyLowTokens` from the import on line 16.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/ussd-hubtel`
Expected: FAIL. The new "balance 0 accepted" test gets `"Shop has no sessions left..."` instead of the product menu, and/or there are type errors, because fakes still reference `deductToken`.

- [ ] **Step 4: Implement**

`lib/ussd-hubtel/flows/shop.ts`: replace lines 1-5 with:

```ts
// lib/ussd-hubtel/flows/shop.ts
// Shop mode entry (spec 5 "Shop mode"): shop code first, then the shop's product menu. Port of
// lib/ussd-shop/handlers/shop.ts. Entering a shop is free: session tokens were retired
// (docs/superpowers/specs/2026-10-14-ussd-shop-free-sessions-design.md), so an active code is all it takes.
```

Delete lines 11-12 (`LOW_TOKEN_ALERT_AT` and `BillingClaim` imports) and the constants `UNAVAILABLE` and `NO_SESSIONS` (lines 23-24). Replace the `recoverShopCodeEntry` doc sentence `"Billing stays guarded per (SessionId, code)."` with nothing (delete that sentence). Replace `enterCode` (lines 88-156) with:

```ts
async function enterCode(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps } = ctx
  if (input === "0") return finish(ctx, "Goodbye.")
  // A wrong / malformed / inactive code counts toward the per-session cap (no guessing codes in one session).
  const wrongCode = async (): Promise<HubtelReply> => {
    const attempts = (ctx.session.shopCodeAttempts ?? 0) + 1
    if (attempts >= MAX_CODE_ATTEMPTS) return finish(ctx, TOO_MANY)
    return goto(ctx, { step: "SHOP_ENTER_CODE", shopCodeAttempts: attempts }, shopCodeRetryText(INVALID), CODE)
  }
  if (!SHOP_CODE_RE.test(input)) return wrongCode()

  const shop = await deps.shop.resolveCode(input)
  if (!shop || shop.status !== "active") return wrongCode()

  // A shop may sell only airtime / vouchers: an empty network list does not block entry (Uzo).
  // A lookup failure must not fail the request: continue with no networks (the data flow then
  // says there is nothing to buy) and log ids only.
  const rawNetworks = await deps.shop.networks(shop.shopId, shop.parentShopId ?? undefined).catch((e: unknown) => {
    console.error("[HUBTEL-SHOP] networks lookup failed after code acceptance for shop", shop.shopId, safeDbError(e))
    return [] as string[]
  })
  const networks = sortShopNetworks(rawNetworks)
  return goto(ctx, {
    step: "SHOP_PRODUCT",
    shopCodeAttempts: undefined,
    shopCodeId: shop.shopCodeId,
    shopId: shop.shopId,
    parentShopId: shop.parentShopId ?? undefined,
    shopName: shop.shopName,
    shopNetworks: networks,
  }, shopMenuText(shop.shopName, shopMenuFor(ctx.config, ctx.session.dataBlocked === true)), PRODUCT)
}
```

Also change the `startShopSession` comment `// Checked BEFORE the code is asked (D4), so no shop token is ever spent on an empty menu.` to `// Checked BEFORE the code is asked (D4), so the caller is never asked for a code with nothing to buy.`

`lib/ussd-hubtel/shop-services.ts`:
- header line 5 becomes: `// shop bot. The Uzo-private shop airtime fee rate (lib/ussd-shop/handlers/airtime.ts) is ported here with identical money logic.` (lines 4-5 replaced by that one sentence, continuing from line 3)
- delete lines 18-19 (`LOW_TOKEN_ALERT_AT` + its comment)
- delete from the `ShopServices` interface the `deductToken` doc+member (lines 30-37) and the `notifyLowTokens` doc+member (lines 38-39)
- delete the `notifyLowTokens` function (lines 78-93)
- in `defaultShopServices`, delete the `deductToken: ...` property (lines 108-115) and the `notifyLowTokens: ...` line (116)
- if `safeDbError` is now unused in this file, remove its import (line 14)

`lib/ussd-hubtel/flow-kit.ts`: delete line 12 (`import type { ShopBillingGuard } from "./billing-guard"`) and line 34 (`shopBilling: ShopBillingGuard`).

`lib/ussd-hubtel/router.ts`: delete line 9 (`import { dbShopBillingGuard } from "./billing-guard"`) and line 45 (`shopBilling: dbShopBillingGuard(supabase),`).

`lib/ussd-hubtel/testing/fakes.ts`: delete line 7 (the `billing-guard` import), line 92 (`shopBilling: fakeShopBilling(),`), lines 147-148 (`deductToken`, `notifyLowTokens`) and the whole `fakeShopBilling` function with its doc comment (from `/**\n * Same SET NX semantics` to its closing `}`). Change the `SHOP_CODE` comment to `/** An active shop code owned by a regular (non-sub-agent) shop. tokenBalance is unused since 2026-10-14. */`.

Delete `lib/ussd-hubtel/billing-guard.ts` and `lib/ussd-hubtel/billing-guard.test.ts` (`git rm`).

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run lib/ussd-hubtel && npx tsc --noEmit`
Expected: PASS, with 0 type errors.
Then run: `git grep -n -E "deductToken|shopBilling|fakeShopBilling|billing-guard|notifyLowTokens|LOW_TOKEN_ALERT_AT|no sessions" -- lib/ussd-hubtel`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A lib/ussd-hubtel
git commit -m "feat(hubtel-ussd): shop mode entry no longer bills session tokens"
```

---

### Task 3: Uzo shop entry, remove token gate and deduction

**Files:**
- Modify: `lib/ussd-shop/handlers/shop.ts:33-71`

**Interfaces:**
- Consumes: `resolveShopCode()` (unchanged).
- Produces: nothing new. `handleEnterShopCode` keeps its signature.

This handler has no test harness: it uses a module-level Supabase client and the Uzo Redis session. It's verified by typecheck, the grep below, and the live check in Task 8.

- [ ] **Step 1: Implement**

Delete lines 33-36 (the `if (resolved.tokenBalance <= 0) { ... 'Shop has no sessions left.' ... }` block).

Delete the token deduction block (the comment `// Atomically deduct one token` through the closing `}` of `if (deductError || !deducted) { ... }`).

Delete the owner lookup and low-session push. That's everything from the comment `// resolveShopCode() doesn't fetch user_shops.user_id` through the closing `}` of `if (remainingTokens === 10 && shopOwnerId) { ... }`, i.e. the `shopOwnerRow` query, `shopOwnerId`, `remainingTokens` and the `sendPushToUser` call.

Keep `const shopName = resolved.shopName` and `const parentShopId ... = resolved.parentShopId`.

If `sendPushToUser` is no longer used anywhere in the file, remove its import. Check with `git grep -n sendPushToUser -- lib/ussd-shop/handlers/shop.ts`.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: 0 errors.
Run: `git grep -n -E "tokenBalance|deduct_ussd_shop_token|sessions" -- lib/ussd-shop/handlers/shop.ts`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/ussd-shop/handlers/shop.ts
git commit -m "feat(ussd-shop): Uzo shop code entry is free (no session tokens)"
```

---

### Task 4: WhatsApp shop bot, remove token gates

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts` (helper 183-197, remembered-shop check 320-326, ENTER_CODE branch 374-376, CONFIRM re-checks ~710-720, ~959-967, ~1164-1172, ~1477-1484)
- Modify: `lib/ai-tools.ts:1525-1527` (`resolve_shop_code`)
- Modify: `lib/shop-commerce/shop-code.ts:26` (doc comment only)
- Test: `lib/whatsapp-bot/shop-router.test.ts`, `lib/ai-tools.test.ts`

**Interfaces:**
- Consumes: `ResolvedShopCode` (unchanged).
- Produces: `fetchShopCodeTokenBalance` is deleted. No exported API changes.

- [ ] **Step 1: Write the failing tests**

In `lib/whatsapp-bot/shop-router.test.ts`, replace the test `"rejects a shop code with no sessions left (tokenBalance <= 0)"` with:

```ts
  it("accepts a shop code at token balance 0 (sessions retired 2026-10-14)", async () => {
    const phone = "233241000012"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc2", shopId: "s2", shopName: "Zero Shop", parentShopId: null,
      status: "active", tokenBalance: 0, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE999", "wamid.IN1")

    expect(lastReplyTo(phone)).toContain("What to buy?")
    expect(lastReplyTo(phone)).not.toContain("no sessions")
  })
```

Replace the test `"CONFIRM: a token balance that hit zero since ENTER_CODE rejects and doesn't charge or create an order"` with:

```ts
  it("CONFIRM: a token balance of zero no longer blocks the charge (sessions retired)", async () => {
    const phone = "233241000060"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc40", shopId: "s40", shopName: "Zero Shop", parentShopId: null,
      status: "active", tokenBalance: 0, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p10", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order9" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order9" })
    fakeDb.tokenBalance = 0

    await shopWaRouter(phone, "CODE1", "f1")
    await shopWaRouter(phone, "1", "f2")
    await shopWaRouter(phone, "1", "f3")
    await shopWaRouter(phone, "1", "f4")
    await shopWaRouter(phone, "0244111222", "f5")
    await shopWaRouter(phone, "0244333444", "f6")
    await shopWaRouter(phone, "1", "f7")

    expect(createShopBundleOrder).toHaveBeenCalled()
    expect(chargeMobileMoney).toHaveBeenCalled()
    expect(lastReplyTo(phone)).not.toContain("no sessions")
  })
```

Delete the test `"CONFIRM: a healthy token balance (>0) does not block the charge"` (it's now covered by the test above).

Add a test that inactive codes are still refused, next to the zero-balance test:

```ts
  it("still refuses a suspended shop code", async () => {
    const phone = "233241000013"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc3", shopId: "s3", shopName: "Paused Shop", parentShopId: null,
      status: "suspended", tokenBalance: 50, whatsappActivated: true,
    })

    await shopWaRouter(phone, "CODE998", "wamid.IN2")

    expect(lastReplyTo(phone)).toContain("currently unavailable")
  })
```

In `lib/ai-tools.test.ts`, inside `describe("executeToolCall resolve_shop_code", ...)` (it defines `baseCtx`), add:

```ts
  it("resolves a shop at token balance 0 (sessions retired)", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-9", shopId: "shop-9", shopName: "Zero Shop",
      parentShopId: null, status: "active", tokenBalance: 0, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    const result = await executeToolCall("resolve_shop_code", { code: "AB12CD" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(true)
    expect(setShopPref).toHaveBeenCalledWith("233559919037", "code-9")
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts lib/ai-tools.test.ts`
Expected: FAIL. The zero-balance tests get "no sessions left".

- [ ] **Step 3: Implement**

`lib/whatsapp-bot/shop-router.ts`:
- Delete the `fetchShopCodeTokenBalance` function and its comment block (lines 183-197).
- Line 326: `remembered.status === 'active' && remembered.whatsappActivated && remembered.tokenBalance > 0` becomes `remembered.status === 'active' && remembered.whatsappActivated`. In the comment above it (lines 320-325), change `"deactivated WhatsApp, or run out of sessions"` to `"or deactivated WhatsApp"`.
- Delete the branch `} else if (resolved.tokenBalance <= 0) {` with its two body lines (374-376).
- Delete each of the four CONFIRM re-check blocks. Each consists of a comment (`// Re-check the shop's token balance ...` or `// Same anti-race token recheck ...`) followed by `const tokenBalance = await fetchShopCodeTokenBalance(session.shopCodeId!)` and the `if (tokenBalance === null || tokenBalance <= 0) { ... break }` block.
- Run `git grep -n -E "tokenBalance|fetchShopCodeTokenBalance|no sessions" -- lib/whatsapp-bot/shop-router.ts`. Expected: no output.

`lib/ai-tools.ts`: delete lines 1525-1527 (the `if (resolved.tokenBalance <= 0) { return { resolved: false, message: "That shop has no sessions left ..." } }` block).

`lib/shop-commerce/shop-code.ts` line 26: change `tokenBalance: number` to:

```ts
  /** Legacy session-token balance. Unused for gating since 2026-10-14 (sessions retired). */
  tokenBalance: number
```

In `lib/whatsapp-bot/shop-router.test.ts`, if `fakeDb.tokenBalance` is now read nowhere in the router (the mock's `token_balance` select branch is unreachable), leave the fake as is. It's harmless, and removing it risks breaking the shared chain mock.

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/whatsapp-bot lib/ai-tools.test.ts lib/shop-commerce && npx tsc --noEmit`
Expected: PASS, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp-bot/shop-router.ts lib/whatsapp-bot/shop-router.test.ts lib/ai-tools.ts lib/ai-tools.test.ts lib/shop-commerce/shop-code.ts
git commit -m "feat(whatsapp-shop): no session-token gate at code entry or CONFIRM"
```

---

### Task 5: Paystack webhook, remove the four WhatsApp per-order deductions

**Files:**
- Modify: `app/api/webhooks/paystack/route.ts` (blocks at ~634-656, ~700-716, ~782-799, ~879-889)
- Delete: `lib/shop-commerce/token-deduction.ts`, `lib/shop-commerce/token-deduction.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `deductTokenIfWhatsappShopOrder` no longer exists.

- [ ] **Step 1: Implement**

In `app/api/webhooks/paystack/route.ts`, delete each block in full:
1. The comment starting `// WhatsApp shop bot bills 1 session token per completed order — USSD` through the end of `if (ussdShopOrder.channel === 'whatsapp_shop') { try { ... } catch (deductErr) { ... } }` (data order).
2. The comment starting `// WhatsApp shop bot bills 1 session token per completed order — USSD` through the end of `if (airtimeMarkResult.success && !airtimeMarkResult.alreadyProcessed && ussdAirtimeOrder.channel === 'whatsapp_shop') { ... }` (airtime). Keep the `const airtimeMarkResult = await markAirtimeOrderPaid(...)` line, since it still has a side effect. If `airtimeMarkResult` becomes unused, change it to `await markAirtimeOrderPaid(ussdAirtimeOrder.id, event.data.id)`.
3. The comment starting `// WhatsApp shop bot bills 1 session token per completed order — USSD` through the end of `if (rcResult.newlyPaid && ussdRcOrder.channel === 'whatsapp_shop') { ... }` (RC). Keep `rcResult` if it's used elsewhere. If it's unused, keep the call but drop the binding.
4. The comment `// WhatsApp shop bot bills 1 session token per completed order, same as` through the end of `if (checkReq.channel === "whatsapp_shop") { ... }` (results-check request).

Then run `git rm lib/shop-commerce/token-deduction.ts lib/shop-commerce/token-deduction.test.ts`.

- [ ] **Step 2: Verify**

Run: `git grep -n -E "deductTokenIfWhatsappShopOrder|token-deduction|session token" -- app lib`
Expected: no output.
Run: `npx tsc --noEmit && npx vitest run app/api/webhooks lib/shop-commerce`
Expected: 0 type errors. Tests pass (or "no test files" for the webhook folder).

- [ ] **Step 3: Commit**

```bash
git add -A app/api/webhooks/paystack/route.ts lib/shop-commerce
git commit -m "feat(whatsapp-shop): stop deducting a session token per paid order"
```

---

### Task 6: Dealer self-service, remove buying sessions

**Files:**
- Delete: `app/api/dashboard/ussd-shop/buy-sessions/route.ts`
- Modify: `lib/ai-tools.ts` (lines ~610-616 tool schema, ~3042 and ~3066 `get_my_shop`, ~3088-3100 `manage_my_ussd_shop`)
- Modify: `app/api/ai/chat/route.ts:561-563`
- Modify: `app/dashboard/ussd-shop/page.tsx` (state 47-53, load 85 and 106-108, handler 168-192, badge 246-251 and 304, hero 319-330, warning 333-338, Buy Sessions card 368-416)

**Interfaces:**
- Consumes: nothing new.
- Produces: the `manage_my_ussd_shop` tool enum is `["activate"]` only. `get_my_shop` no longer returns `token_balance`.

- [ ] **Step 1: AI tool and prompt**

`lib/ai-tools.ts`:
- Tool description (line ~610): `"Manage the logged-in dealer's own USSD shop code. Use 'activate' to activate it (may deduct an activation fee from wallet)."`
- Line ~614: `action: { type: "string", enum: ["activate"], description: "activate: activate the USSD shop code (show activation fee and confirm first)." },`
- Delete line ~615 (the `sessions` property). If the schema has a `required` array that lists `sessions`, remove it from that array.
- `get_my_shop` select (line ~3042): `.select("code, status, activation_fee_paid")`. Delete `token_balance: ussdRes.data.token_balance,` (line ~3066).
- Delete the whole `if (action === "buy_sessions") { ... }` block (lines ~3088-3098) and change the fallback to `return { error: \`Unknown action: ${action}. Use activate.\` }`.

`app/api/ai/chat/route.ts`:
- Line 561: `- Use get_my_shop to fetch USSD shop details (code, status, activation).`
- Delete line 563 (`- Use manage_my_ussd_shop with action=buy_sessions ...`).
- Insert in its place: `- USSD and WhatsApp shop sessions are free — there is nothing to top up. Never offer to buy sessions.`

Then run `git rm app/api/dashboard/ussd-shop/buy-sessions/route.ts`.

- [ ] **Step 2: Dealer page**

`app/dashboard/ussd-shop/page.tsx`:
- Delete the state lines `sessionPrice`, `minSessions`, `maxSessions`, `sessionQty` and `buyingSessions` (47-49, 52-53).
- Line 85 select: drop `token_balance, `. Delete `token_balance: number` from the `UssdShopCode` interface (line ~20).
- Delete lines 106-108 (`setSessionPrice` / `setMinSessions` / `setMaxSessions`).
- Delete `handleBuySessions` (168-192).
- Replace `statusBadge` (246-251) with:

```tsx
  const statusBadge = (status: string) => {
    if (status === 'suspended') return <Badge className="bg-amber-500/10 text-amber-600 border-border">Suspended</Badge>
    if (status === 'active') return <Badge className="bg-success/15 text-success border-border">Active</Badge>
    return <Badge className="bg-muted text-muted-foreground border-border">Inactive</Badge>
  }
```

- Line 304: `{statusBadge(shopCode.status)}`.
- Replace the hero footer (319-330, the `<div className="mt-4 flex items-center gap-2 border-t ...">` with `Coins` and the "sessions remaining" text) with:

```tsx
                <div className="mt-4 flex items-center gap-2 border-t border-white/20 pt-3 text-sm text-white/90">
                  <CheckCircle className="h-4 w-4" />
                  <span>Unlimited customer sessions, free</span>
                </div>
```

- Delete the depleted warning block (333-338).
- Delete the `{/* Buy Sessions */}` card (368-416).
- Remove `Coins` from the lucide import if it's no longer used. Keep `Wallet`, which the activation button still uses.
- Run `git grep -n -i -E "session|token|Coins|Depleted" -- app/dashboard/ussd-shop/page.tsx`. Expected: only `supabase.auth.getSession` / `session?.access_token` lines remain.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run lib/ai-tools.test.ts`
Expected: 0 type errors, PASS. If an ai-tools test asserted the `buy_sessions` enum, update it to `["activate"]`.

Visual check (memory `reference-headless-screenshots`): run `npm run dev`, open `/dashboard/ussd-shop` signed in as a dealer, and screenshot at 500px and 1280px width. Expect no Buy Sessions card, no sessions count, and an "Active" badge.

- [ ] **Step 4: Commit**

```bash
git add -A app/api/dashboard/ussd-shop app/dashboard/ussd-shop/page.tsx lib/ai-tools.ts app/api/ai/chat/route.ts
git commit -m "feat(ussd-shop): remove buy-sessions from dealer page, API and AI assistant"
```

---

### Task 7: Admin pages, settings API and storefront API

**Files:**
- Delete: `app/api/admin/ussd-shops/[id]/tokens/route.ts`
- Modify: `app/admin/ussd-shops/page.tsx`
- Modify: `app/api/admin/settings/route.ts:66-68, 182-184, 357-359`
- Modify: `app/api/public/config/route.ts:33-35`
- Modify: `app/api/public/shop-ussd-code/route.ts:30, 34`
- Modify: `app/api/admin/ussd-shops/route.ts` (POST `initial_tokens`, lines ~95 and ~115)
- Modify: `app/api/admin/ussd-shops/[id]/activate/route.ts` (`initial_tokens`, lines ~50 and ~60-68)
- Modify: `app/api/admin/ussd-shops/[id]/route.ts:66` (comment)

**Interfaces:**
- Consumes: the waived columns from Task 1 (display only, optional).
- Produces: the public config no longer returns `ussd_shop_session_price`, `ussd_shop_min_sessions` or `ussd_shop_max_sessions`. `GET /api/public/shop-ussd-code` returns `active = status === 'active'`.

- [ ] **Step 1: APIs**

`app/api/public/shop-ussd-code/route.ts`: select `"code, status"`, and change line 34 to:

```ts
    const active = !!shopCode && shopCode.status === "active"
```

Update its header comment `"Only returns the code when it's genuinely usable right now"`. It stays true, because usability is now just `status`.

`app/api/public/config/route.ts`: delete the three `ussd_shop_session_price` / `ussd_shop_min_sessions` / `ussd_shop_max_sessions` entries (33-35).

`app/api/admin/settings/route.ts`: delete the three session keys at 66-68, 182-184 and 357-359. Leave the DB columns alone.

`app/api/admin/ussd-shops/route.ts` POST: `const { shop_id, code } = body`, and the insert becomes `.insert([{ shop_id, code: finalCode }])`. The Task 1 trigger decides active/inactive.

`app/api/admin/ussd-shops/[id]/activate/route.ts`: stop reading `initial_tokens` from the body. Delete `token_balance: initial_tokens,` from the update. In the `ussd_shop_token_purchases` insert, set `tokens_purchased: 0`. That row is the activation audit record and stays.

`app/api/admin/ussd-shops/[id]/route.ts` line 66 comment: `// DELETE /api/admin/ussd-shops/[id] — only if no pending orders`. Drop `token_balance` from the select at line 72 and use `.select("id")`.

Then run `git rm "app/api/admin/ussd-shops/[id]/tokens/route.ts"`.

- [ ] **Step 2: Admin page**

`app/admin/ussd-shops/page.tsx`:
- Remove `token_balance: number` from the `ShopCode` interface (line 25).
- Delete the state `createTokens` (72), the tokens-modal state (75-79), `sessionPrice` / `minSessions` / `maxSessions` (86-88) and `activateTokens` (100). Rename `savingSessionSettings` to `savingFees` (89).
- Delete lines 161-163.
- Rename `handleSaveSessionSettings` to `handleSaveFees`. Its body sends only `ussd_shop_activation_fee` and `whatsapp_shop_activation_fee`. Toasts become `"Activation fees saved"` / `"Failed to save activation fees"`.
- `handleCreate`: drop `initial_tokens` from the body and `setCreateTokens("0")` from the reset.
- Delete `handleAddTokens` (284-299).
- `handleActivate`: body `JSON.stringify({})`.
- Subtitle (384): `"Manage shop codes, activation and orders for the shop-code USSD storefront"`.
- Storefront-card help text (436): `Advertises the dial code + a shop&apos;s own PIN on their web storefront. Only shows for shops with an active USSD code.`
- Replace the `{/* Session Settings */}` block (449-526) with:

```tsx
            {/* Activation Fees */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-primary uppercase tracking-wide">Activation Fees</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:max-w-xl">
                <div className="space-y-1">
                  <Label className="text-xs text-primary">USSD Activation Fee (GHS)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={activationFee}
                    onChange={e => setActivationFee(e.target.value)}
                    className="bg-card border-primary/20"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-primary">WhatsApp Shop Activation Fee (GHS)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={whatsappActivationFee}
                    onChange={e => setWhatsappActivationFee(e.target.value)}
                    className="bg-card border-primary/20"
                  />
                </div>
              </div>
              <p className="text-xs text-primary/80">
                0 = every shop is open. Raising it affects only shops created after you save. Customer sessions are always free.
              </p>
              <Button
                size="sm"
                onClick={handleSaveFees}
                disabled={savingFees}
                className="bg-primary hover:bg-primary/90"
              >
                <Save className="w-3 h-3 mr-1" />
                {savingFees ? "Saving..." : "Save Activation Fees"}
              </Button>
            </div>
```

- Delete the "Available Tokens" stat card (577-589) and change the stats grid class `lg:grid-cols-5` to `lg:grid-cols-4` on that grid (line 537).
- In all three code tables: delete the `<th className="pb-3 pr-4">Tokens</th>` header cell and the matching `<td className="py-3 pr-4">` cell that renders `code.token_balance` (around 653/674-681, 759/780-790, 849/868-878). Delete both `Tokens` buttons (`onClick={() => { setTokensTarget(code); ...`).
- Delete the "Initial Tokens" field in the create modal (1006-1013), the whole `{/* Add Tokens Modal */}` dialog (1024-1046), and the "Initial Tokens" field in the activate modal (1055-1059). The activate modal body then has only the buttons. Add `<p className="text-sm text-muted-foreground">Marks the activation fee as paid and opens the shop on every channel.</p>` above them.
- Remove `Coins` and `Database` from the lucide import if they're no longer used.
- Run `git grep -n -i -E "token|session" -- app/admin/ussd-shops/page.tsx`. Expected: only `supabase.auth.getSession` / `session?.access_token` lines remain.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run test:run`
Expected: 0 type errors. The full suite passes except the known pre-existing failures in `lib/order-health-service.test.ts` (memory `project-hubtel-ussd`: 9 unrelated failures). Report the exact counts.

Visual check: `/admin/ussd-shops` at 500px and 1280px. Expect an "Activation Fees" card with the help text, no token column or buttons, and four stat cards.

- [ ] **Step 4: Commit**

```bash
git add -A app/admin/ussd-shops app/api/admin app/api/public
git commit -m "feat(ussd-shop): admin fee-only settings; drop token grants and session pricing"
```

---

### Task 8: Final sweep, build, and rollout

**Files:**
- Modify: memory files `project-shop-feature.md`, `project-whatsapp-shop-bot.md`, `project-hubtel-ussd.md` (plus the `MEMORY.md` hooks, if a hook's wording changes)

- [ ] **Step 1: Repo-wide sweep**

Run:

```bash
git grep -n -i -E "buy.?sessions|no sessions left|sessions remaining|deduct_ussd_shop_token|deductTokenIfWhatsappShopOrder|fetchShopCodeTokenBalance|shopBilling|ussd_shop_session_price|ussd_shop_min_sessions|ussd_shop_max_sessions" -- app lib
```

Expected: no output. Any hit must be removed, or justified in the report as an intentional leftover (only the Paystack token-purchase webhook branches are allowed, and they don't match these patterns).

- [ ] **Step 2: Full checks**

Run: `npx tsc --noEmit && npm run test:run`
Then run a real build with placeholder env (memory `feedback-run-next-build-before-pushing-main`):

```bash
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npx next build
```

Expected: the build succeeds. The only test failures are the known pre-existing ones.

- [ ] **Step 3: Apply the migration (user-gated)**

Show the user the Task 1 Step 3 pre-check numbers (`ussd_to_open`, `wa_to_open`, `suspended_untouched`, current fees). **Wait for an explicit "apply".** Then POST `migrations/0121_ussd_shop_free_activation.sql` to the Supabase Management API, and re-run the pre-check query. Expected: `ussd_to_open = 0` (if the USSD fee is 0), `wa_to_open = 0` (if the WhatsApp fee is 0), and `suspended_untouched` unchanged.

The migration must be applied **before** the code deploy, so that between deploys no shop is left "inactive" while the dashboard no longer offers the (removed) token path.

- [ ] **Step 4: Push (user-gated)**

`git fetch origin && git merge origin/main` (another committer pushes to main), re-run `npx tsc --noEmit && npm run test:run`, then push main only after the user says to push. Confirm the Vercel deployment reaches READY.

- [ ] **Step 5: Live checks (user performs the dials/orders)**

For one shop with `token_balance = 0`:
1. Uzo: dial the shop dial code, enter the shop code, and buy the smallest item. Expect the product menu, no "no sessions".
2. WhatsApp: send the shop code to the shop bot number and complete a small order.
3. Hubtel (only if the admin has it in shop mode): `*713*235#`, enter the code, and reach the product menu.
4. Then run: `SELECT code, token_balance FROM ussd_shop_codes WHERE code = '<code>';` Expect `token_balance` unchanged (still 0).
5. The storefront page of that shop shows the USSD card (if the admin toggle is on).

- [ ] **Step 6: Update memory**

- `project-shop-feature.md` and `project-whatsapp-shop-bot.md`: "Session tokens retired 2026-10-14 (spec 2026-10-14-ussd-shop-free-sessions-design). A shop is open when `ussd_shop_codes.status='active'`. Migration 0121 BEFORE INSERT trigger auto-activates (fee waived) while `ussd_shop_activation_fee` / `whatsapp_shop_activation_fee` = 0. Raising a fee grandfathers existing open codes. token_balance / ussd_shop_token_purchases / deduct RPC / hubtel_shop_billing_claims are dead but kept."
- `project-hubtel-ussd.md`: "Shop mode no longer bills; billing-guard deleted (hubtel_shop_billing_claims table unused). Direct dial `*713*235*<code>#` tested 2026-10-14: the network rejects it ('phone number invalid'), so it's not viable."

- [ ] **Step 7: Commit memory and spec/plan updates (if any) as appropriate**

Memory lives outside the repo, so there's no git commit for it. Commit any spec or plan corrections made during execution:

```bash
git add docs/superpowers/specs/2026-10-14-ussd-shop-free-sessions-design.md docs/superpowers/plans/2026-10-14-ussd-shop-free-sessions.md
git commit -m "docs(ussd-shop): free-sessions spec/plan updates from execution"
```
