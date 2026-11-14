# Text-to-Buy Stage 3a (shop line engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers can buy shop **data** by SMS on a second (shop) line, priced and profited by the shop, with replies paid from the shop's SMS credits, shipped dark.

**Architecture:** The lane in `lib/text-to-buy` gets a line-aware adapter set. A new compose-only module in `lib/ussd-shop/handlers` places shop data orders from the primitives the shop USSD menu already uses (live shop handlers untouched). Shop resolution, prefs and credits are new injected-deps modules under `lib/text-to-buy/shop/`; credit money moves only through SQL functions that call `adjust_sms_units`. One additive migration.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest with the fake-db test helpers in `lib/text-to-buy`, Hubtel SMS via `sendSMS`.

**Spec:** `docs/superpowers/specs/2026-11-14-text-to-buy-stage3a-design.md` (read first; section 4.6 holds the lifecycle rulings). Parent: `docs/superpowers/specs/2026-11-13-sms-text-to-buy-design.md` section 5.9. Recon with file:line citations: `C:\Users\User2\AppData\Local\Temp\claude\dea131fb92e9b070\f900306a-506d-45d6-8002-3857e4e9748e\scratchpad\stage3-recon.md` (copied into the workspace by the controller before Task 1).

**Refinement of the spec (Claude's call):** credit holds live in a new table `ttb_credit_reserves` keyed by the inbound message id, not in columns on `ttb_orders`, because the reserve is taken before the order row exists. `ttb_orders` gets only a nullable `shop_id`. Message rows get `shop_id` and `credits`.

## Global Constraints

- Main line behaviour is byte-identical: `lib/text-to-buy/lane-golden.test.ts` snapshot unchanged (new scenarios may be added, never edited).
- Live shop USSD, shop WhatsApp and Hubtel shop code is not edited. The only permitted exception is an additive `sms_shop` acceptance in `lib/payments/charge-events.ts`, and only if Task 5's test proves it is needed.
- Every reply is one GSM-7 segment (existing `sendReply` rule). The shop name in a quote is truncated to fit.
- The line comes only from the forwarder secret, never from the body.
- The AI never supplies a price; quote amount = order row amount = prompt amount.
- No direct balance updates anywhere. Shop credit movement only through the Task 3 SQL functions; no creating accounts from the lane (`getOrCreateAccountForUser` is forbidden here).
- A shop reply is never sent when its shop-side debit fails and never falls back to Datagod paying, except the one "paid but not delivered" notice per order (spec 4.6).
- Customer text never in application logs. Edit/Write tools only (no sed). Never read `.env*`. Never push, merge or apply SQL: the controller runs the production protocol.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Migration number: next free at execution (0179 at planning time); the file and its `.selftest.sql` follow the `0177_text_to_buy` pattern.

## Review Focus

1. A text naming a closed, blocked or unknown shop code: closed-shop reply or "shop not found", never an order, never another shop (Task 6, Task 9 tests).
2. Notifier retry or crash between reserve and release, or between debit and refund: exactly one debit and one refund (Task 3 selftest, Task 7 tests).
3. Two senders at once draining one shop's last credits: only atomic `adjust_sms_units` decides; no order without a successful reserve (Task 7).
4. Shop quote exceeding one segment because of a long or non-GSM shop name (Task 9).
5. Main line and shop line state leaking: same sender open on both lines, line-less blocks/prompt caps, quiet-alert marker shared (Task 4, Task 10).

---

### Task 1: Per-line settings and admin validation

**Files:**
- Modify: `lib/text-to-buy/settings.ts`, `lib/text-to-buy/admin-validate.ts`
- Test: `lib/text-to-buy/settings.test.ts`, `lib/text-to-buy/admin-validate.test.ts`

**Interfaces:**
- Produces: `TtbSettings` gains `shopEnabled: boolean` (key `ttb_shop_enabled`, default false, loaded `=== true`), `shopNumber: string` (key `ttb_shop_number`, default ""), `shopRepliesPerHourPerShop: number` (key `ttb_shop_replies_per_hour_per_shop`, default 60, range 5..1000). `export function lineEnabled(s: TtbSettings, line: Line): boolean` returns `s.mainEnabled` for main, `s.shopEnabled` for shop.
- PUT of `shopEnabled` needs `confirm: true` exactly like the Stage 2 switches.

- [ ] **Step 1:** Write failing tests: defaults (`shopEnabled` false, number "", cap 60); `loadTtbSettings` reads only `=== true` for the switch; `lineEnabled` for both lines; validator rejects a non-boolean switch, a cap of 4 or 1001, a non-phone number, accepts blank number; PUT of the switch without `confirm: true` is refused.
- [ ] **Step 2:** Run `npx vitest run lib/text-to-buy/settings.test.ts lib/text-to-buy/admin-validate.test.ts`; expect the new tests to fail.
- [ ] **Step 3:** Implement the three fields, keys (the `satisfies Record<TtbSettingField,string>` forces a key), defaults, loader, `lineEnabled`, validation.
- [ ] **Step 4:** Re-run the two files plus `lib/text-to-buy/admin-view.test.ts`; expect all pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): per-line settings for the shop line`.

### Task 2: Webhook shop secret and per-line gate

**Files:**
- Modify: `app/api/webhooks/sms-forward/route.ts` (`resolveSource` :40-47, gate :182)
- Test: `app/api/webhooks/sms-forward/route.test.ts`

**Interfaces:**
- Consumes: `lineEnabled`, `TtbSettings.shopEnabled` (Task 1).
- Produces: `resolveSource` maps `SMS_FORWARD_SECRET_SHOP` to `{ line: "shop", momoLane: false }`; if the shop secret equals either main secret it is ignored (the existing rule wins). The order lane runs only when `lineEnabled(settings, source.line)`. A shop-secret request never reaches the Send & Claim ingest. Exported helper `shopSecretDistinct(env): boolean` for the admin warning (Task 11).

- [ ] **Step 1:** Failing tests extending the secret block (:410-468): shop secret resolves to line shop and calls `touchHeartbeat(db,"shop")` and `processInbound` with `line:"shop"`; shop switch off returns ok without processing; main switch on does not enable the shop line and vice versa; a MoMo notice sent with the shop secret is not ingested; equal secrets resolve to the existing source and `shopSecretDistinct` is false; bad secret still 401.
- [ ] **Step 2:** Run the route test; expect failures.
- [ ] **Step 3:** Implement as above; compare secrets timing-safely like the existing ones.
- [ ] **Step 4:** Run the route test and `lib/text-to-buy/lane-golden.test.ts`; expect pass, golden unchanged.
- [ ] **Step 5:** Commit `feat(text-to-buy): shop forwarder secret and per-line switch gate`.

### Task 3: Migration (additive) and SQL selftest

**Files:**
- Create: `migrations/0179_text_to_buy_shop_line.sql` (next free number), `migrations/0179_text_to_buy_shop_line.selftest.sql`
- Test: `lib/text-to-buy/migration-0179.test.ts` (PGlite, pattern of `migration-0177.test.ts`)

**Interfaces:** Produces (service-role only, RLS on, no policies, no anon/authenticated access):
- `ttb_orders.shop_id uuid null`; `ttb_messages.shop_id uuid null`, `ttb_messages.credits int null`.
- `ttb_shop_prefs(sender text primary key, shop_code_id uuid not null references ussd_shop_codes(id) on delete cascade, last_used_at timestamptz not null default now())`.
- `ttb_notices(kind text, sender text, shop_id uuid null, day date, primary key (kind, sender, coalesce shop id, day))` for once-a-day throttles; `ttb_notice_once(p_kind text, p_sender text, p_shop uuid, p_day date) returns boolean` (true when this call created the row).
- `ttb_credit_reserves(message_id uuid primary key, account_id uuid not null, shop_id uuid not null, held int not null check (held>0), used int not null default 0 check (used>=0 and used<=held), released_at timestamptz null, created_at timestamptz default now())`.
- `ttb_reserve_credits(p_account_id uuid, p_message_id uuid, p_shop_id uuid, p_credits int) returns boolean`: idempotent on message id; checks the account is `active` (raise `NOT_ACTIVATED` / `SUSPENDED` / `INSUFFICIENT_CREDITS` like `debit_sms_for_send`), debits through `adjust_sms_units` with reason `text_to_buy` and ref `ttb:<message_id>`, inserts the reserve row, all in one transaction.
- `ttb_draw_reserve(p_message_id uuid, p_credits int) returns boolean`: atomically `used = used + credits` only if `released_at is null and used + credits <= held`.
- `ttb_release_reserve(p_message_id uuid) returns int`: in one transaction sets `released_at` where null and refunds `held - used` through `adjust_sms_units` (reason `text_to_buy_refund`, ref `ttb:<message_id>:release`); returns credits refunded, 0 on a repeat call.
- `ttb_debit_reply(p_account_id uuid, p_credits int, p_ref text) returns boolean` (same status gate, reason `text_to_buy`) and `ttb_refund_reply(p_account_id uuid, p_credits int, p_ref text) returns boolean` (exactly once per ref, reason `text_to_buy_refund`).
- Heartbeat CHECK extended with `quiet_alert_shop`. `ttb_purge` also deletes old `ttb_notices` and released/old reserves (30 days). Builder verifies against the live `adjust_sms_units` and `sms_unit_transactions` shape from `migrations/0062*` before writing.

- [ ] **Step 1:** Write the PGlite test and selftest first: reserve once then again (second call no extra debit); draw beyond held returns false; release twice refunds once; release after full use refunds 0; debit with inactive account raises `NOT_ACTIVATED` and moves no credits; two parallel reserves on a balance of 3 for held 2 succeed once; refund twice by one ref refunds once; `ttb_notice_once` true then false; RLS on and zero policies on new tables; anon and authenticated have no execute.
- [ ] **Step 2:** Run `npx vitest run lib/text-to-buy/migration-0179.test.ts`; expect fail (no migration).
- [ ] **Step 3:** Write the migration to satisfy the tests; `CREATE ... IF NOT EXISTS` / guarded so a rerun is safe; self-rolling-back dry-run block in the selftest as in 0177.
- [ ] **Step 4:** Run the test; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): migration for the shop line (dark, unapplied)`. Applying it is the controller's protocol step (Task 13), not the implementer's.

