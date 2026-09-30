# USSD "Browse Services" Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the data-bundle entry point on both USSD menus (main platform + shop/sub-agent) to "Browse Services", replace raw carrier names with network nicknames throughout the purchase flow, and add `AT-BigTime` as a selectable network (already fulfillable server-side, just missing from the USSD menu).

**Architecture:** One new pure module (`lib/ussd/network-labels.ts`) defines the four network nicknames once; both USSD codebases (`lib/ussd/*`, `lib/ussd-shop/*`) import it wherever a network name is shown to a customer. All other changes are literal string edits to existing menu-rendering functions and their call sites — no new session fields, no new USSD steps, no change to fulfillment/payment logic.

**Tech Stack:** Next.js 15 API routes (Uzo USSD gateway webhooks), TypeScript, Vitest.

**Design spec:** `docs/superpowers/specs/2026-09-30-ussd-services-rebrand-design.md`

**Explicitly out of scope — do not touch:** `lib/whatsapp-bot/router.ts` and `lib/whatsapp-bot/shop-menus.ts` have their own separate, unrelated copies of "Select Bundle:" / "(who gets the data):" strings (confirmed by grep — not shared code with `lib/ussd/menus.ts` or `lib/ussd-shop/menus.ts`). The design spec explicitly excludes the WhatsApp bot, SMS templates, admin panel labels, and internal identifiers. `lib/ussd/menus.ts`'s `airtimeNetworkMenu()`, `lib/ussd-shop/menus.ts`'s `shopAirtimeNetworkMenu()`, and every WhatsApp-specific `wa*Menu()` function in `lib/ussd/menus.ts` are also unrelated to the data-bundle flow and must not be changed.

---

## Task 1: Shared network-nickname module

**Files:**
- Create: `lib/ussd/network-labels.ts`
- Test: `lib/ussd/network-labels.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/ussd/network-labels.test.ts
import { describe, it, expect } from "vitest"
import { networkNickname, NETWORK_NICKNAMES } from "./network-labels"

describe("networkNickname", () => {
  it("maps MTN to Yellow Plans", () => {
    expect(networkNickname("MTN")).toBe("Yellow Plans")
  })

  it("maps Telecel to Tele", () => {
    expect(networkNickname("Telecel")).toBe("Tele")
  })

  it("maps AT-iShare to Instant Blue", () => {
    expect(networkNickname("AT-iShare")).toBe("Instant Blue")
  })

  it("maps AT-BigTime to Delay Blue", () => {
    expect(networkNickname("AT-BigTime")).toBe("Delay Blue")
  })

  it("falls back to the raw value for an unrecognized network (e.g. a legacy generic AirtelTigo row)", () => {
    expect(networkNickname("AirtelTigo")).toBe("AirtelTigo")
  })

  it("exports exactly the 4 expected networks", () => {
    expect(Object.keys(NETWORK_NICKNAMES).sort()).toEqual(
      ["AT-BigTime", "AT-iShare", "MTN", "Telecel"].sort()
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- lib/ussd/network-labels.test.ts`
Expected: FAIL — `Cannot find module './network-labels'`, since the module doesn't exist yet.

- [ ] **Step 3: Implement the module**

