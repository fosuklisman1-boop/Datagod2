# Phone Verification: MTN Whitelist Check Toggle — Design

## Goal

`/admin/phone-verification` currently does exactly one thing: bulk-check uploaded/pasted phone numbers against Moolre's mobile-money account-name lookup. Add a second check method — MTN whitelist status (can this number currently receive an MTN data-bundle order from us) — selectable via a toggle on the same page, reusing the existing upload/progress/history/export flow.

## Context (current state)

- **Page**: `app/admin/phone-verification/page.tsx` — Upload/History tabs, file-or-paste input, single hardcoded check: `validateAccountName()` (`lib/moolre-transfer.ts`) via `lib/phone-verify-processor.ts`.
- **Tables**: `phone_verification_sessions` (one row per upload batch) and `phone_verification_results` (one row per phone number), defined in `migrations/0050_phone_verification_tables.sql`. Status is an informally-enforced string: `pending | verified | invalid | duplicate`.
- **Dedupe**: `app/api/admin/phone-verify/upload/route.ts`'s `findExistingNumbers()` checks *all* prior sessions; any number seen before is inserted as `duplicate` and never re-checked — appropriate for Moolre since a MoMo account name rarely changes.
- **MTN whitelist system** (separate, pre-existing): `lib/mtn-providers/provider-whitelist.ts` defines `WHITELIST_REGISTRY`, an ordered list of the 3 (of 7) MTN fulfillment providers that expose a dedicated whitelist-check endpoint — Xpress, CodeCraft, AgentPortalGH — each gated by its own env var (`XPRESS_KEY`, `CODECRAFT_API_KEY`, `AGENTPORTALGH_API_KEY`) via `configured()`. Batch endpoints already exist per provider: `checkXpressBatch` (chunk 1000), `checkCodecraftBatch` (chunk 100), `checkAgentPortalGHBatch`.
- **Registry**: `mtn_number_registry` (`migrations/20260707_mtn_number_registry.sql`, extended by `0092_mtn_whitelist_tracking.sql`) holds, per phone number, both an MTN-*registration* `status` (unrelated, out of scope here) and separate whitelist columns: `whitelist_status` (`unchecked|allowed|blocked`), `whitelist_allowed_by` (provider name), `whitelist_retry_count`, `whitelist_last_checked`. This is the table that actually gates live order fulfillment (`lib/mtn-fulfillment.ts`) and is what the 24h retry cron (`app/api/cron/mtn-whitelist-retry/route.ts`) reads/writes.
- **Existing bulk-verify endpoint**: `app/api/admin/mtn-whitelist/batch-verify/route.ts` already re-verifies the *entire* `mtn_number_registry` against all configured providers in batches — but only operates on numbers already in the registry; it has no upload/paste entry point for an arbitrary external list.

## Design

### 1. Toggle & UI

On the Upload tab, above the file/paste input, add a two-option switch:
- **"Moolre (MoMo account check)"** (default, current behavior, unchanged)
- **"MTN Whitelist (can this number order from us)"**

The selection is per-session — the whole uploaded batch is checked one way or the other, matching the existing one-session-one-purpose model. The choice is stored on the session row and displayed in the History tab so past sessions show which check they ran.

If zero whitelist providers are configured (no `XPRESS_KEY`/`CODECRAFT_API_KEY`/`AGENTPORTALGH_API_KEY` set), the whitelist option is disabled with an explanatory tooltip rather than silently producing meaningless "blocked" results for every number.

### 2. Data model changes (additive migration)

```sql
ALTER TABLE phone_verification_sessions
  ADD COLUMN check_type TEXT NOT NULL DEFAULT 'moolre'
  CHECK (check_type IN ('moolre', 'mtn_whitelist'));

ALTER TABLE phone_verification_results
  ADD COLUMN whitelist_provider TEXT NULL;
```

- `check_type` defaults existing rows to `'moolre'` — fully backward compatible.
- `whitelist_provider` records which provider (`xpress|codecraft|agentportalgh`) allowed a number; stays `NULL` for Moolre rows and for blocked/not-applicable whitelist rows.
- The informal `status` vocabulary on `phone_verification_results` gains one new value for whitelist sessions: `not_applicable` (non-MTN or unrecognized-network numbers — never sent to any provider). `pending | verified | invalid | duplicate` keep their existing meaning, reinterpreted per check type: in whitelist mode, `verified` means "confirmed able to order," `invalid` means "confirmed blocked by every configured provider."

