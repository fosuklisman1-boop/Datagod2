# Block Unverified Numbers Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin toggle (`block_unverified`) that turns the customer-facing MTN number verification from a warning into a hard block on every ordering surface.

**Architecture:** One shared server-side helper in `lib/mtn-providers/customer-verification.ts` (`verifyRecipientsForOrder`, `isRecipientBlocked`) decides per number: verified / positively rejected / unchecked, and whether blocking is on. Every order path calls it before any charge; outages and timeouts never block. The web UIs read `blocking` from `/api/verify-phone-live` to hide "proceed anyway" options.

**Tech Stack:** Next.js route handlers, Supabase `admin_settings`, Vitest, React (shadcn/ui).

**Spec:** `docs/superpowers/specs/2026-10-29-block-unverified-numbers-toggle-design.md`

Run tests with `npx vitest run <paths>`. Baseline before starting: all green.

---

## File map

| File | Responsibility |
|---|---|
| `lib/mtn-providers/customer-verification.ts` | Settings (`block_unverified`), `resolveVerdicts` (moved from v2), `verifyRecipientsForOrder`, `isRecipientBlocked`, `isBlockingOn`, messages |
| `lib/api-v2/endpoints/data-deps.ts` | Re-export `resolveVerdicts` as `resolveMtnVerdicts`; new `mtnBlocking` dep |
| `lib/api-v2/endpoints/data.ts` | 409 / skip only when `mtnBlocking()` |
| `lib/api-v2/docs/registry.ts` | Doc notes mention the admin setting |
| `app/api/admin/settings/customer-verification/route.ts` | Accept/preserve `block_unverified` |
| `app/admin/settings/mtn/page.tsx` | Second switch |
| `app/api/verify-phone-live/route.ts` | Use the verdict helper, return `blocking` |
| `app/api/shop/orders/create/route.ts`, `app/api/orders/purchase/route.ts`, `app/api/orders/create-bulk/route.ts` | Server gate, 409 `NUMBER_NOT_VERIFIED` |
| `app/api/v1/orders/route.ts` | Check moved before placement; 409 when blocking |
| `lib/ussd-hubtel/{flow-kit,confirm-note,recipient-step,router}.ts`, `flows/data.ts`, `flows/shop-data.ts` | Blocked → re-prompt for another number |
| `lib/ussd/handlers/bundles.ts` (also used by the WhatsApp main bot), `lib/ussd-shop/handlers/bundles.ts`, `lib/whatsapp-bot/shop-router.ts` | Blocked → re-prompt |
| `app/shop/[slug]/storefront-client.tsx`, `app/dashboard/data-packages/page.tsx` | Hard stop instead of "Proceed anyway" |
| `components/bulk-orders-form.tsx` | Hide "Proceed with all", list + copy removed numbers |

---

### Task 1: Settings + shared verdict helper

**Files:** Modify `lib/mtn-providers/customer-verification.ts`; Test `lib/mtn-providers/customer-verification.test.ts`

- [ ] **Step 1: Failing tests** (append to the test file)

```ts
describe("getCustomerVerificationSettings block_unverified", () => {
  it("defaults block_unverified to false when missing", async () => { /* row value {enabled:true, providers:["xpress"]} → block_unverified:false */ })
  it("reads block_unverified:true", async () => { /* row value {..., block_unverified:true} → true */ })
})

describe("verifyRecipientsForOrder", () => {
  const on = { enabled: true, providers: ["xpress"], block_unverified: true }
  it("blocks a positive reject when blocking is on", async () => {
    const r = await verifyRecipientsForOrder(["0551111111", "0559999999"], { registry: [fakeEntry("xpress", new Set(["0551111111"]))], settings: on })
    expect(r.blocking).toBe(true)
    expect(r.blocked).toEqual(["0559999999"])
    expect(r.verdicts.get("0551111111")).toBe(true)
  })
  it("reports but does not block when block_unverified is off", async () => { /* blocked [] , verdict false */ })
  it("never blocks when every provider throws (outage)", async () => { /* checkBatch throws → verdict null, blocked [] */ })
  it("never blocks on timeout", async () => { /* checkBatch never resolves, timeoutMs: 20 → blocked [] */ })
  it("never blocks when the feature is disabled", async () => { /* enabled:false → blocking false */ })
})

describe("isRecipientBlocked", () => {
  it("is false for non-MTN networks without calling providers", async () => { /* network "Telecel" */ })
})
```

- [ ] **Step 2:** Run `npx vitest run lib/mtn-providers/customer-verification.test.ts`: expect FAIL (not exported).

- [ ] **Step 3: Implement.**
  - `CustomerVerificationSettings` gains `block_unverified?: boolean`; `getCustomerVerificationSettings()` returns `block_unverified: value.block_unverified === true`; the default has `block_unverified: false`.
  - Move `resolveMtnVerdicts`, `MtnVerifyIo` and `errName` from `lib/api-v2/endpoints/data-deps.ts` verbatim as `resolveVerdicts` / `VerdictIo` (log tag `[CUSTOMER-VERIFICATION]`).
  - Add:

