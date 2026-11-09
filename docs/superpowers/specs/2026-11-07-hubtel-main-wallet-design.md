# Hubtel main code: wallet payment

Date: 2026-11-07. Status: awaiting owner approval.

## Why

`*713*235*1#` is now the main USSD, but every purchase on it is MoMo through Hubtel's checkout, with Hubtel's charge on top. Dealers holding a wallet balance can only spend it on the Uzo main code. The owner wants registered callers to be able to pay from their wallet on the main code.

Success: a dealer with enough balance buys on `*713*235*1#` from their wallet, pays no Hubtel charge, and gets the same delivery as on MoMo. Nobody else sees any change.

## Scope

In scope: the Hubtel main code only (`line=main`, main mode), on the USSD platform only, for Data Bundles, Buy Airtime and Results Checker (Buy Vouchers and Check Results).

Not in scope, and unchanged: the Hubtel shop code, AFA, Standard Bundles, Special Bundles, Pay Bills, Uzo USSD, WhatsApp, Hubtel's Webstore and app platforms.

Must not happen:
- A wallet is debited with no order recorded as paid, and no admin told.
- A wallet is debited twice for one purchase, or both a wallet and MoMo pay for one order.
- A caller spends a wallet that isn't the account matching their dialling number.
- A MoMo-only caller, or the shop code, sees any change.

## Decisions

Owner decisions:
- Main code only.
- Same protection as Uzo: the dialling number alone, with no PIN or SMS code. A borrowed or stolen phone can spend the balance, on this code as on Uzo.
- Services: Data Bundles, Airtime and Results Checker.
- Same price on wallet and MoMo. The wallet saves only Hubtel's charge.
- Ships switched off.

Calls made for the owner to check:
- A caller whose balance can't cover the price goes straight to the Hubtel checkout, as Uzo does. There is no "insufficient balance" dead end.
- Wallet is offered only when `Platform` is `USSD`. Every session in the 30 days to 2026-11-07 was USSD (14,391), and the phone number on the other platforms is unverified.
- Own switch on the Main code tab, `walletPayment`, stored on the main-line config. Missing means off. The shop line has no such setting.
- A wallet purchase ends the session with a final message, without a Hubtel checkout. No Hubtel charge or `hubtel_transactions` row exists for it.

## The flow

After `1. Confirm`, an eligible caller sees:

```
Pay with:
1. Datagod Wallet
   (bal GHS 42.00)
2. MoMo
0. Cancel
```

- `1`: wallet payment. Final screen: `Payment successful.` plus the service's existing delivery wording.
- `2`: today's Hubtel checkout, unchanged.
- `0`: `Order cancelled.`, nothing created.
- Anything else repaints the screen.

Eligible means all of these: switch on, main mode, `Platform` is `USSD`, the dialling number resolves to an account (`resolveDialer`), and its live balance covers the price. The screen fits 182 characters. Everyone else goes from Confirm to the checkout exactly as today.

All existing checks run again at the moment of paying, on both choices: price re-read and compared with the screen, MTN recipient block, stock, and availability.

## Payment

The Uzo flow debits, then updates the order, without checking the update. That order of steps is not copied, because a failure between them takes money with no paid order.

A new service-role-only RPC does this in one transaction:
1. Lock the wallet row of the given user.
2. Refuse if this session or this order already has a wallet payment, returning the earlier one as a replay. Refuse if the session already has a `hubtel_transactions` row.
3. `deduct_wallet` for the price. Short balance raises `INSUFFICIENT_FUNDS` and writes nothing.
4. Write one `transactions` debit row, with a source per service, as Uzo's sources do.
5. Write a new `hubtel_wallet_payments` row: session id (unique), order table, order id (unique together), user, amount, state `debited`.

The order row is created as today, with its payable status, immediately before the RPC. The order's own post-payment work then runs through the existing `createOrderHandlers(supabase)[table]`, which already marks the order paid under a guard, credits parent profit, delivers and sends SMS. These handlers return early on an already-completed order, so the RPC must not flip the order itself.

The payment row then moves to `fulfilled`, or `needs_review` if the handler throws, with an URGENT admin alert naming the order. Delivery may run in the background (`deps.defer`), since USSD screens have a short deadline. The builder must confirm each service's handler can run there, and that `maxDuration` allows it.

Failure paths:
- RPC refuses for balance: repaint with `2. MoMo` and `0. Cancel`, and delete or fail the unpaid order with the guarded fail.
- RPC throws, outcome unknown: read `hubtel_wallet_payments` by session. Found means continue as paid; not found means fail the order guarded and offer MoMo. A read error ends with the unavailable text, an URGENT alert, and the order left for the sweep.
- As built (2026-11-08): an unknown RPC error with no payment row found ends with the unavailable text, not a MoMo offer, because the debit may still commit late and offering MoMo there could take two payments.
- A process death after the debit: a sweep finds `debited` rows older than 10 minutes, re-runs the handler (its guarded mark makes that safe), and alerts URGENT if it fails again. This runs from the existing Hubtel status-check cron.

Repeat protection: `replaySubmittedOrder` runs first as today. A wallet-paid session answers "This order was already submitted." The unique session key stops a second debit, and an order with a wallet payment can never be carted.

## Refunds

A failed delivery on a wallet-paid order refunds to the same wallet. Neither Hubtel's nor Moolre's rail may pay it out, because that would pay twice.

`/admin/refunds` must recognise these orders. It finds wallet payments today through `WALLET_DEBIT_SOURCES` and `wallet_payments`, so the builder must read `lib/refunds/orders.ts` and add the new sources. It must show the wallet as the only rail, and refuse a second refund. If this needs more than a small change, stop and report it. Existing crons that fail stale unpaid orders must not fail an order with a `debited` wallet payment: the builder must check each one on these four tables.

## Showing it to admins

- The Main code tab gets the switch, labelled `Wallet payment`, with a note that it's main code only.
- `/admin/ussd-hubtel` transactions stay Hubtel-only. Wallet purchases appear in the normal order lists and wallet history, and the interaction log shows the wallet reply.

## Launch

1. Fresh reviewer: mandatory, since this covers money and schema.
2. Migration: pre-check, self-rolling-back dry run, the owner's OK, apply, verify.
3. Deploy with the switch off. Check the screens are unchanged.
4. Supervised test from the owner's phone with a small balance: one each of data, airtime, vouchers and Check Results. Then a balance too short, a Cancel, and a MoMo choice from the new screen. Confirm Hubtel accepts a session ending with no checkout: cancelled orders already do, but this is the first real test.
5. Tell dealers.

## Risks the owner has accepted

Dialling-number trust, as on Uzo. `users.phone_number` decides whose wallet is used, so a wrong number on an account would let the holder of that number spend it. The builder should check how far that field is verified and report what it finds.

## Left to the builder

- Where the Confirm-to-payment step lives, provided the existing flows' checks are shared and not copied.
- How order creation is split from `submitOrder`, provided the MoMo path stays byte-for-byte the same in behaviour.
- The exact final-screen wording per service, following Uzo's.
