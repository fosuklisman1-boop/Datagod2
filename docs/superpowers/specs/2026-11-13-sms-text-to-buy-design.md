# Text-to-Buy: order data by SMS — design

Date: 2026-11-13
Status: draft, awaiting owner approval
Builds on: Send & Claim SMS forwarder (`app/api/webhooks/sms-forward`, `lib/momo-claim/`), the USSD/WhatsApp bot order path (`lib/ussd/handlers/bundles.ts`), the payment gateway switch (`lib/payment-gateway/`), the WhatsApp AI ordering tool (`place_whatsapp_order` in `lib/ai-tools.ts`).

## 1. Intent

A customer texts the business number in their own words ("pls send me 5gig", "buy 2gb for 0551234567"). We work out the order, send a MoMo prompt to the number that texted, and deliver the data once they approve with their PIN. One text and one PIN.

Why: it works on any phone with no data, no app and no menu. A USSD session can time out; a text cannot. The forwarder phone is already in place for Send & Claim, so the inbound channel costs nothing new.

## 2. Goals, non-goals, anti-goals

Goals
- A clear text produces a quote SMS and a MoMo prompt with no further step.
- Free text is understood, including pidgin and Twi, short forms and typos.
- An unclear text gets one short question, and the answer is understood in context.
- Text-to-buy keeps working when Redis (Upstash) is down.
- Ships dark behind an admin switch.

Non-goals for version 1
- AFA registration (too many fields for SMS).
- Rebuy reminders and scheduled prompts. Phase 3.
- Paying from a wallet balance.
- Charging a number other than the sender's.

Anti-goals (a failure even if it works)
- A MoMo prompt for an amount or product the customer did not ask for.
- A prompt arriving on someone's phone hours after they texted.
- Any path where the AI sets a price, picks a payer, or moves money.
- A customer text ever being read as a MoMo payment notice, or a payment notice ever being read as an order.
- Unbounded SMS or AI spend caused by junk texts.

## 3. Decisions the owner made

- Customers write free text and an AI reads it (2026-11-13).
- Replies should come from the same number the customer texted, by registering that number as a sender ID (2026-11-13). Subject to section 9.
- The prompt goes out at once when the order is clear. No "reply 1 to pay" step. The PIN is the confirmation (2026-11-13).
- Two business numbers: one for the main Datagod menu, one for shops, as with the two USSD codes (2026-11-13).
- The AI must always show the right price (2026-11-13). See 5.10.
- Version 1 covers data bundles, airtime, results checker vouchers and bills (2026-11-13). See 5.11.
- On the shop line, replies are paid from the shop's SMS credits; a shop without credits is paused (2026-11-13).
- Shop owners get their own interface (2026-11-13).
- On the shop number, the customer's shop is remembered: a number that has bought from a shop before goes to that shop; a new customer gives the shop code once (2026-11-13).

## 4. Approaches considered

1. **Ride the existing bot order path (chosen).** SMS becomes a third channel beside `ussd` and `whatsapp`. The SMS lane builds the same order details the USSD menu collects and calls `handleConfirm`, which writes a `ussd_orders` row and starts the charge through `startUssdCharge`. Callbacks, delivery, refunds, expiry and admin order screens work unchanged. Cost: a small edit to live shared money code.
2. **A separate lane with its own orders table.** Touches nothing shared, but rebuilds every money path (callbacks, expiry, refunds, reversal flags, delivery messages, admin). Rejected: far larger, and each rebuilt path is a new place for money bugs.
3. **Feed SMS into the full WhatsApp AI unchanged.** Rejected: that flow asks for a MoMo number, shows 1/2/0 menus, writes long replies and carries many tools. It breaks one-text-one-PIN and the 160-character limit and widens what a hostile text can reach.

Chosen by Claude as the build approach; the owner left the how open.

## 5. How it works

### 5.1 Intake: the fork in the forwarder webhook

`POST /api/webhooks/sms-forward` keeps its header-secret check. After reading `{ text, from }`:

