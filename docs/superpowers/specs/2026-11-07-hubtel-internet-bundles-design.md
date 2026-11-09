# Hubtel USSD: Internet Bundles menu and Special Bundles

Date: 2026-11-07. Status: awaiting owner approval.

## Why

The Hubtel menus list "Buy Data Bundle" and "Standard Bundles" as two separate top-level options. The owner wants one
entry, "Internet Bundles", that then asks which type. The owner also wants Special Bundles sold on USSD, as the first
Standard Bundles choice when MTN is selected. Today Special Bundles are sold only from the dashboard wallet.

Success: a caller on either Hubtel code finds every bundle under one option, and can buy a Special Bundle with one
Hubtel payment that delivers every unit, with shops earning their usual share.

## Scope

In scope: the Hubtel main code (`*713*235*1#`, `line=main`) and the Hubtel shop code (`*713*235#`).

Not in scope: Uzo USSD, WhatsApp bots, the storefront and the API. Their menus and Special Bundles access do not change.

Must not happen:
- A caller pays and receives nothing without an admin being told.
- A unit is sent before Hubtel confirms payment, or sent twice.
- A shop share is credited for a unit that was never paid for.
- Dashboard Special Bundles change behaviour.

## Decisions

Owner decisions:
- The menu change applies to both Hubtel codes.
- Option 1 is renamed "Internet Bundles", and its next screen offers 1. Data Bundles, 2. Standard Bundles.
- Standard Bundles moves under it, so it leaves the top-level menu.
- Special Bundles is option 1 in the Standard Bundles category list when MTN is selected.
- Shops earn the same split as Standard Bundles, applied per unit.
- USSD offers the same size list as the dashboard (`standard_bundles_config.special.multiples`, today 2, 3, 5, 8, 10, 15).
  There is no USSD-specific size list.

## Step 1: the menu

```
Main menu              Internet Bundles       Shop menu
1. Internet Bundles    1. Data Bundles        <shop name>
2. AFA Registration    2. Standard Bundles    What would you like to buy?
3. Buy Airtime         0. Back                1. Internet Bundles
4. Results Checker                            2. Buy Airtime
5. Pay Bills                                  3. Results Checker
0. Exit                                       4. Pay Bills
                                              0. Exit
```

Rules:
- Each type's visibility stays as it is: `data` (admin flag, not whitelist-blocked) and `networkPlans` (admin flag and the
  cashback bots gate).
- Both types visible: option 1 opens the new screen.
- One type visible: option 1 is still called "Internet Bundles" and goes straight to that type's first screen.
- Neither visible: option 1 is not shown and the rest renumber, as hidden items do today.
- Back from a type's first screen returns to the Internet Bundles screen when it was shown, otherwise to the main or shop
  menu.
- A session already on a step keeps working across the deploy, because no flow step changes meaning. A session on `MAIN`
  when the deploy lands may have seen the old numbering, so digit 5 on the main menu could mean something else. Accept this
  for the few seconds it lasts: every purchase still has a confirm screen.

Admin: the visibility toggles keep their keys. Their labels should make clear both sit under Internet Bundles.

Numbers change: Pay Bills moves from 6 to 5 on main and from 5 to 4 on shop. Update any customer-facing text or runbook
that quotes them.

This step has no schema or money change, and can ship and be tested on its own.

## Step 2: Special Bundles on USSD

### Flow

In `NP_CATEGORY` for MTN, "Special Bundles" is listed first when all of these hold: the master Special switch is on, the new
USSD switch is on, `multiples` is not empty, and the configured unit is in the live catalog at the configured amount. Then:

```
MTN Special Bundles    Who is this for?         MTN 2.03GB
1. 1.22GB - GHS x.xx   (existing recipient      To: 024xxxxxxx
2. 2.03GB - GHS x.xx    screens)                Amount: GHS x.xx
...                                             Confirm your order?
```

Sizes come from `formatSpecialGb`, the dashboard's existing wording. Paging, recipient, prefix check and confirm follow the
existing Standard Bundles screens, and the screen limit of 182 characters applies. The MTN number check stays off, as for
Standard Bundles.

### Price

Per unit: `quoteBots` for the session's context (rail `hubtel`, shop or main), so cashback is floored per unit. Total is
N x the unit price. The customer pays Hubtel's charge on top, as on every other Hubtel USSD order. The confirm-time check
compares the total the caller saw, and a difference gives "Price changed".

