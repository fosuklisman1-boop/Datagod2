# Block Unverified Numbers Toggle — Design

## Goal

Add an admin toggle that turns the customer-facing MTN number verification (the
"selected whitelist provider" check) from a warning into a hard block: when on,
an order whose recipient number is positively rejected by the admin-selected
providers is refused before any payment or wallet debit, on every ordering
surface.

## Context

- The check already exists: `lib/mtn-providers/customer-verification.ts`
  (`checkCustomerFacingVerification`), configured on `/admin/settings/mtn` via
  the `customer_verification_settings` admin setting (`{ enabled, providers }`).
  A number is verified if any selected, configured provider approves it.
- Today a failed check is advisory almost everywhere:
  - Shop storefront, dashboard single purchase, dashboard bulk call
    `/api/verify-phone-live` client-side and show a "proceed anyway" dialog.
  - API v1 (`app/api/v1/orders/route.ts`) places the order, then returns
    `verification_warning: true`.
  - Hubtel USSD (`lib/ussd-hubtel/confirm-note.ts`) shows `UNVERIFIED_NOTE`.
  - API v2 (`lib/api-v2/endpoints/data.ts`) already rejects with 409
    `MSG_NOT_REGISTERED` regardless of any toggle.
  - WhatsApp bots (`lib/whatsapp-bot/router.ts`, `shop-router.ts`) run no
    verification at all.
- None of the server-side order-creation routes (`app/api/shop/orders/create`,
  `app/api/orders/purchase`, `app/api/orders/create-bulk`) run the check, so a
  client-only block would be bypassable.
- The internal fulfillment-time gate (`mtn_whitelist_enabled` + 24h/72h retry
  cron) is unchanged and independent.

## Decisions (resolved 2026-10-29)

1. **Outage = allow.** Only a *positive* negative blocks — at least one
   selected provider answered and none approved. Setting off, no configured
   provider, every provider erroring, or a timeout → the order proceeds
   (fulfillment-time hold remains the backstop).
2. **Bulk = reject whole batch on the server; remove-and-submit in the UI.**
   The create-bulk route never places a batch containing a blocked number
   (409, nothing charged, `blocked_numbers` listed). The dashboard bulk form
   avoids hitting that: with blocking on it hides "Proceed with all", leaving
   only "Remove unverified & submit rest" or "Cancel", and shows the removed
   numbers with a copy button (see section 4).
3. **API v2 follows the toggle.** With the toggle off, v2 stops returning 409
   and instead reports the number as unverified (warning only), matching v1.
   Rollout note: admins must switch the toggle on to keep v2's current
   blocking behaviour (call out in release notes).
4. **Scope:** shop storefronts, dashboard (single + bulk), dealer APIs v1/v2,
   Hubtel USSD, and both WhatsApp bots (main bot + shop bot).
5. MTN only, same as the existing check.

## Design

### 1. Setting

Extend `customer_verification_settings` to
`{ enabled: boolean, providers: string[], block_unverified: boolean }`.

- `getCustomerVerificationSettings()` accepts the new field; missing or
  non-boolean → `false` (existing rows stay warn-only; no migration).
- `POST /api/admin/settings/customer-verification` accepts optional
  `block_unverified` (must be boolean if present; preserved if omitted).
- Admin UI (`app/admin/settings/mtn/page.tsx`, Customer verification card): a
  second Switch, "Block unverified numbers (no 'proceed anyway')", disabled
  unless `enabled` and at least one provider is selected.

### 2. Shared verdict + block helper

Move the "did any provider answer?" logic from
`lib/api-v2/endpoints/data-deps.ts` (`resolveMtnVerdicts`) into
`lib/mtn-providers/customer-verification.ts` so every surface shares one
contract:

```ts
// true = verified, false = positively rejected, null = unchecked (off/outage/timeout)
export async function resolveVerificationVerdicts(
  phones: string[], opts?: { timeoutMs?: number; registry?; settings? }
): Promise<{ verdicts: Map<string, boolean | null>; blocking: boolean }>

// Convenience for single/bulk order gates.
export async function findBlockedRecipients(phones: string[], opts?)
  : Promise<{ blocked: string[]; blocking: boolean }>
// blocked = phones whose verdict === false, only when settings.block_unverified
```