### Task 4: Line-aware order tables and store functions

**Files:**
- Modify: `lib/text-to-buy/types.ts`, `lib/text-to-buy/store.ts`, `lib/text-to-buy/fake-db.test-helper.ts`
- Test: `lib/text-to-buy/store.test.ts`, `lib/text-to-buy/store-admin.test.ts`

**Interfaces:**
- Produces: `OrderTable` adds `"ussd_shop_orders"`. Replace `ORDER_TABLE_OF` with `export function orderTableFor(line: Line, service: Service): OrderTable` (shop+data -> `ussd_shop_orders`; airtime and results_checker unchanged; shop+airtime/rc throws, they are Stage 3c). `ORDER_COLUMNS` and `orderTableOf`/status readers in `store.ts` handle `ussd_shop_orders` (same status columns as `ussd_orders`). New store functions, all taking `db` first: `getShopPref(db, sender): Promise<{ shopCodeId: string } | null>`, `setShopPref(db, sender, shopCodeId): Promise<void>`, `lastBoughtShopCodeId(db, senderLocal): Promise<string | null>` (completed, not refunded/reversed/failed `ussd_shop_orders`, newest, matched on the dialing phone in its stored `+233` form), `noticeOnce(db, kind, sender, shopId, day): Promise<boolean>`, `serviceCounts(db, line)` (line parameter instead of the hardcoded main), `linkOrder` records `shop_id`, `saveMessage`/`storeOutbound` accept `shopId` and `credits`.
- Keep the old exports used elsewhere compiling; update callers of `ORDER_TABLE_OF`.

