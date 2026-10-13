# Commission Cashback — design

Date: 2026-10-13 · Status: draft for review · Replaces the Phase 3b "30% partner split + Commission Wallets" design.
Builds on Hubtel Commission Services Phases 1, 2a, 2b, 3a (all live; 2b/3a dark).

## 1. Purpose

Providers pay Datagod a commission on every commission-service sale (Hubtel airtime 3.96%, ECG 1.708%, others to be
measured). Instead of charging buyers a fee or a markup, Datagod passes an admin-set **share of that commission** to the
buyer as an **instant discount** at checkout (e.g. pay GHS 9.91 for GHS 10 airtime), and on shop storefronts also to the
**shop owner** as profit. Datagod keeps the rest.

Success: on every surface a buyer sees face value, cashback and the amount to pay before paying; is charged exactly that;
the provider receives the full face value; every order records what was given out; the admin can see, per service, the
set rate vs the actual rate the provider paid, and what was earned, given out and kept — and no configuration can make a
sale lose money.

## 2. Decisions (user, 2026-10-13)

| Topic | Decision |
|---|---|
| Model | Admin sets a **provider rate** (what the provider pays) and the **share** of it given out. Cashback = face × rate × share. |
| Tiers | Separate shares for customers and dealers. |
| Airtime fee | The existing airtime fee (default 5%, `airtime_fee_<net>_<tier>`) is **dropped everywhere**; both Hubtel- and Digiwapy-routed airtime move to cashback pricing. |
| Surfaces | Dashboard (wallet), USSD + WhatsApp bots (main and shop), shop storefronts, public API. |
| Storefronts | Shop markup is **dropped** for commission services. Admin sets a % of the commission for the end customer and a % for the shop owner. |
| Shop credit | Shop share credited to shop profit **at purchase** (like data shop profits); clawed back on refund. |
| Phase 3b | The 30% partner split and Commission Wallets are dropped in favour of this. |
| Display | Admin page shows rates as % and money as amounts (§7). |

## 3. Scope

Commission services (from `lib/hubtel-cs/services.ts` + Digiwapy airtime):

| Group | Services | Providers |
|---|---|---|
| Airtime | MTN, Telecel, AT | Hubtel, Digiwapy |
| Standard Bundles | MTN, Telecel, AT data | Hubtel |
| Utility Bills | ECG, Ghana Water, DSTV, GOtv, StarTimes, Telecel Broadband | Hubtel |

Not in scope: normal data packages, AFA, results checker — their pricing is unchanged.

## 4. Configuration (`admin_settings` key `commission_cashback_config`, written via an atomic patch RPC)

```
{
  enabled: false,                               // master switch
  surfaces: { dashboard: false, bots: false, storefront: false, api: false },
  rates: { "<service>:<provider>": number },    // provider rate in %, e.g. "airtime_mtn:hubtel": 3.96, "bill_ecg:hubtel": 1.708
  shares: {                                     // % of the commission, per group, with optional per-service override
    airtime | bundles | bills: { customer, dealer, storefrontCustomer, storefrontShop },
    overrides: { "<service>": { customer?, dealer?, storefrontCustomer?, storefrontShop? } }
  }
}
```

Rules (enforced in a pure validator and again in the quote engine):
- Rates 0–20 (%), up to 3 decimals; missing rate = 0 ⇒ no cashback for that service/provider.
- Shares 0–100 each; `storefrontCustomer + storefrontShop ≤ 100`; customer/dealer ≤ 100.
- Defaults: everything off, all rates 0, all shares 0.
- Each surface switch is independent, so cashback can be rolled out one surface at a time. While a surface's switch is
  off it keeps today's pricing — **except the airtime fee**: per the user's decision the fee is dropped where cashback is
  on; where cashback is off for a surface, today's fee stays until that surface is switched (no silent price change).

## 5. Quote engine — `lib/cashback/quote.ts` (pure)

`quoteCashback({ service, provider, faceAmount, buyer: "customer" | "dealer", channel: "dashboard" | "bots" | "storefront" | "api" }, config)` →
`{ faceAmount, rate, commission, customerCashback, shopShare, payAmount, datagodKeeps, applied: boolean }`

