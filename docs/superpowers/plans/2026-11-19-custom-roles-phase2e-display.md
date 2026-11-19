# Custom Roles — Phase 2e (Remaining display sites) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two display sites that would show the wrong number for a custom-role user, with zero change for today's roles. Switching custom roles on moves to the end of Phase 3 (owner decision 2026-11-19).

**Architecture:** Admin custom-prices route reads the user's role base via `roleBasePrices(..., { admin: "as_user" })`. Bulk order form keeps today's "unadjusted" set and additionally leaves unadjusted any row whose server-resolved price differs from the plain `price` (a custom-role base), so the form shows exactly what `/api/orders/create-bulk` charges.

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` §5.7. Earlier phases: 2a (`lib/roles/pricing.ts`).

## Global Constraints

- Parity: for user/dealer/admin/sub_agent every displayed number is unchanged (including the edge case dealer_price == price).
- Out of scope (deliberately left, display-only fallbacks that are never cheaper than public): `lib/pricing/user-package-prices.ts` `resolveDisplayPrices` fallback, `mobile/src/lib/datagod.ts` `rolePriced`, `app/api/shop/dealer-price-list` + upgrade page (dealer marketing; Phase 4 plans), my-shop badge (Phase 3), `lib/admin-users/account-ops.ts` legacy dealer deltas, the custom-prices dialog's "below the dealer price" cost warning.
- Edit/Write only, no `sed`. TDD. No PII in logs.

## Review Focus

1. Dealer with dealer_price == price: bulk form adjusts/doesn't adjust exactly as today.
2. Admin custom-prices route for a dealer/admin/user shows the same role_price as today.

---

### Task 1: Admin custom-prices route shows the user's role base

**Files:** Modify `app/api/admin/users/[id]/custom-prices/route.ts:~38-52`; test beside it.
- `role_price` = `priceWith(await roleBasePrices(db, user.role, rows, { admin: "as_user" }), p, NO_CUSTOM_PRICES)` (one base load for all rows; today's comment "direct charge-point rule" still holds — admin as user). On `RoleReadError` → 500 `{ error: "Failed to load prices" }` (same as its other read failures). Keep `dealer_price` and every other field.
- [ ] Tests: dealer/admin/user/sub_agent role_price identical to `rolePrice(p, role === "dealer")`; a custom role row 5.5 shown; roles read failure → 500.
- [ ] Commit `feat(roles): admin custom-prices view shows the user's role price`.

### Task 2: Bulk order form adjusts only plain prices

**Files:** Modify `lib/pricing/user-package-prices.ts:~70-86` (`priceBulkFormPackages`); extend its test.
- `unadjusted` = custom ids ∪ ids where `isDealer && Number(p.dealer_price) > 0` (today's set, unchanged) ∪ ids where the resolved (non-fallback) shown price `!== Number(p.price)`.
- [ ] Tests: today's cases unchanged (dealer, dealer_price == price, user, custom); a resolved custom-role base (≠ price) for a non-dealer row is NOT adjusted; fallback path unchanged.
- [ ] Commit `fix(roles): bulk form never adjusts a role-priced row`.

### Task 3: Verification

- [ ] tsc on touched files; full vitest → only the 12 known pre-existing failures; placeholder build exit 0.
- [ ] Whole-range review (sonnet; display-only phase).