```typescript
// lib/ussd/network-labels.ts
//
// Shared network-nickname map for the "Browse Services" rebrand — both the
// main USSD (lib/ussd) and the shop USSD (lib/ussd-shop) show customers a
// nickname instead of the raw carrier/packages.network value, so the mapping
// lives in exactly one place and the two channels can never drift apart.

export const NETWORK_NICKNAMES: Record<string, string> = {
  'MTN': 'Yellow Plans',
  'Telecel': 'Tele',
  'AT-iShare': 'Instant Blue',
  'AT-BigTime': 'Delay Blue',
}

/**
 * Returns the customer-facing nickname for a packages.network value, or the
 * raw value itself if it has no nickname (e.g. a legacy generic "AirtelTigo"
 * row still present in some shop's stocked-network list) — never throws, and
 * never hides a network the caller can otherwise sell.
 */
export function networkNickname(network: string): string {
  return NETWORK_NICKNAMES[network] ?? network
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- lib/ussd/network-labels.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd/network-labels.ts lib/ussd/network-labels.test.ts
git commit -m "$(cat <<'EOF'
feat(ussd): add shared network-nickname module

Yellow Plans / Tele / Instant Blue / Delay Blue map to MTN / Telecel /
AT-iShare / AT-BigTime in one place, shared by both the main and shop
USSD flows, so the two channels can't drift apart on rebrand copy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Main USSD wording changes

**Files:**
- Modify: `lib/ussd/menus.ts`
- Modify: `lib/ussd/handlers/main.ts`
- Modify: `lib/ussd/handlers/bundles.ts`

No test file exists today for `menus.ts` or the handler files (only the pure `menu-items.ts` numbering engine has tests — confirmed by `find lib/ussd*/**/*.test.ts`). This task follows that existing convention: mechanical string edits, verified by `npx tsc --noEmit` and the full test suite (no regressions), not new unit tests. Task 4 does a full manual trace of the final copy against the design spec.

- [ ] **Step 1: Rename the main-menu label**

In `lib/ussd/menus.ts`, find:

```typescript
const MAIN_MENU_ITEMS: MenuItemDef<MainMenuKey>[] = [
  { key: "data", label: "Buy Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]
```

Replace with:

```typescript
const MAIN_MENU_ITEMS: MenuItemDef<MainMenuKey>[] = [
  { key: "data", label: "Browse Services" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]
```

- [ ] **Step 2: Update the network menu — nicknames only, drop generic AirtelTigo, add AT-BigTime**

In `lib/ussd/menus.ts`, find:

```typescript
export function networkMenu(): string {
  return 'Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back'
}
```

Replace with:

```typescript
export function networkMenu(): string {
  return 'Select Network:\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n4. Delay Blue\n0. Back'
}
```

- [ ] **Step 3: Reword the package-list header**

In `lib/ussd/menus.ts`, inside `bundleMenu()`, find:

```typescript
  lines.push('0. Back')
  return 'Select Bundle:\n' + lines.join('\n')
}

export function paymentMethodMenu(amount: number, balance: number): string {
```

Replace with:

```typescript
  lines.push('0. Back')
  return 'Select Package:\n' + lines.join('\n')
}

export function paymentMethodMenu(amount: number, balance: number): string {
```

- [ ] **Step 4: Drop "data" from the recipient prompt**

In `lib/ussd/menus.ts`, find:

```typescript
export function recipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}
```

Replace with:

```typescript
export function recipientPrompt(): string {
  return 'Enter recipient number:\n(who gets it):\n\n0. Back'
}
```

(`confirmMenu()` itself is unchanged — it already takes `network` as a plain display-string parameter; the nickname substitution happens at its call sites in `handlers/bundles.ts`, Step 7 below. `waConfirmMenu()` and every other Whats App-specific function in this file are untouched — out of scope.)

- [ ] **Step 5: Deduplicate the hardcoded network menu in the main handler**

In `lib/ussd/handlers/main.ts`, find the import line:

```typescript
import { cont, end, afaEnterNamePrompt, airtimeRecipientPrompt, rcMenu, resolveMainMenu, type MainMenuKey } from "../menus"
```

Replace with:

```typescript
import { cont, end, afaEnterNamePrompt, airtimeRecipientPrompt, rcMenu, resolveMainMenu, networkMenu, type MainMenuKey } from "../menus"
```

Then find:

```typescript
    case 'data':
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone, dataBlocked })
      return cont('Select Network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n4. AT-iShare\n0. Back')
```

Replace with:

```typescript
    case 'data':
      await setSession(sessionId, { step: 'SELECT_NETWORK', dialingPhone, dataBlocked })
      return cont(networkMenu())
