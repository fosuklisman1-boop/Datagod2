# Text-to-Buy (Stage 1, main number, data only) - owner runbook

Status (2026-11-13, late): merged to `main` and deployed; migration 0177 applied to production; the follow-up cron (cron-job.org job 8859910) is created and enabled; the switch was turned on by the owner for the first live test, which worked end to end for an own-number MTN order. Still to do before telling customers: the pre-launch gates in section 7. With the switch off, the SMS webhook behaves exactly as it did before this feature.
Spec: `docs/superpowers/specs/2026-11-13-sms-text-to-buy-design.md`. Plan: `docs/superpowers/plans/2026-11-13-text-to-buy-stage1-main-data.md`.

Everything marked **OWNER ACTION** changes production and needs your explicit OK. Sections 5.1 (migration) and 5.2 (cron) have been run, with the owner's OK, on 2026-11-13; the rest of the steps are the checklist for launch.

## 1. What it is, and what is not in Stage 1

1. A customer texts an order to the business number, in their own words ("5gb", "mtn 5gb for 0551234567", "pls send me 5gig").
2. Plain texts are read by fixed rules (free, no AI). Anything else goes to the AI, which only proposes a size, network and recipient. Code checks every field and fills every price from the database. The AI never writes a price, picks who pays, or moves money.
3. The customer gets one SMS with the quote and, at the same moment, a MoMo prompt on the number that texted. One text, one PIN.
4. The payer is always the number that texted. No wallet payment. No other number can be charged. A gift (a different recipient number) is paid by the sender.
5. Every reply is a single 160-character SMS. Keywords: `PRICES` / `MENU`, `AGAIN`, `STATUS`, `HELP`, and `YES` to retry after a failed payment.
6. Orders use the same order, payment, delivery and refund machinery as the USSD bot (channel `sms`), so the admin order screens work as before.

NOT in Stage 1:
- Airtime, results checker vouchers, bills (Stages 2 and 4).
- The shop number, shop credits for replies, shop pausing, the shop owner "Text Orders" page (Stage 3).
- Paying from a wallet, paying from a different number, AFA registration.

## 2. Key settings (admin_settings rows, all set by migration 0177)

Edit them on `/admin/text-to-buy`, tab Settings. Each is stored as `{"value": x}`.

| Key | Default | Meaning |
|---|---|---|
| `ttb_main_enabled` | false | Master switch. Off = webhook behaves as before. |
| `ttb_main_number` | "" | The number customers text (shown in replies and pages). |
| `ttb_reply_sender_id` | "" | Sender ID used for replies. Empty = whatever the SMS Provider Control chain uses. |
| `ttb_shop_reply_sender_id` | "" | Sender ID for the SHOP line's replies (used from Stage 3). Created the first time you save it; no migration. |
| `ttb_ai_enabled` | true | Off = rules only; unreadable texts get the help reply. |
| `ttb_reply_to_unclear` | true | Off = a text that is not an order gets NO reply, so unrelated or promotional texts cost nothing. (A bare YES or AGAIN with nothing to act on counts as unclear.) Created the first time you save it. |
| `ttb_global_replies_per_hour` | 300 | Cap on non-order replies across ALL senders per hour (10 to 5000). Help replies, questions and price lists go quiet once reached; order quotes, payment notices and replies after a MoMo prompt has started are never stopped. One admin alert per hour when reached. Created the first time you save it. |
| `ttb_stale_minutes` | 10 | A text received longer ago than this gets the "arrived late" reply, no prompt. |
| `ttb_prompts_per_hour` | 3 | Most MoMo prompts one sender can trigger per hour. |
| `ttb_replies_per_hour` | 6 | Most replies one sender is sent per hour. |
| `ttb_ai_reads_per_hour` | 10 | Most AI reads one sender may use per hour. |
| `ttb_global_prompts_per_minute` | 30 | Most prompts across everyone per minute (alert when hit). |
| `ttb_prompt_window_minutes` | 5 | An unpaid prompt blocks a new order from that sender this long; after it, "didn't go through" is sent. |
| `ttb_quiet_alert_minutes` | 60 | Alert when the forwarder phone has been silent this long. |
| `ttb_retention_days` | 30 | Stored texts and replies are deleted after this many days (cron). |