- [ ] **Step 1:** Failing tests: `orderTableFor` for each (line, service); a shop link for `ussd_shop_orders` is a known pair (never "unknown order table"); `lastBoughtShopCodeId` ignores refunded/failed/other-phone rows and returns null for none; `noticeOnce` true then false; `serviceCounts` filters by the given line; fake-db mirrors the new columns.
- [ ] **Step 2:** Run the two store test files; expect failures.
- [ ] **Step 3:** Implement; main-line call sites pass `"main"` explicitly so behaviour is identical.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass with the golden snapshot untouched.
- [ ] **Step 5:** Commit `feat(text-to-buy): line-aware order tables and shop store functions`.

### Task 5: Shop confirm-by-text module and the charge-events check

**Files:**
- Create: `lib/ussd-shop/handlers/confirm-by-text.ts`
- Modify (only if the test below proves it is needed): `lib/payments/charge-events.ts`; `lib/shop-commerce/orders.ts` (`ShopOrderChannel` adds `"sms_shop"`)
- Test: `lib/ussd-shop/handlers/confirm-by-text.test.ts`, `lib/payments/charge-events.sms-shop.test.ts`

**Interfaces:**
- Produces: `export async function confirmShopBundleByText(input: { shopCodeId: string; shopId: string; parentShopId: string | null; paystackProvider: "mtn"|"vod"|"tgo"; bundleId: string; recipientLocal: string; senderLocal: string; messageId: string }, deps?: ConfirmShopDeps): Promise<{ orderId?: string; amountGhs?: number }>` with `ConfirmShopDeps` injecting `resolveShopCode`, `verifyBundlePrice`, `createShopBundleOrder`, `startUssdCharge`, the data-whitelist check, and the gateway fee function. No orderId means nothing was written.
- Behaviour pinned by tests: re-checks `resolveShopCode(...).status === "active"` immediately before writing; data whitelist (`ussd_data_whitelist_enabled` + `has_completed_purchase`) enforced; network-prefix and MTN verification as the shop USSD does in its earlier steps; price and profit from `verifyBundlePrice` (sub-agent branch included); row via `createShopBundleOrder` with channel `sms_shop`; charge surface `sms_order`, MoMo only, payer is the sender, no wallet, no 3-second delay, no OTP redial SMS, no cashback; returned `amountGhs` equals the amount charged (property test across tiers, direct and sub-agent shops, Hubtel and Paystack fee paths).
- charge-events check: a test builds a paid `ussd_shop_orders` row with channel `sms_shop` and asserts the payment path credits `shop_profits` for the shop and the parent and starts fulfilment exactly as for `ussd_shop`. If it passes unchanged, no edit to charge-events. If it fails because of a fixed channel list, make the smallest additive change and add characterisation tests for the existing `ussd_shop` and `whatsapp_shop` branches first.