1. `from` exactly matches the Send & Claim sender allowlist → existing `ingestForwardedSms`, unchanged.
2. Else `from` normalises to a Ghana mobile number (`normalizeGhanaPhone`) and text-to-buy is switched on → the new order lane.
3. Else → existing `rejected_sender` handling, unchanged.

The two lanes share no parser and no tables. A text from a personal number is never passed to `parseMomoSms`. With the switch off, behaviour is exactly today's.

The webhook must answer the forwarder quickly. Store the inbound row, answer 200, and do the reading, replying and charging in `after()` (the pattern `handleConfirm` already uses). A failed store answers 503 so the forwarder retries.

Forwarder phone setup (owner, on the phone): the forwarding rule must also pass texts from ordinary numbers, and Params should carry the SMS receive time alongside `text` and `from`. The exact placeholder name in the SmsForwarder app is to be confirmed on the phone.

### 5.2 Intake checks, in order

- **Duplicate:** same sender + same text + same receive time is the same delivery. Without a receive time, same sender + same text within 2 minutes. Idempotent insert, as Send & Claim does.
- **Stale:** receive time older than the staleness limit (default 10 minutes, admin-set) → reply "Your message arrived late. Please text again." No prompt. If the forwarder cannot supply a receive time, this check cannot run; that is a launch gate (section 9).
- **Rate limits (database-backed, not Redis):** per sender — unapproved prompts per hour (default 3), AI reads per hour, replies per hour. One "I didn't understand" style reply per sender per hour; further junk is stored and ignored. A global cap on prompts per minute with an admin alert when hit.
- **One open order per sender:** while an unpaid SMS order for this sender is still awaiting approval, a new order text gets "Approve or wait for your first order" and no second prompt.

### 5.3 Reading the text

Two stages. Both produce the same small result: `{ sizeGb, network?, recipient? }`, a question to ask, or "not an order".

- **Rules first (pure function in `lib/`, no network call).** Handles the plain shapes: `5`, `5gb`, `5 gig`, `mtn 5gb`, `5gb 0551234567`. Instant, free, and works when the AI provider is down.
- **AI second, for everything else.** Uses the existing provider layer (`lib/ai-providers.ts`, the provider configured for WhatsApp). A short SMS-specific system prompt and exactly one tool, `propose_sms_order`. It does not get the WhatsApp tool list.

The AI's output is a proposal. Code decides:

