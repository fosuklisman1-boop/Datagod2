# Text-to-Buy Stage 3a: the shop line (engine) — design

Date: 2026-11-14. Extends `2026-11-13-sms-text-to-buy-design.md` (sections 5.9, 5.12, 7, 10) and the Stage 2 design. Stage 3a is the **engine**: a second line where customers text a shop code and buy **data** through that shop's prices, with replies paid from the shop's SMS credits. The shop owner page is Stage 3b. Airtime and checkers on the shop line are Stage 3c. Bills are Stage 4.

## 1. Why

Shops (sub-agents included) want customers to buy by text from their own number and prices, earning shop profit exactly as on the USSD shop menu. Datagod must not pay for a shop's replies, and a shop that cannot pay must not get orders it cannot service. Owner decisions already taken (2026-11-13) are in section 5.9 of the parent spec and are not reopened here.

## 2. Goals, non-goals, anti-goals

Goals
- A second forwarder phone ("shop line"), identified only by its own secret.
- Shop data orders by text: shop resolved from code, remembered shop, or last shop bought from; priced, profited and fulfilled by the same code the USSD shop menu uses.
- Shop-paid replies with an exactly-once credit ledger; a shop that is not active or short of credits is paused.
- Admin: shop card, shop switch and number, paused-shops list, Try-it on the shop line.
- Ships dark behind its own switch; main line behaviour byte-identical (lane golden snapshots unchanged).

Non-goals (later plans)
- Shop owner "Text Orders" page, owner-set low-credit threshold and owner switch (3b).
- Airtime and results checker on the shop line (3c). On the shop line in 3a only data is offered; an airtime or voucher text is handled as if that service's switch were off.
- Bills (Stage 4). Changes to shop USSD, shop WhatsApp or Hubtel shop flows.

Anti-goals: a shop order that falls back to another shop or to the main line; Datagod silently paying for shop replies; any change to a live shop USSD handler.

## 3. Approaches (owner picked in the conversation, 2026-11-14)

Order path
- **Chosen: a new compose-only module** `lib/ussd-shop/handlers/confirm-by-text.ts` calling the primitives the shop menu already uses (`verifyBundlePrice`, `createShopBundleOrder`, `startUssdCharge`). Shop USSD is untouched. Same shape as the Hubtel shop flow.
- Rejected: adding an `sms` channel to the live shop `handleConfirm`. Smaller code, but edits live shop money code and needs heavy characterisation first.

Remembered shop
- **Chosen: own table `ttb_shop_prefs`**, keyed by the local 0xx sender. A customer switching shop by text is never silently switched on WhatsApp or USSD.
- Rejected: sharing `wa_shop_customer_prefs` (233 format, non-injectable client, cross-channel side effects).

