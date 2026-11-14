# Text-to-Buy Stage 2: airtime and results-checker vouchers by text - design

Date: 2026-11-14
Status: draft, awaiting owner approval
Builds on: Stage 1 (live, `docs/superpowers/specs/2026-11-13-sms-text-to-buy-design.md`), the lane in `lib/text-to-buy/*`, the USSD airtime and results-checker handlers (`lib/ussd/handlers/airtime.ts`, `results-checker.ts`).
Facts in this document come from a read-only code review done on 2026-11-14; file references are to the tree at main f71dd3f9 plus the runbook commit.

## 1. Intent

Customers who already buy data by text can also buy **airtime** (`airtime 10`, `airtime 10 0241234567`) and **results-checker vouchers** (`2 wassce checkers`) on the main number. One text, one MoMo PIN, same prices, stock and limits as the USSD menus. The lane, replies, caps, admin page and follow-up worker are shared; each service is a small module behind one interface.

## 2. Goals, non-goals, anti-goals

Goals
- Airtime and checker vouchers purchasable by text on the main line, behind two admin switches that start OFF.
- Prices, fees, limits, stock and network rules come from the same code the USSD menus use; nothing is priced by the AI or by the customer's text.
- Customers get the same follow-ups as data (unpaid, delayed, price-changed), worded correctly for each service.
- The data service is refactored onto the same interface with behaviour unchanged.
- Everything is reachable from the existing admin page (switches) and the Try-it tab (dry run).

Non-goals
- "Check my results for me" (the results-check service), AFA, bills, the shop number, shop credits.
- Cashback pricing on text. Text airtime uses today's fee pricing only.
- Wallet payment. Payer is always the sender; MoMo only.
- A price-list keyword for airtime or vouchers (`PRICES` stays data).
- Any change to how USSD or WhatsApp airtime and vouchers behave.

Anti-goals (a failure even if it works)
- A MoMo prompt for an amount, board, quantity or recipient the customer did not write.
- "10gb" or "10 gigs" ever becoming GHS 10 of airtime; "10" alone ever changing meaning (it stays 10GB).
- Voucher PINs sent through the lane's reply path, or logged by it.
- A paid airtime or voucher order whose follow-up silently disappears.
- A customer told "no need to pay again" when a refund or wallet credit may be in progress.

## 3. Decisions the owner made

- Stage 2 = airtime and checkers on the main number (2026-11-14).
- Airtime pricing: same as USSD today (fee-inclusive: the customer pays the typed amount, the recipient gets less); no cashback on text (2026-11-14).
- Build approach: one per-service interface, with data moved onto it (2026-11-14).
- Stage 1 decisions still stand: payer is the sender, MoMo only, AI never prices, quotes never capped, one open order per sender.

## 4. Approaches considered

1. **One service interface (chosen).** A small adapter per service (parse, resolve, place, read order, classify, notice copy). The lane drives adapters; data becomes the first adapter. More refactoring of working code up front; every service shares the safety checks; later services (bills, shop) drop in.
2. **Copy the data path per service.** Faster, touches data least, but each money or limit rule must then be fixed in three places, and the order-link trap in section 6.1 gets repeated.
3. **Airtime first, checkers later.** Same interface, smaller first release. Not chosen: the owner asked for both in this stage; the build order inside the stage still puts airtime before checkers (section 10).

## 5. How it works

### 5.1 Reading the text

- **Rules first, one new grammar per service, tried BEFORE the data grammar:**
  - airtime needs the word `airtime` (or `credit`, `recharge`, `topup`) AND an amount: `airtime 10`, `10 airtime`, `airtime ghs10`, `airtime 10 0241234567`, optional network word.
  - vouchers need the word `checker`, `checkers`, `voucher` or `vouchers` and/or a board word (`wassce`, `bece`, `novdec`): `2 wassce checkers`, `bece voucher`, `3 novdec`.
  - A bare number keeps meaning GB. A number with `gb`/`gig`/`mb` stays data. `at` stays a network word only.
- **AI second:** the existing one tool gains a `service` field (`data|airtime|results_checker`), `amount_ghs`, `board`, `quantity`. Every field is re-checked in code against the customer's own text and history: an amount must appear as a number the customer typed and must not be a data size (`10gb`), a recipient must appear in the text (as today), a board must be one of three words, a quantity an integer in range. The system prompt keeps "never state a price"; AI-written questions for airtime and vouchers must not contain digits (the money scrub already enforces this).
- Unclear service ("send me 10") stays data (10GB) as today.

### 5.2 Resolving