## 3. Where the code lives

| What | Where |
|---|---|
| Webhook fork (two lanes) | `app/api/webhooks/sms-forward/route.ts` |
| Reader, checks, replies, store, notifier | `lib/text-to-buy/` (`parse-rules.ts`, `ai-reader.ts`, `catalogue.ts`, `handle-inbound.ts`, `replies.ts`, `notify.ts`, `store.ts`, `settings.ts`, `parse-received.ts`) |
| Shared order path (channel `sms`) | `lib/ussd/handlers/bundles.ts`, `lib/ussd/buyer-tier.ts`, `lib/ussd/gateway-charge.ts` |
| Follow-up cron | `app/api/cron/text-to-buy-notify/route.ts` |
| Admin page and APIs | `app/admin/text-to-buy/`, `app/api/admin/text-to-buy/` (`route.ts`, `messages/route.ts`, `try/route.ts`) |
| Gateway surface `sms_order` | `lib/payment-gateway/config.ts`, `app/admin/gateway/_components/SurfacesCard.tsx` |
| SMS category "Text-to-Buy replies" | `lib/sms/categories.ts` |
| Migration | `migrations/0177_text_to_buy.sql` (self-test: `0177_text_to_buy.selftest.sql`) |
| Cron definition | `lib/cron-migration/crons.json`, `lib/cron-migration/jobs.ts` (batch B) |

## 4. Forwarder phone setup (OWNER ACTION, on the phone)

The phone is the one already running SmsForwarder for Send & Claim.

1. Open the forwarding rule. It must pass texts from ordinary numbers too, not only the sender `MobileMoney`. Remove any "sender must be MobileMoney" filter (or add a second rule with no sender filter that posts to the same URL).
2. Body Params must read exactly: `text=[org_content]&from=[from]&received=[<receive-time placeholder>]`. Look up the receive-time placeholder name in the SmsForwarder app (its placeholder list when editing Params) and test it. It is not guessed here. The webhook also accepts the field names `time`, `receive_time` and `date` if the app labels it differently; the value may be ISO 8601, `YYYY-MM-DD HH:mm:ss` (read as UTC), epoch seconds or epoch milliseconds.
3. Header stays unchanged: `x-sms-forward-secret` with the current `SMS_FORWARD_SECRET`. No URL change.
4. Optional: a second secret env `SMS_FORWARD_SECRET_MAIN` for a phone that is used for orders only. A MoMo payment notice that arrives under that secret is NOT credited (Send & Claim is honoured only on the primary secret). Only set this if you run a separate orders-only phone.
5. Keep the phone on charge with stable internet. If it goes quiet for `ttb_quiet_alert_minutes` an admin alert fires.
6. Confirm the receive time arrives (LAUNCH GATE):
   1. Send a text from another phone to the forwarder phone.
   2. With the switch ON (during the supervised test, or on a preview), open `/admin/text-to-buy`, tab Messages, and open the row for that text.
   3. `received_at` must be set to the time the phone received it (within a minute). If it is empty, the placeholder or field name is wrong: fix it and repeat. Do not launch with it empty (there is then no "arrived late" protection).
7. Confirm Send & Claim still works: a real MoMo notice still creates a claim exactly as before (see test 9 in section 8).

## 5. Production steps, in order (OWNER ACTIONS)

Every step follows the production change protocol: precheck counts, a self-rolling-back dry run, your OK, apply, verify, build, push, watch the deploy, live check. Nothing happens until you approve each step.

**Order matters: apply the migration BEFORE deploying the code.** If the code is live first, every inbound SMS logs "heartbeat not recorded" until the migration is applied. It is harmless but noisy.

**Migration number.** This migration is numbered **0177**. It was first numbered 0163, which clashed with `feat/retire-api-v1` (0163 and 0164); main already has 0160 to 0162 and 0170 to 0176. 0177 is above every number on every branch checked on 2026-11-13. Before applying, re-check that nothing newer has taken 0177 (list `migrations/` on `origin/main` and on any open branch that adds migrations).

