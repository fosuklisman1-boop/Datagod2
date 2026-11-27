# Network Out-of-Stock Reason Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-written reason for a network-wide out-of-stock, shown to customers on the Hubtel USSD codes (main + shop) and the web buy pages, with the network kept visible.

**Architecture:** Reason lives on the existing `network_stock_status` entry in `admin_settings`. One pure lib module turns the stock map into `{ dbNetworkName: customerText }` ("notices"). Every surface reads notices and, when a picked network has one, shows the text instead of bundles. Purchase gating is untouched: packages stay `is_available=false`.

**Tech Stack:** Next.js 15 App Router, Supabase JS, Vitest (fake-client pattern, see reference-testing memory).

**Spec:** `docs/superpowers/specs/2026-11-27-network-out-of-stock-reason-design.md`

**Workspace:** new worktree on B: from `origin/main`, branch `feat/network-stock-reason` (C: is near full; see reference-b-drive-worktrees). Commit the spec + this plan as the first commit. Edits with Edit/Write only, never sed.

## Global Constraints

- Reason max length: **100** characters after normalisation.
- Default text when reason empty: `"<Label> bundles are temporarily unavailable. Please check back soon."` where Label = `MTN`, `Telecel`, `AT iShare`, `AT BigTime`.
- DB network names (source of truth, verified live 2026-11-27): `MTN`, `Telecel`, `AT - iShare`, `AT - BigTime`. Hubtel USSD uses `AT-iShare` / `AT-BigTime` — all lookups go through `stockNetworkKey()`.
- Never change `packages.is_available` semantics or any purchase gate.
- Never lose `restoreIds` when the reason changes (existing invariant in `setNetworkOutOfStock`).
- Public output = network name + reason text only. Nothing else from `admin_settings`.
- Notice reads must fail open: on error, return `{}` and behave exactly like today.
- No schema change, no migration.

## Review Focus

1. Reason with newlines, `<script>`, emoji or 300 chars → stored as single-line plain text ≤100 chars; USSD screen still fits (Task 1 + Task 4 tests).
2. Editing the reason while out of stock, or a double-submit, keeps the original `restoreIds` (Task 1 test).
3. `AT-iShare` (USSD) vs `AT - iShare` (DB) resolve to the same notice (Task 1 + Task 4 tests).
4. Stock-map read throws → USSD shows today's `No X packages available.`; storefront/dashboard show today's UI (Task 4, Task 5 tests).
5. A shop that sells no MTN packages must not gain an MTN option when MTN is out of stock (Task 5 test).

---

### Task 1: Reason storage + notices helper

**Files:**
- Create: `lib/network-stock-notice.ts`, `lib/network-stock-notice.test.ts`
- Modify: `lib/network-stock-service.ts`, `lib/network-stock-service.test.ts`

**Interfaces:**
- Produces (`lib/network-stock-notice.ts`, pure, no Supabase import):
  - `export const STOCK_REASON_MAX = 100`
  - `normalizeStockReason(raw: unknown): string | null` — non-string/blank → null; strip `<` `>`; collapse all whitespace incl. newlines to single spaces; trim; cut to 100.
  - `stockNetworkKey(name: string): string` — lowercase, remove all spaces → `"at-ishare"` for both spellings.
  - `stockNetworkLabel(dbName: string): string` — `MTN`, `Telecel`, `AT iShare`, `AT BigTime`; unknown → name as-is.
  - `type StockNotices = Record<string, string>` keyed by DB network name.
  - `buildStockNotices(map: NetworkStockMap): StockNotices` — only `outOfStock === true` entries; value = `reason` or default text.
  - `noticeFor(notices: StockNotices, network: string): string | null` — matched via `stockNetworkKey`.
- Produces (`lib/network-stock-service.ts`):
  - `NetworkStockEntry` gains `reason?: string`.
  - `setNetworkOutOfStock(supabase, network, reason?: string | null): Promise<{ affected: number; alreadyOutOfStock: boolean; reasonUpdated: boolean }>` — when already out of stock and `reason !== undefined`, write only the new reason (keep `restoreIds`), `reasonUpdated: true`; `null`/blank clears it.
  - `restockNetwork` unchanged signature; resulting entry `{ outOfStock: false }` (no reason).
  - `getStockNotices(supabase): Promise<StockNotices>` — `buildStockNotices(await getNetworkStockMap())`, any error → `{}` and `console.error` with no payload.