```

This removes the pre-existing duplication (the hardcoded string here was never kept in sync with `networkMenu()` in `menus.ts` — both are now the single source of truth in `menus.ts`).

- [ ] **Step 6: Update `NETWORK_OPTIONS` — drop generic AirtelTigo, add AT-BigTime**

In `lib/ussd/handlers/bundles.ts`, find:

```typescript
const NETWORK_OPTIONS: Record<string, { dbName: string; paystackProvider: 'mtn' | 'vod' | 'tgo' }> = {
  '1': { dbName: 'MTN', paystackProvider: 'mtn' },
  '2': { dbName: 'Telecel', paystackProvider: 'vod' },
  '3': { dbName: 'AirtelTigo', paystackProvider: 'tgo' },
  '4': { dbName: 'AT-iShare', paystackProvider: 'tgo' },
}
```

Replace with:

```typescript
const NETWORK_OPTIONS: Record<string, { dbName: string; paystackProvider: 'mtn' | 'vod' | 'tgo' }> = {
  '1': { dbName: 'MTN', paystackProvider: 'mtn' },
  '2': { dbName: 'Telecel', paystackProvider: 'vod' },
  '3': { dbName: 'AT-iShare', paystackProvider: 'tgo' },
  '4': { dbName: 'AT-BigTime', paystackProvider: 'tgo' },
}
```

This lines up 1-4 with the new `networkMenu()` order from Step 2 (Yellow Plans=MTN, Tele=Telecel, Instant Blue=AT-iShare, Delay Blue=AT-BigTime). `AT-BigTime` packages already exist and are already fulfillable (`lib/ussd/fulfill.ts`'s `fulfillableNetworks` already includes `"AT - BIGTIME"`/`"AT-BIGTIME"`) — this is the only change needed to make them purchasable via USSD.

- [ ] **Step 7: Add the nickname import and use it at both `confirmMenu()` call sites, and in the "no bundles" message**

In `lib/ussd/handlers/bundles.ts`, find the import block at the top:

```typescript
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentMethodMenu, mainMenu } from "../menus"
import { setSession } from "../session"
```

Replace with:

```typescript
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentMethodMenu, mainMenu } from "../menus"
import { networkNickname } from "../network-labels"
import { setSession } from "../session"
```

Then find (the "no bundles for this network" message inside `handleSelectNetwork`):

```typescript
  const { bundles, total } = await fetchBundles(net.dbName, 0, effectivePriceTier, subAgentParentShopId)
  if (bundles.length === 0) {
    return cont(`No ${net.dbName} bundles available.\n\n${networkMenu()}`)
  }
```

Replace with:

```typescript
  const { bundles, total } = await fetchBundles(net.dbName, 0, effectivePriceTier, subAgentParentShopId)
  if (bundles.length === 0) {
    return cont(`No ${networkNickname(net.dbName)} packages available.\n\n${networkMenu()}`)
  }
