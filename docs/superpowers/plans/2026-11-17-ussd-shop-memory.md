# USSD Shop Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Returning callers on both shop USSD codes press `1` to reach the shop they last used. That remembered shop is stored as one row per phone, shared by USSD, SMS and WhatsApp.

**Architecture:** Migration 0183 adds a new table, `shop_customer_prefs`, backfilled from `ttb_shop_prefs` and `wa_shop_customer_prefs`. One module, `lib/shop-commerce/customer-prefs.ts`, sits in front of it. The SMS store and the WhatsApp prefs module keep their exported signatures but delegate to that module, so their call sites barely move. The Hubtel and Uzo shop code screens get an optional `1. <name> (last used)` line, gated by the admin setting `ussd_shop_memory_enabled`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (PostgREST), Vitest, PGlite for SQL tests.

**Spec:** `docs/superpowers/specs/2026-11-17-ussd-shop-memory-design.md`

## Global Constraints

- Build in a worktree off `origin/main` (base 3e7531f4 or newer), on branch `feat/ussd-shop-memory`. The first commit is the spec file, copied from the main checkout.
- Make code edits with Edit/Write only, never sed or other shell edits. Tell every subagent.
- Phones in the table are local `0XXXXXXXXX` only, with CHECK `^0[0-9]{9}$`. Inputs may be `+233…`, `233…` or `0…`.
- `last_channel` is one of `ussd_hubtel`, `ussd_uzo`, `sms` or `whatsapp`.
- Never log a phone number. Log only ids and `safeDbError(e)`-style messages.
- Pref writes are best-effort. A failed write never fails the caller's reply or changes it.
- The USSD shortcut shows only when `admin_settings` key `ussd_shop_memory_enabled` has `value.enabled === true`. A missing row or a read error counts as OFF.
- With the switch OFF, or with no usable memory, every USSD screen stays byte-for-byte as it is today.
- The shortcut line text is exactly `1. <name> (last used)`. `<name>` is the shop's display name, trimmed and cut to 20 characters, with no ellipsis character.
- The builder does NOT apply the migration. Applying it to production follows the prod change protocol (dry run, then owner OK) after review.
- Vitest: run from PowerShell or from an uppercase `C:/` working directory. A lowercase `c:/` working directory breaks `vi.mock`.

## Review Focus

1. **The remembered shop was closed or blocked between the offer and `1`.** Expect the plain prompt plus `That shop is unavailable.`, no attempt counted, and no `1.` line. Tests: Task 5 and Task 6.
2. **A phone written in the WhatsApp form (`233…`) is later read by USSD (`+233…`).** The two must match. Tests: Task 2 (`toLocalPhone`) and Task 4 (WhatsApp delegation writes the local form).
3. **The Hubtel session is lost and the caller then presses `1`.** The recovery path must re-read the memory and open the shop, not use up an attempt. Test: Task 5.
4. **A caller with a remembered shop types a wrong code twice, then presses `1`.** The retry screen keeps the `1.` line, and `1` still works on the third attempt. Tests: Task 5 and Task 6.
5. **The remembered shop is not WhatsApp-activated.** WhatsApp falls through to code entry, and the shared row survives for USSD. Test: Task 4.

---

### Task 1: Migration 0183 — shared table + backfill

**Files:**
- Create: `migrations/0183_shop_customer_prefs.sql`, `migrations/0183_shop_customer_prefs.selftest.sql`
- Test: `lib/shop-commerce/migration-0183.test.ts`. Mirror `lib/text-to-buy/migration-0180.test.ts`: PGlite, apply the prerequisite tables, then 0183, then the selftest.

**Interfaces:**
- Produces: the table `public.shop_customer_prefs(phone text PK, shop_code_id uuid NOT NULL FK ussd_shop_codes(id) ON DELETE CASCADE, last_channel text NOT NULL, last_used_at timestamptz NOT NULL DEFAULT now())`.

- [ ] **Step 1: Write the failing tests** in `migration-0183.test.ts`:
  - `creates the table with RLS on and zero policies`.
  - `rejects phone '+233241234567' and channel 'web'` (CHECK violations).
  - `backfills newest-wins`: a ttb row `0241234567`→codeA at T1 and a wa row `233241234567`→codeB at T2, with T2 > T1, leave one row: codeB, channel `whatsapp`.
  - `normalises '+233' and '233' wa phones and skips malformed ones`: `23324` is skipped.
  - `is re-runnable`: applying it twice gives no error and no duplicates.
  - `cascades on code delete`.