- commission = face × rate / 100 (unrounded, for display/margin).
- customerCashback = floor_to_pesewa(commission × share/100); shopShare (storefront only) = floor_to_pesewa(commission × storefrontShop/100).
- payAmount = face − customerCashback. The provider is always sent `faceAmount`.
- `applied=false` (cashback 0, today's pricing) when the master switch or the surface switch is off, or rate/share is 0.
- Never returns `customerCashback + shopShare > commission`; `payAmount > 0`.
- Each order stores the quote (§6) so later config changes never alter existing orders.

Every checkout on every surface calls this one function — no per-route fee math (today the shop airtime route has its own
fee + markup + 10% cap logic; that is replaced).

## 6. Order data

Additive columns on each commission-service order table (`airtime_orders`, `hubtel_bill_orders`, `hubtel_data_orders`, and
the USSD/WhatsApp airtime order tables the plan identifies): `face_amount`, `paid_amount`, `cashback_amount`,
`shop_share_amount`, `cashback_rate` (provider rate used), `cashback_share` (share used), `expected_commission`.
Existing `amount` semantics per table are mapped in the plan (bills/bundles `amount` = what was debited ⇒ becomes
`paid_amount`; the provider amount is `face_amount`). Actual commission: Hubtel's per-transaction commission already
lands in `hubtel_cs_transactions.commission` / order `commission`.

**Digiwapy actual commission is unverified:** its status type declares `commission` and `fee`, but no real response has
been stored. Plan step 1 reads one real status response (admin digiwapy-debug route) before relying on it; until
confirmed, Digiwapy rows show "expected" figures only (feedback: verify external API assumptions).

## 7. Admin — Cashback page (`/admin/hubtel-commission` → "Cashback" tab)

- **Settings:** master + surface switches; rate table (service × provider, %) with an "use actual" button that fills the
  observed rate; shares per group with optional per-service overrides; live example ("GHS 10 → customer pays 9.91,
  dealer pays 9.81, storefront customer pays 9.93 + shop earns 0.15, Datagod keeps …").
- **Margin report** (date range, default 7 days), one row per service × provider: set rate %, actual rate % (actual
  commission ÷ face, completed orders) with ✓ / ⚠ (unset or differs by > 0.05 points), commission earned, cashback given,
  shop shares, Datagod kept — amounts in GHS.
- Per-order views (existing admin lists) gain face / paid / cashback / shop share / commission columns.

## 8. Surfaces

- **Dashboard** (airtime, Utility Bills, Standard Bundles): checkout shows face, "Cashback −GHS x", "You pay GHS y";
  wallet is debited `payAmount`; provider gets face.
- **USSD + WhatsApp (main + shop bots):** the confirm screen shows "Pay GHS y (GHS x cashback)"; the MoMo/Hubtel
  charge is `payAmount`. Shop bots use storefront shares and credit the shop share.
- **Storefronts:** markup fields for commission services are hidden/ignored; customer pays `payAmount`; shop share is
  credited to `shop_profits` at purchase.
- **Public API:** price endpoints and order responses return face, cashback and pay amounts; API buyers are charged
  `payAmount` (dealer shares unless the plan finds API users carry their own tier).

## 9. Refunds and failures

- Refunds return `paid_amount` (what the customer actually paid), never face.
- Shop share is clawed back on refund with a negative `shop_profits` row (the mechanism `/admin/refunds` already uses).
- Never automatic refunds or resends — unchanged from Phases 1–3a.
- If a Hubtel airtime order fails and an admin re-fulfils it via Digiwapy, the stored quote is kept (no re-pricing).

## 10. Build order (each part ships dark behind its surface switch)

1. **Part 1** — config + validator + patch RPC, quote engine, order columns, admin Cashback tab + margin report,
   Digiwapy commission verification, **dashboard** airtime / bills / Standard Bundles.
2. **Part 2** — USSD + WhatsApp bots (main and shop).
3. **Part 3** — storefronts (markup dropped, shop share credited, clawback) + public API.

## 11. Error handling

| Situation | Behaviour |
|---|---|
| Config unreadable | Cashback not applied; today's pricing for that surface (fail safe = no discount, never a negative margin). |
| Rate/share 0 or switch off | `applied=false`, today's pricing. |
| Invalid config save | Rejected by the validator (shares > 100, storefront sum > 100, rate out of range). |
| Quote changes between display and pay | Server recomputes at pay time from current config; if `payAmount` differs from what was shown, 409 "price updated" (same pattern as Standard Bundles). |
| Refund | `paid_amount` back; shop share clawed back. |

## 12. Testing

Unit: quote engine (floor rounding, sum caps, switch combinations, zero rate, tiers, storefront split, never
`payAmount ≤ 0`); validator; patch builder; per-surface checkout charges `payAmount` and sends face; refunds return
`paid_amount` and claw back shop share; margin report maths. Real `next build` before pushing. Live: one cheap purchase
per surface with cashback on.

## 13. Rollout

Migrations applied before merge; all switches off. Enter rates (Hubtel airtime 3.96, ECG 1.708, others after their first
sale via "use actual"), set shares, enable the master switch + one surface, buy once, check the order's face/paid/cashback
and the margin report, then widen.
