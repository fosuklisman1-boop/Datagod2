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
5. Ships behind a new switch "Strict supplier verification", default off.

## Calls made while writing (owner may override)

- A supplier's "no" is remembered 24 h, then asked again.
- Suppliers with no number-check endpoint (e.g. sykes, datakazina) are skipped while strict mode is on: they can
  never approve, so they never receive MTN orders in strict mode. The settings page shows this.
- Hubnet "queued" counts as no answer.
- The old `mtn_whitelist_enabled` send-time block and its provider auto-switch are removed (dead while off today).
- Held orders: unanswered numbers are re-checked about every 5 minutes, definite "no" numbers once a day (the
  existing `mtn-whitelist-retry` job, daily 06:00 UTC, verified running 2026-11-22). Released orders go to an
  approving supplier through the normal path.
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
3. Hubnet calls must respect the shared Hubnet cooldown (`hubnet_rate_limited_until`): if it is set, treat as no
   answer without calling.
4. Nobody approved: hold (`held_registration`, as today's whitelist holds), with the reason (all said no vs some
   could not answer) so the re-check cadence differs.
5. Admin pin not approved: return a refusal naming the supplier; the order stays pending; no other supplier tried.
6. OUTCOME_UNKNOWN from a send keeps today's rule: stop, never try another supplier.

Strict mode off: behaviour exactly as today, except the removed old block (already off).

## Facts the builder must respect

- `admin_settings` is service-role only. Settings changes need `verifyAdminAccess` with a real admin user id.
- `WHITELIST_REGISTRY` (`lib/mtn-providers/provider-whitelist.ts`) holds each supplier's check; use the strict
  (throwing) batch variants; the non-strict ones fail open.
- `checkWhitelistForOrder` excludes `mtn_disabled_providers`; prod disables xpress, bisdel, eazyghdata, codecraft.
- Prod MTN routing: primary hubnet, retry sequence [agentportalgh]; `mtn_fallback_provider` {sykes} exists, find
  its callers.
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