### 5.1 Apply migration 0177

Precheck (read-only). All must return nothing or zero:

```sql
select to_regclass('public.ttb_messages'), to_regclass('public.ttb_conversations'),
       to_regclass('public.ttb_orders'), to_regclass('public.ttb_blocked'), to_regclass('public.ttb_heartbeat');
-- expected: five NULLs. If any is not NULL, STOP: 0177 was already applied (or partly). Do not re-run it blindly.

select count(*) from admin_settings where key like 'ttb\_%';
-- expected: 0
```

Dry run: run the whole file inside a transaction that ends in a RAISE so it rolls back, then run `migrations/0177_text_to_buy.selftest.sql` the same way. Expected: no error. Then your OK, then apply.

After applying, verify (read-only):

```sql
-- the 5 tables
select table_name from information_schema.tables
 where table_schema='public' and table_name in ('ttb_messages','ttb_conversations','ttb_orders','ttb_blocked','ttb_heartbeat')
 order by 1;                                    -- expected: 5 rows

-- the 5 functions (includes ttb_add_notice)
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and proname in ('ttb_counts','ttb_global_prompts','ttb_overview','ttb_purge','ttb_add_notice')
 order by 1;                                    -- expected: 5 rows

-- the 12 settings rows, switch off
select key, value from admin_settings where key like 'ttb\_%' order by key;
                                                -- expected: 12 rows; ttb_main_enabled = {"value": false}
select value from admin_settings where key='ttb_main_enabled';   -- expected {"value": false}

-- RLS on
select relname, relrowsecurity from pg_class
 where relname in ('ttb_messages','ttb_conversations','ttb_orders','ttb_blocked','ttb_heartbeat');
                                                -- expected: 5 rows, all true

-- no anon / authenticated grants on the tables
select table_name, grantee, privilege_type from information_schema.table_privileges
 where table_schema='public' and table_name like 'ttb\_%' and grantee in ('anon','authenticated','PUBLIC');
                                                -- expected: 0 rows

-- no anon / authenticated / PUBLIC execute on the functions
select p.proname, r.rolname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
 where n.nspname='public' and p.proname in ('ttb_counts','ttb_global_prompts','ttb_overview','ttb_purge','ttb_add_notice')
   and has_function_privilege(r.rolname, p.oid, 'EXECUTE');
                                                -- expected: 0 rows
```

Note for re-running: 0177 repeats `REVOKE ALL ... FROM service_role` then re-grants; if it is ever re-applied, run it whole, not in pieces.

### 5.2 Create the cron job

crons.json alone schedules nothing; the job must exist on cron-job.org.

1. Dry run (no API calls): `npx tsx scripts/sync-cronjob-org.ts --only /api/cron/text-to-buy-notify`. Expected: one line `create B  * * * * *  /api/cron/text-to-buy-notify` and `1 jobs`.
2. Real diff (1 API call): `npx tsx scripts/sync-cronjob-org.ts --plan --only /api/cron/text-to-buy-notify`. Expected: the same single row with action `create`.
3. Create it (needs `CRONJOB_API_KEY` and `CRON_SECRET` in `.env.local`; runs a preflight that `/api/cron/sms-kyc-purge` answers 401): `npx tsx scripts/sync-cronjob-org.ts --apply --only /api/cron/text-to-buy-notify`. Expected: `created <id> /api/cron/text-to-buy-notify`. It is created DISABLED.
4. Enable it after the migration is applied and the code is deployed: `npx tsx scripts/sync-cronjob-org.ts --enable B --only /api/cron/text-to-buy-notify`. Expected: `enabled <id> /api/cron/text-to-buy-notify` then `1 changed, 0 already enabled`.
5. Check: the route answers 401 to a request without the cron secret; with the switch off the cron does nothing harmful (it follows open links, sweeps stranded texts, purges old rows, checks the quiet phone).

The cron can stay enabled or be disabled (`--disable B --only ...`) at any time.

### 5.3 Gateway setting

