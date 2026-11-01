# Special Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MTN "Special Bundles" category to the dashboard Standard Bundles page. Each plan is N × the MTN GHS 3 non-expiry Hubtel bundle for one recipient. The buyer pays with one wallet debit, and delivery happens as N ordinary Standard Bundle orders linked by `special_group_id`.

**Architecture:**
- **Catalog.** The catalog API adds synthetic Special entries (signed token `{unitToken, n}`), built from the live unit bundle.
- **Buying.** `buySpecial` re-checks the unit and prices it per unit, with cashback floored per unit. A new service-role RPC then takes one wallet debit and inserts N child `hubtel_data_orders` rows in a single transaction.
- **Delivery.** The children are dispatched one after another through the existing `dispatchBundleOrder`.
- **Partial failure.** It uses the existing per-order admin retry and refund.

**Tech Stack:** Next.js 15, TypeScript, Supabase (Postgres RPC), Hubtel Commission Services, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-special-bundles-design.md`.

## Global Constraints

- **Scope:** MTN only, and the dashboard (wallet) only. Storefront, API v1/v2, USSD and WhatsApp paths must stay byte-identical. Where they share helpers, pin them with tests.
- **Ships dark.** The config `standard_bundles_config.special` defaults to `{ enabled: false, multiples: [3,5,8,10,15], unitAmount: 3 }`.
  - The validator accepts `multiples` as 1–10 distinct integers, each 1–50, sorted. `unitAmount` must be > 0 with at most 2 decimal places.
  - A missing or invalid `special` resolves to disabled.
- **Price shown = price charged.**
  - Each child's `amount` is the unit's live Hubtel amount.
  - Each child's `paid_amount` is the per-unit cashback price: `quoteCashback`, floored per unit, with the same dashboard channel and buyer role that `quoteBundle` uses today.
  - Total = N × unit pay. The client sends `expectedPay` = that total. A mismatch returns 409 "Price changed. Please try again." and charges nothing.
  - The UI shows N × the per-unit display price, never `quoteForDisplay(N × amount)`, so its rounding matches the server's.
- **Unit rule (ruling 2026-10-30, replaces the regex rule).** The unit is the MTN catalog item whose Hubtel `value` equals the admin-set `special.unitValue` (default `RACT_Data_GHC_3_Others`, live 406.89MB at GHS 3), whose amount equals `unitAmount` to the cent, and whose size parses. If none match, the Special category is absent. `findSpecialUnit(bundles, unitAmount, unitValue)`.
- **Buy re-checks (ruling).** The special token does not encode config. At buy, re-check `special.enabled`, that `n` is in the current `multiples`, that the live unit still matches `unitValue` and `unitAmount`, and verify the nested unit token. Special is independent of the Data category's "hidden" setting: its own switch governs it, so the buy path must not apply the hidden-category refusal to Special.
- **Special entries:**
  - `display` = N × the unit's MB, shown in GB to 2 dp (3 × 406.8MB → "1.22GB");
  - `amount` = N × the unit amount;
  - `category` = "Special Bundles", listed FIRST for MTN;
  - each entry also carries `special: { n, unitAmount, unitDisplay }`;
  - the token uses the same secret as the bundle token, a distinct type tag, and the same 10-minute TTL.
- **Delivery.** Children are dispatched one after another inside `after()`, and one child failing never stops the rest. Each child keeps every existing safeguard: the claim, the ledger, the status check and the alerts. Children carry `special_index` 1..N.
- **Idempotency.**
  - The group idempotency key is the client's `idempotencyKey`, and each child's key is `${key}:${i}`.
  - A buy retried with the same key returns the existing group and never debits twice. The RPC enforces this.
- **Migration 0141.**
  - Adds the `special_group_id uuid` and `special_index smallint` columns and an index.
  - Adds the RPC `create_special_bundle_orders`: SECURITY DEFINER with `search_path` set, `REVOKE ALL` from public/anon/authenticated, and `GRANT EXECUTE` to service_role only.
  - Ships with a `.selftest.sql` that rolls itself back, following the house pattern (see 0140).
  - Implementers must NOT apply it.
- **Process rules.**
  - Edit code with the Edit/Write tools only; no sed, heredoc or python edits of source.
  - Keep logic in `lib/`, and write the failing test first.
  - Run a real `next build` before merging.
  - Before pushing, check origin/local main for commits from other sessions.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. One purchase means exactly one wallet debit and N child rows. A double-tap or a retry never debits twice or creates two groups.
2. The price shown = `expectedPay` = the sum of the children's `paid_amount` = the amount debited, with per-unit flooring.
3. A failing child never blocks the other children's dispatch, and never leaves a paid child undispatched without a trace.
4. With the switch off, the catalog, buy, storefront, API and bot outputs are byte-identical.
5. The RPC is service-role only and validates every input: N is 1–50, the row count equals N, every row belongs to p_user, the total equals the sum of `paid_amount`, and the wallet covers it.

---

### Task 1: Config + admin switch
**Files:**
- `lib/standard-bundles/config.ts` (+test)
- the admin standard-bundles settings UI and its route (find where `setBundlesConfig` is called)

**Steps:**
1. **Config.** Add `special` to `BundlesConfig`, `resolveBundlesConfig` (defaults; invalid → disabled) and `validateBundlesPatch`.
2. **Admin card.** Add a "Special Bundles (MTN)" card with an enabled switch, a multiples input (comma list) and the unit amount, and show validation errors.
3. **Tests first.** Cover the defaults, invalid shapes, the caps, sorting and dedupe, and the existing fields staying unchanged.
4. Commit.

### Task 2: Unit discovery, Special catalog entries, token
**Files:**
- **Create:** `lib/standard-bundles/special.ts` (+test).
- **Modify:** `lib/standard-bundles/token.ts` (+test). Add special-token sign and verify, with a type tag so a normal token can never verify as special, and the other way round.
- **Modify:** `app/api/standard-bundles/catalog/route.ts`, or the caller of `getCatalog`. For MTN, when the switch is on and a unit is found, put the Special category first.

**Interfaces:**
- `findSpecialUnit(bundles: CatalogBundle[], unitAmount: number): { bundle: CatalogBundle; mb: number } | null`
- `buildSpecialEntries(unit, multiples, secret, now): SpecialEntry[]`
- `parseBundleMb(display, value): number | null`

**Tests:**
- size parsing: MB, GB, decimals, and junk → null;
- unit choice: none matching, and several matching;
- GB formatting for 3/5/8/10/15 × 406.8MB, which must match the screenshot: 1.22, 2.03, 3.26, 4.07, 6.10;
- the token: round trip, expiry, and refusal across types;
- the catalog unchanged when the switch is off, and Special listed first when it is on.

Commit.

### Task 3: Migration 0141 + RPC (not applied)
**Files:** `migrations/0141_special_bundles.sql` and `migrations/0141_special_bundles.selftest.sql`.

**RPC:** `create_special_bundle_orders(p_user uuid, p_group_key text, p_rows jsonb, p_total numeric)`, which runs in this order:
1. Lock the wallet row.
2. If a child with idempotency_key `p_group_key || ':1'` already exists for this user, return that existing group.
3. Validate the input as listed in Review Focus 5.
4. Debit the wallet with the same logic the dashboard bundle path uses: find the existing debit RPC and mirror its `transactions` row.
5. Insert the N rows with one shared new `special_group_id`.
6. Return the group id and the child ids. Errors carry a code: `INSUFFICIENT_FUNDS` or `BAD_INPUT`.

**Selftest** (in a transaction that rolls back): the happy path, an idempotent replay, a short wallet, and a bad total.

Commit.

### Task 4: buySpecial service + route
**Files:** `lib/standard-bundles/special-service.ts` (+test) and `app/api/standard-bundles/buy/route.ts`.

**Route:** if the token verifies as special, call `buySpecial`. Otherwise run today's path unchanged.

**`buySpecial` checks, in order:**
1. The switch is on and the network is MTN.
2. The unit is still in the live catalog (same token verify path).
3. Compute unit pay per unit.
4. Total = n × unitPay must equal `expectedPay`, otherwise return 409.
5. Validate the recipient exactly as `buyBundle` does (prefix rules).

Then call the RPC and dispatch the children one after another inside `after()`.

**Tests:** one debit, N rows, a replay, the 409, a short wallet (402), child 2 failing while children 1 and 3 still complete, and the normal path untouched.

Commit.

### Task 5: UI
**Files:** `components/standard-bundles/StandardBundlesPage.tsx`, `BundleBuySheet.tsx` and `app/api/standard-bundles/orders/route.ts`.

**Changes:**
- The "Special Bundles" pill comes first, with the blurb "Low Cost Non Expiry Bundles, special for you".
- Card prices are N × the per-unit display price.
- The buy sheet shows "3 × 407MB to 0XX" and sends `expectedPay` = the total.
- My orders groups the children by `special_group_id`, with one combined status: Completed, "Part delivered — we're on it", or Processing.
- Tests for the pure helpers (the price and the grouping).

Commit.

### Task 6: Admin badge, runbook, verification
- **Admin:** in the `/admin/standard-bundles` list, add a "Special i/N" badge and a group id filter.
- **Runbook:** a "Special Bundles" section in `docs/hubtel-commission-services/runbook.md`. It covers:
  - applying 0141 first, with its pre and post checks;
  - the enable steps;
  - a supervised live test: Special 3× to a test number, confirming the unit really gives ~407MB;
  - the partial-failure procedure.
- **Verification:** the full vitest run (known failures only), tsc, and a real `next build`. STOP before merging.
