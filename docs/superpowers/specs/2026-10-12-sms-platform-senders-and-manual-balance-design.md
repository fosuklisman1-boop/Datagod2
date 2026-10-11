# Platform sender names + manual Hubtel balance — design

Date: 2026-10-12. Requested by the owner during the Hubtel go-live. Two small, independent features.

## A. Admin-managed platform sender names (multiple, one default)
**Today:** the platform's own default sender is a code constant: `platformSenderName()` (`lib/sms-service.ts`) = `HUBTEL_SENDER_ID || MOOLRE_SENDER_ID || 'CLINGDTGOD'`. The existing admin "Sender ID pool" is a different thing (shared names *business-mode customers* may pick).
**Facts learned live (2026-10-12):** Hubtel accepts any alphanumeric sender name up to **11 characters** (12 is rejected: "Invalid SenderId"); a name accepted by Hubtel can still be filtered by a carrier (`CLINGSDTGOD` was accepted but never delivered on MTN; `CLINGDTGOD2` delivered in ~5 s). Moolre only sends from names registered with Moolre.

**Design**
- Two new SMS settings (`tenant_global_settings`, same mechanism as the other `sms_*` keys; validated section `platform_senders` in `lib/sms/admin-settings.ts`): `sms_platform_senders` (list of 3–11 letters/digits/spaces, upper-cased, de-duplicated, max 20) and `sms_platform_default_sender` (must be one of the list; empty/unset ⇒ today's behaviour, i.e. the env/hardcoded name).
- New `lib/sms/platform-sender.ts`: `resolvePlatformSender()` = the configured default when set and still in the list, else `platformSenderName()`. Fails safe to the env name if settings can't be read.
- **Used for Hubtel sends only** (campaign dispatch with `senderId === null`, `sendSMS` when no sender and the provider is Hubtel, the customer Home "platform sender" line). Moolre/other fallback providers keep their own env-registered name (they reject unregistered names). Customers' own sender IDs are unaffected.
- Admin UI: Settings tab → new section "Platform sender names": chips input for the list + a "Default" choice (radio/select among the chips) + helper text (≤ 11 chars; test delivery on MTN/Telecel/AT before making a name default). Save is section-wise, audited, cache-invalidated like the other sections.

## B. Manual Hubtel balance (stop-gap while `/balance` is blocked)
**Why:** the credit-sales solvency gate (`lib/sms/wholesale.ts`) needs the Hubtel Disbursement balance from the relay `/balance`; until Hubtel whitelists the relay IP for `trnf.hubtel.com` it fails (sales go pending) and the app refuses to switch the primary to Hubtel.
**Design**
- Setting `sms_hubtel_manual_balance` = `{ amountGhs, setAt, setBy }` (written only through the admin API; audited with old/new).
- New `resolveHubtelBalance()` in `lib/sms/wholesale.ts`: (1) try the relay; if it succeeds use it (`source:'relay'`) — **the real balance always wins**; (2) if it fails and a manual balance exists, use `estimate = amountGhs − spentSince(setAt)` (`source:'manual'`, floored at 0), where `spentSince` = exact SQL sum over Hubtel `sms_messages` created at/after `setAt` that were not refunded: `cost_ghs` when the delivery report supplied it, else `segments × (observed rate or the configured rate)`; (3) else unavailable (today's behaviour). `getWholesaleCredits`, `getWholesaleSnapshot` and the admin Supply strip use it; the snapshot carries `balanceSource` so the UI says "Hubtel (manual estimate)".
- The "switch primary to Hubtel" guard accepts a working relay `/balance` **or** a manual balance set within the last 30 days. A manual balance older than 30 days is ignored.
- Admin UI: Settings tab → section "Hubtel balance (manual fallback)": amount input + "Set balance now" (stamps `setAt = now`), shows the current estimate, its source and when it was set, and a reminder to update it after every top-up. Messages sent outside the app (e.g. test curls) are not counted, so the estimate can be slightly high: documented.
- Conservative by construction: unknown costs use the highest observed rate; the estimate never exceeds the entered amount.

## Out of scope
Per-customer platform sender choice; changing the Moolre sender; removing the manual balance once `/balance` works (it simply stops being used).