```ts
export const NOT_VERIFIED_MESSAGE =
  "This MTN number is not verified for data and can't be ordered. Please use a different number."
export const NOT_VERIFIED_CODE = "NUMBER_NOT_VERIFIED"

export function isBlockingOn(s: CustomerVerificationSettings): boolean {
  return s.enabled && s.block_unverified === true && s.providers.length > 0
}

export type OrderVerification = { verdicts: Map<string, boolean | null>; blocking: boolean; blocked: string[] }

export async function verifyRecipientsForOrder(
  phones: string[],
  opts: { timeoutMs?: number; registry?: WhitelistEntry[]; settings?: CustomerVerificationSettings } = {}
): Promise<OrderVerification> {
  try {
    const settings = opts.settings ?? await getCustomerVerificationSettings()
    const verdicts = await resolveVerdicts(phones, {
      settings: async () => settings,
      registry: opts.registry ?? WHITELIST_REGISTRY,
      check: (p, reg, s) => checkCustomerFacingVerification(p, reg, s),
      timeoutMs: opts.timeoutMs ?? (phones.length > 1 ? 10_000 : 5_000),
    })
    const blocking = isBlockingOn(settings)
    const blocked = blocking ? [...new Set(phones)].filter(p => verdicts.get(p) === false) : []
    return { verdicts, blocking, blocked }
  } catch {
    return { verdicts: new Map(phones.map(p => [p, null])), blocking: false, blocked: [] }
  }
}

export async function isRecipientBlocked(network: string | null | undefined, phone: string): Promise<boolean> {
  if ((network ?? "").trim().toUpperCase() !== "MTN") return false
  return (await verifyRecipientsForOrder([phone])).blocked.length > 0
}
```

  - In `data-deps.ts`: `export { resolveVerdicts as resolveMtnVerdicts, type VerdictIo as MtnVerifyIo } from "@/lib/mtn-providers/customer-verification"`.

- [ ] **Step 4:** Run `npx vitest run lib/mtn-providers lib/api-v2`: expect PASS. If the data-deps tests assert the `[API v2]` log text, keep a thin wrapper in data-deps that logs that tag instead of re-exporting.
- [ ] **Step 5:** Commit `feat(verification): block_unverified setting and shared order verdict helper`.

### Task 2: Admin settings route + UI switch

