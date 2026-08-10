# Phone Verification: Whitelist Provider Selection — Design

## Goal

The MTN Whitelist check mode on `/admin/phone-verification` (shipped 2026-08-10) always checks every configured whitelist-capable provider (Xpress → CodeCraft → AgentPortalGH, in that order, stopping at the first allow). Let the admin choose a subset of providers to check against for a given upload instead of always using all of them.

## Context (current state)

- `lib/mtn-providers/provider-whitelist.ts`: `WHITELIST_REGISTRY` (3 entries, each with `name`, `configured()`, `check()`, `checkBatch()`); `checkWhitelistBatch(msisdns, registry = WHITELIST_REGISTRY)` already accepts an optional registry override — no signature change needed to support a filtered subset.
- `lib/phone-verify-whitelist-processor.ts`: `processWhitelistChunk()` calls `checkWhitelistBatch(mtnPhones)` (always the full registry); `decideWhitelistOutcomes()` is a pure function producing per-row status buckets + `mtn_number_registry` upsert payloads (`whitelist_status`, `whitelist_allowed_by`, `whitelist_last_checked`, `whitelist_retry_count`).
- `lib/phone-verify-upload.ts`: `findRecentWhitelistChecks(supabase, candidates)` implements the 24h dedupe freshness window, returning `{status, allowedBy}` per phone, provider-agnostic — any check within 24h counts as "known," regardless of which provider produced it.
- `mtn_number_registry`: per-number, tracks `whitelist_status` (allowed/blocked/unchecked), `whitelist_allowed_by` (the ONE provider that allowed it, null if blocked or unchecked), `whitelist_last_checked`, `whitelist_retry_count`. **No record of which provider(s) produced a `blocked` verdict** — today that's fine because a blocked result only happens when every configured provider was tried.
- `app/api/admin/mtn-whitelist/batch-verify/route.ts` (separate, pre-existing bulk re-verify tool operating on the whole registry) already supports an optional `providers` comma-separated filter — but doesn't track which providers were consulted either, for the same reason.

## Design

### 1. New data: track *which* providers produced a number's current verdict

Add `mtn_number_registry.whitelist_checked_providers TEXT[]` — the **cumulative union**, across every check ever run against a number (regardless of entry point), of every provider name that was actually consulted to arrive at its current `whitelist_status`. This is new information the schema doesn't currently capture at all (today only "who allowed it" is recorded, never "who was asked and said no").

Add `phone_verification_sessions.whitelist_providers TEXT[]` — the provider subset *this session* was configured to check against. Null/empty for `moolre` sessions. Shown in the session progress card and History tab for transparency (mirrors how `check_type` is already surfaced there).

```sql
ALTER TABLE phone_verification_sessions
  ADD COLUMN IF NOT EXISTS whitelist_providers TEXT[];

ALTER TABLE mtn_number_registry
  ADD COLUMN IF NOT EXISTS whitelist_checked_providers TEXT[] NOT NULL DEFAULT '{}';
```

### 2. Dedupe becomes a set-coverage check, combined with the existing 24h window

A stored result counts as "known, skip as duplicate" only if **both** hold:
- (unchanged) `whitelist_last_checked` is within the last 24h, AND
- (new) this run's selected provider set is already fully covered by what produced the stored result:
  - **Allowed** rows: covered iff `whitelist_allowed_by` is in this run's selected set. (We know a selected provider already said yes — no need to ask again.)
  - **Blocked** rows: covered iff this run's *entire* selected set is a subset of `whitelist_checked_providers`. (Every provider we'd ask this run already said no.) If the selection includes even one provider that's never been tried against this number, it's not covered — re-check.

If either the recency or the coverage condition fails, the number is treated as fresh (queued `pending`), even if it was checked before. This is a strict narrowing of today's dedupe (provider-agnostic within 24h) — nothing that used to skip under the old rule but shouldn't have started passing through as a false duplicate; the new rule only makes MORE numbers eligible for a fresh check, never fewer.