- **Airtime recipient:** with no number in the text, the recipient is the sender (own-number airtime) and the network comes from the sender's number. A number in the text makes it a gift (recipient and network from that number). The number must appear in the customer's own text, as for data.
- **Airtime:** network from the recipient's number using the admin prefix map first, then the static airtime table; only MTN, Telecel, AT; an unknown prefix asks "Which network is that number on?" (numbered choices). Checks: the per-network airtime switch (`airtime_enabled_*`), `getAirtimeLimits` min/max, the dialer's fee tier (`resolveDialer`, `airtimeBaseFeeRate`, `splitInclusive`), recipient valid, MTN number-verification block as for data. Preview = pay X, recipient gets Y.
- **Vouchers:** board enabled, stock (`getAvailableCount`), quantity 1..min(stock, max quantity), price via `calculateRCPrice({applyBulk:true})`. Recipient is always the sender; PINs go to the payer's number by the existing voucher SMS. No gift form.
- Gating: a text switch per service in admin (section 7) AND the existing live switches. The USSD menu-visibility toggles are NOT reused as the text switch (they are display toggles).

### 5.3 Placing the order

The lane calls the service's `place()`, which wraps the existing USSD handler as channel `sms`, with the same rules as the data path got in Stage 1:
- MoMo only: the wallet detour (`AIRTIME_PAYMENT_METHOD`, `RC_PAYMENT_METHOD`) is skipped for `sms`, forced inside the handler regardless of options.
- No 3-second wait, no OTP "redial" SMS from the handler (the lane notifier owns customer messages).
- No cashback field is ever set for `sms`; the cashback ternaries must not route `sms` to the WhatsApp switch (explicit legacy-only branch + test that the bot quote function is never called for `sms`).
- The handler returns the created `orderId` and the amount written on the order row (airtime: `total_paid` and `airtime_amount`; vouchers: `total_paid`). The quote is built from the order row after confirm, never from the preview (the fee tier is read live at confirm; voucher confirm re-prices with no "price changed" comparison).
- `setSession` is not called with the sender's number: the opaque session id convention stays (`sms:<message id>`).
- Both order rows keep `channel = 'ussd'` (see 6.5). The lane's link row records the service and table.
- Existing USSD and WhatsApp behaviour is pinned by characterisation tests written BEFORE any edit (the pattern of `bundles.confirm-sms.test.ts`).

### 5.4 Replies (all one GSM-7 segment, money filled by code)

- Airtime quote: `MTN airtime for 0241234567: you pay GHS 10.00, they get GHS 9.52. Approve the MoMo prompt now. <tip>` (same tip and fee-on-top rule as data; amounts come from the order row).
- Voucher quote: `2 WASSCE checkers, GHS 30.00. Approve the MoMo prompt now. PINs come by SMS to this number.`
- Unpaid retry text uses a re-textable token stored in the link (`size`): `airtime 10`, `2 wassce`.
- Help/not-understood copy mentions all enabled services ("data, airtime or checkers").
- Errors: below/over airtime limits (`Airtime is GHS a to b`), out of stock, board off, quantity too high.

### 5.5 Follow-ups (cron notifier)

