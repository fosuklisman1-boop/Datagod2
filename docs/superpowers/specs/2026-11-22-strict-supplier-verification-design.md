# Strict per-supplier MTN verification: design

Date: 2026-11-22. Owner asked: "with orders that are sent to suppliers with whitelist capability do we strictly
check verification before we send?" The answer was no, and the owner approved this design (choices below are theirs
unless marked as calls).

## Why

MTN suppliers only deliver to numbers they have approved ("whitelisted"). Today:

- The send-time check (`mtn_whitelist_enabled`) has been OFF in prod since 2026-09-14, so every MTN send (checkout,
  admin "Send to supplier", "Fulfill pending", retries, auto-fulfil) goes out with no verification.
- Checkout (`customer_verification_settings`: agentportalgh then hubnet, blocking on) passes a number when ANY one
  supplier approves it, does not route the order to that approver, fails open on outages, and caches a yes forever.
  Hubnet carries most MTN volume (1,152 of 1,354 sends in the 24 h before 18:50 UTC) yet is asked only when
  AgentPortalGH does not approve.
- The old send-time check (if re-enabled) treats errors and Hubnet "queued" as approval, and switches provider to
  the approver even when an admin pinned one (`lib/mtn-fulfillment.ts` ~481-500), which would break the hard-pin
  promise of "Send to supplier" and could double-deliver a released held order.

## Goal

A supplier receives an MTN order only if that same supplier has approved that number.

## Anti-goals

- Sending to a supplier that has not approved the number (including on outage, timeout, rate limit or "queued").
- Moving an admin-pinned order to a different supplier.
- Blowing Hubnet's 50-calls-a-minute budget (shared with status sync; 294 rate-limit send failures in the last 24 h).
- Phone numbers in logs.
- Changing anything while the new switch is off.

## Owner decisions

1. Per-supplier: each supplier needs its own yes. Another supplier's yes never qualifies it.
2. No answer (timeout, error, rate limit, "queued"): send to the next supplier in the normal order that HAS approved
   the number; if none has, hold the order and re-check in minutes. Never send unchecked.
3. A supplier's yes is trusted for 30 days, then that supplier is asked again before its next send.
4. Admin pick: sent only if that supplier approved; otherwise refused with a clear message, never re-routed.
5. Ships behind a new switch "Strict supplier verification" (admin toggle on the MTN settings page), default off.
   Turning it off restores today's behaviour at once.
6. Hold limit: a strict-held order is re-checked for up to 72 hours; then it stops being retried and moves to
   Needs action for a person (no automatic refund). Admins are told once when it moves.
7. First-time numbers (Hubnet answers "queued" first, decides ~2 minutes later): send to another supplier that has
   already approved the number; otherwise hold and re-check in a few minutes. Never block the sender waiting.
8. Live checkout stays exactly as it is (blocks only when every checkout supplier rejects; any one yes or no answer
   lets the customer pay). It additionally saves each definite per-supplier answer for the send step.

## Calls made while writing (owner may override)

- A supplier's "no" is remembered 24 h, then asked again.
- Suppliers with no number-check endpoint (e.g. sykes, datakazina) are skipped while strict mode is on: they can
  never approve, so they never receive MTN orders in strict mode. The settings page shows this.
- Hubnet "queued" counts as no answer.
- The old `mtn_whitelist_enabled` send-time block and its provider auto-switch are removed (dead while off today).
- Held orders: a NEW strict re-check job (every 5 minutes) handles strict holds: numbers with no definite answer are
  re-asked each run, numbers every supplier rejected are re-asked once a day, within the 72 h limit. It reads held
  orders directly (not `mtn_number_registry`), asks only enabled sending suppliers with strict checks, and releases
  by normalised phone. The old `mtn-whitelist-retry` job (daily 06:00 UTC, registry-driven, fail-open checks) is
  left for non-strict mode; registry/whitelist releasers must not release a strict hold (mark strict holds so they
  can be told apart, e.g. a hold-reason column or record).
- Customer SMS on a strict hold: one message per order, wording about the number being checked and delivery
  following automatically (not the "MTN registration" text). Re-holds after a re-check send nothing.
- Admin-pin refusal ("Hubnet hasn't approved this number" / "Hubnet couldn't check this number right now"): a
  distinct error type; the order stays pending; no tracking row, no admin failure SMS/push, no retry_count bump; the
  queue row fails with that message (never sent to a supplier).
- Hubnet pacing: strict checks go through the existing Hubnet client/cooldown (`verifyMtn` already returns no
  answer while `hubnet_rate_limited_until` is set); a burst of new numbers (bulk, API) beyond the budget simply gets
  "no answer" and follows decision 2/7. Owner-reported key limit is 50/min; code comments saw ~10 quick calls before
  a 429, so budget conservatively.