### Orders

The existing dashboard structures cannot hold these orders, so a migration is required:
- `hubtel_data_orders_special_check` allows only `channel = 'dashboard'`. It must also allow `channel = 'bots'`.
- `create_special_bundle_orders` debits a wallet and needs a user. USSD buyers have neither. A NEW service-role-only RPC
  creates N `pending` + `unpaid` rows, `channel = 'bots'`, `user_id` NULL, with the bot surface, shop, buyer phone and cashback
  snapshot of `botCreateBundleOrder`. It debits nothing. It is atomic and replay-safe on (surface, buyer phone, session key),
  with child keys `<key>:<i>`.
- The dashboard RPC stays as it is.

`hubtel_transactions` holds one row per payment: `order_table = hubtel_data_orders`, `order_id` = child 1,
`expected_amount` = the total. Child 1's `special_group_id` is how later steps recognise a group.

### After payment

The Hubtel handler for `hubtel_data_orders` compares Hubtel's amount with the order's `paid_amount`. For a group it must
compare with the sum over the children, pesewa-exact.

- Amount matches: confirm each child through the existing engine confirmation, with the child's unit amount and the same
  payment reference. Each child gets its own guarded unpaid-to-paid flip, its own shop share (existing per-order unique key,
  so one share per unit) and its own dispatch claim (one Hubtel POST per unit).
- Amount differs, or a child is not `pending` + `unpaid`: nothing is sent. Every still-unpaid child is recorded for review with
  the payment reference, and the transaction goes to `needs_review`.
- Dispatch runs one unit after another and must not delay the callback to Hubtel. The dashboard's size 10 purchase took about
  33 seconds in total, so it runs in the background with the existing time-budget and URGENT alert behaviour. The builder must
  confirm the route that runs it allows long enough.
- A unit that fails, or is left unsent, raises an URGENT alert naming the group and unit, and goes to admin review (retry,
  send or refund per unit), as on the dashboard.
- Retried delivery of the same payment must not resend: the engine's claim and the "paid by this payment" recovery path already
  provide this per child, and tests must prove it for a group.

### Things that assume one order per payment

Each of these needs a group-aware change and a test:
- Unpaid expiry and admin "not paid" (`createFailHandlers`, `failOrderStrict`) fail one order id. They must fail every child, or
  the others stay `pending` for ever.
- The stale-unpaid sweep (`lib/bot-commission/stale-sweep.ts`) could fail some children while a payment is arriving.
- A late payment after expiry (`recordBotPaymentForReview`) must cover the whole group.
- `checkBotPendingCaps` counts pending rows, so N children could trip the buyer's cap. A group counts once.
- `findOrderId` and the orphan clean-up in the confirm step look up one key, so a throw after commit must fail the whole group.
- The stuck-children watch (`special-watch.ts`) must include bot groups. Check whether it filters by channel.
- `replaySubmittedOrder` must not create a second cart for a group.
- Admin order views and `/admin/refunds` must show bot Special children, including the refund route for a Hubtel-paid unit.
  A refund goes to the payer rather than a wallet.
- SMS: one confirmation for the group, not one per unit.

### Switches and launch

- New `special.ussdEnabled` in `standard_bundles_config`, default off, with an admin toggle beside the existing Special card. It
  lets Step 2 ship dark and be tested, and it can be turned off without stopping dashboard sales. It holds no size list.
- Live test before opening: on the main code, smallest size then the largest. On the shop code, one purchase. Each must show all
  units delivered on the handset, the shop share correct, and the callback sent.

## Risks the owner has accepted

All dashboard sizes are offered from the start. The record so far is three purchases: size 3 delivered fully twice, and size 10
delivered 9 of 10 (unit 10 failed with `Hubtel code 2001`). USSD customers pay by MoMo rather than wallet, so a failed unit needs a
refund to a phone. The builder should find what code 2001 means before launch.

## Left to the builder

- Whether the Internet Bundles screen is a new step in `router.ts` or a small flow file.
- Where the group logic lives, provided single-order behaviour stays byte-for-byte the same.
- Order of the group-aware changes. The migration needs a pre-check, a self-rolling-back dry run and the owner's OK before it is
  applied.

## Reviews

Step 1: normal review. Step 2: a fresh reviewer is mandatory, since it covers money and schema.