- The link row stores `service` and `order_table`; the notifier reads the right table through the service's `readOrder` and `classify`. Airtime and vouchers use `payment_status` + `status` (not `order_status`) and `total_paid`.
- Status mapping per service (airtime: `pending_payment|otp_required` waiting; `failed|expired` payment_failed; paid + `pending|processing|flagged` paid; `completed` delivered; paid + `failed` delivery_failed; `refunding|refunded` refunded. Vouchers: same, no refunded state).
- Notices: `unpaid` and `repriced` as for data. `delivered`: airtime gifts only (the recipient's network already notifies the owner for own-number); vouchers never (the PIN SMS is the delivery). `paid_not_delivered` (30 minutes): neutral wording that does NOT say "no need to pay again" for airtime or vouchers ("We received your payment. Delivery is delayed; we are on it and will update you."), because admin "Failed" credits a registered payer's wallet and vouchers can be refunded.
- A voucher order that is paid but short of stock stays `pending`: the 30-minute notice covers it.
- **Accepted gap:** a voucher order that completes but whose PIN SMS never reaches the customer produces no lane follow-up. The existing "delivered via" record is best-effort, so it is not a reliable signal and a notice built on it would misfire. The runbook records this, and admins can see the order and the voucher SMS log.

### 5.6 Admin

- Two new settings, both default false, created by the first save (no seed row needed): "Airtime by text" and "Checkers by text" (Settings tab switches with helper text). A text switch can never turn on a service that is off on its own admin switch (per-network airtime switch, per-board checker switch).
- Overview adds per-service counts for today (computed from the link table's `service`; no new database function).
- Try-it works for the new services through the same dry run: airtime preview = pure fee computation; voucher preview = price + stock read; nothing written.
- The shared caps stay shared: per-sender and global prompt caps, one open order per sender across services, the overall reply cap.

## 6. Constraints discovered in the code (each becomes a task or test)

1. **Order-link trap.** `linkOrder` does not pass `service` or `order_table` today (database defaults 'data' / 'ussd_orders'); `latestOrderLink`, `watchedLinks`, `ussdOrderStatus`, `ussdOrderForNotify` and `orderStatusOf` assume `ussd_orders`. An airtime or voucher link written as it is would be read as a missing order and closed silently with no notices. The link functions must carry both fields, with a test that a link with the wrong table never closes quietly.
2. **No order id returned.** `handleAirtimeConfirm` and `createRcOrderAndChargeMomo` return only `end(...)`; the latter is private; the airtime channel type excludes `sms`. They need sms-capable variants that return `{orderId, amount...}`, exactly as `handleConfirm` did.
3. **Wallet detour** creates an orphan pending row with a menu and no charge: forced off for `sms` inside each handler.
4. **Fee model.** Airtime is fee-inclusive and tiered live; the quote comes from the order row.
5. **Channel value.** Both rows hard-code `channel:"ussd"`, and the Telecel/AT OTP redial in `router.ts` filters on `channel='ussd'`. Decision: keep `"ussd"` (no router change). A text-channel analytics tag is out of scope; the link table's `service` and the message log identify text orders.
6. **PIN SMS** is multi-segment, contains secrets, is logged in `sms_logs`, goes on the default sender to the payer: it stays on the existing delivery code and never touches `sendReply`.
7. **Voucher stock** is not reserved at order creation; a shortfall leaves a paid order at `pending`.
8. **Webhook SMS** (airtime "payment received", voucher PINs) bypass the lane's reply caps and sender ID; accepted, and documented in the runbook.
9. **Telecel on Paystack** needs a one-time code that the text lane cannot collect: unchanged from Stage 1 (choose Hubtel for the `sms_order` row).
10. **Test fakes** know only `ussd_orders`; the strict fake must learn the two new tables' columns.
11. **Unverified in the live database:** results-checker `status`/`payment_status` CHECKs may not allow `expired`, which the expiry job writes. Verify with `pg_get_constraintdef` before relying on `expired` for vouchers; the lane closes its own link at 30 minutes regardless.

## 7. Settings (no migration)

`ttb_airtime_enabled` (bool, default false), `ttb_results_checker_enabled` (bool, default false). Added to the settings type, key map, defaults, validation, API and the Settings tab, exactly like the Stage 1 settings added after the seed.

## 8. Data

No migration: `ttb_orders.service` and `order_table` are free text, notices are free keys, settings are upserted, conversation state is JSON. A new database function for per-service Overview counts is NOT built; counts are read from the link table.

## 9. Abuse cases

- Spoofed sender: same as Stage 1 (only the real owner's phone is prompted; caps and one-open-order apply). Airtime adds money-to-a-third-party: a spoofed sender can name any recipient, but pays nothing without the real owner's PIN.
- Amount confusion: "10gb" / "send 10 data" / "10" must never become airtime; "airtime 10gb" is not an airtime order.
- Fee tier gaming: the tier follows the sender's registered account, as on USSD; a dealer's number can only be prompted, not charged without their PIN.
- Voucher exhaustion: a sender cannot reserve stock (no reservation); per-sender prompt caps bound the rate.
- Admin "Failed" on a paid airtime order credits a registered payer's wallet (existing behaviour) and is now reachable from text; the notice wording never promises "no need to pay again".

## 10. Build order and rollout

Each step is its own reviewed unit; money-path steps get a fresh reviewer.
1. **Interface and data refactor:** adapter types, link functions carry service and table, notifier reads per table; data moved onto the interface; every Stage 1 test still green. No behaviour change.
2. **Airtime:** reader (rules + AI), resolve, sms-capable confirm path with characterisation tests of USSD/WhatsApp first, quote and notices, settings switch, Try-it.
3. **Vouchers:** same, plus stock and PIN-delivery handling.
4. **Admin and runbook:** per-service counts, switches, runbook sections, announcement text.
Ships dark (both switches off). Switch on one service at a time after a supervised paid test on each network. Rollback = switch off; nothing to undo in the database.

## 11. Left to the builder

- Exact adapter file layout and names (the interface in this document is the contract, not the file names).
- Wording of each reply within one GSM-7 segment (the worst-case amount and board lengths are tested).
- Which of the airtime grammar's word variants to accept beyond the listed ones, as long as the anti-goals hold.
- How the sms-capable handler variants are exported (a thin wrapper around the shared confirm logic is preferred over duplicating it).

## 12. Calls Claude made (owner to check)

- Both services share the existing prompt caps, the one-open-order rule and the reply cap.
- Row `channel` stays `'ussd'`; no router change.
- Airtime network detection uses the admin prefix map first, then the static table; an unknown prefix asks a question.
- `PRICES` stays data-only; no airtime or voucher price-list keyword.
- No delivered SMS for own-number airtime or for vouchers.
- The delayed-delivery notice for airtime and vouchers is reworded to avoid "no need to pay again".
- Text switches default off and are separate from the USSD menu-visibility toggles.
- Voucher PINs always go to the sender's number, never to a typed number.
- `airtime 10` with no number is own-number airtime (recipient and network from the sender's number); an unknown prefix asks which network.
- A lost voucher PIN SMS is an accepted, documented gap (no reliable failure signal).