- [ ] **Step 2: Run** `npx vitest run lib/shop-commerce/migration-0183.test.ts`. Expected: FAIL, because the file is missing.
- [ ] **Step 3: Write the migration:**
  - `CREATE TABLE IF NOT EXISTS` with the two CHECKs.
  - `ENABLE ROW LEVEL SECURITY`, and `REVOKE ALL … FROM anon, authenticated`.
  - The backfill: `INSERT … SELECT DISTINCT ON (phone) … ORDER BY phone, last_used_at DESC ON CONFLICT (phone) DO NOTHING`, over a `UNION ALL` of:
    - `ttb_shop_prefs`: phone from `sender`, channel `sms`.
    - `wa_shop_customer_prefs`: phone via `regexp_replace(phone, '^\+?233', '0')`, channel `whatsapp`.

    Keep only phones matching `^0[0-9]{9}$`.
  - The selftest raises unless RLS is on, there are no policies and anon has no privilege. It rolls itself back, the same way 0180's selftest does.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shop-memory): migration 0183 shared shop_customer_prefs with backfill`.

### Task 2: Shared module `customer-prefs.ts`

**Files:**
- Create: `lib/shop-commerce/customer-prefs.ts`, `lib/shop-commerce/customer-prefs.test.ts`

**Interfaces:**
- Consumes: `resolveShopCode(code)` and `ResolvedShopCode` from `lib/shop-commerce/shop-code.ts`.
- Produces the following. Every function takes `db: Pick<SupabaseClient, "from">` as its first argument.
  - `type PrefChannel = "ussd_hubtel" | "ussd_uzo" | "sms" | "whatsapp"`.
  - `class CustomerPrefsError extends Error`.
  - `toLocalPhone(raw: string): string | null`.
  - `getCustomerShopCodeId(db, phone: string): Promise<string | null>`. Throws `CustomerPrefsError` on a DB error.
  - `rememberCustomerShop(db, phone: string, shopCodeId: string, channel: PrefChannel): Promise<void>`. Upserts on `phone` and sets `last_used_at` to now. Throws on a DB error. Does nothing for a phone that won't normalise.
  - `lastBoughtShopCodeId(db, phone: string): Promise<string | null>`. Moved unchanged from `lib/text-to-buy/store.ts`, along with `dialingForms` and `NOT_BOUGHT`. Throws `CustomerPrefsError`.
  - `resolveShopCodeById(db, shopCodeId: string, lookup = resolveShopCode): Promise<ResolvedShopCode | null>`. Moved from `shopCodeByIdWith` in `lib/text-to-buy/shop/default-deps.ts`.
  - `type RememberedShop = { shopCodeId: string; shopName: string }`.
  - `rememberedShopForUssd(db, phone: string, channel: PrefChannel): Promise<RememberedShop | null>`. Never throws: it logs ids only and returns null.
  - `isShopMemoryEnabled(db): Promise<boolean>`. Never throws, and returns false on any failure.

- [ ] **Step 1: Write the failing tests**, using the repo's fake-client pattern.
  - `toLocalPhone`:
    - `'+233241234567'`, `'233241234567'` and `'0241234567'` all give `'0241234567'`.
    - `'24123'`, `''` and `'+44…'` give null.
  - `rememberCustomerShop upserts local phone + channel`: asserts the upserted row and `onConflict: "phone"`.
  - `rememberedShopForUssd`:
    - (a) A pref row whose joined code is `active` and whose shop is `is_active` gives `{shopCodeId, shopName: ussd_display_name || shop_name}`, using exactly one `from()` call.
    - (b) A pref row whose shop has `is_blocked: true` gives null, and the last purchase is NOT checked.
    - (c) A pref row whose code has `status: 'suspended'` gives null.
    - (d) No pref row, plus a last-bought code that resolves active, gives that shop and seeds the pref once with the given channel.
    - (e) No pref row and no purchase gives null.
    - (f) A DB error gives null and does not throw.
  - `isShopMemoryEnabled`: `{enabled:true}` gives true. A missing row, `{enabled:"true"}` or a read error gives false.
