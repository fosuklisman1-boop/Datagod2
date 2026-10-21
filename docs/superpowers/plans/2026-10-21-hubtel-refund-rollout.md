# Hubtel refund gateway: rollout runbook

The gateway ships dark. Nothing changes for admins until step 4.

1. **Redeploy the relay** on the DigitalOcean droplet.
   - Copy `lib/ussd-hubtel/relay-handler.ts` and `scripts/hubtel-relay/server.ts` to the droplet, preserving their paths.
   - Add env `HUBTEL_REFUND_BASIC_AUTH` ONLY IF Hubtel rejects the existing status credential for `refund-api.hubtel.com`.
   - Restart the systemd service.
   - Check that `POST /refund` now returns 400 (not 404) for an empty body.
2. **Vercel env**: set `HUBTEL_REFUND_CALLBACK_SECRET` (random, 32+ bytes). Paste it in the Vercel dashboard only; never in a command line, chat or settings file. Confirm `NEXT_PUBLIC_APP_URL` is the production URL (the callback URL is built from it).
3. **Ask Hubtel**:
   - (a) Must the callback host be registered/whitelisted?
   - (b) Are refunds debited from our Hubtel collection balance?
   - (c) Is the callback `charges` fee taken from the customer's refund or from us?
4. **Deploy the code with the gateway still dark**, then set `HUBTEL_REFUND_ENABLED=true` on Vercel and redeploy.
5. **Supervised test**: refund ONE real Hubtel USSD order of 1-2 GHS from /admin/refunds, gateway "Hubtel (refund to payer)". Watch History go `processing` -> `completed` when the callback arrives. Confirm the customer actually received the money. Record the charges shown in the refund's reference.
6. **If the callback never arrives**: the refund stays `processing` and cannot be auto-checked (Hubtel has no refund-status endpoint, so no cron covers it). Verify the money with Hubtel/the customer, then resolve it from History.
7. **Rollback**: set `HUBTEL_REFUND_ENABLED` to anything other than `true`. The gateway disappears from the dialog; in-flight refunds still settle through the callback.

## Known limits

- Full refund only (the amount field is locked to what Hubtel collected).
- 44-day window from `paid_at`.
- One paid Hubtel payment row per order.
- Hubtel USSD bot orders only.