Credits (Claude's call, owner to check): debit-then-refund through `adjust_sms_units`, with exactly-once guards owned by us. No hold primitive exists, and inventing one is out of scope.

## 4. Design

### 4.1 Line plumbing (no reshape)
`Line = "main" | "shop"` and the 0177 CHECKs already allow `shop`. Changes:
- Webhook `resolveSource`: third env secret `SMS_FORWARD_SECRET_SHOP` maps to `{ line: "shop", momoLane: false }`; same timing-safe compare; identical secrets still resolve to the MoMo source. The line is never read from the body.
- Settings (additive keys, default off): `ttb_shop_enabled`, `ttb_shop_number`, `ttb_shop_replies_per_hour_per_shop` (default 60). The switch gate becomes per line in the webhook, in `processInbound` and in the recovery sweep. Today `mainEnabled` gates everything.
- `Line`-aware adapters: adapters get the line and, on the shop line, the resolved shop. `ORDER_TABLE_OF` becomes a function of (line, service); `OrderTable` gains `ussd_shop_orders`; `ORDER_COLUMNS` gains it; the notifier, STATUS and link follow-up use the line-aware mapping so shop data links are followed, never treated as unknown.
- Notifier: recovery sweep and quiet-phone alert run per line; the quiet-alert marker becomes per line (needs a heartbeat CHECK extension in the migration).
- Try-it accepts `line: "shop"`; the Overview shop card becomes real (switch, number, heard, counts, cost, paused shops); service counts become per line.

### 4.2 Shop resolution
In order: (1) a shop code in this text; (2) `ttb_shop_prefs` for this sender; (3) the shop this number last bought from (read-only lookup of completed `ussd_shop_orders` by dialing phone; seeds the pref once); (4) otherwise reply "Which shop? Reply with the shop code" and hold the read in conversation pending (20-minute TTL, as the Stage 2 pendings).
- Code recognition: rules pick candidate tokens (4–20 characters, not a Ghana phone, not a size); the AI may nominate a token; **code** resolves it with `resolveShopCode`. A token that is a real code but a closed shop (status not `active`) gets the closed-shop reply; an unknown code gets "shop not found". Never a fallback to another shop. A new valid code always switches the remembered shop.
- Shop status is re-checked at place time (`resolveShopCode`), because the USSD shop confirm does not.
- A valid shop code texted to the **main** line gets "For shop orders text <shop number>", once per sender per day.
- Shop name in every shop quote, truncated to keep one GSM-7 segment.

### 4.3 Placing a shop data order
`confirm-by-text` (injected deps, like the main `*ByText` wrappers):
- Price: `verifyBundlePrice` gives price and profit; gateway fee added the same way the shop handler does; the amount returned to the lane is the amount charged (price guarantee: quote = order row = prompt, with a property test across tiers and gateways).
- Order row: `ussd_shop_orders` via `createShopBundleOrder` with `channel` `sms_shop` (a new value on a column that has no CHECK). Profit and fulfilment come from the existing payment-time code in `charge-events`, keyed by the order id; the plan must verify that claim with a test before relying on it.
- Charge surface `sms_order`; MoMo only, payer is the sender, no wallet, no OTP redial SMS, no 3-second delay, no cashback.
- Repeats the data-whitelist and network-prefix/MTN checks that the shop USSD does in earlier steps rather than in confirm.
- Characterisation tests for shop USSD and shop WhatsApp are run as the safety net (they are untouched, so the diff must not change them).

### 4.4 Shop credits
- Account lookup is read-only (never the creating `getOrCreateAccountForUser`). An account must exist and be `active`.
- New SQL function (migration): status-gated debit that calls `adjust_sms_units` with reason `text_to_buy` and a ref naming the order link or message, so the ledger names Text-to-Buy. No direct balance updates anywhere.
- **Order reserve:** before the order is placed, debit 2 credits (own-number order) or 3 (gift) with ref `ttb:<link>`; failure means pause (no order, no prompt). Replies for that order (quote, spare, delivered) draw on the reserve and are counted on the order row. When the order closes, the unused part is returned once (a guarded release step, as the notifier's other exactly-once notices). Replies not tied to an order (after the shop is known: "not understood", price list) debit 1 each and refund 1 on a definite provider refusal; an unknown outcome counts as sent.
- A reply is never sent when the shop-side debit fails, and never falls back to Datagod paying.
- Pre-resolution replies ("Which shop?", "shop not found", "wrong line") and the once-a-day "<SHOP> can't take text orders right now. Call <helpline>." are Datagod-paid, rate-limited per sender, and throttled by a small notice table (kind, sender, shop, day).
- Paused shop: owner gets one throttled alert to buy credits through the existing notification channels; the Overview lists paused shops.
- Per-shop reply cap (`ttb_shop_replies_per_hour_per_shop`) so many senders cannot drain one shop. Shop-paid replies do not count toward Datagod's global reply cap, since they cost Datagod nothing.

### 4.5 Data additions (one migration, additive, production protocol)
`ttb_orders`: `shop_id`, `credits_held`, `credits_used`, `credits_released_at`. `ttb_messages`: `shop_id`, `credits`. New `ttb_shop_prefs` (sender, shop_code_id, last_used_at) and a notice table. Heartbeat CHECK extended for the per-line quiet alert. New debit SQL function. All tables service-role only, RLS on, no policies, as 0177. Message retention (30 days) covers the new tables.

### 4.6 Lifecycle details (added after the builder check)
- **Reserve timing.** Data orders are placed and quoted together: the order row, the MoMo prompt and the quote reply happen in one step (as on the main line), so there is no separate YES for a normal order. The reserve is taken immediately before `place`; the order row records `credits_held`. A clarifying question, a "Which shop?" hold or a quote the customer never acts on involves no reserve: those replies are the 1-credit individually debited kind. Pending states expire on their own TTL and release nothing, because they hold nothing.
- **Closing.** The reserve is released when the order link closes (paid and delivered, failed, expired or flipped to unpaid by the notifier). The release is idempotent through `credits_released_at`.
- **Retry YES.** A retry after a failed or expired payment places a new order with a **fresh** reserve; the old reserve was already released when the old link closed. If the debit fails, the shop is paused and the customer gets the single Datagod-paid pause reply.
- **Reserve runs short mid-order.** A shop-paid reply that cannot be charged to the remaining reserve falls back to a single 1-credit debit; if that fails too the reply is not sent and no Datagod fallback happens, except the case below.
- **Paid but not delivered.** The one message telling a payer their paid order failed or needs review is **Datagod-paid** when the shop cannot cover it, at most once per order. Silence after a customer has paid is worse than a one-segment SMS. This is the only shop-line exception to "Datagod never pays for shop replies" (owner to check).
- **Which SMS account.** The account of the shop's own owner: `user_shops.user_id` to `sms_accounts.user_id`, found by a read-only lookup. A sub-agent's shop uses the sub-agent's account, never the parent's. One owner has one pool.
- **Closed shop.** Blocked, suspended, inactive or unapproved shops (any `resolveShopCode` status other than `active`) get the same closed-shop reply as the paused-shop reply ("<SHOP> can't take text orders right now. Call <helpline>."), once per sender per shop per day. No order, no prompt.
- **Last bought from.** Deliberately narrow in 3a: completed (paid, not refunded, reversed or failed) `ussd_shop_orders` only. Storefront and WhatsApp purchases are not read (different phone formats and tables); a customer in that position simply gets the "Which shop?" question once.
- **Shop-line charge handling.** If the `charge-events` profit and fulfilment path turns out to branch on a fixed set of channel values, the plan makes the smallest additive change there (accept `sms_shop` where `ussd_shop` is accepted), pinned by characterisation tests written first and a mandatory reviewer. Nothing else in live shop code changes.
- **Equal secrets.** If `SMS_FORWARD_SECRET_SHOP` equals `SMS_FORWARD_SECRET` or `SMS_FORWARD_SECRET_MAIN`, the existing rule wins (main or MoMo source) and the shop line never activates; the admin Overview shows a "shop secret is not distinct" warning. Not a startup error, so a misconfiguration can never take main down.

## 5. Abuse cases
- Naming any shop code: a prompt reaches only the real owner of the sender's number; the shop's credits are protected by the per-shop reply cap and the pause rule.
- Random-code spam: costs Datagod a pre-resolution reply; bounded by per-sender and per-line reply caps and then silence.
- A shop owner texting their own shop to farm profit: same exposure as shop USSD today; noted, not new.
- Credits race: the atomic `adjust_sms_units` is the only check; read-then-debit is never used.
- Double release or double debit on notifier retry: refs and a release guard make both exactly-once; tested with a simulated crash between steps.
- Forged line: line comes from the secret only.

## 6. Owner prerequisites (not code)
Second phone and SIM; `SMS_FORWARD_SECRET_SHOP` in Vercel (set by the owner, never in a command or file I write); forwarder rule on that phone; numeric sender ID for the shop number registered and delivering on MTN, Telecel and AT (handset tests); `ttb_shop_enabled` stays off until the supervised paid test.

## 7. Rollout and review
Dark behind `ttb_shop_enabled`. Migration through the production change protocol (precheck, self-rolling-back dry run, owner OK, apply, verify). Money, auth and schema are touched, so a fresh reviewer is mandatory, with opus on the final whole-branch review. Test-first, logic in `lib/`, real `next build` before pushing main. Supervised paid test per network before the switch is announced.

## 8. Left to the builder
Table and column names; exact reply wording (one segment each); how "last bought from" is queried efficiently (indexed, read-only, no PII returned to logs); whether the order reserve release rides on the existing close step; copy for the owner alert.

## 9. Calls Claude made (owner to check)
- Shop line offers data only in 3a; airtime and checkers follow in 3c.
- Separate prefs table; last-bought-from seeds it once.
- Shop-paid replies do not count toward Datagod's global reply cap; a per-shop cap protects the shop.
- Reserve of 2 (own number) or 3 (gift) credits, debit-then-refund with our own exactly-once guards.
- Wrong-line reply on main is included in 3a.
- One `sms_order` gateway surface for both lines; one SMS provider category.
- A main order and a shop order may be open for the same sender at the same time (the one-open rule stays per line and sender).