1. `/admin/gateway`, row "Text orders (SMS)" (surface `sms_order`). Default is Paystack/direct.
2. A Telecel customer paying through Paystack may be asked for a one-time code (OTP). Stage 1 cannot finish that by text; the customer gets the "Payment didn't go through" reply. So choose Hubtel for this row BEFORE you promote the feature to Telecel customers.
3. Hubtel quotes show "+ MoMo charge" (the fee is added on top on the prompt). See section 9.

### 5.4 SMS Provider Control

`/admin/sms-centre`, Providers tab (SMS Provider Control), category "Text-to-Buy replies": default Hubtel. Keep Hubtel unless a test in section 6 shows otherwise.

### 5.5 Admin settings, then the switch

1. `/admin/text-to-buy` tab Settings: set the number shown to customers (`ttb_main_number`), the reply sender ID (`ttb_reply_sender_id`, see section 6) and review the limits in section 2.
2. Only after all launch gates in section 10 are ticked: Overview tab, flip the switch for the main line (a confirm dialog appears). This is the last step.

## 6. Sender ID test checklist (do before the switch, per network)

The reply should come from the same number the customer texted, so it lands in the same thread. Hubtel accepting a send proves nothing about delivery on a given network.

For each of MTN, Telecel, AT, from a real handset on that network (record the result):
1. Delivered at all? (yes / no / how long)
2. Sender shown as the business number (not a name or a strange number)?
3. Does it appear in the same thread as the customer's own messages to that number?

| Network | Delivered | Sender shown | Same thread | Notes |
|---|---|---|---|---|
| MTN | Yes | still to record | still to record | 2026-11-13: Hubtel accepted the owner's number as sender ID to an MTN number and reported Delivered within about 9 seconds (Hubtel network code 62001 = MTN Ghana; 62002 = Telecel; 62003 = AT). The live Text-to-Buy replies (AI question, quote, unpaid notice) also reached the owner's MTN handset. What the handset displays as the sender, and whether it threads with the customer's own messages, is still to be recorded. A past alphanumeric sender ID (`CLINGSDTGOD` style) was accepted by Hubtel but NOT delivered on MTN, so numeric IDs behave differently. |
| Telecel | TO TEST | TO TEST | TO TEST | |
| AT | TO TEST | TO TEST | TO TEST | NOT yet tested. (An earlier note here called the first test "AT": that was wrong. The test number was MTN, see the MTN row.) |

If a network fails, the fallbacks in order: replies sent from the SIM by the forwarder app; an alphanumeric sender ID with the number written in the text.

"No prompt?" dial paths in the quote SMS. The MTN path is the one USSD already uses. The Telecel and AT paths are PLACEHOLDERS to confirm on real handsets (does the menu exist, and are the digits right). The exact strings are the `PAYER_TIPS` table in `lib/text-to-buy/replies.ts`:
- MTN: `No prompt? Dial *170#, 6, 3.`
- Telecel: `No prompt? Dial *110#, 4, 2.` (placeholder)
- AT: `No prompt? Dial *110#, 6.` (placeholder)

To change one, edit that string in `PAYER_TIPS` (and the matching expectations in `lib/text-to-buy/replies.test.ts`), then deploy. An empty string removes the tip for that network.

## 7. Pre-launch gates (tick each)

- [x] Receive time arrives: a real text shows `received_at` in the Messages tab (section 4 step 6). Done 2026-11-13 (the forwarder Params use `received=[receive_time]`).
- [ ] Sender ID verified on MTN, Telecel and AT (section 6 table filled in). MTN delivery proven; Telecel and AT still to test, and the handset display/threading is still to record.
- [ ] Real catalogue query run, and every size spelling confirmed parseable. Read-only:
  ```sql
  select network, size, count(*) from packages where is_available group by 1, 2 order by 1, 2;
  ```
  Put each row's size into the "Try it" tab (section 8 note) and confirm it is found. A size whose text cannot be parsed is NOT orderable by text. A bare number is read as GB: check that no bare number in the catalogue means MB.
