# Developer / API Page + v1 API Expansion

## Why

Datagod already has a working `X-API-Key`-authenticated public API (`app/api/v1/balance`, `app/api/v1/orders`) and a backend for generating/revoking keys (`app/api/user/keys`). It also already has a self-service key-management widget — `components/developer/ApiKeysManager.tsx` — but it's buried inside the Profile page behind an `isDealer || role === 'admin'` gate, built with raw CSS-in-JS instead of the app's shadcn/`DashboardLayout` system, and its embedded docs only cover the 2 existing endpoints. The only *dedicated* page today (`/admin/api-keys`) is an admin control panel for managing everyone's keys and audit logs, not a self-service integration page. This spec pulls the key-management functionality out of Profile into a proper dedicated page — modeled on a reference screenshot of a competitor's ("Apex Prime") developer API docs page — rebuilt on the app's real design system, opened up to all users, and expands the v1 API surface to cover the other purchasable services (airtime, AFA, results-checker vouchers, SMS) so the new page has something complete to document.

## Access model

Any authenticated user (role `user`, `sub_agent`, `dealer`, or `admin`) can generate and use API keys — this is a deliberate widening from the current backend, which restricts key generation (`POST /api/user/keys`) to `dealer`/`admin` only. That role check is removed entirely; every logged-in user gets the same key-management experience.

`POST /api/v1/sms/send` is the one endpoint that stays effectively gated, but by a different mechanism: `getOrCreateAccountForUser()` only returns an SMS account for shop owners, sub-agents, or admins. A plain `user` role can hold a valid API key and call every other endpoint, but will get a clear 403 from the SMS endpoint specifically, because they have no SMS account — this is an existing entitlement rule unrelated to key generation, and is out of scope to change here.

## New v1 API endpoints

All new routes live under `app/api/v1/` and follow the exact pattern already established by `app/api/v1/orders/route.ts`:

1. `authenticateApiKey(request)` (from `lib/api-auth.ts`) — reject with 401 if missing/invalid key.
2. `applyRateLimit(request, <identifier>, user.rate_limit_per_min, 60_000, user.id)` — reject with 429 over budget.
3. Do the actual work by calling existing, already-tested service logic (see table) — no new business logic invented in the route handler.
4. `logApiRequest(...)` — so every new endpoint shows up for free in the existing `/admin/api-keys` "Audit Logs" tab.

Response shape stays consistent with the existing v1 routes: `{ success: boolean, error?: string, error_code?: string, ...data }`.

| Endpoint | Wraps | Sync/Async | Notes |
|---|---|---|---|
| `GET /api/v1/products` | `packages` table (role-aware price/dealer_price) + admin-settings-driven airtime/results-checker/AFA pricing | Sync, read-only | No order/auth-owner side effects beyond key auth. Response sections: `data_bundles`, `airtime`, `results_checker`, `afa`. |
| `POST /api/v1/airtime` | `lib/airtime-service.ts: triggerDigiwapyFulfillment` | Sync (awaits the Digiwapy call, same as the dashboard route) | The current purchase route (`app/api/airtime/purchase/route.ts`) inlines pricing/order-creation rather than exposing a function. Extract a small `purchaseAirtime()` helper first so the v1 route and the dashboard route share one implementation instead of a third fork. Also calls `checkPhoneVerified` on the key owner (see Phone-gate parity below). |
| `POST /api/v1/afa` | `lib/afa-fulfillment.ts: fulfillAfaOrder` (+ `lib/sykes-afa-provider.ts`) | Fire-and-forget fulfillment, matching existing dashboard behavior — response returns `status: "pending"` | Same "extract a small order-creation helper first" note as airtime (`app/api/afa/submit/route.ts` currently inlines it). Also calls `checkPhoneVerified`. |
| `POST /api/v1/results-checker` | `lib/results-checker-service.ts: purchaseResultsCheckerVouchers` + `lib/results-checker-notification-service.ts: deliverVouchers` | Sync — already a clean reusable function | Response includes the purchased voucher PINs. Also calls `checkPhoneVerified`. |
| `POST /api/v1/sms/send` | `lib/sms/account-service.ts: getOrCreateAccountForUser` + `lib/sms/send-service.ts: enqueueSendBatched` | Sync (dispatch is awaited inside `enqueueSend`) | 403 with a clear message if the key owner has no SMS account. No phone-gate call — SMS sending isn't in the existing phone-gate enforcement list and this spec doesn't add it. |

