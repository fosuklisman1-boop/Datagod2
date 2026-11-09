# Hubtel Main Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second Hubtel USSD code open the main menu with its own settings, while `*713*235#` keeps behaving exactly as it does today.

**Architecture:** The new code's Interaction URL carries `line=main`. The route swaps `deps.getConfig` to a main line loader backed by a new `admin_settings` key, so `hubtelRouter` and all flows run unchanged. The admin API and page gain a second, isolated set of settings.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Supabase, Vitest, shadcn/ui `Tabs`.

**Spec:** `docs/superpowers/specs/2026-11-07-hubtel-main-line-design.md`

## Global Constraints

- Branch `feat/hubtel-main-line`, worktree `.claude/worktrees/hubtel-main-line`. Never push `main` without the owner's OK.
- No migration, and no changes to the relay, callbacks, fulfilment, status checks or crons.
- New key: `hubtel_ussd_main_line_config`. Main line code never reads or writes `hubtel_ussd_config`, and the reverse.
- Only an explicit stored `true` enables the main line; a missing row means off. `mode` is always `main`.
- Unknown line reply text: `Service unavailable. Please try again later.`
- Audit action: `hubtel_ussd_main_line_config_update`.
- Existing Hubtel tests pass unmodified, apart from additions (mock additions included).
- Edit with Edit/Write tools only, never `sed` or shell rewrites. Never log secrets, reply text or customer data.

## Review Focus

- **`?line=main&line=shop` (repeated parameter):** treated as unrecognised, so no menu opens. Pinned in Task 1 and Task 2.
- **Malformed stored row (string, array, `enabled: "true"`):** the main line resolves to off. Pinned in Task 1.
- **Main line config read fails:** the caller gets a well-formed "Service unavailable", and the shop config is never used as a fallback. Pinned in Task 2.
- **A paid cart replays after the session is lost on `line=main`:** the existing replay still answers before any restart. Pinned in Task 3.
- **Blank brand or welcome saved on the main line:** resets only that line to its default. Pinned in Task 4.

---

### Task 1: Line parsing and main line settings

**Files:**
- Create: `lib/ussd-hubtel/line.ts`, `lib/ussd-hubtel/line.test.ts`
- Modify: `lib/ussd-hubtel/config.ts`, `lib/ussd-hubtel/config.test.ts`

**Interfaces:**
- Produces:
  - `parseHubtelLine(values: string[]): "default" | "main" | null`, given `searchParams.getAll("line")`
  - `HUBTEL_USSD_MAIN_LINE_CONFIG_KEY = "hubtel_ussd_main_line_config"`
  - `getHubtelMainLineConfig(supabase): Promise<HubtelUssdConfig>`
  - `setHubtelMainLineConfig(supabase, patch: { enabled?: boolean; visibility?: Partial<HubtelUssdConfig["visibility"]>; brandName?: string; welcome?: string | null }): Promise<HubtelUssdConfig>`

- [ ] **Step 1: Set up the worktree.** If `node_modules` is missing, run `npm ci`. Run `npx vitest run lib/ussd-hubtel/config.test.ts`. Expected: PASS.

- [ ] **Step 2: Write failing tests in `line.test.ts`.** Name: `parseHubtelLine`. Assert:

```ts
expect(parseHubtelLine([])).toBe("default")
expect(parseHubtelLine(["main"])).toBe("main")
for (const bad of [[""], ["MAIN"], ["shop"], ["main "], ["main", "shop"], ["main", "main"]])
  expect(parseHubtelLine(bad)).toBeNull()
```

- [ ] **Step 3: Write failing tests in `config.test.ts`.** Add a fake keyed by `.eq("key", k)`, holding a `Map` of rows and recording upserted keys. Cases:
  - Missing row: `enabled: false`, `mode: "main"`, all six visible, brand `Clingshub`, welcome `Welcome to Clingshub`.
  - Each of `{ enabled: "true" }`, `{ enabled: 1 }`, `"on"`, `[]` resolves to `enabled: false`.
  - Stored `{ enabled: true, mode: "shop" }` resolves to `enabled: true`, `mode: "main"`.
  - Invalid stored brand or welcome falls back to the defaults.
  - Isolation: with both rows seeded, `setHubtelMainLineConfig` upserts only the new key and leaves the shop row deep-equal; `setHubtelUssdConfig` upserts only the old key and leaves the main row deep-equal.
  - `setHubtelMainLineConfig` stores no `mode` field; `welcome: null` clears the override; an invalid brand throws before any upsert; a partial patch keeps the other fields.

- [ ] **Step 4: Run the tests.** `npx vitest run lib/ussd-hubtel/line.test.ts lib/ussd-hubtel/config.test.ts`. Expected: FAIL, functions not defined.

