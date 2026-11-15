# Text-to-Buy: missed-call support SMS (and support-aware shop-line replies) — design

Date: 2026-11-15. Extends the Text-to-Buy stack (parent spec `2026-11-13-sms-text-to-buy-design.md`, shop line `2026-11-14-text-to-buy-stage3a-design.md`). Owner decisions from the conversation of 2026-11-14/15 are marked (owner).

## 1. Why

The shop number (0559919037) is also the public **support phone**, and the main number (0256078092) is the number customers text to order. Customers call these numbers and nobody answers; texts to the shop number that are not orders get a "not understood" reply with no way to reach a human. A missed call should automatically send the caller one short SMS saying where to get help. (owner)

## 2. Behaviour (owner decisions)

- **Main number** missed call -> one SMS with Datagod's **WhatsApp support line**, read live from `support_settings.support_whatsapp` (currently `233265753887`). Datagod pays.
- **Shop number** missed call ->
  - caller linked to a shop (their remembered shop in `ttb_shop_prefs`, else the shop they last bought from) and that shop is `active` -> one SMS with that **shop owner's number** (the shop's helpline, as the shop quotes show). The SMS costs the **shop 1 credit** (shop payer, same rules as other shop replies).
  - caller not linked to any shop, or the shop is closed/paused/cannot pay -> the Datagod **WhatsApp support line**, Datagod pays. (owner: "Datagod support line" for unknown callers; "shop's SMS credits" when linked.)
- **Support-aware replies on the shared shop number:** the shop line's "not understood" reply (and "Which shop?" fallbacks that already exist) gain a short pointer to the WhatsApp support line where it fits in one GSM-7 segment, because the support phone doubles as the shop line (owner confirmed intentional).

## 3. Goals, non-goals, anti-goals

Goals: dark behind an admin switch; at most one SMS per caller per line per day; hard hourly caps; the line comes only from the forwarder secret; no customer data in logs; admin visibility (counts) on the Overview.

Non-goals: ordering by call; call-back; recording calls; any change to the SMS order lane's money paths.

Anti-goals: an SMS storm to spoofed or repeated callers; Datagod silently paying for a shop's reply when the shop can pay (and vice versa); a missed call reaching the Send & Claim (MoMo) ingest.

## 4. Design

### 4.1 Phone side (forwarder app)
Settings -> **Forward Calls Log** on, call type **Missed** only; the app needs the READ_CALL_LOG permission (currently not granted). Two **call rules** (Rules -> Call tab): one limited to SIM-1 (shop line) sending to a "Shop Call" sender, one limited to SIM-2 (main line) sending to a "Main Call" sender. The two call senders are clones of the text senders with the URL changed to `/api/webhooks/call-forward` and the same `x-sms-forward-secret` values (shop secret on the shop sender, main secret on the main sender), params `from=[from]&received=[receive_time]` (the builder confirms the call-template tag names on the phone before the phone steps). The SIM numbering fix (Settings -> SIM SubId Refresh) must be in place. These phone steps are done by the owner or the controller after deploy, never by code.

### 4.2 Webhook `POST /api/webhooks/call-forward`
- Secret check reuses the timing-safe helpers in `lib/text-to-buy/forward-secrets.ts` and the same secret-to-line mapping as the SMS webhook (extract a shared `resolveForwardSource` if needed; keep SMS behaviour byte-identical). A call webhook **never** reaches the Send & Claim ingest (the MoMo secret maps to the main line for calls, MoMo parsing is not called).
- Body: `from`, `received`. Normalise `from` to a Ghana mobile local number; ignore anything else (short codes, international, anonymous). Ignore events older than 15 minutes (same staleness idea as texts). Always answer 200 after the secret check (the app retries on non-200): errors are logged without numbers.
- Heartbeat: touches the line's heartbeat like texts do.
- Gated by the call switch (section 4.5); when off it records nothing and answers 200.

### 4.3 Decision and reply
A pure function in `lib/text-to-buy/call/` decides, from injected deps, one of: send main support SMS, send shop-owner SMS (shop-paid), send support SMS (Datagod-paid fallback), or skip (reason: duplicate today, hourly cap, switch off, invalid caller, stale, blocked caller). Order: validate -> blocked sender (existing `ttb_blocked`) -> daily once-per-caller-per-line via `ttb_notice_once` (kinds `call_main` / `call_shop`; shop id null) -> hourly line cap -> for the shop line: shop resolution (`getShopPref`, then `lastBoughtShopCodeId`, resolved with the existing shop resolution helpers and verified `active`) -> payer: shop payer when linked and the shop account can pay (1 credit through the existing `sendReply` shop payer; an unpaid result falls back to the Datagod support SMS, sent at most once because the daily marker is already taken) -> send through the existing `sendReply` (one GSM-7 segment, sender ID per line, never throws) -> log.
Reply copy (one segment each, exact wording a builder call within these meanings): main/support: "Sorry we missed your call. For help WhatsApp us: <wa.me link>"; shop-owner: "Sorry we missed your call. Please contact <SHOP NAME> on <owner number>." The shop name is truncated like the shop quote (existing `gsm7` helper). A missing support number in settings means the SMS is skipped with an admin alert (never a blank or wrong number).