`data-deps.ts` re-exports / delegates to it so v2 tests keep their shape.
Default timeout 5 s single, 10 s bulk (existing values).

### 3. Server-side enforcement (MTN orders only, before charge)

| Surface | Change |
|---|---|
| `app/api/shop/orders/create` | Before creating the order / Paystack init: `findBlockedRecipients([phone])`; if blocked → 409 `{ error, code: "NUMBER_NOT_VERIFIED" }` |
| `app/api/orders/purchase` | Same, before wallet debit |
| `app/api/orders/create-bulk` | Check all MTN recipients in one call; any blocked → 409 with `blocked_numbers: [...]`, nothing placed |
| API v1 `app/api/v1/orders/route.ts` | Move the check before the order insert/charge. Blocking on → 409; off → unchanged `verification_warning` |
| API v2 `lib/api-v2/endpoints/data.ts` | Gate the existing 409 paths (lines ~341, ~507) on `blocking`; when off, place the order and set the warning flag instead |
| Hubtel USSD `confirm-note.ts` + flows | `verifyRecipient` dep returns `{ verified, blocking }`; when blocked, end the session with "Number not verified by MTN. Cannot proceed." instead of the confirm screen |
| WhatsApp main bot `lib/whatsapp-bot/router.ts` (`ENTER_RECIPIENT`, MTN) | After recipient entry: blocked → reply with the not-verified message and re-prompt for a recipient; warn-only mode → append the unverified note to the confirm menu |
| WhatsApp shop bot `lib/whatsapp-bot/shop-router.ts` (`ENTER_RECIPIENT`, ~line 700, MTN) | Same as the main bot, before advancing to `ENTER_PAYMENT_PHONE` |

The order-creation routes are the authoritative gate; bot/USSD checks give the
customer an early, friendly stop. Messages never echo provider error text.

### 4. Front-end

`/api/verify-phone-live` response adds `blocking: boolean`. Every web surface
also handles the new 409 `NUMBER_NOT_VERIFIED` from the create routes (covers
races / stale clients).

**Single orders** (`app/shop/[slug]/storefront-client.tsx`,
`app/dashboard/data-packages/page.tsx`): when `blocking` and the number is
unverified, replace the "proceed anyway" dialog with a hard-stop message asking
for a different number.

**Bulk orders** (`components/bulk-orders-form.tsx`, batch verification warning
dialog). Today the dialog offers *Cancel*, *Remove unverified & submit rest*
and *Proceed with all*. When `blocking` is true:

- **Proceed with all** is hidden. Only *Cancel* and *Remove unverified & submit
  rest* remain.
- The dialog copy changes from "may be delayed" to "can't be ordered: these
  numbers failed verification and will be removed".
- The unverified numbers are shown as a list (deduped, one per line) with a
  **Copy numbers** button that copies them to the clipboard, newline-separated,
  so the user can keep them for later.
- After *Remove unverified & submit rest* succeeds, the result view keeps a
  "Removed (not verified)" section listing those numbers with the same
  **Copy numbers** button, so they're still available after the dialog closes.
- If every number is unverified, the submit button stays disabled (existing
  behaviour) and only *Cancel* and *Copy numbers* are usable.

When `blocking` is false the dialog is unchanged (all three buttons, no forced
removal); the copy button is shown in both modes since it's harmless.

The server-side batch rejection (section 3) remains as the backstop: a client
that skips removal still gets a 409 listing `blocked_numbers`, and the form
shows that list with the same copy button.

### 5. Tests

- `customer-verification.test.ts`: settings parsing of `block_unverified`;
  verdict helper — positive reject blocks only when toggle on; all-providers-throw,
  timeout, feature off → never blocked.
- Admin settings route test: accepts/validates/preserves `block_unverified`.
- Route tests for shop create, purchase, create-bulk, v1: blocked → 409 and no
  order/charge; toggle off → current behaviour.
- v2 `data.test.ts`: 409 only when blocking; warning path when off.
- USSD `router.test.ts` / flow tests: blocked ends session; outage proceeds.
- WhatsApp `bots.test.ts` / `shop-router.test.ts`: blocked re-prompts; off
  proceeds.

## Out of scope

- Telecel / AT numbers.
- Changing the internal fulfillment-time whitelist gate or retry cron.
- Persisting verification results.