- [ ] **Step 1:** Write the failing tests above (module tests with injected fakes; charge-events test using the existing `charge-events-*.test.ts` fixtures as the pattern).
- [ ] **Step 2:** Run both files; expect failures.
- [ ] **Step 3:** Implement `confirm-by-text.ts` as a composition; do not import or edit `lib/ussd-shop/handlers/bundles.ts`.
- [ ] **Step 4:** Run both files plus `lib/ussd-shop`, `lib/shop-commerce` and `lib/whatsapp-bot/shop-*` suites; expect pass and zero diffs to those tests.
- [ ] **Step 5:** Commit `feat(shop-commerce): confirm shop data orders by text`.

### Task 6: Shop resolution

**Files:**
- Create: `lib/text-to-buy/shop/resolve.ts`, `lib/text-to-buy/shop/candidates.ts`
- Test: `lib/text-to-buy/shop/resolve.test.ts`, `lib/text-to-buy/shop/candidates.test.ts`

**Interfaces:**
- Produces: `export function shopCodeCandidates(text: string): string[]` (tokens of 4 to 20 characters that are not Ghana phone numbers, not sizes like `5gb`/`500mb`, not network words; stable order). `export type ShopRef = { shopCodeId: string; shopId: string; parentShopId: string | null; name: string; helpline: string | null }`. `export type ShopResolution = { kind: "shop"; shop: ShopRef; via: "code"|"pref"|"last" } | { kind: "ask" } | { kind: "not_found" } | { kind: "closed"; shop: ShopRef }`. `export async function resolveShopForText(deps: { resolveShopCode; getShopPref; setShopPref; lastBoughtShopCodeId; shopCodeById }, input: { sender: string; text: string; aiCandidate?: string | null }): Promise<ShopResolution>`. `shopCodeById` is a small extracted lookup (id to code to `resolveShopCode`) replacing the WhatsApp router's private helper; do not edit the router.
- Rules: candidates are tried in order and the AI candidate last; a candidate that resolves to a shop wins (status `active` gives `shop`, anything else gives `closed`); if candidates exist but none resolve, `not_found`; with no candidate use the pref, then last-bought (which seeds the pref once, and is verified still `active`), else `ask`. A new valid code always replaces the pref. A pref or last-bought shop that is no longer `active` yields `closed`, never a different shop. The pref is written only when an order will be placed (the lane calls `setShopPref`, not this function, except the one-time seed).