```

Then find the first `confirmMenu(` call, inside `handleEnterRecipient`:

```typescript
  return cont(confirmMenu(
    session.network!,
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!,
    session.mtnWhitelistActive === true
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
```

Replace with:

```typescript
  return cont(confirmMenu(
    networkNickname(session.network!),
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!,
    session.mtnWhitelistActive === true
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
```

Then find the second `confirmMenu(` call, inside `handleConfirm`'s invalid-input branch:

```typescript
  if (input.trim() !== '1') {
    return cont(confirmMenu(
      session.network!,
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!,
      session.mtnWhitelistActive === true
    ))
  }
```

Replace with:

```typescript
  if (input.trim() !== '1') {
    return cont(confirmMenu(
      networkNickname(session.network!),
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!,
      session.mtnWhitelistActive === true
    ))
  }
```

`session.network` itself (the raw dbName, e.g. `'AT-BigTime'`) is left completely unchanged everywhere else — network↔prefix validation, fulfillment, DB writes, SMS. Only these three customer-facing display points are nicknamed.

- [ ] **Step 8: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: All existing tests still pass (no regressions — these are all string/config edits in files with no dedicated unit tests today).

- [ ] **Step 10: Commit**

```bash
git add lib/ussd/menus.ts lib/ussd/handlers/main.ts lib/ussd/handlers/bundles.ts
git commit -m "$(cat <<'EOF'
feat(ussd): rebrand main USSD data-bundle flow to "Browse Services"

Main-menu label, network menu (nicknames only, AT-BigTime added,
generic AirtelTigo dropped), package-list header, and recipient prompt
all reworded per the design spec. Also deduplicates a hardcoded network
menu string in handlers/main.ts that had drifted from menus.ts's
networkMenu(). session.network (the raw DB value used for fulfillment,
prefix validation, etc.) is untouched — only display strings change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Shop USSD wording changes

**Files:**
- Modify: `lib/ussd-shop/menus.ts`
- Modify: `lib/ussd-shop/handlers/shop.ts`
- Modify: `lib/ussd-shop/handlers/bundles.ts`

Same testing approach as Task 2 — no dedicated unit tests exist for these files today; verified by `tsc` + full suite + Task 4's manual trace.

Note: the design spec flagged `paymentSentMenu()` (`lib/ussd-shop/menus.ts`) as needing its exact string confirmed during planning. Confirmed: `` `MoMo prompt sent to ${localPhone}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.` `` — no "data"/"bundle" wording present, so it is intentionally left unchanged below.

- [ ] **Step 1: Rename the product-menu label**

In `lib/ussd-shop/menus.ts`, find:

```typescript
const PRODUCT_MENU_ITEMS: MenuItemDef<ProductMenuKey>[] = [
  { key: "data", label: "Data Bundle" },
  { key: "airtime", label: "Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]
```

Replace with:

```typescript
const PRODUCT_MENU_ITEMS: MenuItemDef<ProductMenuKey>[] = [
  { key: "data", label: "Browse Services" },
  { key: "airtime", label: "Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]
```

- [ ] **Step 2: Add the nickname import and NETWORK_PRIORITY entry for AT-BigTime**

In `lib/ussd-shop/menus.ts`, find the import line at the top:

```typescript
import { UzoResponse, ShopBundleOption } from "./types"
import { MenuItemDef, resolveMenuItems, renderMenuText } from "../ussd/menu-items"
```

Replace with:

```typescript
import { UzoResponse, ShopBundleOption } from "./types"
import { MenuItemDef, resolveMenuItems, renderMenuText } from "../ussd/menu-items"
import { networkNickname } from "../ussd/network-labels"
```

Then find:

```typescript
const NETWORK_PRIORITY: Record<string, number> = { mtn: 1, telecel: 2, airteltigo: 3, 'at-ishare': 4 }
```

Replace with:

```typescript
const NETWORK_PRIORITY: Record<string, number> = { mtn: 1, telecel: 2, airteltigo: 3, 'at-ishare': 4, 'at-bigtime': 5 }
```

- [ ] **Step 3: Render network-menu entries as nicknames**

In `lib/ussd-shop/menus.ts`, find:

```typescript
export function networkMenu(shopName: string, networks: string[]): string {
  const sorted = sortNetworks(networks)
  const lines = sorted.map((n, i) => `${i + 1}. ${n}`)
  lines.push('0. Back')
  return `${gsm7(shopName)}\nSelect Network:\n` + lines.join('\n')
}
```

Replace with:

```typescript
export function networkMenu(shopName: string, networks: string[]): string {
  const sorted = sortNetworks(networks)
  const lines = sorted.map((n, i) => `${i + 1}. ${networkNickname(n)}`)
  lines.push('0. Back')
  return `${gsm7(shopName)}\nSelect Network:\n` + lines.join('\n')
}
```

This stays fully dynamic (only shows networks the shop actually stocks) — a stocked network with no nickname entry (e.g. a legacy generic `"AirtelTigo"` row) falls back to showing that raw value, per `networkNickname()`'s fallback behavior from Task 1.

- [ ] **Step 4: Reword the package-list header**

In `lib/ussd-shop/menus.ts`, inside `bundleMenu()`, find:

```typescript
  const offset = page * PAGE_SIZE
  const limit = 160
  const header = `${gsm7(shopName)}\nSelect Bundle:\n`
  const back = '0. Back'
```

Replace with:

```typescript
  const offset = page * PAGE_SIZE
  const limit = 160
  const header = `${gsm7(shopName)}\nSelect Package:\n`
  const back = '0. Back'
```

- [ ] **Step 5: Drop "data" from the recipient prompt**

In `lib/ussd-shop/menus.ts`, find:

```typescript
export function recipientPrompt(): string {
  return 'Enter recipient number\n(who gets the data):\n\n0. Back'
}
```

Replace with:

```typescript
export function recipientPrompt(): string {
  return 'Enter recipient number:\n(who gets it):\n\n0. Back'
}
```

(`confirmMenu()` in this file is unchanged for the same reason as main — nickname substitution happens at its call sites, Step 7 below.)

- [ ] **Step 6: Reword the "no networks stocked" message**

In `lib/ussd-shop/handlers/shop.ts`, find:

```typescript
    case 'data': {
      const networks = session.networks ?? []
      if (networks.length === 0) return cont('No bundles available.\n\n' + productMenu(shopName, effective))
```

Replace with:

```typescript
    case 'data': {
      const networks = session.networks ?? []
      if (networks.length === 0) return cont('No packages available.\n\n' + productMenu(shopName, effective))
```

- [ ] **Step 7: Add the nickname import, reword the whitelist-gate message, and use nicknames at both `confirmMenu()` call sites**

In `lib/ussd-shop/handlers/bundles.ts`, find the import block at the top:

```typescript
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentSentMenu, otpMenu, sortNetworks } from "../menus"
import { setSession } from "../session"
```

Replace with:

```typescript
import { cont, end, networkMenu, bundleMenu, recipientPrompt, confirmMenu, paymentSentMenu, otpMenu, sortNetworks } from "../menus"
import { networkNickname } from "@/lib/ussd/network-labels"
import { setSession } from "../session"
```

Then find the whitelist-gate message inside `handleSelectNetwork`:

```typescript
  const hasPurchasedOrWhitelisted = hasPurchasedData === true
  if (whitelistRow?.value?.enabled === true && !hasPurchasedOrWhitelisted) {
    return cont('Data bundles not available.\nSign up on our app\nto unlock this service.\n\n' + networkMenu(session.shopName!, networks))
```

Replace with:

```typescript
  const hasPurchasedOrWhitelisted = hasPurchasedData === true
  if (whitelistRow?.value?.enabled === true && !hasPurchasedOrWhitelisted) {
    return cont('Not available.\nSign up on our app\nto unlock this service.\n\n' + networkMenu(session.shopName!, networks))
```

Then find the "no packages for this network" message, a few lines later in the same function:

```typescript
  const allBundles = await fetchShopBundles(session.shopId!, selectedNetwork, session.parentShopId)

  if (allBundles.length === 0) {
    return cont(`No ${selectedNetwork} bundles available.\n\n${networkMenu(session.shopName!, networks)}`)
  }
```

Replace with:

```typescript
  const allBundles = await fetchShopBundles(session.shopId!, selectedNetwork, session.parentShopId)

  if (allBundles.length === 0) {
    return cont(`No ${networkNickname(selectedNetwork)} packages available.\n\n${networkMenu(session.shopName!, networks)}`)
  }
```

Then find the first `confirmMenu(` call, inside `handleEnterRecipient`:

```typescript
  return cont(confirmMenu(
    session.shopName!,
    session.network!,
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
```

Replace with:

```typescript
  return cont(confirmMenu(
    session.shopName!,
    networkNickname(session.network!),
    session.bundleSize!,
    session.bundlePrice!,
    local,
    session.dialingPhone!
  ))
}

// ── CONFIRM ───────────────────────────────────────────────────────────────────
```

Then find the second `confirmMenu(` call, inside `handleConfirm`'s invalid-input branch:

```typescript
  if (input.trim() !== '1') {
    return cont(confirmMenu(
      session.shopName!,
      session.network!,
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!
    ))
  }
```

Replace with:

```typescript
  if (input.trim() !== '1') {
    return cont(confirmMenu(
      session.shopName!,
      networkNickname(session.network!),
      session.bundleSize!,
      session.bundlePrice!,
      session.recipientPhone!,
      session.dialingPhone!
    ))
  }
```

As with the main flow, `session.network` (and `selectedNetwork`, the same raw value pre-session-write) is left unchanged everywhere else — `fetchShopBundles`, prefix validation, `verifyBundlePrice`, order creation. Only these display points are nicknamed.

- [ ] **Step 8: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: All existing tests still pass (no regressions).

- [ ] **Step 10: Commit**

```bash
git add lib/ussd-shop/menus.ts lib/ussd-shop/handlers/shop.ts lib/ussd-shop/handlers/bundles.ts
git commit -m "$(cat <<'EOF'
feat(ussd-shop): rebrand shop USSD data-bundle flow to "Browse Services"

Product-menu label, network menu (nicknames, AT-BigTime now sortable
and selectable wherever a shop stocks it), package-list header,
recipient prompt, and the two "not available" messages all reworded
per the design spec, mirroring the main USSD's Task 2 changes.
session.network (used for fulfillment, prefix validation, order
creation) is untouched — only display strings change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: All tests pass, including the new `lib/ussd/network-labels.test.ts`.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Trace every reworded screen against the design spec**

There is no interactive USSD simulator in this codebase and no staging Uzo gateway — do not attempt to dial the real shortcode or hit the live `app/api/ussd/route.ts`/`app/api/ussd-shop/route.ts` endpoints against production, since that would exercise real payment flows. Instead, read the final `lib/ussd/menus.ts` and `lib/ussd-shop/menus.ts` in full and manually confirm every screen in the data-bundle path renders exactly as specified:

Main USSD:
1. Main menu shows `"Browse Services"` as item 1 (with AFA/Airtime/Results Checker/Exit unchanged).
2. Network menu reads exactly `Select Network:\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n4. Delay Blue\n0. Back`.
3. Package list header reads `Select Package:` (size/price rows unchanged, e.g. `1. 1GB - GHS 5.50`).
4. Recipient prompt reads `Enter recipient number:\n(who gets it):\n\n0. Back`.
5. Confirm screen's network line uses the nickname (e.g. `1GB Yellow Plans`, not `1GB MTN`).

Shop USSD:
1. Product menu shows `"Browse Services"` as item 1 (Airtime/Results Checker/Exit unchanged).
2. Network menu shows only the nicknames for whatever networks that shop stocks (spot-check against the `sortNetworks`/`NETWORK_PRIORITY` ordering: MTN-equivalent first, then Telecel, then iShare, then BigTime).
3. Package list header reads `Select Package:`.
4. Recipient prompt matches main's new wording.
5. Confirm screen's network line uses the nickname.
6. Whitelist-gate message reads `Not available.\nSign up on our app\nto unlock this service.` (no "Data bundles").

- [ ] **Step 4: Confirm `session.network` values are untouched everywhere except the 6 display points**

Run: `git diff main -- lib/ussd/handlers/bundles.ts lib/ussd-shop/handlers/bundles.ts` and confirm every changed line is either an import addition, the `NETWORK_OPTIONS` table, a `networkNickname(...)` wrap around a `confirmMenu`/error-message argument, or a wording-only string literal — nothing touches how `session.network`, `net.dbName`, or `selectedNetwork` is written to the session, compared against `packages.network` in Supabase queries, or passed to `fulfillUssdOrder`/`validateNetworkPrefix`/`fetchShopBundles`/`verifyBundlePrice`.

- [ ] **Step 5: Report results**

Summarize what was verified. If any screen's copy doesn't match Step 3's checklist exactly, fix it and re-run Steps 1-2 before reporting done.