- [ ] **Step 1: Write failing tests** in `lib/network-stock-notice.test.ts`:
  - `normalizeStockReason("  MTN delays,\n back by 6pm  ")` → `"MTN delays, back by 6pm"`
  - `normalizeStockReason("<b>hi</b>")` → `"bhi/b"`; `normalizeStockReason("   ")` → `null`; `normalizeStockReason(42)` → `null`
  - `normalizeStockReason("x".repeat(300))!.length` → `100`
  - `stockNetworkKey("AT-iShare") === stockNetworkKey("AT - iShare")`
  - `buildStockNotices({ MTN: { outOfStock: true, restoreIds: [] }, Telecel: { outOfStock: false } })` → `{ MTN: "MTN bundles are temporarily unavailable. Please check back soon." }`
  - `buildStockNotices({ "AT - iShare": { outOfStock: true, reason: "Back at 6pm" } })` → `{ "AT - iShare": "Back at 6pm" }`; `noticeFor(that, "AT-iShare")` → `"Back at 6pm"`; `noticeFor(that, "MTN")` → `null`

  In `lib/network-stock-service.test.ts` (extend the existing fake client):
  - out-of-stock with reason `"Back soon"` stores `{ outOfStock: true, restoreIds: [...], reason: "Back soon" }`
  - second call with reason `"Back tomorrow"` → `reasonUpdated: true`, `restoreIds` identical to first call, packages not re-queried
  - second call with `reason` undefined → true no-op (existing behaviour, `reasonUpdated: false`)
  - restock → entry is exactly `{ outOfStock: false }`
  - `getStockNotices` with a client whose select errors → `{}`
- [ ] **Step 2: Run** `npx vitest run lib/network-stock-notice.test.ts lib/network-stock-service.test.ts` — expect FAIL (module/exports missing).
- [ ] **Step 3: Implement** both files per Interfaces. `setNetworkOutOfStock` normalises the reason via `normalizeStockReason`.
- [ ] **Step 4: Run** same command — expect PASS, and existing network-stock tests still green.
- [ ] **Step 5: Commit** `feat(network-stock): optional out-of-stock reason + customer notices helper`

### Task 2: Admin API + Network Stock card

**Files:**
- Modify: `app/api/admin/packages/network-stock/route.ts`, `lib/admin-service.ts` (`setNetworkStock`), `components/admin/network-stock-card.tsx`
- Create: `lib/network-stock-request.ts`, `lib/network-stock-request.test.ts` — validation lives in lib, route stays thin.

**Interfaces:**
- Consumes: Task 1 `setNetworkOutOfStock(supabase, network, reason)`, `STOCK_REASON_MAX`.
- Produces: `parseNetworkStockBody(body: unknown): { ok: true; network: TrackedNetwork; outOfStock: boolean; reason?: string | null } | { ok: false; error: string }` in `lib/network-stock-request.ts`. `reason` must be absent, `null` or string, else error `"reason must be text"`. `reason` is ignored when `outOfStock` is false.
- `adminPackageService.setNetworkStock(network: string, outOfStock: boolean, reason?: string | null)`.
- POST response adds `reasonUpdated`; audit `new_value` adds `reason`.

- [ ] **Step 1: Failing tests** for `parseNetworkStockBody`: valid with reason; `reason: 5` → error; unknown network → error listing networks; `outOfStock: "yes"` → error; restock body with reason → `reason` undefined.
- [ ] **Step 2: Run** `npx vitest run lib/network-stock-request.test.ts` — FAIL.
- [ ] **Step 3: Implement** parser; route uses it, passes reason through.
- [ ] **Step 4: Card UI:**
  - Confirm dialog gets a textarea "Reason customers will see (optional)" with a `n/100` counter, `maxLength={100}`, and a placeholder showing the default text.
  - While a network is out of stock, its row shows the current reason (or "Default message") under the name, plus an "Edit reason" button. The button reopens the same dialog prefilled, titled "Update {network} reason", and it calls `setNetworkStock(network, true, reason)`.
  - Toast: "Reason updated" when `reasonUpdated`. Follow docs/ui-conventions.md.
- [ ] **Step 5: Run** tests — PASS; `npx tsc --noEmit -p .` clean for touched files.
- [ ] **Step 6: Commit** `feat(admin): type a reason when marking a network out of stock`