- [ ] **Step 1:** Failing tests for each branch above, including: phone number and `5gb` are never candidates; unknown code gives `not_found` and does not fall to the pref; a closed pref shop gives `closed`; two candidates where only the second resolves; code lookup is exact-match (`resolveShopCode` contract).
- [ ] **Step 2:** Run the two files; expect failures.
- [ ] **Step 3:** Implement with the injected deps only (no module-level clients).
- [ ] **Step 4:** Run the two files; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): shop resolution from code, memory and last purchase`.

### Task 7: Shop credits module and payer-aware reply

**Files:**
- Create: `lib/text-to-buy/shop/credits.ts`
- Modify: `lib/text-to-buy/send-reply.ts`
- Test: `lib/text-to-buy/shop/credits.test.ts`, `lib/text-to-buy/send-reply.test.ts`

**Interfaces:**
- Produces in `credits.ts` (all deps injected, wrapping the Task 3 RPCs): `shopAccountFor(db, shopId): Promise<{ accountId: string } | null>` (read-only: shop's `user_shops.user_id` to `sms_accounts.user_id`, never creates); `reserveForOrder(db, { accountId, shopId, messageId, credits }): Promise<{ ok: true } | { ok: false; reason: "no_account"|"inactive"|"insufficient" }>`; `drawReserve(db, messageId, credits): Promise<boolean>`; `releaseReserve(db, messageId): Promise<number>`; `chargeSingleReply(db, { accountId, credits, ref }): Promise<boolean>`; `refundSingleReply(db, {...}): Promise<boolean>`.
- `sendReply` gains an optional `payer` argument: `{ kind: "datagod" }` (default, current behaviour) or `{ kind: "shop"; shopId: string; accountId: string; messageId: string | null }`. Shop payer: first draw from the reserve if `messageId` has one, else `chargeSingleReply`; if the charge fails the reply is NOT sent (returns `{ sent:false, skipped:"unpaid" }`); a definite provider refusal (`success:false` after the full chain) refunds exactly what this reply took; a throw or timeout counts as sent; a skipped send (SMS globally off) charges nothing. The outbound message row records `shop_id` and `credits`. Quote, spare and delivered replies of an order draw from its reserve.
- Per-shop reply cap: `shopReplyCapReached(db, shopId, settings): Promise<boolean>` counting shop-paid outbound rows in the last hour against `shopRepliesPerHourPerShop`.

- [ ] **Step 1:** Failing tests: reserve ok/inactive/insufficient/no-account; two concurrent reserves on a shop with credits for one; draw until held is used then false; release returns unused once and 0 on repeat; reply refused by the provider refunds once; provider throw refunds nothing; failed debit sends nothing and does not fall back; skipped SMS charges nothing; cap trips at the setting; `shopAccountFor` never calls any create function (assert by fake).
- [ ] **Step 2:** Run the two files; expect failures.
- [ ] **Step 3:** Implement; keep `sendReply` "never throws" and the one-segment rule.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass, golden unchanged (default payer is Datagod).
- [ ] **Step 5:** Commit `feat(text-to-buy): shop credit reserve and payer-aware replies`.

### Task 8: Line-aware shop data adapter

**Files:**
- Create: `lib/text-to-buy/services/shop-data.ts`
- Modify: `lib/text-to-buy/services/index.ts`, `lib/text-to-buy/services/types.ts`, `lib/text-to-buy/catalogue.ts` (only to expose the shop-priced offer), `lib/text-to-buy/replies.ts`
- Test: `lib/text-to-buy/services/shop-data.test.ts`, `lib/text-to-buy/replies.test.ts`

**Interfaces:**
- Produces: `export function makeAdapters(deps, line: Line): AdapterSet` (main output unchanged); `adapterForLink(line, service, orderTable)` replaces the single-table mapping; `shopDataAdapter(deps: { shopPrices; confirmShop: typeof confirmShopBundleByText; ... }, shop: ShopRef): ServiceAdapter` with `orderTable "ussd_shop_orders"`, `textEnabled` true on the shop line, `resolve` pricing with `verifyBundlePrice`/shop package availability (network and size must exist in the shop's packages, else a refusal that asks or says unavailable), `place` calling `confirmShopBundleByText`, `quote` including the shop name, `readOrder`/`classify`/`statusOf` over `ussd_shop_orders`. `notices.delivered` is null for own-number orders and set for gifts, as main data. Airtime and results-checker adapters are not registered on the shop line (their reads behave as switch-off, spec section 2).
- `replies.ts`: `shopQuoteReply(input: QuoteInput & { shopName: string }): string` truncating the shop name so the whole reply stays one GSM-7 segment; a name outside GSM-7 is transliterated or truncated by the existing `gsm7()` helper.

- [ ] **Step 1:** Failing tests: adapter registry returns different adapters per line; shop quote includes the shop name and is one segment for a 60-character name with accents and emoji; a size the shop does not sell gives the unavailable refusal naming the shop; shop airtime/voucher reads are treated as off; quote amount equals the placed amount; main adapters unchanged.
- [ ] **Step 2:** Run the two test files; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass, golden unchanged.
- [ ] **Step 5:** Commit `feat(text-to-buy): shop data adapter and shop-named quote`.

### Task 9: Lane wiring for the shop line

**Files:**
- Modify: `lib/text-to-buy/handle-inbound.ts`, `lib/text-to-buy/inbound-steps.ts`, `lib/text-to-buy/store.ts` (pending shape), `lib/text-to-buy/ai-reader.ts` (optional shop candidate field)
- Test: `lib/text-to-buy/handle-inbound.shop.test.ts`; extend `lib/text-to-buy/lane-golden.test.ts` with new shop scenarios only

**Interfaces:** `processInbound` already receives `line`. New behaviour when `line === "shop"`, in this order after the existing intake, blocked, staleness and keyword steps:
1. `lineEnabled` off returns outcome `off` as today.
2. `resolveShopForText`: `ask` replies "Which shop? Reply with the shop code" (Datagod-paid) and stores a pending `{ type: "shop", read }` (20-minute TTL; a bare reply that resolves to a shop completes the held read); `not_found` replies "shop not found" (Datagod-paid, no fallback); `closed` replies the closed-shop copy once per sender per shop per day via `noticeOnce` (Datagod-paid, `<SHOP> can't take text orders right now. Call <helpline>.`), no order.
3. Shop found: check `shopReplyCapReached`; `shopAccountFor` then `reserveForOrder` with 2 credits for an own-number order or 3 for a gift; any failure is the pause path: no order, no prompt, the once-per-day Datagod-paid pause reply, and a throttled owner alert (existing notification channel; builder picks it, no new channel).
4. Place through the shop adapter; if no `orderId`, `releaseReserve` at once. On success `linkOrder` with `shop_id`, `setShopPref`, and the quote goes out drawing from the reserve.
- Wrong line: on the **main** line a text containing a candidate that resolves to an active shop code (and no data order of its own would be placed from it) replies "For shop orders text <shop number>" once per sender per day via `noticeOnce`, Datagod-paid, no order. Only when `shopNumber` is set.
- The one-open-order rule stays per (line, sender). `AGAIN` and `YES` retry on the shop line re-resolve the same shop from the stored last order (`LastOrder` carries `shopCodeId`) and take a fresh reserve.
- Ordering invariant: the idempotency pre-write (`setInboundResult` outcome `error`) stays immediately before `place`, after the reserve, and a crash after reserve is recovered because the reserve release is keyed by message id (Task 10).

