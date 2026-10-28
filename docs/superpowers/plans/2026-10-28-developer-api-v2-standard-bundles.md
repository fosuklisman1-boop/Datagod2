# Developer API v2 — Plan 9: Standard Bundles (Hubtel-fulfilled)

**Goal:** Commission-key (`dg2_cs_*`) developers can list the Standard Bundles catalogue, buy a bundle with a required client `reference`, and look up / list their orders, by wrapping the existing engine `buyBundle` (lib/standard-bundles/service.ts, unchanged). v1 `/api/v1/bundles` stays untouched.

**Why:** Plans 1-8 never covered Standard Bundles (the Hubtel-fulfilled bundles with their own dashboard page). v1 had them; v2 did not.

**Risk tier:** Tier 1 (wallet money). Mandatory fresh whole-branch review, database-reviewer on the migration, abuse-case pass, failing tests first, prod protocol (code-asserted self-rolling-back dry run, explicit user OK before apply).

## Endpoints (all `requiredType: "commission"`)

| Method / path | Group | Notes |
|---|---|---|
| `GET /bundles/catalog?network=MTN\|Telecel\|AT` | status | Priced catalogue with signed `bundle_token`s (10 min). Gated by the admin API surface switch. |
| `POST /bundles/purchase` | purchase | `{ bundle_token, recipient, reference, expected_pay? }`. `failClosedWhenLimiterDegraded`, `maxDuration` 300. |
| `GET /bundles/orders` | status | Own orders (done claims, 30). |
| `GET /bundles/orders/{reference}` | status | By client reference; shows `claim.state` while pending/unknown. |

## Calls I made

1. **Commission key** (user's choice), because Standard Bundles are a Hubtel commission service.
2. **Claim-before-engine** (`api_v2_idempotency`, new kind `bundle`, migration 0140) like airtime/bills. The engine has its own idempotency key but its replay ignores the request body, and a failed-unpaid order would pin a reference to a 402 forever. So the engine key is derived from the **claim id** (`v2-` + sha256(claimId)[0..40]): each fresh claim gets a fresh engine key; one claim reaches the engine at most once.
3. **Request hash** = network + bundle value + face amount + recipient (decoded from the token WITHOUT verifying; the engine verifies the signature). A refreshed token for the same bundle replays instead of conflicting. `expected_pay` excluded.
4. **No-charge vs ambiguous:** a refusal is no-charge (claim released) only when it carries no order row (400/403/409/503 pre-insert) or is the unpaid-insufficient 402. Anything with an order attached, any 5xx other than the pre-insert 503, any throw or malformed result => claim marked `unknown`, urgent admin alert, `OUTCOME_UNKNOWN`, never re-run.
5. **Gates** (live): API surface switch (403 NOT_AVAILABLE), phone gate (403), then engine.
6. **Sandbox** (test keys): static `sbx_*` catalogue from lib/api-v1/bundles; `placeSandboxOrder` action `standard_bundle`, replay keyed by client reference.
7. Response never contains engine text, provider references, notes or failure reasons.

## Tasks

1. Migration 0140 + selftest (claim kind `bundle`). Do not apply until Task 8.
2. Pure rules `lib/api-v2/bundles.ts` (+ test): parse body, token identity, hash, network parse, mappers, refusal classifier/messages.
3. Endpoint core `lib/api-v2/endpoints/bundles.ts` (+ test) and real deps `bundles-deps.ts` (+ test).
4. Routes `app/api/v2/bundles/{catalog,purchase,orders,orders/[reference]}/route.ts` (+ tests).
5. Docs registry group + samples + Postman requests; key-types / commission wording; drift tests.
6. Whole-branch verification: vitest, tsc, real `next build`.
7. Reviews (fresh whole-branch, database-reviewer, abuse cases); fix with failing tests.
8. Ship: user OK -> apply 0140 with dry run -> verify -> push -> watch deploy -> probe unauthenticated routes -> memory.
