# Hubnet reference reservation — short design

Date: 2026-11-22. Owner chose approach A (Hubnet-only reservation).

## Why
Live probe 2026-11-22 (owner-approved, staff numbers): Hubnet does **not** reject a reused
`reference` — single `mtn-new-transaction` and `bulk/mtn-new-transaction` both charged twice
for the same reference, contrary to Hubnet's docs. Our only protection today is the pre-place
status lookup ("place only on a proven *missing*"). Two processes sending the same order at the
same moment (queue drain + a manual Fulfil, two admins) can both see *missing* and both place:
a double charge and double delivery.

## Goal
Before any call that places a Hubnet order (data or airtime), atomically reserve its reference in
our database. Only the reservation owner may call Hubnet; anyone else stops before Hubnet.

## Non-goals / anti-goals
- No change for other suppliers (approach B — widening `claim_order_dispatch` — is a follow-up).
- Never fall through to another supplier when the reservation is held elsewhere (that would be
  a cross-supplier double delivery): a held reservation ⇒ OUTCOME_UNKNOWN-style hold.
- No bulk endpoint work here (comes later, built on this reservation).

## Approaches considered
- **A. Hubnet-only reservation table (chosen).** Narrow, quick to test; covers the supplier proven not to dedupe.
- B. Widen `claim_order_dispatch` into an in-flight lock for all suppliers. Wider protection, but shared
  with refunds/cashback and its "blocked" result means "being refunded" today — more risk. Follow-up.

## Design (decided)
- Migration **0192**: table `hubnet_ref_reservations(ref text primary key, kind text not null
  check (kind in ('data','airtime')), order_id text not null, created_at timestamptz not null default now())`.
  RLS on, no policies, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT SELECT, INSERT, DELETE … TO service_role`.
  House migration pattern (single txn, timeouts, one COMMIT, selftest ending `SELFTEST_OK 0192`, run-string builder, PGlite test).
- `lib/hubnet/reservations.ts`: `reserveRef(db, {ref, kind, orderId}) → "reserved" | "held" | "error"`
  (`held` = unique violation 23505; `error` = anything else, fail closed) and
  `releaseRef(db, ref) → void` (best effort, never throws). Injectable into the provider and the
  airtime path (default = service-role client, lazily built, like `defaultHubnetCooldown`).
- Data provider (`HubnetProvider.place`) and airtime (`fulfillAirtimeViaHubnet` place step):
  after the pre-place lookup says *missing*, call `reserveRef` **before** the Hubnet POST.
  - `reserved` ⇒ place. On a definite **not sent** outcome (rejected, insufficient balance, auth,
    rate limited / cooldown RATE_LIMIT, never-reached NETWORK_ERROR) ⇒ `releaseRef` so a later
    resend can use the same reference. On success, duplicate, or any unclear outcome ⇒ keep it.
  - `held` ⇒ do not call Hubnet; data: return `outcomeUnknownResponse("Hubnet", …)` with message
    "another send of this order is in progress — not sent again"; airtime: the existing
    hold-for-review path ("do not resend").
  - `error` ⇒ do not call Hubnet; data: ordinary failure `RESERVE_FAILED` (nothing was sent, so the
    retry sequence may try another supplier); airtime: `notSent("could not reserve reference")`.
- References already placed before this ships have no reservation; their safety is unchanged
  (pre-place lookup). Reservations are kept indefinitely (refs are deterministic per attempt).

## Left to the builder
Exact module wiring for injection, test structure, whether `releaseRef` logs on failure (ids only).

## Review gates
Money path + schema ⇒ fresh reviewer per task, ECC security review, PGlite test, prod protocol
(precheck → dry run → owner OK → apply → verify), build, owner OK before push.