- [ ] **Step 2: Run** `npx vitest run lib/shop-commerce/customer-prefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The pref path of `rememberedShopForUssd` is ONE embedded select: `from("shop_customer_prefs").select("shop_code_id, ussd_shop_codes(status, user_shops(shop_name, ussd_display_name, is_active, is_blocked))").eq("phone", local).maybeSingle()`.
  - A shop counts as active when the code's `status === "active"`, `is_blocked !== true` and `is_active !== false`. This is the same rule `resolveShopCode` uses.
  - The no-row path runs `lastBoughtShopCodeId`, then `resolveShopCodeById`, then seeds the pref with `rememberCustomerShop`, catching any error from the seed.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shop-memory): shared customer-prefs module`.

### Task 3: SMS shop line + missed-call helper use the shared table

**Files:**
- Modify:
  - `lib/text-to-buy/store.ts`: `getShopPref`, `setShopPref` and `lastBoughtShopCodeId`, around lines 819-862.
  - `lib/text-to-buy/shop/default-deps.ts`: `shopCodeByIdWith` becomes a re-export or thin wrapper of `resolveShopCodeById`.
- Test: `lib/text-to-buy/store.test.ts`, and `lib/text-to-buy/fake-db.test-helper.ts` (table name).

**Interfaces:**
- Consumes: Task 2's `getCustomerShopCodeId`, `rememberCustomerShop(…, "sms")`, `lastBoughtShopCodeId` and `resolveShopCodeById`.
- Produces: the same exported signatures as today: `getShopPref(db, sender)`, `setShopPref(db, sender, shopCodeId)` and `lastBoughtShopCodeId(db, senderLocal)`. They still throw `TtbStoreError` on failure, so wrap `CustomerPrefsError`.