- Gate time budget: per supplier check at most 5 s, whole gate at most 10 s, so inline purchase routes stay fast.
- Settings page warns when strict mode is on and a sending supplier has no working check (e.g.
  `HUBNET_WHITELIST_ENABLED` unset makes Hubnet unable to approve, so it would receive nothing).
- Checkout keeps its current any-one-supplier rule (a send then goes to an approver), but every definite answer it
  gets is saved per supplier, so the send usually needs no extra call.
- Approvals are stored in one new service-role-only table (phone normalised, supplier, verdict, checked_at); no
  phone in logs. The existing forever-yes checkout cache is not trusted for send-time decisions.

## Approaches

- **A. One verification step inside `createMTNOrder` (chosen).** Every MTN send already goes through
  `createMTNOrderUnguarded` (primary, retry sequence, admin pin), so one per-supplier gate there covers checkout,
  admin sends, releases, resends and auto-fulfil.
- B. Check at each caller. Twelve-plus call sites; easy to miss one (leaderboard prizes already skip checkout).
- C. Re-enable the old toggle. Rejected: any-one approval, fail-open, pin override.

## Behaviour (strict mode on)

For each candidate supplier, in today's order (admin pin alone; else primary then `mtn_retry_sequence`):
1. Read its stored verdict for the number. Yes younger than 30 days: send. No younger than 24 h: skip.
2. Otherwise ask it now (strict check, bounded time). Store a definite yes/no. Yes: send. No / no answer: skip.
3. Hubnet calls respect the shared Hubnet cooldown (already enforced inside the Hubnet client).
4. Nobody approved: hold (`held_registration`), marked as a strict hold with the reason (all said no vs some could
   not answer) so the re-check cadence differs; after 72 h it moves to Needs action.
5. Admin pin not approved: return a refusal naming the supplier; the order stays pending; no other supplier tried.
6. OUTCOME_UNKNOWN from a send keeps today's rule: stop, never try another supplier.

Strict mode off: behaviour exactly as today, except the removed old block (already off).

## Facts the builder must respect

- `admin_settings` is service-role only. Settings changes need `verifyAdminAccess` with a real admin user id.
- `WHITELIST_REGISTRY` (`lib/mtn-providers/provider-whitelist.ts`) holds each supplier's check; use the strict
  (throwing) batch variants; the non-strict ones fail open.
- `checkWhitelistForOrder` excludes `mtn_disabled_providers`; prod disables xpress, bisdel, eazyghdata, codecraft.
- Prod MTN routing: primary hubnet, retry sequence [agentportalgh]. `mtn_fallback_provider` {sykes} has no code
  callers (superseded by `getRetrySequence()`), so candidates are primary + retry sequence only.
- Strict batch checks: Hubnet's strict batch drops "queued" rows and throws only when nothing was definite; for one
  number, queued / cooldown / outage all look like a throw. The gate needs its own per-supplier result
  (yes / no / no answer). AgentPortalGH echoes numbers in another format: match on normalised phone; a missing row
  is "no answer", never "no". `WhitelistCheckFailed` is not exported.
- `holdMtnOrder` sends `mtnRegistrationHold` SMS on every hold with no dedupe; strict holds must not use it as is.
- Prod `mtn_whitelist_enabled` row exists with `enabled:false`, so removing the old block changes nothing live; its
  admin controls (`mtn_whitelist_enabled`, `mtn_whitelist_switch_providers`) are removed or relabelled with it.
- Only admin paths set an explicit provider (Send to supplier, per-row Fulfill, v1/v2/USSD overrides);
  `processManualFulfillment` passes the raw provider so normal sends are unpinned. `retryMTNOrder` has no callers.
- Hubnet verification is opt-in (`HUBNET_WHITELIST_ENABLED=true` in prod) and shares the 50/min key budget.
- Admin pins come from Send to supplier (`fulfillment_queue.provider`), the per-row Fulfill dropdown and v1/v2/USSD
  provider overrides. The Send to supplier dialog promises a hard pin.
- `release*HeldOrders` in `lib/mtn-hold.ts` re-dispatch held orders; `mtn-whitelist-retry` uses fail-open checks today.

## Left to the builder

Table/migration shape (next free number, at least 0194), where the per-supplier store lives in code, the settings UI
placement (MTN settings page), the held re-check schedule mechanics, copy.

## Delivery

1. Build behind the switch (off), tests incl. pin, outage, cooldown, 30-day expiry, held release.
2. Review gates (money path), prod migration protocol, owner OK to push.
3. Owner turns the switch on; watch holds and sends.
