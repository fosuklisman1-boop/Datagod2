# Network out-of-stock reason — design (short)

Date: 2026-11-27 · Size: small change · Status: awaiting owner approval

## Intent
When the admin marks a network out of stock, customers today either see a bare
"No MTN packages available" (USSD main code, dashboard) or the network vanishes
entirely (USSD shop codes, storefronts). The owner wants the network to stay
visible everywhere, and picking it shows an admin-written reason
(e.g. "MTN delays, back by 6pm").

## Goals
- Admin types an optional reason when switching a network off on the Network
  Stock card (/admin/packages).
- Out-of-stock networks stay listed on: USSD main code, USSD shop codes,
  dashboard Data Packages page, shop storefronts.
- Picking one shows the reason instead of bundles; the customer can go back.
- Restock clears the reason; everything behaves as today.

## Non-goals
- Shop-owner reasons for their own per-shop out-of-stock toggle (owner chose
  "admin only for now"; possible later).
- WhatsApp bots, text-to-buy SMS, developer API, AI ordering wording.

## Anti-goals
- Any change to whether a bundle can be bought. Packages stay
  `is_available=false` while out of stock; every purchase gate is untouched.
- Exposing anything from admin_settings beyond network name + reason.

## Approaches
1. **Keep the switch, store the reason beside it (picked).** Reason saved in
   the existing `network_stock_status` entry; surfaces read a small
   network → reason list and display it. Zero change to purchase gates.
2. Replace package-disabling with a network-level gate — rejected: every
   selling surface would need the new check; one miss sells undeliverable
   bundles.
3. Change text only where the network already shows — rejected: shop codes and
   storefronts would still hide the network, the very problem raised.

## Decided
- Admin only; reason optional.
- Network stays visible and opens a reason screen when picked.

## My calls (owner can override)
- Reason capped at 100 characters (fits one USSD screen with the back option).
- Empty reason → default "<Network> bundles are temporarily unavailable.
  Please check back soon."
- Reason editable while out of stock (edit without toggling off/on), so the
  admin can update "back by 6pm" → "back tomorrow" without touching the
  restoreIds snapshot.
- Reason stored as `reason` on `NetworkStockEntry`; restock drops it.
- One shared helper in lib/ (pure, tested) that returns
  `{ [network]: reasonText }` for out-of-stock networks, plus a name
  normaliser so USSD names (`AT-iShare`, `AT-BigTime`) match stock names
  (`AT - iShare`, `AT - BigTime`).
- Public read-only route (e.g. `/api/public/network-stock`) returning only
  out-of-stock networks and their reasons, short cache, for storefront and
  dashboard. Server-side USSD reads it directly via the helper.
- Shop network lists (USSD shop + storefront) = today's list ∪ admin
  out-of-stock networks the shop has packages for (ignoring
  `is_available` for that membership check only).
- Reason text sanitised to plain text (no newlines beyond one, no markup).

## Left to the builder
- Exact UI for the reason box (in the confirm dialog + an edit field on the
  row while off), styled per docs/ui-conventions.md.
- How the storefront and Data Packages page render the reason (card/banner in
  place of the package grid), with lg: widening per desktop-layout rule.
- Tests: helper (default text, cap, name matching), set/restock keeping
  restoreIds intact when only the reason changes, USSD main + shop flows
  showing the reason, shop network union.