- [ ] **Step 1: Update the tests.** The store tests now expect table `shop_customer_prefs`, column `phone` and `last_channel: "sms"`. Add `setShopPref then getShopPref round-trips`.
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy`. Expected: the updated store tests FAIL and everything else passes.
- [ ] **Step 3: Implement the delegation.** Don't touch `resolve.ts`, `lane.ts`, `call/decide.ts` or the Try-it route.
- [ ] **Step 4: Run** `npx vitest run lib/text-to-buy app/api/admin/text-to-buy`. Expected: PASS, including the lane golden tests.
- [ ] **Step 5: Commit** `refactor(ttb): shop prefs read/write the shared table`.

### Task 4: WhatsApp shop bot uses the shared table, never deletes

**Files:**
- Modify:
  - `lib/whatsapp-bot/shop-prefs.ts`.
  - `lib/whatsapp-bot/shop-router.ts`, lines 426-455.
  - `lib/ai-tools.ts`, lines 1211-1225: `currentShopForPhone` now uses `resolveShopCodeById`.
- Test:
  - `lib/whatsapp-bot/shop-prefs.test.ts` (create it).
  - The existing shop-router test file, if one covers returning customers. Find it with `grep -l getShopPref lib/whatsapp-bot/*.test.ts`.

**Interfaces:**
- Consumes: Task 2's functions, with channel `"whatsapp"`.
- Produces:
  - `getShopPref(phone)` and `setShopPref(phone, shopCodeId)`, signatures unchanged. Both normalise the phone with `toLocalPhone`.
  - `getShopPref` returns null on a read error, which matches today's behaviour of swallowing errors.
  - `clearShopPref` is DELETED.

- [ ] **Step 1: Write the failing tests:**
  - `setShopPref('233241234567', id) writes phone '0241234567' channel 'whatsapp'`.
  - `getShopPref reads by local phone`.
  - In the router: `a remembered shop that is not WhatsApp-activated falls through to code entry and does not delete the pref`. Assert that no `delete` call reaches `shop_customer_prefs`.
- [ ] **Step 2: Run** `npx vitest run lib/whatsapp-bot`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Delegate in `shop-prefs.ts`. In `shop-router.ts`, replace the `else { await clearShopPref(from) }` branch so it simply falls through, and remove the import.
- [ ] **Step 4: Run** `npx vitest run lib/whatsapp-bot lib/ai-tools`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(wa-shop): shared shop memory, never delete on ineligibility`.

### Task 5: Hubtel shop code screen shortcut

**Files:**
- Modify:
  - `lib/ussd-hubtel/menus.ts`: `shopCodePromptText` and `shopCodeRetryText`.
  - `lib/ussd-hubtel/types.ts`: `HubtelSession`.
  - `lib/ussd-hubtel/shop-services.ts`: `ShopServices` and `defaultShopServices`.
  - `lib/ussd-hubtel/flows/shop.ts`.
  - `lib/ussd-hubtel/testing/fakes.ts`.
- Test: `lib/ussd-hubtel/flows/shop.test.ts` and `lib/ussd-hubtel/menus.test.ts`.

**Interfaces:**
- Consumes: Task 2's `rememberedShopForUssd(db, phone, "ussd_hubtel")`, `rememberCustomerShop`, `isShopMemoryEnabled` and `resolveShopCodeById`.
- Produces:
  - `shopCodePromptText(welcome: string, remembered?: string): string` and `shopCodeRetryText(reason: string, remembered?: string): string`. When `remembered` is set, they add the line `1. <shortName> (last used)` just before `0. Exit`.
  - `shortShopName(name: string): string`, exported from `menus.ts`. It trims the name and cuts it at 20 characters. Task 6 imports it.
  - Two new session fields: `HubtelSession.rememberedShopCodeId?: string` and `rememberedShopName?: string`.
  - Three additions to `ShopServices`:
    - `remembered(phone: string): Promise<RememberedShop | null>`, which returns null when the switch is off.
    - `remember(phone: string, shopCodeId: string): Promise<void>`.
    - `resolveById(shopCodeId: string): Promise<ResolvedShopCode | null>`.

- [ ] **Step 1: Write the failing tests** in `flows/shop.test.ts`, using the fakes:
  - `switch off / no memory: prompt is exactly today's text`.
  - `memory: prompt shows '1. KofiData (last used)'`.
  - `'1' opens the remembered shop's product menu, same as typing its code`: compare the reply text and session with the typed-code path.
  - `'1' does not increment shopCodeAttempts`.
  - `'1' when the shop closed since the offer: 'That shop is unavailable.' + plain prompt, attempts unchanged, rememberedShopCodeId cleared`.
  - `wrong code keeps the 1. line on the retry screen; '1' still works after two wrong codes`.
  - `typing a valid active code calls remember(phone, id)`.
  - `a remember() rejection still returns the product menu`.
  - `'1' also calls remember (touch)`.
  - `recoverShopCodeEntry with '1' re-reads memory and opens the shop`.
  - `recoverShopCodeEntry with '1' and no memory counts as a wrong code`.

  In `menus.test.ts`: `shortShopName cuts at 20`.
- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - In `startShopSession`, call `deps.shop.remembered(req.Mobile)` once and store the shop's id and name in the session.
  - Pull the accepted-shop branch of `enterCode` out into `enterShop(ctx, shop: ResolvedShopCode)`, so a typed code and `1` share the networks lookup and the session write.
  - In `enterCode`, check `input === "1" && ctx.session.rememberedShopCodeId` before `SHOP_CODE_RE`.
  - Make the `remember` calls through `deps.defer?.(…)` when it exists, otherwise await them with a catch.
- [ ] **Step 4: Run** `npx vitest run lib/ussd-hubtel app/api/ussd-hubtel`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ussd-hubtel): remembered shop shortcut on the shop code screen`.

### Task 6: Uzo shop code screen shortcut

**Files:**
- Modify:
  - `lib/ussd-shop/menus.ts`: `enterShopCodeMenu` and `invalidCodeMenu`.
  - `lib/ussd-shop/types.ts`: `USSDShopSession`.
  - `lib/ussd-shop/router.ts`: the three `ENTER_SHOP_CODE` + `enterShopCodeMenu()` sites, around lines 70, 84 and 172.
  - `lib/ussd-shop/handlers/shop.ts`.
- Test: `lib/ussd-shop/handlers/shop.test.ts`, plus a router test if one exists (`ls lib/ussd-shop/*.test.ts`). The Uzo golden snapshot must not change while the switch is off.

**Interfaces:**
- Consumes: Task 2's functions with channel `"ussd_uzo"`, and `shortShopName` from `lib/ussd-hubtel/menus.ts`.
- Produces:
  - `enterShopCodeMenu(remembered?: string): string` and `invalidCodeMenu(reason: string, remembered?: string): string`. They add the same line as Task 5. With no argument, the output doesn't change.
  - Two new session fields: `USSDShopSession.rememberedShopCodeId?: string` and `rememberedShopName?: string`.
  - `shopCodePrompt(sessionId: string, dialingPhone: string, prefix?: string): Promise<UzoResponse>` in `handlers/shop.ts`:
    - It reads the switch and the memory, writes the `ENTER_SHOP_CODE` session, and returns `cont(prefix + enterShopCodeMenu(name))`.
    - The router uses it at all three sites.
    - The "back" sites in `bundles.ts`, `airtime.ts` and `results-checker.ts` stay as they are.

- [ ] **Step 1: Write the failing tests** that mirror Task 5's, as far as they apply to Uzo:
  - With the switch off, the prompt doesn't change.
  - With a remembered shop, the prompt shows the line.
  - `1` opens the shop and runs the whitelist check, with `dataBlocked` worked out the same way as for a typed code.
  - The shop closed since it was offered.
  - A wrong code keeps the line.
  - A valid typed code is remembered with `ussd_uzo`.
  - A failed remember does no harm.
- [ ] **Step 2: Run** `npx vitest run lib/ussd-shop lib/ussd/bots`. Expected: the new tests FAIL, and the golden snapshot passes.
- [ ] **Step 3: Implement.**
  - Pull the post-resolve part of `handleEnterShopCode` out into `enterShop(resolved, sessionId, dialingPhone)`.
  - In `handleEnterShopCode`, handle `1` against `session.rememberedShopCodeId`. The function gains a `session` parameter, so update the router's call.
  - Uzo has no cap on code attempts today. Don't add one.
- [ ] **Step 4: Run** `npx vitest run lib/ussd-shop lib/ussd`. Expected: PASS, with the snapshot unchanged.
- [ ] **Step 5: Commit** `feat(ussd-shop): remembered shop shortcut on the Uzo shop code screen`.

### Task 7: Admin switch

**Files:**
- Create: `app/api/admin/settings/ussd-shop-memory/route.ts`, copied from `app/api/admin/settings/ussd-whitelist/route.ts`: GET/POST, `verifyAdminAccess`, value `{ enabled }`. The setting's description is "Offer the caller's remembered shop as option 1 on the shop USSD code screens".
- Modify: `app/admin/settings/page.tsx`. Add a toggle card next to the USSD data whitelist card, with the title "USSD shop memory" and the hint "Callers who bought before press 1 for their last shop instead of typing the code."
- Test: `app/api/admin/settings/ussd-shop-memory/route.test.ts`:
  - `401 without admin`.
  - `400 when enabled is not boolean`.
  - `POST upserts key ussd_shop_memory_enabled {enabled:true}`.
  - `GET returns enabled false when no row`.
- [ ] **Steps 1-4:** Write the tests, run them and confirm they FAIL, implement, then run them again and confirm they PASS.
- [ ] **Step 5:** Commit `feat(admin): USSD shop memory switch`. The whitelist toggle doesn't use the admin-action notifier, so this switch doesn't either; say so in the commit body.

### Task 8: Whole-branch verification and hand-off (no prod actions)

- [ ] **Step 1:** Run `npx vitest run`. Expected: only the known baseline failures (the order-health set plus the documented flaky tests). List any new failure.
- [ ] **Step 2:** Run `npx tsc --noEmit` and compare with the baseline. Expected: no new errors.
- [ ] **Step 3:** Run `next build` with placeholder env values. Expected: exit 0.
- [ ] **Step 4:** Confirm that no live shop code is the single character `1`: `SELECT count(*) FROM ussd_shop_codes WHERE code = '1'` must return 0. Run it read-only through the Management API, and record the result in the PR body.
- [ ] **Step 5:** Dry-run 0183 on prod inside a transaction ending in `ROLLBACK`, and report the row count from each source table and the merged total.

  **Stop here.** Each of these steps waits for the owner's OK, in this order: apply the migration, deploy the code, turn the switch on, then do live test dials on `*713*235#` and on the Uzo shop code.
- [ ] **Step 6:** Run an Opus final review of the whole branch. It's required because there's a schema change. Fix each finding by writing a failing test first.