`findRecentWhitelistChecks` gains a `selectedProviders: string[]` parameter and now also selects `whitelist_checked_providers`, applying the coverage logic above per row instead of the current "any status is close enough" check.

### 3. Processing: filter the registry, then union the checked-providers set back in

`processWhitelistChunk` needs the session's `whitelist_providers` to:
- Build `registry = WHITELIST_REGISTRY.filter(p => selectedProviders.includes(p.name))` and pass it as `checkWhitelistBatch(mtnPhones, registry)` instead of the default full registry.
- After `decideWhitelistOutcomes` returns its (unchanged) per-row decision, merge `whitelist_checked_providers` into each registry upsert row as the union of the number's existing `whitelist_checked_providers` (fetched once per chunk, keyed by phone) and this run's `selectedProviders` — regardless of whether the row ended up allowed or blocked, since "providers consulted" is independent of the outcome.

`decideWhitelistOutcomes` itself does **not** change signature or logic — every row in one processing chunk shares the same `selectedProviders` (it's a per-session setting, not per-number), so the union step is uniform across the whole chunk and belongs in the orchestrator, not the per-row pure decision function. Its existing tests are unaffected.

`app/api/admin/mtn-whitelist/batch-verify/route.ts` gets the same union treatment for its own registry writes, so `whitelist_checked_providers` stays accurate regardless of which of the two entry points touched a number.

### 4. Upload-time validation

When `checkType === "mtn_whitelist"`, the upload route now also reads a `providers` field (comma-separated provider names) from the form data. Validate: non-empty, every name matches a `WHITELIST_REGISTRY` entry, and every named provider is actually `.configured()` — reject with 400 otherwise (mirrors the existing `hasWhitelistProviders()` gate, just scoped to the specific requested subset instead of "at least one, anywhere"). The validated set is written to the new session column and threaded through as described above.

### 5. Frontend

- `GET /api/admin/phone-verify/whitelist-availability` is extended from `{ available: boolean }` to also return per-provider configuration state: `{ available: boolean, providers: [{ name, configured }] }` (new export `getConfiguredWhitelistProviders()`-style helper in `provider-whitelist.ts`, or just map over `WHITELIST_REGISTRY` in the route — no new business logic, just exposing what `.configured()` already knows per entry).
- When "MTN Whitelist" mode is selected, show one checkbox per provider, labeled with its display name, all checked by default; a provider with `configured: false` renders disabled/grayed with a "not configured" note. At least one must remain checked to enable the upload controls.
- `handleFileSelect` sends the checked provider names (comma-separated) as a `providers` field alongside `checkType`.
- The progress card and History tab show which providers a session used (small text line / badge), reusing the existing "Allowed By" per-row display pattern for consistency.

## Testing

- Unit tests for the new coverage predicate (call it `isWhitelistResultCovered(row, selectedProviders, now)` or similar, extracted as a pure function in `lib/phone-verify-upload.ts` alongside `findRecentWhitelistChecks`) — covering: allowed-by-selected-provider (covered), allowed-by-excluded-provider (not covered), blocked-with-full-coverage (covered), blocked-with-a-never-tried-selected-provider (not covered), stale-beyond-24h (never covered regardless of provider match).
- Unit tests for the checked-providers union merge step (pure array-union helper).
- Existing `decideWhitelistOutcomes` tests unchanged — no signature change.
- Existing `checkWhitelistBatch` tests unchanged — already supports a registry override, which is all this feature needs from it.

## Out of scope

- Reordering provider priority (this is a subset-selection control, not a priority/drag-to-reorder control) — providers checked always follow `WHITELIST_REGISTRY`'s existing fixed order among whichever are selected.
- Backfilling `whitelist_checked_providers` for existing registry rows — the column defaults to `'{}'` for all historical rows; the first time any of them go through either write path again (this feature or `batch-verify`), it'll start being populated. No historical reconstruction.
- Changing `checkWhitelistForOrder` (the real-time, order-fulfillment-path whitelist check) — untouched, this feature is scoped to the two bulk/admin-tool entry points only.
