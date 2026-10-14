# Commission Cashback — Bots design (Part 2 + Phase 4)

Date: 2026-10-14 · Status: draft for review · Builds on Commission Cashback Part 1 (dashboard), Plan A (storefronts) and Plan B (API) —
all live-dark. Replaces the open "Part 2 (bots)" and "Phase 4 (bills on bots)".

## 1. Purpose

All five chat/USSD surfaces sell airtime, **Network Plans** (Hubtel Standard Bundles) and **Pay Bills** (Utility Bills) with
commission-cashback pricing, paid through each bot's existing payment method, with shop bots crediting the shop's share.

Success: a customer on any bot sees "Pay GHS x (was GHS y) · You receive …" before paying, pays once, the provider gets face, the
order completes or is refundable; a shop bot's shop earns its share at payment (clawed back on refund); no bot path debits, sends or
credits twice; and every bot keeps today's behaviour while its switch is off.

## 2. Decisions (user, 2026-10-14)

| Topic | Decision |
|---|---|
| Surfaces | All five: Hubtel USSD (live, shop mode, "Clingshub"), main USSD (`lib/ussd`), shop USSD (`lib/ussd-shop`), WhatsApp main bot, WhatsApp shop bot. |
| Payment fee | Per payment method, each per group (airtime / bundles / bills): `botFees.paystack` (main + shop USSD, both WhatsApp bots) and `botFees.hubtel` (Hubtel USSD checkout). Added on top, rounded up to the pesewa. |
| Names | "Network Plans" for Hubtel Standard Bundles; "Pay Bills" for Utility Bills — no "data"/"bundle" words (USSD rebrand rule). |
| Ghana Water | WhatsApp bots only (needs an email); hidden on USSD. |
| Control | Admin only (like storefronts): admin switches the `bots` surface and each group on for bots; every bot follows. |
| Shares | Main USSD / main WhatsApp: buyer gets the `customer` share (no shop). Shop USSD / WhatsApp shop bot / Hubtel USSD in shop mode: buyer gets `storefrontCustomer`, shop earns `storefrontShop`. Hubtel USSD in main mode: `customer`. |
| Refunds | Same as storefronts: `/admin/refunds` (Paystack reversal / Moolre payout) or "Mark refunded manually"; shop share clawed back. |

## 3. Pricing

`quoteBots({ serviceKey, provider, faceAmount, rail: "paystack" | "hubtel", shop: boolean }, cfg)`:
- shares as §2; `base = face − customerCashback`; `fee = ceil(base × botFees[rail][group] / 100)`; `pay = base + fee`.
- Applied only when `cfg.enabled && cfg.surfaces.bots && cfg.botGroups[group]` (validator now allows `bots`).
- Not applied: **airtime keeps today's exact bot pricing** (each bot's current fee logic); Network Plans / Pay Bills menus are hidden.
- Hubtel airtime per-request cap and provider rules exactly as the dashboard/storefront airtime.

## 4. Orders and payment

- Bills/bundles bot orders go into `hubtel_bill_orders` / `hubtel_data_orders` with `channel = 'bots'`, `bot_surface`
  (`hubtel_ussd | ussd | ussd_shop | whatsapp | whatsapp_shop`), `shop_id` (shop bots), `buyer_phone` (dialing / WhatsApp number),
  `user_id` NULL, unpaid until confirmed — same columns as storefront rows plus `bot_surface`.
- Airtime bot orders stay in each bot's existing order table/flow, with the cashback snapshot columns where that table has them
  (`airtime_orders`) — the plan maps each bot's airtime table.
- Payment: each bot's existing rail creates the charge for `paid_amount` (opaque references, no product words):
  - Paystack bots: the existing MoMo charge path; confirmation through the existing webhook/verify → the shared confirm function
    (generalised from `confirmStorefrontOrder` to `channel IN ('storefront','bots')`).
  - Hubtel USSD: the existing AddToCart/checkout and its payment callback → the same confirm function.
- Confirm (unchanged rules): pesewa-exact amount check, guarded `unpaid → paid`, shop share once (`shop_profits`), dispatch once
  (engine claim), recoverable after a crash, alerts deduped.

## 5. Menus

- **Network Plans:** network → category (Flexi/Video/Social/Midnight/… from `lib/standard-bundles/categories.ts`) → plans, 5 per
  screen with `0 Next` / `00 Back` → recipient (own number default) → confirm ("Pay GHS 2.90 (was GHS 3.00) · You receive 8.48GB")
  → pay. The catalog token + Hubtel re-query for the recipient run exactly as on the dashboard (409 → "price changed, try again").
- **Pay Bills:** biller → inputs:
  - ECG: "1 Use this number / 2 Other number / 3 Meter number" → meters list or meter entry (Prepaid/Postpaid) → consent ("1 Yes,
    link meter X to Y") → amount → confirm;
  - DSTV/GOtv/StarTimes: smartcard/account → (masked name, due) → amount → confirm;
  - Telecel Broadband: landline → account → amount → confirm;
  - Ghana Water: WhatsApp only (meter → email → amount).
  Verify uses the existing engines; shop-bot tokens are shop-bound; names masked like storefronts.
- **Airtime:** existing flow; confirm screen shows the cashback price when applied.
- Text fits USSD limits (≤ 182 chars per screen; the plan adds a tested truncation helper).

## 6. Admin

Cashback tab: Bots surface switch, per-group "Sell on bots" switches, two fee sets (Paystack bots / Hubtel USSD), live examples;
margin report channel filter gains `bots` (airtime bot rows identified per table the plan maps). Bills/bundles admin lists: channel
"Bot" + surface label.

## 7. Data model (one migration, additive; next free number)

- `hubtel_bill_orders`, `hubtel_data_orders`: channel CHECK adds `'bots'`; `bot_surface text` with CHECK of the five values;
  `(channel <> 'dashboard' OR user_id IS NOT NULL)` unchanged; dedupe index for bot bundle orders on `(bot_surface, buyer_phone,
  idempotency_key)` where `channel='bots'`.
- Refund RPCs: extend the storefront-only checks (`BAD_CHANNEL`) to accept `channel='bots'` rows.

## 8. Build order (each ships dark)

1. **Shared bot engine**: config (`surfaces.bots`, `botGroups`, `botFees`), `quoteBots`, bot order creation for bills/bundles,
   generalised confirm, migration, refunds, admin settings.
2. **Hubtel USSD** (live code, shop mode first, main mode too).
3. **Main + shop USSD** (Paystack).
4. **WhatsApp main + shop bots** (Paystack; Ghana Water here).

## 9. Error handling

| Situation | Behaviour |
|---|---|
| Bots switch/group off | Menus hidden; airtime unchanged. |
| Price/plan changed before pay | "Price changed — please try again", nothing charged. |
| Payment amount ≠ paid_amount | Not dispatched, urgent alert. |
| Paid, Hubtel down | Order paid + "Not sent", alert; refundable. |
| USSD session times out after payment | Order completes via the payment callback/webhook; SMS/WhatsApp confirmation as today. |

## 10. Testing

Unit: `quoteBots` (rails, shop/no shop, fee rounding), menu builders (paging, truncation, consent wording, no product words),
confirm generalisation (bots + storefront regression), per-bot flow tests with fake sessions; airtime legacy byte-identity per bot
when off; real `next build`; live: one cheap purchase per bot per group with test numbers.