- [ ] **Step 1:** Failing tests, one per rule: closed shop (once a day, second text silent); unknown code; ask-then-answer completes the held read; stale shop pending forgets; shop with no credits is paused and nothing placed or prompted; reserve taken exactly once for a normal order and 3 for a gift; place failure releases the reserve; quote names the shop; wrong-line reply once a day and only with a shop number; a shop whose status flipped between resolve and place does not place; main scenarios unchanged.
- [ ] **Step 2:** Run the new file; expect failures.
- [ ] **Step 3:** Implement the shop steps as a small module called from the lane; do not branch main code paths.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy lib/ussd app/api/admin/text-to-buy`; expect pass; Stage 1 and 2 golden scenarios byte-identical.
- [ ] **Step 5:** Commit `feat(text-to-buy): shop line in the lane (dark)`.

### Task 10: Notifier per line, reserve release, paid-not-delivered notice

**Files:**
- Modify: `lib/text-to-buy/notify.ts`, `app/api/cron/text-to-buy-notify/route.ts` (only if it hardcodes main)
- Test: `lib/text-to-buy/notify.shop.test.ts`

**Interfaces:** the sweep (stranded texts) and the quiet-phone alert run for each line whose switch is on (`lineEnabled`), with the shop quiet-alert using heartbeat marker `quiet_alert_shop`. `makeAdapters`/`adapterForLink` are line-aware so shop data links are followed (paid, delivered, failed, expired). When a link closes, `releaseReserve(db, messageId)` runs (idempotent). `notice()` for a shop link sends through the shop payer; the single "paid but not delivered / failed after payment" message is Datagod-paid when the shop cannot cover it and sent at most once per order (existing per-order notice record). Stranded shop texts recovered by the sweep re-run with the same line and never place twice (the pre-write guard).

- [ ] **Step 1:** Failing tests: shop-line stranded text recovered only when the shop switch is on; main-off/shop-on works; shop link closes and the unused reserve is refunded once even if `close` runs twice; crash after reserve and before place is released by the sweep after the stale window; paid-then-failed shop order with an empty shop balance still sends one Datagod-paid notice and not two; quiet alert per line with separate markers; shop data link is never reported as an unknown order table.
- [ ] **Step 2:** Run the new file; expect failures.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass, goldens unchanged.
- [ ] **Step 5:** Commit `feat(text-to-buy): per-line notifier and reserve release`.

### Task 11: Admin (Overview, Settings, Try-it)

**Files:**
- Modify: `lib/text-to-buy/admin-view.ts`, `app/api/admin/text-to-buy/route.ts`, `app/api/admin/text-to-buy/try/route.ts`, `app/admin/text-to-buy/_components/{api.ts,format.ts,SettingsTab.tsx,OverviewTab.tsx}`
- Test: `lib/text-to-buy/admin-view.test.ts`, `app/api/admin/text-to-buy/route.test.ts`, `app/api/admin/text-to-buy/try/route.test.ts`

**Interfaces:** `buildOverview` reports the shop card from real settings (`enabled: shopEnabled`, `number: shopNumber`), heard time from the shop heartbeat, counts per line, `serviceCounts` per line, a `pausedShops` list (shops with a pause notice in the last day: id, name, count; ids and names only, no phones), and `shopSecretDistinct: boolean` driving a warning banner "shop secret is not distinct" when false. Try-it accepts `line: "shop"` (dry run: no sends, no charges, no reserve, no writes; it passes both service switches true as in Stage 2, and for the shop line reports what shop and reply would result). Settings tab gets the shop switch (confirm dialog, `confirm: true`), shop number and per-shop reply cap fields beside the main ones; copy "from the shop number". Sidebar and NEW tags unchanged (page exists).

- [ ] **Step 1:** Failing tests: overview shop card reflects settings; `pausedShops` shape carries no phone; warning flag false when secrets equal; try-it shop dry run never calls reserve, send or place; settings PUT of `shopEnabled` without confirm refused; services degrade to zeros if the count query throws (as Stage 2).
- [ ] **Step 2:** Run the three test files; expect failures.
- [ ] **Step 3:** Implement API and UI; desktop widening and 500px/1280px checks are a controller step after build.
- [ ] **Step 4:** Run `npx vitest run app/api/admin/text-to-buy lib/text-to-buy`; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): admin shop card, settings and try-it for the shop line`.