- [ ] **Step 5: Implement.** `line.ts` holds the pure parser. In `config.ts`, reuse `resolveConfig`, passing `{ ...stored, mode: "main" }` for the main line, and extract the validation shared by both setters. `setHubtelUssdConfig` must keep writing the same shape and description. The main line's upsert description: `Hubtel USSD main code: on/off, per-service visibility, brand name, custom welcome line.`

- [ ] **Step 6: Run the tests.** Same command. Expected: PASS, with no existing test edited.

- [ ] **Step 7: Commit** with `feat(ussd-hubtel): main line parser and isolated settings`.

### Task 2: Interaction route selects the line

**Files:**
- Modify: `app/api/ussd-hubtel/interaction/route.ts`, `app/api/ussd-hubtel/interaction/route.test.ts`

**Interfaces:**
- Consumes: `parseHubtelLine`, `getHubtelMainLineConfig` from Task 1.

- [ ] **Step 1: Write failing tests.** Change the mock additively so `defaultRouterDeps` returns `{ getConfig: h.existingGet }`, and mock `getHubtelMainLineConfig` as `h.mainGet`, keeping the rest of the config module real. Cases, each posting a valid body:
  - `?line=main` with a wrong secret: 401, router not called.
  - No `line`: `h.router`'s deps `getConfig` is `h.existingGet`; calling it never touches `h.mainGet`.
  - `?line=main`: calling the deps' `getConfig` calls `h.mainGet` once and never `h.existingGet`.
  - `?line=`, `?line=MAIN`, `?line=shop` and `?line=main&line=shop`: 200, `Type: "release"`, `Message: "Service unavailable. Please try again later."`, router not called, and `console.warn` output contains neither the secret nor the mobile number.
  - `?line=main` with the router rejecting, as it does when `getConfig` throws: 200, `release`, and `h.existingGet` never called.

- [ ] **Step 2: Run the tests.** `npx vitest run app/api/ussd-hubtel/interaction/route.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** After `parseHubtelRequest` succeeds, so the reply carries `SessionId` and `Platform`, call `parseHubtelLine(request.nextUrl.searchParams.getAll("line"))`. On `null`: warn and return `release(...)` before any router or transcript call. On `"main"`: override `getConfig` in `deps` with `() => getHubtelMainLineConfig(supabase)`. Add `line` to the `[HUBTEL] Incoming` log object. Update the URL comment at the top of the handler.

- [ ] **Step 4: Run the tests.** Same command. Expected: PASS, including the existing logging test.

- [ ] **Step 5: Commit** with `feat(ussd-hubtel): route line=main to the main menu settings`.

### Task 3: Router behaviour on the main line

**Files:**
- Modify: `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/router.test.ts`

**Interfaces:**
- Consumes: `HubtelUssdConfig` shape only; `hubtelRouter` keeps its signature. For six-item menus, follow `router.bot-menus.test.ts` to open the `botMenus` gate.

- [ ] **Step 1: Write failing and regression tests** in a new `describe("hubtelRouter: separate lines")`, using `makeDeps` with `getConfig` standing in for each line:
  - Main config `{ enabled: true, mode: "main" }` with the bot gate open: `Initiation` shows all six labels in menu order and stores `mode: "main"`.
  - Main config `enabled: false`: `release`, even with a live `MAIN` session in the store.
  - Shop config `enabled: true` is unaffected: `Initiation` still shows `Enter shop code:`.
  - `Response` with no session on the main config restarts on the main menu with `Session expired.`, never the shop prompt.
  - Lost session with a submitted paid cart, using the existing replay test's setup with the main config: replay reply returned, no menu.
  - Screen limit: `Platform: "USSD"`, a 60-character welcome, all six items, no session on `Response`. Assert `Message.length <= USSD_SCREEN_LIMIT`, `Message.endsWith("0. Exit")`, `Message` contains the whole welcome and doesn't end in `...`.

- [ ] **Step 2: Run the tests.** `npx vitest run lib/ussd-hubtel/router.test.ts`. Expected: only the screen limit test FAILS (191 characters are cut). If another fails, stop and find out why before changing anything: the design assumed the router needs no line logic.

- [ ] **Step 3: Implement** in `startSession` only: when `prefix + menu` exceeds `USSD_SCREEN_LIMIT`, send the menu without the prefix.

- [ ] **Step 4: Run all Hubtel library tests.** `npx vitest run lib/ussd-hubtel`. Expected: PASS.

- [ ] **Step 5: Commit** with `fix(ussd-hubtel): keep the full main menu when the expiry notice would overflow`.

### Task 4: Admin API

**Files:**
- Modify: `app/api/admin/ussd-hubtel/config/route.ts`, `app/api/admin/ussd-hubtel/config/route.test.ts`

**Interfaces:**
- Consumes: `getHubtelMainLineConfig`, `setHubtelMainLineConfig` from Task 1.
- Produces:
  - `GET` returns `{ config, mainLine, env }`, with `config` unchanged because `/admin/utility-bills` reads it.
  - `POST { line: "main", enabled?, visibility?, brandName?, welcome? }` returns `{ mainLine }`.
  - `POST` without `line` still returns `{ config }`.

- [ ] **Step 1: Write failing tests.** Add `h.getMain` and `h.setMain` to the config mock. Cases:
  - `GET` includes `mainLine` and an unchanged `config`.
  - `POST { line: "main", enabled: true }` calls `h.setMain` and never `h.set`, and the response has `mainLine`.
  - `POST` without `line` calls `h.set` and never `h.setMain`.
  - `line: "main"` with `mode`: 400, nothing written. `line` of `"shop"`, `""`, `null` or `1`: 400, nothing written.
  - `line: "main", enabled: true` with env not ready: 400, nothing written.
  - Invalid visibility, brand or welcome with `line: "main"`: 400, nothing written.
  - `line: "main", brandName: "  "` calls `h.setMain` with `DEFAULT_BRAND`. `line: "main", welcome: ""` calls it with `welcome: null`. `h.set` is not called in either case.
  - Audit row: action `hubtel_ussd_main_line_config_update`, with `old_value` and `new_value` from the main line. Non-admin: rejected, as on the existing route.

- [ ] **Step 2: Run the tests.** `npx vitest run app/api/admin/ussd-hubtel/config/route.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Validate `line` right after the body type check, then reuse the existing validation for both lines and branch only at read, write, audit and response.

- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(admin): configure the Hubtel main code separately`.

### Task 5: Admin page tabs

**Files:**
- Create: `components/admin/hubtel-line-settings.tsx`
- Modify: `app/admin/ussd-hubtel/page.tsx`

**Interfaces:**
- Consumes: the Task 4 API.
- Produces: `HubtelLineSettings({ line, config, envOk, busy, onSave }: { line: "shop" | "main"; config: HubtelUssdConfig | null; envOk: boolean; busy: string | null; onSave: (patch: object, label: string) => void })`.

- [ ] **Step 1: Move** the Channel, Brand name and Welcome message cards, with their draft state, from the page into `HubtelLineSettings`, keeping behaviour the same. The Mode selector, its confirmation and shop mode notes render only for `line === "shop"`. Prefix `busy` labels with the line so one tab's saving state never disables the other's controls.

- [ ] **Step 2: Add the tabs** using `components/ui/tabs`: `Main code` and `Shop code`, with `defaultValue="shop"`. Hold `mainLine` state in the page, and load it from `GET`. On the main tab, `save` adds `line: "main"` to the body and stores `res.mainLine`; on the shop tab it stays as today. Transactions, sessions, environment and callback logs stay below the tabs.

- [ ] **Step 3: Add the tab copy.**
  - Header subtitle: `Two Hubtel codes: the main menu and the shop menu. Configure each one and watch payments.`
  - Shop tab note: `These settings apply to the existing URL, with no line parameter.`
  - Main tab, a "URLs to register with Hubtel" block, using the literal placeholder and never the real secret:
    - `https://www.datagod.store/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>&line=main`
    - `https://www.datagod.store/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>`
  - Main tab has no Mode selector, and all six services are toggleable.

- [ ] **Step 4: Apply the layout.** Brand and Welcome cards use `lg:grid-cols-2`. No sidebar change.

- [ ] **Step 5: Verify.** `npx tsc --noEmit`. Expected: no new errors. A visual check needs an admin login, so try it on a local dev server if a session is available. If not, record it as an owner check after the deploy.

- [ ] **Step 6: Commit** with `feat(admin): tabs for the Hubtel main and shop codes`.

### Task 6: Runbook and full verification

**Files:**
- Modify: `docs/hubtel-ussd-runbook.md`

- [ ] **Step 1: Update the runbook** with a new section covering the two codes:
  - The URLs and the `line` rules.
  - The spec's Launch steps and its post-deploy checks.
  - Each code's switch is independent.
  - The `/admin/utility-bills` Pay Bills status reflects the shop code only.
  - Correct the opening claim of one code per deployment wherever it appears.

- [ ] **Step 2: Run the full checks.**
  - `npx tsc --noEmit`: no errors.
  - `npm run test:run`: only the 9 known `lib/order-health-service.test.ts` failures.
  - A real placeholder-env `npx next build`: succeeds.

- [ ] **Step 3: Commit** with `docs(ussd-hubtel): runbook for the separate main code`.

- [ ] **Step 4: Get a fresh review** of the whole branch, including the abuse-case pass (free, someone else's, twice, cheaper, no auth, at scale) and the spec's anti-goals. Verify each finding, then fix real ones with a failing test first.

- [ ] **Step 5: Stop for the owner's OK** before merging to `main`. After approval: check local `main` for other sessions' commits, merge, push, watch the deploy, then run the spec's post-deploy checks.
