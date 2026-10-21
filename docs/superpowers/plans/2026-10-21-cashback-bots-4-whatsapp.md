# Commission Cashback — Bots Plan 4: WhatsApp main + shop bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main WhatsApp bot (`lib/whatsapp-bot/router.ts`, which reuses the Uzo USSD handlers) and the WhatsApp shop bot (`lib/whatsapp-bot/shop-router.ts`) gain cashback-priced:
- **Network Plans**;
- **Pay Bills**, including Ghana Water, which needs an email;
- **airtime**.

Customers pay with a Paystack MoMo prompt to a number they type. The shared bot engine confirms the payment. Everything ships dark behind WhatsApp-only opt-in switches.

**Architecture:**
- **Orders:** the Plan 1 engine (`lib/bot-commission`) creates them.
- **Payment:** Plan 3's `botChargeMomo`, generalised so the **paying number** can differ from the buyer (buyer = the WhatsApp sender, payer = the typed MoMo number).
- **Confirmation:** the existing Paystack webhook path (`wallet_payments` cs_* → `settleStorefrontWebhook` → `confirmCommissionOrder`) settles each order exactly once.
- **Flows:** the Plan 3 flows (`lib/ussd/bots/network-plans.ts`, `pay-bills.ts`, `kit.ts`, `screen.ts`) gain a **presentation profile**, so one tested state machine serves both Uzo USSD and WhatsApp. The WhatsApp profile:
  - shows names as Hubtel sends them;
  - allows longer messages;
  - adds the WhatsApp-only steps: the MoMo number, the SMS check of that number when the storefront OTP switch is on, and the Ghana Water email.
- **Untouched:** the Hubtel USSD is not touched, and Uzo USSD output stays byte-identical.