### Task 12: Runbook, golden coverage, whole-branch verification

**Files:**
- Modify: `docs/text-to-buy/runbook.md` (new section 13: Stage 3a), `lib/text-to-buy/lane-golden.test.ts` and its snapshot (insertions only)
- Test: the whole suite

- [ ] **Step 1:** Add golden scenarios for the shop line (code in text, remembered shop, paused, closed, wrong line) as insertions.
- [ ] **Step 2:** Write runbook section 13: owner prerequisites (second phone/SIM, `SMS_FORWARD_SECRET_SHOP` set by the owner in Vercel, forwarder rule, numeric sender ID registered for the shop number, per-network handset tests), the switch-on order, the supervised paid test (own shop, own number, MoMo, check shop profit row and credit ledger rows `text_to_buy` and `text_to_buy_refund`), the rollback (switch off; never revert code while shop links or reserves are open), the announcement labelled "Hold until launch" with how-to-use steps, and the known limits (data only; last-bought-from reads shop USSD orders only; Datagod pays one notice after a paid failure).
- [ ] **Step 3:** Run `npx vitest run lib/text-to-buy lib/ussd lib/ussd-shop lib/shop-commerce lib/whatsapp-bot app/api/admin/text-to-buy app/api/webhooks`; expect pass. Then `npx tsc --noEmit` (baseline only: `lib/leaderboard/delivery.test.ts`, `app/api/admin/broadcast/route.shop-buyers.test.ts`) and the full suite once (12 known failures only; restore `lib/ussd/bots/__snapshots__/uzo-golden.test.ts.snap` if the run touches it).
- [ ] **Step 4:** Commit `docs(text-to-buy): Stage 3a runbook and golden scenarios`.

### Task 13: Production protocol (controller only, not a subagent task)

Gated on the final opus whole-branch review passing and the owner's explicit OK at each step: precheck counts, run `0179_text_to_buy_shop_line.selftest.sql` as a self-rolling-back dry run, owner OK, apply, verify (tables, six functions, RLS on, no anon grants), real `next build` with placeholder env, check local `main` for other sessions' commits before pushing, push, watch the Vercel deploy, live check (webhook still rejects a bad secret; admin routes 401 not 404; shop card shows off). Ships dark: `ttb_shop_enabled` stays off.