### Task 3: Public notices route + dashboard Data Packages page

**Files:**
- Create: `app/api/public/network-stock/route.ts`
- Modify: `app/dashboard/data-packages/page.tsx`

**Interfaces:**
- Consumes: Task 1 `getStockNotices`, `noticeFor`.
- Produces: `GET /api/public/network-stock` → `{ notices: StockNotices }`, service-role client, header `Cache-Control: public, s-maxage=30, stale-while-revalidate=60`. On error → `{ notices: {} }` with 200.

- [ ] **Step 1: Route** — thin wrapper, no logic beyond Task 1 calls (Task 1 tests cover behaviour).
- [ ] **Step 2: Page:**
  - Fetch the notices once alongside `loadPackages`. If the fetch fails, use `{}`.
  - In the network tabs (`NETWORK_ORDER` loop, ~line 409), a network with a notice shows a destructive-tone "Out of stock" pill instead of "Live" / "No Packages".
  - When the selected network has a notice, render a card with the notice text (icon `PackageX`) in place of the package grid and of "No packages found for…". Widen it at `lg:` per the desktop-layout rule.
- [ ] **Step 3: Verify** headless screenshot (reference-headless-screenshots, ≥500px wide) of /dashboard/data-packages with MTN out of stock — reason card visible, other networks unchanged.
- [ ] **Step 4: Commit** `feat(dashboard): show out-of-stock reason on Data Packages`

### Task 4: USSD main code (Hubtel)