Status/lookup-by-reference for the new resources is a `GET` handler on each resource's own route file (e.g. `GET /api/v1/airtime?reference=...`), mirroring the existing `GET /api/v1/orders?reference=...` pattern — not one unified "transactions" endpoint. The order tables involved (`airtime_orders`, `afa_orders`, `results_checker_orders`) haven't been confirmed to share a common reference-column name, so a unified endpoint is deferred rather than guessed at; each resource's own GET only needs to know its own schema.

### Phone-gate parity

`airtime`, `afa`, and `results-checker` v1 endpoints call `checkPhoneVerified(supabaseAdmin, user.id)` (from `lib/phone-verify-guard.ts`) on the API key owner, matching what their dashboard/session-auth equivalents already enforce (per the existing 3-layer phone-gate: API layer, DB layer, UI layer). The existing `GET/POST /api/v1/orders` and `GET /api/v1/balance` endpoints are **not** touched — they don't currently call this check, and changing already-shipped API behavior for existing integrators is a separate decision outside this spec's scope.

### Explicitly out of scope

- Sandbox/test-mode API keys (no `dg_test_` prefix, no fake fulfillment).
- Auto-generated OpenAPI/Swagger spec — the docs page is driven by a hand-written registry (see below), not spec-generation tooling.
- Webhooks/callback push for async status changes — API consumers poll `GET .../route.ts?reference=`, same as today.
- Any change to `/api/v1/orders` or `/api/v1/balance` behavior.

## `/dashboard/developer` page

New page, visible in the sidebar to **all** logged-in roles (`user`, `sub_agent`, `dealer`, `admin`), styled with the app's existing dark/emerald "Compute Network" design tokens and `DashboardLayout` wrapper (not a literal copy of the reference screenshot's blue theme). This **replaces** `components/developer/ApiKeysManager.tsx`: that component is deleted, its call site in `app/dashboard/profile/page.tsx` (the `{(isDealer || profile.role === 'admin') && <Card>...<ApiKeysManager /></Card>}` block) is removed rather than left as a second, now-stale copy of key management. The new page's key section reuses the same backend (`/api/user/keys`) and the same one-time-reveal UX, rebuilt with shadcn components.

**Your API Keys** card — full self-service key management against the existing `/api/user/keys` endpoints (no backend contract change needed there beyond removing the role restriction noted above):
- List: name, key prefix, active/revoked status badge, last used, created date.
- "Generate New Key" → dialog (name input) → the full key is shown exactly once with a copy-to-clipboard button and an explicit "save this now, it won't be shown again" warning, matching the existing API contract (`POST /api/user/keys` already returns the raw key once).
- Revoke button per key with a confirm dialog (soft-delete via `is_active: false`, same as today).
- Enforces the existing 5-active-keys cap client-side (disable "Generate" with an explanatory tooltip at 5) in addition to the backend's own 400.

**API Configuration** card — base URL, and the one real auth method (`X-API-Key` header). No second auth method is documented, since none is implemented.

**Endpoint documentation** — a sticky pill tab nav (Balance · Products · Data Orders · Airtime · AFA · Results Checker · SMS), each tab rendering from a small typed registry (e.g. `lib/api-docs-registry.ts`): one object per endpoint with method, path, description, params table, example cURL request, example success/error JSON, and status codes. A single `<EndpointDoc>` component renders any entry, so adding a future 8th endpoint is a registry entry, not a new hand-written section — justified here because there are already 7 endpoints to document, not a speculative abstraction.

New sidebar entry ("Developer / API", Code icon) in `components/layout/sidebar.tsx`'s nav array with `roles: ["user", "admin", "dealer", "sub_agent"]`.

## Implementation phasing

This spans backend (5 new routes + 2 small refactor-extractions) and frontend (1 new page + registry + sidebar entry). Recommended phase split for the implementation plan:

1. Backend: `GET /api/v1/products` (read-only, lowest risk, and gives the frontend real data to build against).
2. Backend: `POST/GET /api/v1/airtime`, `/api/v1/afa`, `/api/v1/results-checker` (each needs the phone-gate call + the airtime/AFA helper-extraction refactors).
3. Backend: `POST/GET /api/v1/sms/send`.
4. Backend: remove the dealer/admin role restriction in `app/api/user/keys` (POST).
5. Frontend: `/dashboard/developer` page — key management first, then the docs registry/tabs wired to the now-complete endpoint set, then the sidebar entry.

Each phase should get its own review pass given this touches money-moving endpoints (purchases, SMS credits) behind a new, wider-open auth surface.