**Files:** `app/api/admin/settings/customer-verification/route.ts`, its `route.test.ts`, `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Failing tests:**
  - POST with `block_unverified: "yes"` → 400.
  - POST `{enabled:true, providers:[], block_unverified:true}` → 200 and `settings.block_unverified === true`.
  - POST without the field keeps the stored value: `maybeSingleMock` returns `{block_unverified:true}`, so the response is `true`.
  - Update the GET default expectation to `{ enabled:false, providers:[], block_unverified:false }`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement.** Destructure `block_unverified`. If it's not `undefined` and not a boolean → 400. If it's omitted, use `(await getCustomerVerificationSettings()).block_unverified`. Save `{ enabled, providers, block_unverified }`.
- [ ] **Step 4: UI.**
  - Add state `custVerifyBlock`, loaded from `d.settings?.block_unverified ?? false`.
  - `saveCustomerVerificationSetting(enabled, providers, block = custVerifyBlock)` sends `block_unverified: block`.
  - Render a second `Switch` labelled "Block unverified numbers", with helper text "Customers can't proceed with an MTN number the selected providers reject. Provider outages never block." It is disabled unless `custVerifyEnabled && custVerifyProviders.length > 0`.
- [ ] **Step 5:** Run the tests, then commit.

### Task 3: `/api/verify-phone-live` returns `blocking`

- [ ] **Step 1:** Change the test mock to `verifyRecipientsForOrder: vi.fn(async (phones) => ({ verdicts: new Map(phones.map(p => [p, p !== "0559999999"])), blocking: true, blocked: ["0559999999"] }))`. Expect `body.blocking === true` and the same `results`. Add a test that a `null` verdict comes back as `verified: true`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3:** Route: `const v = await verifyRecipientsForOrder(phones)` and return `{ results: phones.map(phone => ({ phone, verified: v.verdicts.get(phone) !== false })), blocking: v.blocking }`. The catch path returns `blocking: false`.
- [ ] **Step 4:** Run, then commit.

### Task 4: Server gates in the web order routes

These routes have no test harness. The logic lives in the Task 1 helper, which is already tested, so each route only gets a small call. Insert before any order insert or wallet debit:

- `app/api/shop/orders/create/route.ts`, after the prefix check:

```ts
if (await isRecipientBlocked(network, normalizedPhone)) {
  console.warn(`[SHOP-ORDER] ⛔ Unverified MTN number blocked for shop ${shop_id}`)
  return NextResponse.json({ error: NOT_VERIFIED_MESSAGE, code: NOT_VERIFIED_CODE }, { status: 409 })
}
```

- `app/api/orders/purchase/route.ts`: same, right after the prefix check, using `phoneNumber`.
- `app/api/orders/create-bulk/route.ts`, after `checkPhoneVerified`:

```ts
if (network.trim().toUpperCase() === "MTN") {
  const { blocked } = await verifyRecipientsForOrder(orders.map((o: BulkOrderData) => o.phone_number))
  if (blocked.length > 0) {
    return NextResponse.json({
      error: `${blocked.length} number(s) are not verified for MTN data. Remove them and resubmit.`,
      code: NOT_VERIFIED_CODE,
      blocked_numbers: blocked,
    }, { status: 409 })
  }
}
```

- [ ] Run `npx tsc --noEmit -p .`, filtered to the changed files, then commit.

### Task 5: API v1 and v2

- **v1** (`app/api/v1/orders/route.ts`):
  - After the sandbox early return and before `place_api_order`, run `verifyRecipientsForOrder([normalizePhoneNumber(cleanRecipient)])` for MTN.
  - If anything is blocked → 409 `{ success:false, error: NOT_VERIFIED_MESSAGE, error_code: "NUMBER_NOT_VERIFIED" }`.
  - Otherwise `verificationWarning = verdict === false`.
  - Delete the old post-placement block. The helper carries the 5 s bound.
- **v2:**
  - Add `mtnBlocking(): Promise<boolean>` to `DataDeps`; the real one is `isBlockingOn(await getCustomerVerificationSettings())`.
  - Add a `safeBlocking()` wrapper that returns false on a throw.
  - Single purchase: `if (verdict === false && await safeBlocking(deps)) return fail(409, MSG_NOT_REGISTERED)`.
  - Bulk: compute `blocking` once, only when some verdict is false, and skip only when blocking.
  - `verify-number` is unchanged: it reports the truth.
  - The test fake gets `mtnBlocking: vi.fn(async () => true)` so the existing tests keep their meaning. New tests: single with a false verdict and blocking off → placed (201); bulk the same → placed, not skipped.
  - Docs registry notes: append "(when Datagod's number-blocking setting is on; otherwise the order is accepted)".
- [ ] Run `npx vitest run lib/api-v2`, then commit.

### Task 6: USSD (Hubtel + legacy) and WhatsApp

- `flow-kit.ts`: `verifyRecipient?(phoneLocal: string): Promise<boolean | "blocked">`.
- `confirm-note.ts`: `export const RECIPIENT_BLOCKED_NOTE = "Number not verified for MTN data. Enter a different number."`. If verified is `"blocked"`, return `RECIPIENT_BLOCKED_NOTE`.
- `recipient-step.ts`: `export const blockedRecipientScreen = (ctx, step) => goto(ctx, { step, otherRecipient: true }, `${RECIPIENT_BLOCKED_NOTE}\n${recipientPromptText()}`, TYPE_NUMBER)`.
- `flows/data.ts`, `flows/shop-data.ts` confirm callback: `if (note === RECIPIENT_BLOCKED_NOTE) return blockedRecipientScreen(ctx, "<step>")`.
- `router.ts`: `verifyRecipient: async phone => { const v = await verifyRecipientsForOrder([phone]); if (v.blocked.length) return "blocked"; return v.verdicts.get(phone) !== false }`.
- Legacy `lib/ussd/handlers/bundles.ts` (also the WhatsApp main bot), `lib/ussd-shop/handlers/bundles.ts` and `lib/whatsapp-bot/shop-router.ts` `ENTER_RECIPIENT`: after the prefix check, `if (await isRecipientBlocked(session.network, local)) return cont/reply("This MTN number is not verified for data.\nEnter a different number:\n\n0. Back")`.
- Tests: in Hubtel `router.test.ts`, `verifyRecipient: async () => "blocked"` → the reply re-prompts for a number and the session step stays on the recipient step; `async () => false` still shows `UNVERIFIED_NOTE`.
- [ ] Run `npx vitest run lib/ussd-hubtel lib/ussd lib/ussd-shop lib/whatsapp-bot`, then commit.

### Task 7: Web UIs

- Storefront and data-packages: keep `verifyBlocking` from `verifyData.blocking === true`. When true, the warning shows the title "Number can't be used", the text from `NOT_VERIFIED_MESSAGE`, and only the "Change number" button ("Proceed anyway" is hidden).
- Bulk form:
  - `verifyPhonesLive` returns `{ map, blocking }`, stored in `verifyBlocking` state.
  - Dialog when blocking: hide "Proceed with all"; the copy is "can't be ordered…will be removed"; the deduped number list sits in a scrollable `<pre>`; a "Copy numbers" button calls `navigator.clipboard.writeText(list.join("\n"))` and toasts.
  - After "Remove unverified & submit rest" succeeds, set `removedUnverified` to those numbers. This renders a "Removed (not verified)" panel with the same list, a copy button and a dismiss X.
  - A 409 with `blocked_numbers` sets the same panel and toasts the error.
- [ ] Run `npx tsc --noEmit` and `npx eslint` on the changed files, then commit.

### Task 8: Full verification

- [ ] `npx vitest run`: all green.
- [ ] `npx tsc --noEmit`: no new errors compared with the baseline.
- [ ] Push.