**Files:**
- Modify: `lib/ussd-hubtel/flow-kit.ts` (`RouterDeps`), `lib/ussd-hubtel/router.ts` (wire dep), `lib/ussd-hubtel/flows/data.ts`
- Test: `lib/ussd-hubtel/router.test.ts` (follow its existing fake-deps pattern; create `flows/data.test.ts` only if the router tests can't reach the step)

**Interfaces:**
- Consumes: Task 1 `getStockNotices`, `noticeFor`.
- Produces: `RouterDeps.stockNotices?(): Promise<StockNotices>` — doc comment "must not throw; fail open to {}". Router wires `() => getStockNotices(supabase)`.

- [ ] **Step 1: Failing tests:**
  - With `stockNotices` → `{ MTN: "MTN delays, back by 6pm" }` and input `1` on SELECT_NETWORK: the reply text is `"MTN delays, back by 6pm\n" + networkMenuText()`, the step stays SELECT_NETWORK, and `fetchBundles` is not called.
  - Notice keyed `"AT - iShare"` + input `3` → reason shown.
  - `stockNotices` rejects → today's flow (fetchBundles called).
  - The 100-char reason + menu passes the existing screen-fit check (`lib/ussd-hubtel/screen-fit.test.ts` helper).
- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel` — new tests FAIL.
- [ ] **Step 3: Implement** in `selectNetwork` (data.ts:24), before `resolveCaller`: `const notice = noticeFor(await safeNotices(deps), net.dbName)`; if set → `say(ctx, notice + "\n" + networkMenuText(), "SELECT_NETWORK", NETWORK)`. `safeNotices` wraps with `.catch(() => ({}))` and treats a missing dep as `{}`.
- [ ] **Step 4: Run** `npx vitest run lib/ussd-hubtel` — all PASS.
- [ ] **Step 5: Commit** `feat(ussd): show out-of-stock reason on the main code`

### Task 5: USSD shop codes + storefront (shared "sold networks" rule)

**Files:**
- Modify: `lib/shop-commerce/shop-code.ts` (`fetchShopNetworks`), `lib/ussd-hubtel/shop-services.ts`, `lib/ussd-hubtel/flows/shop.ts`, `lib/ussd-hubtel/flows/shop-data.ts`, `app/api/shop/public-packages/route.ts`, `app/shop/[slug]/storefront-client.tsx`
- Create: `lib/shop-stock-networks.ts`, `lib/shop-stock-networks.test.ts`
- Test: `lib/ussd-hubtel/flows/shop.test.ts`, `lib/ussd-hubtel/flows/shop-data.test.ts`

**Interfaces:**
- Consumes: Task 1 `StockNotices`, `noticeFor`, `stockNetworkKey`; Task 4 `RouterDeps.stockNotices`.
- Produces:
  - `fetchShopNetworks(shopId, parentShopId?, client?, opts?: { includeUnavailable?: boolean })`. With `includeUnavailable`, skip only the `packages.is_available` filter; the shop-level `is_available` / `is_active` filters stay. Default behaviour is unchanged, so the WhatsApp bot is unaffected.
  - `ShopServices.soldNetworks(shopId, parentShopId?)` = `fetchShopNetworks(..., { includeUnavailable: true })`.
  - `mergeStockedOutNetworks(available: string[], sold: string[], notices: StockNotices): string[]` returns `available` plus the networks in `sold` that have a notice and aren't already in `available`. It doesn't sort; callers keep `sortShopNetworks`.
  - `noticesForShop(sold: string[], notices: StockNotices): StockNotices` keeps only the networks the shop sells.

- [ ] **Step 1: Failing tests:**
  - `mergeStockedOutNetworks(["Telecel"], ["Telecel","MTN"], { MTN: "x" })` → `["Telecel","MTN"]`
  - `mergeStockedOutNetworks(["Telecel"], ["Telecel"], { MTN: "x" })` → `["Telecel"]` (Review Focus 5)
  - `noticesForShop(["MTN"], { MTN: "x", Telecel: "y" })` → `{ MTN: "x" }`
  - shop.test: entering the code with MTN out of stock and sold → `shopNetworks` includes MTN. If `stockNotices` or `soldNetworks` rejects → today's list.
  - shop-data.test: picking MTN with a notice → `notice + "\n" + networkScreen`, the step stays SHOP_DATA_NETWORK, and `shop.bundles` is not called. A rejecting `stockNotices` → today's `No MTN packages available.`
  - If all of the shop's networks are out of stock, `startShopData` still lists them (no "No packages available").
- [ ] **Step 2: Run** `npx vitest run lib/shop-stock-networks.test.ts lib/ussd-hubtel/flows/shop.test.ts lib/ussd-hubtel/flows/shop-data.test.ts` — FAIL.
- [ ] **Step 3: Implement the USSD side.**
  - shop.ts (~line 100): run `networks`, `soldNetworks` and `stockNotices` in parallel, each with its own `.catch`, then `sortShopNetworks(mergeStockedOutNetworks(...))`.
  - shop-data.ts `selectNetwork`: check the notice before `pageOf`.
- [ ] **Step 4: Implement the storefront side.**
  - public-packages route: after `packages` is built, compute `sold` with `fetchShopNetworks(shop.id, shop.parent_shop_id, supabase, { includeUnavailable: true })` and `notices` with `getStockNotices`. Add `stock_notices: noticesForShop(sold, notices)` to the JSON, and fall back to `{}` on any error.
  - storefront-client: the network grid = the `Set` of package networks plus the `stock_notices` keys, appended in that order.
  - Show the empty "No packages available at the moment" card only when both the packages and the notices are empty.
  - When the selected network has a notice, show the notice card in place of the package list, styled with the shop's accent colour.
- [ ] **Step 5: Run** step 2 command + `npx vitest run lib/ussd-hubtel` — PASS.
- [ ] **Step 6: Verify** a headless screenshot of a test storefront with MTN out of stock: the MTN tab shows the reason.
- [ ] **Step 7: Commit** `feat(shop): keep out-of-stock networks visible with the admin reason`

### Task 6: Ship checks

- [ ] `npx vitest run` — only the 9 known order-health failures (testing-discipline memory).
- [ ] Placeholder-env `next build` passes (run-next-build-before-pushing-main memory).
- [ ] Fresh reviewer (sonnet) on the branch diff with this plan's Review Focus.
- [ ] Owner OK → merge to main, push (check local main first), live check: set an MTN reason in /admin/packages, then dial the main and a shop code and open a storefront and the dashboard.
- [ ] Update memory (new project file + MEMORY.md line); draft the WhatsApp channel post (Post now / Hold).

## Out of scope (flagged to owner)
- The legacy `/api/ussd` and `/api/ussd-shop` codes (`lib/ussd/`, `lib/ussd-shop/`) are unchanged.
- **Pre-existing bug, not fixed here:** the Hubtel main code queries `packages.network = 'AT-iShare' / 'AT-BigTime'`, but the DB stores `'AT - iShare' / 'AT - BigTime'`. AT bundles likely never list on the main code. This needs its own fix.
