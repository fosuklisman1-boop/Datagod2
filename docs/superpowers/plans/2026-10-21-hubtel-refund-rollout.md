# Hubtel refund gateway: rollout runbook

The gateway ships dark. Nothing changes for admins until step 4.

1. **Redeploy the relay** on the DigitalOcean droplet.
   - Copy `lib/ussd-hubtel/relay-handler.ts` and `scripts/hubtel-relay/server.ts` to the droplet, preserving their paths.
   - Add env `HUBTEL_REFUND_BASIC_AUTH` ONLY IF Hubtel rejects the existing status credential for `refund-api.hubtel.com`.
   - Restart the systemd service.
   - Check that `POST /refund` now returns 400 (not 404) for an empty body.
2. **Vercel env**: set `HUBTEL_REFUND_CALLBACK_SECRET` (random, 32+ bytes). Paste it in the Vercel dashboard only; never in a command line, chat or settings file. Confirm `NEXT_PUBLIC_APP_URL` is the production URL (the callback URL is built from it).
   - `NEXT_PUBLIC_APP_URL` must be the **canonical host that does not redirect**. If the apex redirects to `www` (or the reverse) with a 307/308, Hubtel's POST callback can be dropped or turned into a GET and the refund never settles. Check with `curl -sI -X POST <NEXT_PUBLIC_APP_URL>/api/webhooks/hubtel-refund` — it must answer 401 directly, not 3xx.
   - **Rotating `HUBTEL_REFUND_CALLBACK_SECRET` invalidates every callback URL already sent to Hubtel**: each in-flight refund's callback will then get 401 and never settle. Only rotate when no Hubtel refund is `reserved`/`processing`, or be ready to settle those by hand (step 6).
3. **Ask Hubtel**:
   - (a) Must the callback host be registered/whitelisted?
   - (b) Are refunds debited from our Hubtel collection balance?
   - (c) Is the callback `charges` fee taken from the customer's refund or from us?
   - (d) Is the callback `amount` the gross refund or net of `charges`? (The callback settles when `amount` equals the refund amount — the order price — or the gross the customer paid Hubtel; any other figure parks the refund for review.)
   - (e) Does a ServiceStatus "failed" fulfilment callback automatically reverse the customer's payment? If yes, refunding those orders here would pay the customer twice — do not refund them until Hubtel answers.
4. **Deploy the code with the gateway still dark**, then set `HUBTEL_REFUND_ENABLED=true` on Vercel and redeploy.
5. **Supervised test**: refund ONE real Hubtel USSD order of 1-2 GHS from /admin/refunds, gateway "Hubtel (refund to payer)". Watch History go `processing` -> `completed` when the callback arrives. Confirm the customer actually received the money. Record the charges shown in the refund's reference.
   - **Record the amount Hubtel actually refunded to the customer**: the net order price (`amount_after_charges`, what our ledger refunds) or the gross including Hubtel's customer fee (`amount_paid`). Also record the callback's `amount` and `charges` fields (from the Vercel log or the refund's reference/note). The code currently refunds and ledgers the **order price** and accepts a callback `amount` equal to **either** figure, so this test is what tells us which one Hubtel really uses; if the ledger and what the customer received differ, fix the code before enabling more refunds.
6. **If the callback never arrives** (or the refund was parked for review): the refund stays `processing` and cannot be auto-checked — Hubtel has no refund-status endpoint, so no cron covers it, and "Check status" only reports that. There is no button for this; settle it by hand in SQL, under the project's prod-change protocol (read the `order_refunds` row first and confirm its `status`, `amount` and `gateway_ref`; state the exact statement; get the user's OK before running it):
   - **Only once Hubtel or the customer confirms the money arrived**:
     `select complete_order_refund('<refund id>', '<hubtel orderId> manual-confirm');`
     This marks the order refunded. No customer notice is sent this way — tell the customer yourself if needed.
   - **Only once Hubtel confirms no money moved**:
     `select fail_order_refund('<refund id>', '<reason>');`
     This restores the shop owner's clawback. Never run it on a guess: if Hubtel paid after all, the customer is refunded and the shop keeps its cut.
   - If neither is confirmed, leave the row `processing` (the clawback stays in place) and keep chasing Hubtel.
   - A refund flagged `CONFLICT: Hubtel reported this refund paid after it was marked failed` means Hubtel paid a refund we had already failed (and possibly refunded another way): check for a double refund with Hubtel and the customer before doing anything else.
7. **Rollback**: set `HUBTEL_REFUND_ENABLED` to anything other than `true`. The gateway disappears from the dialog; in-flight refunds still settle through the callback.

## Known limits

- Full refund only (the amount field is locked to the order price, which must equal Hubtel's net `amount_after_charges`; otherwise refund manually).
- 44-day window from `paid_at`.
- One paid Hubtel payment row per order.
- Scope: Hubtel USSD data orders (`ussd_orders` / `ussd_shop_orders` rows with a paid `hubtel_transactions` row) plus Hubtel USSD bot commission orders (`bot_surface = 'hubtel_ussd'`). NOT Uzo/Paystack-paid orders: they have no Hubtel payment to refund.