### 4.4 Data (one small additive migration, production protocol)
New table `ttb_calls` (id, line, sender, shop_id nullable, outcome text, created_at) for hourly counting and the Overview; service-role only, RLS on, no policies; `ttb_purge` deletes rows older than 30 days. Outcomes: `replied_main`, `replied_shop`, `replied_support`, `skipped_duplicate`, `skipped_cap`, `skipped_off`, `skipped_invalid`, `skipped_blocked`, `skipped_stale`, `error`. No call content exists to store.

### 4.5 Settings and admin
New settings (additive keys, defaults off/safe): `ttb_calls_enabled` (bool, default false, PUT needs `confirm: true`), `ttb_calls_per_hour_per_line` (int 5..500, default 60). Settings tab gets the switch and the cap. Overview gets "Missed calls today" per line (replied / skipped) and the shared-number note. Admin alerts: support number missing, send failures. The admin-action notifier is used as for the other settings.

### 4.6 Support-aware "not understood" on the shop line
The shop line reply for texts that are not orders gets the WhatsApp support pointer when it fits one GSM-7 segment; if it cannot fit, the existing wording is kept. Reads the same live support number. Main line wording is unchanged. Golden snapshots for the main line must not change.

### 4.7 Rulings after the builder check
- **Per-shop hourly cap:** it is enforced today by `shopReplyCapReached(db, shopId, settings)` in `lib/text-to-buy/shop/credits.ts` (used by the shop lane). The call path calls the same function before a shop-paid SMS; at the cap the shop path is skipped and the caller gets the Datagod support SMS once (the line hourly cap still bounds Datagod's cost).
- **Daily marker and failed sends:** the marker is taken first (this is what prevents a storm). A failed or refused send does not release it: the caller gets nothing more that day. Accepted (rare, cheap), logged as `error` in `ttb_calls`.
- **`ttb_notices.kind`:** the builder verifies in `migrations/0180_text_to_buy_shop_line.sql` that it has no CHECK; if it does, the new migration relaxes it. Kinds used: `call_main`, `call_shop`.
- **Owner number and "can pay":** `ShopRef.helpline` from the shop resolution helper is the owner's number. The paying account comes from `shopAccountFor(db, shopId)`; "can pay" is decided by attempting the shop payer through `sendReply` and reading `skipped: "unpaid"` (race-free), then falling back to the support SMS.
- **Which secret is which line for calls:** the primary secret (`SMS_FORWARD_SECRET`, the one the main-number senders use) means the main line; the shop secret means the shop line; an equal or unset secret follows the existing rules. A call sender must never use a MoMo-parsing path: the call route has no ingest at all.
- **Received time:** parsed with the existing `parseReceived` helper used for texts; missing or unparseable falls back to the server clock (the daily and hourly caps bound any replay).
- **Settings snapshot:** adding `ttb_calls_*` to `TtbSettings` adds default lines to the lane golden snapshots, additions only, as the shop line did; main-line wording snapshots must not change.

## 5. Abuse cases
- **Call flood from one number:** one SMS per caller per line per day, plus the hourly line cap; excess is logged as skipped, no SMS.
- **Spoofed caller ID:** the SMS goes to the owner of the spoofed number, at most once per day per number, bounded by the hourly cap; no money moves.
- **Drain a shop's credits with many callers:** the shop payer uses the existing per-shop hourly reply cap (`shopRepliesPerHourPerShop`); beyond it the caller gets nothing from the shop path (no Datagod fallback beyond the one daily support SMS, which the line cap bounds).
- **Forged webhook:** secret required; wrong secret 401; the call route cannot reach MoMo ingest.
- **Information leak:** the shop-owner SMS reveals the owner's number only to a number linked to that shop (they already receive it in quotes); an unlinked caller gets only Datagod's support line.

## 6. Rollout and review
Dark behind `ttb_calls_enabled`. Migration through the production change protocol (dry run, owner OK, apply before code deploys). A fresh reviewer is mandatory (it sends SMS and can charge shop credits); opus on the final whole-branch review. Test-first, logic in `lib/`, real `next build` before pushing main. Phone steps and a supervised test (call the shop number from a number linked to a shop, an unlinked number, and the main number) before switching on.

## 7. Left to the builder
Exact reply wording; the shared forward-source helper's shape; how "last bought" is read for this purpose (reuse `lastBoughtShopCodeId`); the Overview card layout; the call-template tag names confirmed on the phone.

## 8. Calls Claude made (owner to check)
- One switch for both numbers; one SMS per caller per line per day; hourly cap default 60.
- Calls to the main number always get the Datagod support line.
- An unpaid shop-owner SMS falls back to the support line once (Datagod pays) rather than staying silent.
- A new `ttb_calls` table instead of overloading `ttb_messages` (whose outcome values are for texts).
- The "not understood" support pointer is part of this work because of the shared number.