- [ ] Telecel and AT "no prompt? dial ..." paths confirmed on handsets (section 6).
- [ ] Gateway row "Text orders (SMS)" set (Hubtel before promoting to Telecel customers).
- [ ] Supervised paid test passed on each network (section 8).
- [ ] Browser pass of `/admin/text-to-buy` at 500px and 1280px. NOT yet done: the page was built without a browser check. (The detail lists in Overview and Try it were fixed to `grid-cols-[auto_1fr]`: confirm they show two columns.)
- [x] Migration 0177 applied and verified; cron job created and enabled (section 5). Done 2026-11-13.
- [x] Whole-branch review done (money, auth and schema are touched: a fresh reviewer is mandatory). Done 2026-11-13; its Important findings were fixed.

## 8. Supervised paid test script

Use your own phones and a small package (for example 1GB). Open `/admin/text-to-buy` in a second window: Messages tab (every text with its outcome; click a row for the whole conversation with replies) and, for orders, the normal USSD order screen (SMS orders appear with USSD orders, channel `sms`). The Try it tab runs the real reader with nothing sent or charged: use it for a free check of any wording first (a real customer's number typed there shows that customer's own STATUS and conversation view, so use your own).

Expected SMS texts below are the current templates; sizes and prices are filled by code.

1. Own-number order. Text `1GB` from phone A (the number to be charged).
   - Expect within seconds: `1GB MTN for 0XXXXXXXXX, GHS x.xx. Approve the MoMo prompt now. No prompt? Dial ... Next time just text 1GB` (or `+ MoMo charge` instead of the figure's final total if Hubtel adds a fee on top), and a MoMo prompt on phone A for the same amount.
   - Approve. Expect the network's own data notice, and NO extra "delivered" SMS from us (own-number orders get none).
   - Messages tab: inbound row outcome "Payment prompt sent", linked order. Order screen: paid, then completed.
   - Wrong: no quote, no prompt, a second prompt, a prompt amount different from the quote with no "Total is now" follow-up, or a "delivered" SMS for an own-number order.
2. Gift order. From phone A text `1GB 0XXXXXXXXX` with phone B's number.
   - Expect the quote naming phone B, and the prompt on phone A (never phone B). After approval, phone A gets `1GB sent to 0XXXXXXXXX. Text 1GB to buy again.`
   - Wrong: phone B gets a prompt, or the order is for phone A.
3. Ignored prompt. Text `1GB`, do not approve, wait past the window (`ttb_prompt_window_minutes`, default 5 minutes, then up to a minute for the cron).
   - Expect: `Payment didn't go through. Reply YES to try again, or text 1GB. If you already approved, ignore this.` Then reply `YES`: expect a fresh quote and prompt at the current price. Approve this time.
   - Wrong: no "didn't go through" reply after about 7 minutes, or YES places a different size.
4. Late approval after the window closed. Text `1GB`, ignore until the "didn't go through" reply arrives, then approve the OLD prompt if it is still on screen (or on the MoMo approvals list).
   - Expect: the order still completes (paid), the system notices the late payment (the open-link scan sets it paid) and a gift order gets its "sent to" SMS; an own-number order gets nothing more.
   - Wrong: money taken and the order stays unpaid in the order screen. If so, do not retry: check the order and the payment manually.
5. `PRICES` then a digit. Text `PRICES`: expect `MTN: 1) 1GB GHS x.xx 2) 2GB GHS x.xx ...` (as many as fit one SMS). Reply with one digit, for example `2`: expect an order for that item (quote and prompt). (A bare digit with no question pending means that many GB.)
   - Wrong: prices that differ from the USSD menu for the same account, or the digit ordering the wrong size.
6. Junk text. Text something unrelated (`hello how are you`, then another junk text).
   - Expect exactly one polite reply (`To buy data, text the size e.g. 5GB. ...`), then silence for that sender for the next hour. Both rows stored with outcome "Not an order".
   - Wrong: a reply to every junk text, or any prompt.
7. Duplicate send of the same SMS. Make the forwarder deliver the same SMS twice (for example use the app's resend or retry on the same message).
   - Expect one order and one prompt. The second delivery is stored as a duplicate and does nothing.
   - Wrong: two prompts.
8. A text arriving more than the stale limit late. Make the forwarder deliver a text whose receive time is older than `ttb_stale_minutes` (for example turn off the phone's internet for 15 minutes with a text pending, then restore it).
   - Expect: `Your message arrived late so we did not charge you. Please text again.` No order, no prompt. Outcome "Too late to pay".
   - Wrong: a prompt for an old text.
9. A MoMo notice (Send & Claim unaffected). Send or wait for a real MoMo payment notice from the MoMo sender as usual.
   - Expect: it appears in the Send & Claim page exactly as before and creates no Text-to-Buy row and no reply.
   - Also: a text from an ordinary personal number that LOOKS like a payment notice is stored as an order-lane text ("Not an order"), never credited.
   - Wrong: a notice treated as an order, or a personal text credited as a payment.

Repeat tests 1 and 3 on each of MTN, Telecel and AT payer numbers (Telecel only after the gateway row is set to Hubtel).

## 9. Known limits and accepted risks (in plain words)

1. Two texts at once. If one customer's two texts arrive almost together, both can pass the "one open order" check. The loser's order is LEFT PENDING (never failed: its MoMo prompt was already started and cannot be stopped, and a payment for a failed order would be ignored with no refund path). If the customer approves both prompts they are charged twice and BOTH orders are fulfilled: two bundles, no lost money, but the customer paid twice for the same text. Admins get an alert naming the order id only. The second order has no Text-to-Buy link row, so it gets no follow-up SMS. There is no automatic refund; `/admin/refunds` handles completed orders in the normal way if you decide to refund one. The same applies if linking an order fails after it was placed: the quote is still sent, an admin alert names the order id, and there is no follow-up SMS for it.
2. Sizes whose text cannot be parsed are not orderable by text. A bare number as a size (for example `5`) is read as GB.
3. A Hubtel quote shows "+ MoMo charge". If Hubtel refuses the prompt and the charge falls back to Paystack, the prompt amount can differ from the quote; the customer then gets one corrective SMS (`Total is now GHS x.xx. Approve the MoMo prompt or ignore it.`).
4. Follow-up SMS (didn't go through, delivered gift, delayed, repriced) are dropped, not queued, while SMS is globally disabled.
5. Limits: hourly caps per sender (prompts, replies, AI reads), a global prompts-per-minute cap, and one open order per sender (the next text gets "Approve the MoMo prompt for your first order, or wait 5 minutes and text again."). Late replies do not count toward the hourly reply cap.
6. Replies are paid by Datagod's SMS account on the main line (about one SMS per reply, one segment each).
7. The price tier follows the SENDER's account. A dealer texting for a gift pays the dealer price.
8. Only the sender can be charged. Never a wallet, never the recipient.
9. Pre-existing, not changed here (owner follow-up): `lib/sms-service.ts` console.logs the recipient phone number on every send across the whole app.
10. The webhook answers 200 before it processes the text. If the server dies mid-processing, the one-minute cron sweep picks the text up; a text older than the stale limit by then gets the "arrived late" reply instead of an order.
11. A refunded or refunding order sends no "delivery delayed" notice; the order screen shows it.
12. If the forwarder phone is off, texts are not received. The quiet-phone alert is the only backstop.

## 10. Rollback

1. Switch off: `/admin/text-to-buy`, Overview, main line switch (or set `ttb_main_enabled` to false). The webhook then behaves exactly as before: a text from a personal number on the primary secret is stored as `rejected_sender` with the text redacted, as today. Texts already in flight finish normally.
2. No data migration to undo. The five tables and 12 settings rows can stay.
3. The cron job can stay (harmless) or be disabled: `npx tsx scripts/sync-cronjob-org.ts --disable B --only /api/cron/text-to-buy-notify`.
4. To remove the feature fully, revert the merge; migration 0177 is additive and unused when off.

## 11. Announcement (hold until launch)

Hold until every gate in section 7 is ticked. Ready-to-paste text for the customer channel, with the number filled in:

> 📢 NEW: Buy data by SMS 🎉
>
> No internet, no app, no code to dial. Just text us.
>
> HOW IT WORKS
> 1️⃣ Text <number> with the size you want, in your own words. Example: `5GB`, or "please send me 5 gig"
> 2️⃣ We reply with the price, and a MoMo prompt comes to your phone
> 3️⃣ Enter your MoMo PIN. Your data arrives ✅
>
> BUYING FOR SOMEONE ELSE?
> Add their number: `5GB 0241234567`. You pay with your MoMo and they get the data. You get a message when it has been sent.
>
> OTHER THINGS YOU CAN TEXT
> • PRICES: see the price list
> • AGAIN: repeat your last order
> • STATUS: check your last order
> • YES: try again if a payment did not go through
>
> GOOD TO KNOW
> • The MoMo prompt goes to the number you text from. Nothing is taken until you enter your PIN.
> • No prompt? On MTN dial *170#, choose 6, then 3 to approve.
> • Save <number> and try it today 📲
>
> (Before posting: fill in the number, and check the "No prompt?" line for Telecel and AT customers matches what the quote SMS says for those networks.)

## 12. Stage 2: airtime and checkers (OWNER runbook)

### 12.1 What it is

Customers text the main number for two more services, on the same lane as data:

- Airtime: `airtime 10` (own number) or `airtime 10 0241234567` (someone else's). The quote names the network, the number and the total; a MoMo prompt goes to the number they texted from. Airtime is credited by the normal airtime flow after payment.
- Checkers (results checker vouchers): `2 wassce` (also `bece`, `novdec`). The quote carries the board, the quantity and the total (bulk price applies by quantity). After payment the PIN(s) arrive by SMS to the number that texted.

Payer is always the texting number. No wallet, no other number can be charged. Data behaves exactly as in Stage 1.

### 12.2 The two switches

Two new switches, both default OFF, on `/admin/text-to-buy` settings (PUT field names `airtimeEnabled` = `ttb_airtime_enabled`, `resultsCheckerEnabled` = `ttb_results_checker_enabled`). Switching either ON asks for confirmation. They sit under the main Text-to-Buy switch: with the main switch off, nothing is read at all. The existing controls still apply on top: the per-network airtime switches and the per-board checker switches. A text switch that is OFF does not produce a "not available" reply: the text is treated exactly as in Stage 1, so the customer gets the Stage 1 not-understood copy, or silence if unclear replies are off or one was already sent. Only the per-network airtime switches and the per-board checker switches give a "not available" reply. With a text switch off the AI is never allowed to ask about that service either (no "how much airtime?" or "how many checkers?" question). The Overview card "By service today" shows an Off badge on it.

### 12.3 Switch-on order

One service at a time, each only after a supervised PAID test: airtime on MTN, Telecel and AT payer numbers; checkers on one board. Leave the first service on for a day and look at the Overview card before switching the next.

### 12.4 Supervised test script

Use your own phones and the smallest amounts. Expected texts below are the current templates; figures are filled by code.

1. Own-number airtime. From phone A text `airtime 1`. Expect a one-segment quote naming the network, phone A and the total ending with "Approve the MoMo prompt now."; a MoMo prompt on phone A for the same amount. Approve: the airtime arrives and the "payment received" SMS comes from the airtime flow.
2. Gift airtime. From phone A text `airtime 1 <phone B>`. Quote names phone B; the prompt goes to phone A only. After payment and delivery, phone A gets a "sent to <phone B>" message.
3. Unknown prefix. Text `airtime 1 <a number on a prefix we do not know>`. Expect the question "Which network is that number on? 1) MTN 2) Telecel 3) AT". Answer `1`, `2` or `3`: the quote follows. An invalid number gets "That phone number is not valid."
4. Limits. Text `airtime 0.5` and then an amount above the maximum. Expect the "limits" reply that states the minimum and the maximum, and no prompt.
5. `10gb` stays data. Text `10gb`: a data quote, never airtime.
6. Checkers with bulk price. Text `2 wassce` (or the board you are testing). Expect the quote with board, quantity 2, the bulk total and "PINs come by SMS to this number." Approve: two PINs arrive by SMS on phone A. Ask for a quantity that reaches a bulk tier and check the total against the price in admin.
7. Out of stock. With a board at zero stock, text it. Expect the "not available now" reply (or, if stock ran out after the prompt, see the pending note in 12.5).
8. Ignored prompt. Text `airtime 1`, do not approve. After the window the lane sends the "Payment didn't go through" style notice and closes the link. No charge.
9. Late approval. Approve the prompt after that notice. The normal webhook still credits it. The lane sends nothing, with one exception: a GIFT airtime order that is delivered still gets the "sent to <phone B>" delivered notice to phone A. A plain own-number order gets no further text. Check the order is paid and delivered and nobody is charged twice.

Repeat test 1 on MTN, Telecel (only with the gateway row on Hubtel, see 12.5) and AT payer numbers.

### 12.5 Accepted gaps (in plain words)

1. A completed voucher order whose PIN SMS never arrives gets no lane follow-up. The PIN SMS is the webhook's own send. Check the order and the SMS log, and resend by hand if needed.
2. Voucher stock is not reserved when the prompt goes out. A paid order can wait at `pending` if stock ran out in between. The customer gets the delay notice; an admin resolves it from the normal results-checker order screen.
3. The webhook's own SMS (airtime "payment received", voucher PINs) bypass the lane's reply caps and the lane's sender ID. They count against nothing in the Text-to-Buy caps.
4. Admin "Failed" on a paid airtime order credits a registered payer's wallet (existing behaviour of that flow). Check the payer before marking it.
5. Telecel on Paystack needs a one-time code the text lane cannot collect. Keep `sms_order` on Hubtel in the gateway settings. An order that comes back as `otp_required` (a code prompt the lane cannot collect), for airtime or vouchers, simply stays `otp_required`; the lane closes it with the unpaid notice at the window. Tell the customer to retry with another network or number.
6. The caps (prompts per hour, replies per hour, global prompts per minute) are shared across all three services.
7. Order rows still say `channel = 'ussd'`, as for data. Tell text orders apart by the Text-to-Buy link, not by channel.
8. A possible orphan charge. If placing an order throws an unexpected error, the customer gets no SMS, and the admin alert reads "placing an order failed unexpectedly: message <messageId>". The prompt may already have been sent. Check Paystack and Hubtel and the order tables around that time for that sender. No lane follow-up will ever come, because no link row exists. Refund through `/admin/refunds` if the customer was charged.
9. Placing is guarded, not idempotent. Just before an order is placed the lane marks the incoming text as handled (outcome `error`), so the recovery sweep and a forwarder retry can never place it a second time; if that mark cannot be written, nothing is placed and the customer is told it is not available. The residual risk is the other direction: if the server dies after the mark but before the order or its link is recorded, the text is NOT retried and the customer may get no reply (and, rarely, an order with no link row). Look for inbound rows with outcome `error` and no order link, and check the order tables and gateways for that sender around that time.
10. The voucher quantity question completes on a bare whole number only: `2` works, `two` is asked again.

### 12.6 OWNER check before switching vouchers on

Run this read-only in the SQL editor and record the answer:

`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'results_checker_orders'::regclass`

Note whether the status check constraint allows `expired`. The lane closes its own link at 30 minutes either way; this only tells you whether the order row can also be marked expired.

### 12.7 Rollback

Switch the service off (Overview or settings). Nothing to undo in the database. Orders already prompted finish normally; the lane still sends their follow-ups.

Never roll the deploy back to Stage 1 code while airtime or voucher links are open. Stage 1 code reads `ussd_orders` for every link, so it would close those links silently and send wrong notices. Switch the services off and let open links finish (30 minutes) first.

### 12.8 Announcement (HOLD UNTIL LAUNCH)

Post only after the supervised tests for each service you are announcing pass:

```
New: buy airtime and checkers by text!
Text the main number:
- airtime 10  (GHS 10 airtime for your own number)
- airtime 10 0241234567  (for someone else)
- 2 wassce  (2 WASSCE checkers; also bece, novdec)
Approve the MoMo prompt with your PIN. Checker PINs come by SMS to the number you texted from.
```