### 3. Shared provider-fallback logic (small refactor)

`app/api/admin/mtn-whitelist/batch-verify/route.ts` already implements "try each configured provider's batch endpoint in provider-registry order, mark the first success" for re-verifying the whole registry. Extract that loop into one function in `lib/mtn-providers/provider-whitelist.ts`, e.g.:

```ts
export async function checkWhitelistBatch(
  msisdns: string[]
): Promise<Map<string, { allowed: boolean; allowedBy?: WhitelistProviderName }>>
```

Both `batch-verify/route.ts` and the new phone-verification whitelist processor call this same function, so provider precedence and chunk-sizing logic exist in exactly one place instead of two copies that could drift.

### 4. Upload-time dedupe (per check type, time-boxed for whitelist)

`upload/route.ts`'s dedupe logic is extended, branching on `check_type`:

- **Moolre session** (unchanged): a number seen in *any* prior session (regardless of age) → inserted as `duplicate`, never re-checked.
- **`mtn_whitelist` session** (new): a number is `duplicate` only if `mtn_number_registry.whitelist_last_checked` for that number is **less than 24 hours old**. Otherwise it's queued `pending` for a fresh check, even if it was checked before (whitelist status is time-varying — a number blocked weeks ago may be allowed now, and the existing 24h retry cron already uses the same freshness window for the same reason). `mtn_number_registry.whitelist_last_checked` is the single freshness clock — no second timestamp is introduced.
- Dedupe is always scoped to matching check type: a number already Moolre-verified is still checked fresh under a whitelist session, and vice versa — the two checks answer unrelated questions.

### 5. Chunked processing (new `lib/phone-verify-whitelist-processor.ts`, sibling to the existing Moolre processor)

Follows the same session/chunk/progress-polling shape as `lib/phone-verify-processor.ts`. Per pending row:

1. **Network check first**: numbers not classified as MTN (using the codebase's existing canonical MTN-prefix detector, matching `gh_is_mtn` from the network-prefix-validation feature — not a fresh reimplementation) are set to `not_applicable` immediately. No provider call, no registry write.
2. **MTN numbers**: call `checkWhitelistBatch()` (chunked at 100 — CodeCraft's limit is the binding constraint among the three providers).
3. Any provider allows → `status: 'verified'`, `whitelist_provider` set to that provider; upsert `mtn_number_registry` (`whitelist_status: 'allowed'`, `whitelist_allowed_by`, `whitelist_last_checked: now()`), inserting a new registry row if the number isn't already tracked.
4. All configured providers explicitly deny → `status: 'invalid'`; upsert registry with `whitelist_status: 'blocked'`, `whitelist_last_checked: now()`.
5. All configured providers error/timeout → row stays `pending` for the next processing tick (same retry-friendly behavior the Moolre processor already has for transient failures); registry untouched.

### 6. Export

The existing "verified-only" xlsx export behavior is preserved for both check types — it exports `status = 'verified'` rows only (the numbers confirmed usable). For a `mtn_whitelist` session, the export adds a `whitelist_provider` column and omits `account_name` (meaningless outside Moolre mode).

### 7. Testing

- Unit tests for the new time-boxed dedupe branch (fresh vs. stale `whitelist_last_checked`, and cross-check-type isolation).
- Unit tests for the MTN/non-MTN skip branch.
- Unit tests for `checkWhitelistBatch()` covering: single-provider allow, fall-through to second/third provider, all-deny, all-error/unconfigured — using the repo's existing fake-Supabase-client pattern (see `lib/mtn-reversal.test.ts`).
- Existing Moolre-path tests (if any) remain untouched — this is purely additive.

## Out of scope

- Changing anything about the existing Moolre check path's behavior, dedupe, or export.
- The MTN *registration* gate (`mtn_number_registry.status`, the batch-export-to-MTN pipeline) — untouched, unrelated column on the same table.
- Adding whitelist-check support for the 4 providers that don't expose a dedicated endpoint (Sykes, DataKazina, EazyGhData, Bisdel).
- Real-time/single-number ad hoc checking UI — this feature is bulk-upload only, same as the existing Moolre flow.