**Tech Stack:** Next.js 15, TypeScript, Supabase, Upstash Redis, Paystack charge API, WhatsApp Cloud API (existing send helpers), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-bots-design.md`, sections §2–§5 and §9 (Ghana Water is WhatsApp-only). Related documents:
- Plan 1 (engine): `docs/superpowers/plans/2026-10-14-cashback-bots-1-engine.md`.
- Plan 3 (Uzo USSD, live-dark on main `19883cba`): `docs/superpowers/plans/2026-10-20-cashback-bots-3-uzo-ussd.md`. Its reviewed modules are the base for this plan.
- Runbook sections "Commission Cashback — Bots (Plan 1/2/3)".

## Global Constraints

- **Surfaces:**

  | Bot | `botSurface` | Shop | Buyer share | Shop share |
  |---|---|---|---|---|
  | Main WhatsApp | `"whatsapp"` | none | `customer` | none |
  | WhatsApp shop | `"whatsapp_shop"` | `shopId` (see below) | `storefrontCustomer` | `storefrontShop` |

  - The shop bot's `shopId` is the shop its session resolved from the shop code. Re-check it with the existing `isShopStillOpen` before the order, and fail closed.
  - Rail `"paystack"` for both.
  - `buyerPhone` = the WhatsApp sender's number in local `0XXXXXXXXX` form.
- **User decisions (2026-10-21):**
  - **Names as-is on WhatsApp.** Plan, category and biller names show exactly as Hubtel sends them, with no `uzoSafeLabel` rewrite. The menu entries are named **"Network Plans"** and **"Pay Bills"**. Uzo USSD keeps its rewrite rule, and the Hubtel USSD is unchanged.
  - **The typed MoMo number follows the storefront OTP switch.** When `isStorefrontOtpRequired()` is on, the number must have a real SMS OTP verification (`isPhoneOtpVerified`) before any charge. The bot sends the code by SMS, and the customer replies with it in the chat. When the switch is off, the number is charged as typed.
  - **Per-number cap:** always 3 MoMo prompts per number per hour (`momodirect_phone`, shared with storefronts and Plan 3).
- **Existing rule ([[project-whatsapp-bot]]):** never charge the WhatsApp sender's own number automatically. Always ask for the MoMo number, using the `Enter MoMo number to charge:` wording the existing WhatsApp flows use.
- **Payment method:**
  - Network Plans and Pay Bills: MoMo only, no wallet.
  - Airtime: keeps the main bot's dealer wallet option. The wallet pays `base`, with no Paystack fee and `fee_amount` 0 (Plan 3 ruling).
- **Dark rollout (required).** In prod the Bots surface and all `botGroups` are already ON (Plans 2 and 3), so the shared switches cannot keep this dark.
  - Add a new `admin_settings` key `whatsapp_cashback_visibility` with `{ networkPlans, payBills, cashbackAirtime }`. Each switch is ON only when stored `=== true`, so a missing key reads as off.
  - An item is live only when both the shared cashback gate and its WhatsApp switch are on.
  - The switches are edited on the existing WhatsApp admin page, next to the other bot settings.
  - With them off, every WhatsApp message, price and order row is byte-identical (tests).
- **Price shown = price charged** = the engine's `payAmount` (`quoteBots` rail paystack, with `botFees.paystack[group]` on top). The confirm message shows `Pay GHS x (was GHS y)` and what the buyer receives.
  - Airtime follows the Plan 3 rules: `fee_amount` is 0 under cashback, the fee goes in `payment_fee_amount`, and on the shop bot `merchant_commission` equals the shop share.
- **Ghana Water:**
  - offered on WhatsApp only;
  - needs the buyer's email, asked for in the chat and validated with the same validator the storefront bills use;
  - USSD surfaces still refuse it (in the engine).
- **Paystack OTP (`send_otp`):**
  - the customer replies with the code in the chat;
  - `submitBotOtp` handles it, with retry on a wrong code and `0` to cancel;
  - the pointer is keyed to the WhatsApp sender (`setBotOtpPointer`) and must never be usable for someone else's order.
- **Errors → text:**
  - 409 ⇒ "Price changed. Please try again."
  - 429 ⇒ "Too many attempts. Please try later."
  - 403 ⇒ "Not available right now."
  - anything else ⇒ "Service unavailable. Please try again later."
  - Never show provider or DB text. Show masked names only.
- **WhatsApp message conventions:**
  - Up to 1000 chars per message.
  - Lists page 10 per message, with `0. Back` / `99. More` or whatever the existing WhatsApp list uses.
  - The main bot keeps its natural-language digit mapping, extended to the new steps where obvious.
  - The shop bot keeps its own menus (`shop-menus.ts`) and its WhatsApp text without `gsm7`.
- **AI ordering:** `lib/ai-tools.ts` and `lib/whatsapp-bot/shop-ai.ts` are unchanged and do not offer the new items.
- **No migration expected:**
  - `bot_surface` already allows `whatsapp` / `whatsapp_shop` (0123);
  - `airtime_orders.channel` keeps the values the WhatsApp bots already use;
  - `phone_otp_verifications` already exists.

  If a CHECK blocks you, STOP and report.
- **Prod `wallet_payments.status` includes Paystack's `ongoing` / `abandoned`.** Guards must exclude `'completed'`, never require `'pending'` (Plan 3 lesson).
- **Working rules:**
  - Edit code with the Edit/Write tools only: no sed, heredoc or python edits of source.
  - Logic goes in `lib/`.
  - Run a real `next build` before merging.
  - Before pushing, check origin/local main for foreign commits, and chain `merge --ff-only && push`.
  - Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Crons are now managed partly on cron-job.org (`lib/cron-migration`). This plan adds no cron.

## Review Focus

1. **One payment, one effect.** One MoMo payment ⇒ one confirm, one shop share and one Hubtel POST. That includes a duplicate webhook, verify racing the webhook, and a Paystack OTP finished in chat. (Tasks 1, 3, 4)
2. **The typed number is protected.** It is never charged without the SMS check while the OTP switch is on, the 3/hour cap holds, and the WhatsApp sender's number is never charged automatically. (Tasks 1, 3, 4)
3. **Switches off ⇒ no change.** Every WhatsApp message, price and row is byte-identical, and so is Uzo USSD output. (Tasks 2, 3, 4, 5)
4. **Shop shares.** The shop bot credits a share only to the resolved, still-open shop. The main bot never credits one. (Tasks 3, 4, 5)
5. **Ghana Water** works on WhatsApp with a validated email and stays refused on every USSD surface. (Tasks 2, 3)

---

### Task 1: Engine — paying number, OTP-switch check, WhatsApp switches

**Files:**
- Modify: `lib/bot-commission/momo.ts`, `lib/bot-commission/momo.test.ts`, `lib/bot-commission/otp-pointer.ts`
- Create: `lib/bot-commission/payer-verify.ts`, `lib/bot-commission/payer-verify.test.ts`
- Create: `lib/whatsapp-bot/cashback-visibility.ts`, `lib/whatsapp-bot/cashback-visibility.test.ts`
- Read:
  - `lib/storefront-otp.ts` (`isStorefrontOtpRequired`, `isPhoneOtpVerified`);
  - `app/api/auth/send-phone-otp/route.ts` and `app/api/auth/verify-phone-otp/route.ts`, to find the send/verify logic so it can be reused in-process. If that logic lives only in the routes, extract it into `lib/` without changing the routes' behaviour, and add tests;
  - `lib/sms-service.ts`.

**Interfaces:**
- **`BotChargeInput` gains `payPhone?: string`**, the number to charge.
  - It defaults to `dialingPhone`, so Plan 3 callers are unchanged and byte-identical.
  - The existing `buyer_phone` guard keeps comparing against `dialingPhone` (the WhatsApp sender).
  - The provider, the per-number cap, `recordPayerPhone` and the charge itself all use `payPhone`.
  - `botSurface` widens to `"ussd" | "ussd_shop" | "whatsapp" | "whatsapp_shop"`.
- **New result code `NEEDS_VERIFY`.** Returned when `isStorefrontOtpRequired()` is on and `!isPhoneOtpVerified(payPhone)`, with no write and no charge. It applies only to the WhatsApp surfaces; the Uzo surfaces are unchanged.
- `payer-verify.ts`:
  ```ts
  export async function sendPayerOtp(phone: string): Promise<{ ok: true } | { ok: false; code: "RATE_LIMITED" | "SEND_FAILED" }>
  export async function verifyPayerOtp(phone: string, code: string): Promise<{ ok: boolean; retry: boolean }>
  ```
  It uses the same `phone_otp_verifications` table and rules as `/api/auth/*-phone-otp`. A success writes `used=true`, so `isPhoneOtpVerified` then passes.
- `cashback-visibility.ts`:
  ```ts
  export const WHATSAPP_CASHBACK_VISIBILITY_KEY = "whatsapp_cashback_visibility"
  export interface WhatsAppCashbackVisibility { networkPlans: boolean; payBills: boolean; cashbackAirtime: boolean }
  export async function getWhatsAppCashbackVisibility(db): Promise<WhatsAppCashbackVisibility>   // === true only; read error ⇒ all false
  export async function setWhatsAppCashbackVisibility(db, patch): Promise<void>
  export async function whatsappBotItemsVisible(db): Promise<{ networkPlans: boolean; payBills: boolean; cashbackAirtime: boolean }>  // AND cashback gate, fail closed
  ```

- [ ] **Step 1: Write failing tests:**
  - **`payPhone`:**
    - the charge goes to `payPhone`, and the cap, provider and payer record use it;
    - the `buyer_phone` guard still uses `dialingPhone`;
    - without `payPhone`, the result is byte-identical to Plan 3, and every existing momo test stays green.
  - **`NEEDS_VERIFY`:**
    - switch on and number unverified on a WhatsApp surface ⇒ `NEEDS_VERIFY`, with no wallet_payments row and no charge;
    - switch on and number verified ⇒ charge;
    - switch off ⇒ charge;
    - Uzo surfaces never get `NEEDS_VERIFY`;
    - a failed read of the switch on a WhatsApp surface fails closed and returns `NEEDS_VERIFY`.
  - **`payer-verify`:**
    - send is rate-limited the same way as the auth route;
    - verify succeeds once;
    - a wrong code ⇒ `retry` true;
    - an expired code ⇒ `retry` false.
  - **Visibility:**
    - a missing key or a read error ⇒ all off;
    - only a stored `true` turns an item on;
    - `whatsappBotItemsVisible` needs both the gate AND the switch.
- [ ] **Step 2:** Run `npx vitest run lib/bot-commission lib/whatsapp-bot/cashback-visibility.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then `npx tsc --noEmit -p .`.
- [ ] **Step 5:** Commit in pieces.

### Task 2: Flow presentation profile (shared with Uzo) + WhatsApp-only steps

**Files:**
- Modify: `lib/ussd/bots/kit.ts`, `lib/ussd/bots/screen.ts`, `lib/ussd/bots/network-plans.ts`, `lib/ussd/bots/pay-bills.ts`, and their tests
- Create: `lib/ussd/bots/profile.ts` (+test)

**Interfaces:**
```ts
export interface BotFlowProfile {
  kind: "uzo" | "whatsapp"
  limit: number                     // uzo 160, whatsapp 1000
  pageSize: number                  // uzo 5, whatsapp 10
  label(name: string): string       // uzo: uzoSafeLabel; whatsapp: identity (trimmed)
  askPayPhone: boolean              // whatsapp: true
  allowGhanaWater: boolean          // whatsapp: true
}
export const UZO_PROFILE: BotFlowProfile
export const WHATSAPP_PROFILE: BotFlowProfile
```
- **Context type:** `UzoBotCtx` becomes `BotFlowCtx`, with `surface: "ussd" | "ussd_shop" | "whatsapp" | "whatsapp_shop"` and `profile`. Keep the old name as an alias so Plan 3 callers compile unchanged.
- **New steps,** used only when the profile asks for them:
  - `NP_PAY_PHONE` / `PB_PAY_PHONE`, before confirm: "Enter MoMo number to charge", checked with the existing Ghana validator.
  - `NP_PAY_VERIFY` / `PB_PAY_VERIFY`: when the charge returns `NEEDS_VERIFY`, `sendPayerOtp` sends a code and the bot asks for it. `verifyPayerOtp` checks the reply; on success, the same charge is retried with the same order (idempotent replay).
  - `PB_EMAIL` (Ghana Water only): ask for the buyer's email and check it with the storefront bills validator before verify.
- **Confirm text:** the WhatsApp profile shows the paying number ("MoMo: 0XX…"). The Uzo profile is unchanged.

- [ ] **Step 1: Write failing tests:**
  - **Uzo:** every existing Uzo flow test passes unchanged. Add a golden test that pins the Uzo output byte-for-byte for each step.
  - **WhatsApp profile:**
    - names exactly as given (`"Data 1GB Bundle"` stays);
    - 10 per page;
    - the pay-phone step comes before confirm, and an invalid number re-prompts;
    - `NEEDS_VERIFY` path: the code is sent, a wrong code gives a retry, and the right code leads to the charge;
    - Ghana Water is listed and asks for an email; a bad email re-prompts, and the email is passed to verify;
    - every message is ≤ 1000 chars.
  - **Engine Ghana Water rule:** still refused on `ussd`, `ussd_shop` and `hubtel_ussd`.
- [ ] **Step 2:** Run `npx vitest run lib/ussd lib/ussd-shop lib/bot-commission` and expect FAIL.
- [ ] **Step 3:** Implement. This refactors reviewed live-dark code, so keep the Uzo behaviour pinned by the goldens.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit in pieces.

### Task 3: Main WhatsApp bot — Network Plans + Pay Bills

**Files:**
- Modify: `lib/whatsapp-bot/router.ts`, `lib/ussd/menus.ts` (main-menu visibility for the WhatsApp channel), `lib/ussd/handlers/main.ts`
- Create: `lib/whatsapp-bot/bots.test.ts` (or extend the existing router tests)

**Behaviour:**
- **Main menu:** on WhatsApp it adds "Network Plans" / "Pay Bills" at the END, only when `whatsappBotItemsVisible` says so.
  - `handleMain` with channel `"whatsapp"` uses the WhatsApp switches. With channel `"ussd"`, it keeps Plan 3's Uzo switches.
  - With the switches off, the menu text and digit dispatch are byte-identical to today.
  - `mainMenu()` with no arguments (the AI tool) is unchanged.
- **Flow routing:** route the `NP_*` / `PB_*` steps to the shared flows with `WHATSAPP_PROFILE`, `surface: "whatsapp"`, `shopId: null` and `dialingPhone` = the WhatsApp sender.
  - Run the replies through the existing `fixWaMomoMsg`, which turns "redial" into "reply here with your OTP code".
  - Extend the natural-language mapping where obvious ("my number", "yes", "cancel").
- **Paystack `send_otp`:** the OTP pointer is keyed by the WhatsApp sender. The next chat reply goes to `submitBotOtp`, alongside the existing `SUBMIT_OTP` candidates.

- [ ] **Step 1: Write failing tests:**
  - the menu with the switches off and on, byte-identical when off;
  - the full Network Plans and Pay Bills paths through the router, including Ghana Water with an email;
  - the MoMo number is asked for and charged, and the sender's number is never charged automatically;
  - `NEEDS_VERIFY` verification in chat;
  - OTP in chat, with retry and cancel;
  - shopId null;
  - the error texts.
- [ ] **Step 2:** Run `npx vitest run lib/whatsapp-bot lib/ussd` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit.

### Task 4: WhatsApp shop bot — Network Plans + Pay Bills

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts`, `lib/whatsapp-bot/shop-menus.ts`, `lib/whatsapp-bot/shop-types.ts`, and the shop-router tests

**Behaviour:**
- **Product menu:** "Network Plans" / "Pay Bills" are added at the END, only when visible. With them off, the menu text, digits and `shopNaturalToDigit` are byte-identical.
- **Shop check:** before order creation, re-check `isShopStillOpen(shopCodeId)` and fail closed with the existing shop-closed text. The shopId is the session's resolved shop id.
- **Flows:** run the shared flows with `WHATSAPP_PROFILE`, `surface: "whatsapp_shop"` and `dialingPhone` = the sender.
  - The shop bot's session type (`WaShopSession`) is different, so add a thin adapter that maps it to and from the fields the flows need. Do not duplicate the flows.
  - Use the shop bot's existing payment-phone wording (`shopPaymentPhonePrompt`).
- **Paystack OTP:** in chat, the same as Task 3, inside the shop bot's `SUBMIT_OTP` handling.

- [ ] **Step 1: Write failing tests:**
  - the menu with the switches off and on, byte-identical when off;
  - both flows end to end;
  - the shop share goes only to the resolved shop;
  - a closed shop refuses the order;
  - the sender's number is never charged automatically;
  - `NEEDS_VERIFY`;
  - OTP in chat.
- [ ] **Step 2:** Run `npx vitest run lib/whatsapp-bot` and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit.

### Task 5: Airtime with cashback on both WhatsApp bots

**Files:**
- Modify: `lib/ussd/handlers/airtime.ts` (the `channel === "whatsapp"` path, today pinned to "never cashback"), `lib/ussd/bots/airtime.ts`, `lib/whatsapp-bot/router.ts`, `lib/whatsapp-bot/shop-router.ts` (its own airtime implementation, `shopAirtimeFeeRate` / `AIRTIME_CONFIRM`), and the tests for each

**Behaviour:**
- **When cashback applies:** only when `quoteBotAirtime(network, face, { rail: "paystack", shop })` gives a usable quote AND the WhatsApp `cashbackAirtime` switch is on.
- **Plan 3 rules, unchanged:**
  - on MoMo, the charge = `total_paid` = `payAmount`;
  - the wallet pays `base`;
  - `fee_amount` is 0 and the fee goes in `payment_fee_amount`;
  - on the shop bot, `merchant_commission` = `shopShare`;
  - more than 2 decimals is rejected on the cashback branch;
  - the prompt reads "Enter airtime amount".
- **Switch off:** today's WhatsApp messages, rows and charges are byte-identical. Pin this with tests written BEFORE the change.
- **Charge path:** the MoMo charge still goes to the asked number. The existing airtime charge path stays, with reference = order id and no `NEEDS_VERIFY`. This is a ruling, the same as Plan 3, where airtime keeps its own charge path. The airtime OTP-switch gap is a follow-up in the runbook.

- [ ] **Step 1: Write failing tests:**
  - applied on main (customer share);
  - applied on shop (storefront shares and `merchant_commission`);
  - not applied ⇒ byte-identical;
  - wallet = `base`;
  - more than 2 decimals is rejected;
  - a re-quote mismatch at confirm ⇒ "Price changed" and no order;
  - the webhook accepts `total_paid` and credits the share once.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit.

### Task 6: Admin switches, verification, runbook

**Files:**
- Modify: the WhatsApp admin page and its settings route (find where the other WhatsApp bot settings are edited, e.g. `/admin/whatsapp`), and `docs/hubtel-commission-services/runbook.md`

**Behaviour:**
- **Admin:**
  - Add three switches, "Network Plans", "Pay Bills" and "Cashback airtime" (WhatsApp), that save `whatsapp_cashback_visibility` through a validated admin route (`verifyAdminAccess`).
  - Use navy brand styling and an lg: layout.
  - No new sidebar item is expected. If one is added, it needs the NEW tag.
- **Runbook section "Commission Cashback — Bots (Plan 4: WhatsApp)":**
  - **Step 0:** pre-deploy SQL showing `whatsapp_cashback_visibility` is absent or false.
  - **Migration:** none.
  - **Fees:** `botFees.paystack` must be set before go-live (it is 0 in prod as of 2026-10-20).
  - **Staged go-live,** one switch at a time, each tested with a real GHS 1 payment on both bots: first Pay Bills (including Ghana Water with an email), then Network Plans, then Cashback airtime.
  - **MoMo number checks:** how the OTP switch behaves, the per-number cap, and OTP in chat.
  - **Refunds:** Paystack reversal is available, and the payer number is recorded.
  - **Needs-review procedure:** see Plan 2 step 8.
  - **Rollback.**
  - **Follow-ups:** the airtime OTP-switch gap, and AI ordering not offering the new items.
- **Verification:**
  - `rm -rf .next` (if a hook blocks it, note it and continue);
  - full `npx vitest run` (only the 9 known `lib/order-health-service.test.ts` failures; re-run any file that is flaky under load on its own);
  - `npx tsc --noEmit -p .`;
  - a real `next build` with placeholder env.

- [ ] **Step 1:** Write failing tests (admin route validation; the page loads with the switches).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run and expect PASS.
- [ ] **Step 4:** Write the runbook section.
- [ ] **Step 5:** Run the full verification.
- [ ] **Step 6:** Commit in pieces. STOP before merging or pushing.

## Self-review

- **Spec coverage:**
  - §2 surfaces and shares → Global Constraints;
  - §3 pricing → Tasks 2–5 (engine `quoteBots`);
  - §4 Paystack rail and shared confirm → Task 1 (`payPhone`, `NEEDS_VERIFY`) plus Plan 3's proven webhook path;
  - §5 menus, including Ghana Water on WhatsApp → Tasks 2–4;
  - §9 errors → Global Constraints;
  - §10 testing → every task, plus Task 6.
- **Carried items:**
  - charge the number the bot asks for → Task 1 `payPhone`;
  - bot payments follow the storefront OTP switch → Task 1 `NEEDS_VERIFY` (user decision 2026-10-21);
  - payer phone recorded for refunds → Task 1.
- **User decisions (2026-10-21):** names as-is on WhatsApp → `WHATSAPP_PROFILE`; OTP switch followed → Task 1.
- **Dark deploy:** `whatsapp_cashback_visibility`, read with `=== true` only.
- **Review Focus coverage:**
  - item 1 → Tasks 1, 3, 4;
  - item 2 → Tasks 1, 3, 4;
  - item 3 → the golden tests in Tasks 2–5;
  - item 4 → Tasks 3–5;
  - item 5 → Tasks 2, 3.
- **Type consistency:**
  - `BotFlowProfile`, `BotFlowCtx` (alias `UzoBotCtx`) and `BotChargeInput.payPhone` are defined in Tasks 1–2 and used in Tasks 3–5;
  - `whatsappBotItemsVisible` is defined in Task 1 and used in Tasks 3–5.
