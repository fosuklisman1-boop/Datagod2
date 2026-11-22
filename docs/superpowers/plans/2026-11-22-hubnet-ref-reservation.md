# Hubnet Reference Reservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Reserve every Hubnet reference in our DB before the Hubnet POST, so two concurrent senders of one order can never both place it.

**Architecture:** New table `hubnet_ref_reservations` (migration 0192, service-role only) + `lib/hubnet/reservations.ts` (`reserve`/`release`), injected into `HubnetProvider` and `fulfillAirtimeViaHubnet`.

**Tech Stack:** Next.js 15, Supabase service client, Postgres 17, vitest + PGlite.

**Spec:** `docs/superpowers/specs/2026-11-22-hubnet-ref-reservation-design.md`

## Global Constraints
- Worktree `B:/worktrees/dg-order-queue`, branch `fix/hubnet-ref-reservation`; vitest from `cd B:/worktrees/dg-order-queue`.
- Edit/Write only — never sed or scripted string replaces. No subagents inside tasks. No real database.
- No phone numbers in logs (ids/refs only).
- Migration house pattern, exactly as `migrations/0191_bulk_send_guard.sql` + `.selftest.sql` + `lib/order-queue/migration-0191-run.ts` + `lib/order-queue/migration-0191.test.ts` (place the new run/test files in `lib/hubnet/`). Selftest seeds only `hubnet_ref_reservations` rows with fake refs (`SELFTEST0192-…`) and ends with `RAISE EXCEPTION 'SELFTEST_OK 0192 …'`.
- A held reservation must never lead to another supplier being tried (return OUTCOME_UNKNOWN for data).

## Review Focus
1. Concurrent second sender: reserve returns `held` ⇒ Hubnet POST never called (Task 2 test).
2. Reservation DB down / unexpected error ⇒ Hubnet never called; data returns `RESERVE_FAILED` (not OUTCOME_UNKNOWN) (Task 2 test).
3. A definite refusal releases the ref so a later resend can place it; an unclear reply keeps it (Task 2 tests).
4. `anon`/`authenticated` cannot read or write the table (Task 1 test).
5. Existing Hubnet tests keep their meaning: default injection must not touch the DB in tests — mirror how `createHubnetClient` picks `memoryCooldown` when `fetch` is injected.

---

### Task 1: Migration 0192 + reservations module

**Files:** Create `migrations/0192_hubnet_ref_reservations.sql`, `.selftest.sql`, `lib/hubnet/migration-0192-run.ts`, `lib/hubnet/migration-0192.test.ts`, `lib/hubnet/reservations.ts`, `lib/hubnet/reservations.test.ts`.

**Interfaces — Produces:**
- Table per spec.
- `type ReserveResult = "reserved" | "held" | "error"`
- `interface HubnetReservations { reserve(r: { ref: string; kind: "data" | "airtime"; orderId: string }): Promise<ReserveResult>; release(ref: string): Promise<void> }`
- `dbReservations(getDb: () => { from(t: string): any } | null): HubnetReservations` — reserve inserts; PG `23505` ⇒ `held`; any other error, thrown error, or `getDb()` null ⇒ `error`. release deletes by ref, never throws.
- `memoryReservations(): HubnetReservations` (per-process Set; for tests).
- `defaultHubnetReservations(): HubnetReservations` — lazy service-role client from `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`; null client ⇒ `error` (fail closed).

- [ ] Failing tests: PGlite — migration text rules, run-string rules, apply twice ok, second insert of same ref ⇒ 23505, CHECK rejects kind 'x', anon/authenticated denied select/insert/delete, service_role allowed; unit — `dbReservations` maps 23505⇒held, other error⇒error, throw⇒error, null db⇒error, success⇒reserved; release swallows errors; `memoryReservations` second reserve ⇒ held, release then reserve ⇒ reserved.
- [ ] Implement; tests pass. Commit `feat(hubnet): reference reservation table (0192) + reservations module`.

### Task 2: Wire into data provider and airtime

**Files:** Modify `lib/mtn-providers/hubnet-provider.ts`, `lib/airtime-hubnet.ts`, `lib/airtime-service.ts` (pass reservations), their tests.

**Interfaces — Consumes:** `HubnetReservations`, `defaultHubnetReservations`, `memoryReservations` (Task 1).
- `HubnetDeps.reservations?: HubnetReservations` (default: `memoryReservations()` when a `client` is injected — tests — else `defaultHubnetReservations()`).
- `AirtimeHubnetDeps.reservations?: HubnetReservations` (same defaulting rule).

- [ ] Failing tests (data): missing ⇒ reserve ⇒ place called once; `held` ⇒ placeData NOT called, result `error_type: "OUTCOME_UNKNOWN"`, message contains "another send of this order is in progress"; `error` ⇒ placeData NOT called, `error_type: "RESERVE_FAILED"`; refusal classes (rejected 403, insufficient_balance, auth 401, rate_limited 429 JSON, client RATE_LIMIT cooldown result, never-reached NETWORK_ERROR) ⇒ release called with the ref; success / duplicate / unknown (503) ⇒ release NOT called; two concurrent `createOrder` calls sharing one `memoryReservations` with a `missing` lookup ⇒ placeData called exactly once.
- [ ] Failing tests (airtime): same matrix — `held` ⇒ placeAirtime not called, order held for review ("do not resend"); `error` ⇒ notSent with "could not reserve reference"; refusal ⇒ release; success/unknown ⇒ kept.
- [ ] Implement; run `npx vitest run lib/hubnet lib/mtn-providers lib/airtime-hubnet.test.ts lib/airtime-service` — pass; `npx tsc --noEmit -p .` clean in touched files. Commit `fix(hubnet): reserve each reference before placing (no double send)`.

### Task 3: Release
- [ ] Opus final review of the branch diff; fix findings with failing tests first.
- [ ] Controller: prod precheck (`to_regclass('public.hubnet_ref_reservations')` is null) → self-rolling-back dry run (`SELFTEST_OK 0192`) → owner OK → apply → verify grants + RLS.
- [ ] Merge origin/main, placeholder-env `npm run build`, owner OK, push, watch deploy READY, check a live Hubnet order writes a reservation row.