- Network: from the recipient's prefix through the existing prefix map and its hard block. The sender's own number when no recipient is given.
- Package: the proposed size must match exactly one active, in-stock package for that network. No match → reply with the nearest sizes and prices.
- Recipient: any recipient number must appear digit for digit in the customer's own text (after stripping spaces and dashes). Otherwise the proposal is discarded and we ask.
- Price: resolved from the database the same way the USSD menu resolves it (`ussd_price_tier`, dealer and sub-agent tiers by the sender's registered number). Never taken from the AI or the text.
- MTN number registration / whitelist gates apply as they do on USSD.

The customer's text is untrusted input. The system prompt says so, and the single tool means there is nothing else for an injected instruction to call.

### 5.4 Conversation memory

A database table holds, per sender, the last few turns and any pending question, valid for about 20 minutes. It lets "i need data" → "Which size?" → "2" resolve to an order, and "how much is 10gb?" → price → "YES" resolve to an order. Nothing here uses Redis.

### 5.5 Placing the order and prompting

The lane builds the order details in memory (network, package id, size, price, recipient, payer = sender) and calls the shared confirm path with a new channel value `sms`:

- Extend the channel type from `'ussd' | 'whatsapp'` to include `'sms'`.
- Add a "MoMo only" option so a wallet-holding sender is not diverted to the payment-method screen. SMS never debits a wallet.
- For the gateway's payer rule (`isUssdHubtelPayer`), the owner phone on `sms` is the sender, and the charged number is the sender. No other number can be charged.
- Add a gateway surface `sms_order`, prompt-only like `ussd` and `whatsapp`, selectable at `/admin/gateway`. The existing `sms` surface is the bulk-SMS product and is left alone.

The session store's in-memory fallback already lets `handleConfirm` run without Redis; the SMS lane needs no later menu step from it.

Telecel on Paystack can answer `otp_required`. On SMS the customer replies with the code; the pending state for that lives in the conversation table and feeds the existing OTP submit handler. If that proves awkward, version 1 may refuse Telecel payers on Paystack with a clear reply; builder's call after reading `handleSubmitOtp`.

### 5.6 Replies

All replies are one SMS segment (160 characters), enforced in code with a hard cap, not left to the AI. Fixed templates for money messages; the AI writes only clarifying questions and price answers, which are then length-capped.

- Quote, sent with the prompt: `5GB MTN for 0241234567, GHS xx. Approve the MoMo prompt now. No prompt? Dial *170#, 6, 3.` (the missing-prompt tip is per network)
- Not paid / timed out: `Payment didn't go through. Text 5GB to try again.`
- Delivered: the buyer must get a delivered message. The builder traces what a USSD buyer receives today and makes sure an SMS buyer gets at least quote, failure and delivered, without doubling any message.
- Late, limited, unclear, out of stock: one template each.

Hubtel's prompt description stays "Clingshub" and references stay opaque, per the standing rule. The order detail lives in our SMS.

Replies go out through `lib/sms-service.ts` under a new category in SMS Provider Control. Sender ID is a setting: the business number if a provider and the networks carry it (section 9), an alphanumeric sender ID otherwise.

### 5.7 Linking a sender to an order

The SMS tables record which order id each conversation produced. That link, not a new column on `ussd_orders`, is how the failure and delivered replies find the sender, and how the one-open-order rule is checked. If the builder finds a channel column on `ussd_orders` is clearly simpler for existing screens, that is acceptable; it goes through the production change protocol either way.

### 5.8 Keywords

Read by the rules stage, no AI: `PRICES`/`MENU` (price list for the sender's network), `AGAIN` (repeat the last SMS order through all the same checks), `STATUS` (state of the last order), `HELP`.

### 5.9 Two numbers: main and shop

Each number is a separate phone running the forwarder. Which line a text came in on must be known with certainty, because it decides prices and who earns profit.

- **Identifying the line.** Each phone has its own forwarder secret (`SMS_FORWARD_SECRET` stays for the Send & Claim phone; a second secret for the other). The webhook maps the matching secret to a line, `main` or `shop`. Never trust a field in the body for this. The MoMo allowlist lane (Send & Claim) is only honoured on the line whose SIM is the MoMo business number.
- **Main line.** Sections 5.1 to 5.8 as written: `handleConfirm` in `lib/ussd/handlers/bundles.ts`, `ussd_orders`, Datagod prices.
- **Shop line.** The same intake, checks, reader, memory and reply rules, but the order is placed through the shop path (`lib/ussd-shop/handlers/bundles.ts`): the shop's prices and packages, the shop order table, and shop profit credited exactly as on the USSD shop menu. The shop resolver's gates apply unchanged (blocked or unapproved shops, activation). The same "third channel, MoMo only, payer is the sender" changes are made there, guarded by characterisation tests of today's shop USSD and shop WhatsApp behaviour.
- **Which shop.** In order: (1) a shop code in this text, validated by the existing shop resolver; (2) the shop remembered for this number; (3) the shop this number last bought from on USSD shop, shop WhatsApp or storefront; (4) otherwise reply "Which shop? Reply with the shop code" and hold the order in conversation memory. The existing `wa_shop_customer_prefs` table (phone → shop code) is the model; whether SMS shares that row or keeps its own is the builder's call, but a customer who switches shop on one channel should not be silently switched on another without that being a deliberate choice.
- **Recognising a code in free text.** A code only counts if it resolves to a real, open shop. The AI may point at a candidate word; code does the lookup. An unknown code gets a "shop not found" reply, never a fallback to a different shop.
- **Replies on the shop line** name the shop in the quote (`5GB MTN from KOFI DATA for 024..., GHS xx`) so a wrong-shop guess is visible before the PIN, and carry the shop's Helpline number where the reply has room.
- **Who pays for replies (owner decision 2026-11-13).** On the shop line, once the shop is resolved, every reply to that customer is debited from the shop's SMS credits (`sms_accounts`, through the existing debit/ledger functions only; never a direct balance update), 1 credit per reply, with the one-segment cap guaranteeing a reply never costs 2. The ledger row names Text-to-Buy and the order. Replies sent before a shop is resolved ("Which shop?", "shop not found") are paid by Datagod and rate-limited per sender. The main line uses Datagod's own SMS account. A reply that the provider definitely refused is refunded to the shop the way campaign sends are; an unknown outcome is treated as sent.
- **Credit check before the prompt.** Before any shop-line order is placed, the shop's SMS account must be active and hold enough credits for the whole order (3: quote, one spare, delivered). The credits for the order are reserved at that point so the delivered and failure replies cannot be starved by other sends; unused reserve is returned when the order closes. Builder's call whether reserve is a debit-then-refund or a hold, within the existing ledger rules.
- **Shop out of credits or SMS not activated (owner decision 2026-11-13): pause that shop.** No order, no prompt. The customer gets one Datagod-paid reply, at most once per customer per shop per day: "<SHOP> can't take text orders right now. Call <helpline>." The shop owner gets an alert to buy credits, throttled. The admin Overview lists paused shops.
- **Sender ID** is per line: each reply comes from the number the customer texted. Each number needs its own handset test (section 9).
- **Switches and rollout.** One on/off switch per line. Main ships and is proven first; the shop line follows on the same engine.
- **Gateway.** One `sms_order` surface covers both lines unless the owner wants them switchable separately.

### 5.10 Price guarantee

The AI never writes a price. This is enforced in code, not asked of the AI in its prompt.

- The AI's tool output carries no amount field. For a price question it returns "price query" plus the product; code resolves the price and fills a fixed template.
- Every reply that shows money is a fixed template filled by code from the database. The amount in the quote SMS and the amount on the order row come from the same resolved value in one function, so they cannot differ.
- The quote shows what the customer will see on the MoMo prompt: the order amount plus any gateway fee added on top for the customer (Hubtel adds its charge on top; USSD prices on Paystack already carry the fee). The builder confirms the exact prompt amount per gateway and tests that the SMS figure equals it.
- Any AI-written text (clarifying questions only) is scanned before sending; if it contains a currency word or symbol or a digit sequence that reads as an amount, it is discarded and the fixed fallback template is sent instead. Sizes ("2GB") are allowed.
- Price is resolved again at order time. A `YES` after a price answer re-resolves; if the price changed, the quote carries the new one. The PIN prompt always follows a quote with the current figure.
- Price source per line: Datagod's USSD price tier on the main line (dealer and sub-agent tiers by the sender's registered number), the shop's own prices on the shop line. Same resolution functions the USSD menus use; no second price table.
- Tests: for each service, a property-style test that the SMS amount equals the charged amount across tiers, lines and gateways; and a test that an AI reply containing a made-up price is replaced.

### 5.11 Services

Version 1: data bundles, airtime, results checker vouchers, bills. Each goes through the confirm handler its USSD menu already uses, with the same "third channel, MoMo only, payer is the sender" change and its own characterisation tests first. The AI tool gains a `service` discriminator, as `place_whatsapp_order` has.

- **Data** — as sections 5.3 to 5.5.
- **Airtime** — "airtime 10 for 0241234567". Amount is the customer's, within the existing airtime limits; any fee comes from the existing airtime fee rules. The known airtime fee-tier quirk (tier follows the payer) is harmless here because payer and orderer are the same number.
- **Results checker vouchers** — "2 wassce checkers". Exam type and quantity must match the existing catalogue and stock. Voucher PINs are delivered by SMS as the existing flow does; the builder confirms the delivery message fits the reply rules and, on the shop line, how many credits it costs.
- **Bills** — two texts. First: service and account or meter number ("ecg 0123456789 50"); we run the existing name/account lookup and reply "ECG prepaid, <NAME>, GHS 50, fee GHS x. Reply YES to pay." `YES` sends the prompt. This is the one place a confirm reply is kept, because paying the wrong account cannot be undone and the customer must see the account name first. Uses the Hubtel commission services path, its claim-before-send rule and its ledger.

A service is offered on a line only where the matching menu already offers it and that service's own existing switch is on. Text-to-Buy adds a per-service switch per line on top; it never turns on a service that is off elsewhere. Asking for a service that is off gets a short "not available by text yet" reply.

Build order: data, then airtime, then results checker, then bills. Each is switched on only after its own supervised paid test.

### 5.12 Smoother and cheaper (refinement round, 2026-11-13)

Owner decisions
- **Delivered SMS only when it adds something.** Sent for gifts (payer is not the recipient), results checker PINs, bills, and any failure or delay. Not sent when the customer bought data or airtime for their own number; the network's own notice covers that. This replaces "delivered: the buyer must get a delivered message" in 5.6 for own-number orders. The shop-line credit set-aside in 5.9 becomes 2 for own-number data and airtime, 3 otherwise.
- **Four stages**, section 10.

Claude's calls
- **No 3-second wait on SMS.** `handleConfirm` delays the charge 3 seconds because a prompt cannot show during an open USSD session. SMS has no session; the `sms` channel skips the delay. The builder confirms that is the delay's only purpose before removing it for this channel.
- **Retry without retyping.** After a failed or expired payment, `YES` within the conversation window places the same order again through every check, at the current price.
- **Numbered choices.** Clarifying questions and the price list offer numbered options; a single digit answers them while the question is pending. A bare digit with no pending question keeps its meaning as a size in GB.
- **Teach the short form.** Where the segment has room, a reply ends "Next time just text 5GB", steering customers to the rules path.
- **Never guess a number.** A recipient that is not a valid Ghana mobile number after normalising gets a question, never a prompt.
- **Wrong line.** A valid shop code texted to the main number gets "For shop orders text <shop number>", once per sender per day. No order.
- **Paid but not delivered.** When a paid order fails or is flagged for review or refund, the payer gets one message saying so and what happens next. The builder hooks this to the existing failure and refund states without promising a refund time the process does not guarantee.
- **No replies to non-customers.** Senders that are not Ghana mobile numbers (network promos, short codes, alphanumeric senders) are never replied to; already implied by 5.1, stated here as a cost rule.
- **Cost visibility.** The admin Overview shows reply-SMS and AI cost per day and per order, and the share of texts read by rules versus AI.
- **Operations.** Each forwarder phone stays on charge with stable internet; the quiet-phone alert is the backstop. A launch checklist item, not code.

## 6. Data

New tables (service role only, RLS on with no policies, as the Send & Claim tables):

- Inbound/outbound message log: sender, direction, text, receive time, outcome, order id. Customer texts are personal data: keep 30 days, then delete by cron. Never written to application logs.
- Conversation state per sender: recent turns, pending question, expiry.
- Rate-limit counters, or reuse the Send & Claim database rate-limit helper if it fits.

Settings (admin_settings keys): enabled switch (default off), number shown to customers, staleness minutes, per-sender limits, global prompt cap, reply sender ID.

## 7. Admin

One new page, `/admin/text-to-buy`, modelled on `/admin/momo-claims` (same tab layout, navy accent, desktop widening from the start, checked at 500px and 1280px). Sidebar entry carries the NEW tag (`lib/nav-new.ts`). All routes behind `verifyAdminAccess`; all reads and writes through server routes with the service role.

- **Overview.** One card per line (main, shop): on/off switch, the number, "phone last heard" (time of the last forward of any kind on that line's secret; red past a set quiet period), today's counts (texts, prompts, paid, delivered), and today's reply-SMS and AI cost.
- **Messages.** Every inbound text, newest first, filter by line, phone and outcome. A row shows the text, how it was read (rules or AI), the outcome (prompted, asked, late, limited, not an order, shop not found), and the linked order. Opening it shows the whole conversation with that number including replies. Per-number actions: Block, and Mark as misread (collects reader mistakes for the test set). Paged with a stable order (id tie-breaker). Rows older than 30 days are gone.
- **Try it.** Type a text, pick a line and a pretend sender, and see the reading and the reply that would be sent. Runs the real reader and checks with sending and charging stubbed out: no SMS, no order, no prompt. Admin only.
- **Settings.** Per line: switch, number shown to customers, reply sender ID. Limits: unapproved prompts per sender per hour, replies per sender per hour, staleness minutes, global prompts-per-minute cap. AI on/off (off means rules only). Blocked numbers. Every change goes through the central admin-action notifier (`lib/admin-actions/`), as Send & Claim settings do.

Existing pages
- Order screens: SMS orders appear with USSD and shop orders, marked SMS; refunds and retries unchanged.
- `/admin/gateway`: new `sms_order` row.
- SMS Provider Control: new "Text-to-Buy replies" category.
- Admin alerts: phone quiet, global cap tripped, replies failing, AI failing.

### 7.1 Shop owner page (owner decision 2026-11-13: shop owners get an interface)

A "Text Orders" page in the shop dashboard, for any account with a shop code (sub-agents included). Navy accent, `lg:` widening and multi-column from the start, NEW tag on the sidebar entry. Every route derives the shop from the logged-in owner on the server; no shop id is taken from the client. All reads go through server routes with the service role, scoped to that owner's shop; the new tables stay closed to browser roles.

- **Status.** Active, Paused (out of credits or SMS not activated), or Off (owner's own switch). Paused shows a banner and a Buy credits button into the existing credits page. The owner's switch only turns their shop off; it cannot turn the line on when admin has it off.
- **Credits.** Current SMS credit balance and roughly how many text orders it covers (balance / 3). A low-credit warning threshold the owner sets; the alert reuses existing notification channels and is throttled.
- **Tell your customers.** The shop number and the owner's shop code as one line ("Text 5GB <CODE> to <shop number>"), with Copy, Share on WhatsApp, and a simple downloadable poster.
- **Numbers (7 and 30 days).** Texts received, orders paid, delivered, profit from text orders, credits used.
- **Orders tab.** The shop's text orders: customer number, bundle, amount, status, profit. Same rows as the main shop order list, filtered to SMS.
- **Messages tab.** Conversations attributed to this shop: customer text, our reply, outcome, credits charged per reply. Only messages from the point the shop was resolved; nothing from the main line or other shops. Same 30-day retention.

Not available to shop owners: limits, blocking, the reader, reply wording (fixed in version 1 to hold the one-segment, one-credit rule), other shops' data.

## 8. Abuse cases

- **Faked sender number.** A prompt reaches the real owner of that number; nothing is charged without their PIN. Limited by the per-sender prompt cap and the one-open-order rule. This is why there is no wallet payment and no paying from another number.
- **Forged payment notice from a personal number.** Goes to the order lane, is not an order, gets at most one "didn't understand" reply. Never reaches the money parser.
- **Junk flood.** Each text costs the sender an SMS. Our cost is capped by the per-sender AI and reply limits and the global cap.
- **Prompt injection in the text.** One tool, code-side checks on every field, price from the database.
- **Delayed SMS.** The staleness check.
- **Double payment.** One open order per sender; the order id is the charge reference, as on USSD.
- **Cheaper than intended.** Price tier comes from the sender's registered role exactly as on USSD; the sender is also the payer, so a faked dealer number means the dealer is the one prompted.

## 9. To verify before launch

1. **Numeric sender ID.** First test 2026-11-13: Hubtel accepted a send with the owner's number as sender ID (HTTP 201, rate GHS 0.0243) and reported it Delivered 9 seconds later to an AT number (network id 62001), with `from` unchanged as the 10-digit number. Still to record from the handset: what sender it showed, and whether it threaded with the customer's own messages to that number. Repeat to an MTN and a Telecel handset: a past sender ID (`CLINGSDTGOD`) was accepted by Hubtel but not delivered on MTN, so Hubtel's acceptance proves nothing for MTN. Fallbacks, in order: the forwarder app sends replies from the SIM; alphanumeric sender ID with the number in the text.
2. **Receive time from the forwarder.** Confirm the SmsForwarder placeholder and that it survives retries. Without it there is no staleness check, and launch waits.
3. **Forwarder rule.** Confirm the phone forwards texts from ordinary numbers and still forwards MoMo notices exactly as now.
4. **Real texts.** Collect real samples in English, pidgin and Twi and add them to the reader's tests.
5. **Supervised paid test** on each network before the switch is announced.

## 10. Rollout

Four stages (owner decision 2026-11-13). Each stage gets its own implementation plan, review and supervised paid test, and is live before the next begins.

1. **Main number, data only, admin page.** Webhook fork, intake checks, reader (rules + AI), price guarantee, conversation memory, replies, `sms_order` gateway surface, `/admin/text-to-buy`. Proves the forwarder, the sender ID and the real cost.
2. **Airtime and results checker vouchers** on the main number.
3. **Shop number.** Second forwarder secret and line, shop resolution and memory, shop order path, shop SMS credits and pause rule, shop owner Text Orders page. Data first, then airtime and checkers where the shop menus offer them.
4. **Bills**, on whichever lines have bills enabled.

The stage 1 data model and line concept must already allow a second line and more services, so later stages add rows and handlers, not migrations that reshape stage 1 tables.

Dark behind the switch. Migration through the production change protocol. Money, auth and schema are all touched, so a fresh reviewer is mandatory. Test-first, with the reader, the checks and the reply templates as pure functions in `lib/`. Run a real `next build` before pushing main.

## 11. Left to the builder

- Exact table and column names, and whether to reuse the Send & Claim rate-limit helper.
- The wording of each reply template within 160 characters.
- How the "MoMo only" option is threaded through `handleConfirm` with the least change, guarded by characterisation tests of today's USSD and WhatsApp behaviour written first.
- Telecel-on-Paystack OTP: support by reply, or refuse with a clear message.
- Where the failure and delivered replies hook in (payment expiry, charge events, delivery confirmation outbox).

## 12. Calls Claude made (owner to check)

- Bills keep a "Reply YES" step after showing the account name; every other service prompts at once.
- Services are built and switched on one at a time: data, airtime, results checker, bills.
- Text-to-Buy never turns on a service that is switched off elsewhere.
- Any AI-written reply containing a money amount is discarded and replaced with a fixed reply.
- Payer is always the sender. No wallet payment.
- Plain texts are read by rules without the AI.
- One open SMS order per sender at a time.
- Texts older than 10 minutes are not acted on.
- Customer texts are kept 30 days.
- Same price as the USSD menu.
- Send & Claim stays on the phone whose SIM is the MoMo business number; orders run on a separate lane on both phones.
- New gateway surface `sms_order` rather than sharing `ussd`, one surface for both lines.
- Each phone has its own forwarder secret, and that secret decides main or shop.
- Main line is built and proven first; the shop line second.
- The shop is named in every shop-line quote.
- An unknown shop code never falls back to another shop.
- Shop owners can read the text of their own customers' messages, not only the outcome.
- Shop owners can switch text orders off for their own shop.
- Sub-agents with a shop code get the same page.
- A shop needs 3 credits in hand before a text order is taken, reserved for that order.
- Datagod pays for replies sent before the shop is known, and for the once-a-day "can't take text orders" reply.
