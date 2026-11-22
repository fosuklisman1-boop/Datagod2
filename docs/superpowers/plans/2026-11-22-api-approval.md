# API Approval (Release 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people request a live key or API access, message the admin on WhatsApp with a request code, and be approved without changing their prices or breaking a working key.

**Architecture:** One additive migration holds requests, grants and the atomic decision functions. Pure rules live in `lib/api-v2/`. Routes stay thin, derive the user from the session, and notify through `lib/admin-actions/` after the state change.

**Tech Stack:** Next.js 15, TypeScript, Supabase Postgres, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-11-22-api-approval-design.md`. Read it with this plan; section numbers below refer to it.

## Global Constraints

- Work only in `B:/worktrees/api-rebuild`. vitest needs the uppercase drive path (`B:/...`).
- Use Edit/Write for code. No sed.
- Failing test first. Commit after each task, staging named files only.
- Never log or return a key hash, full key, phone or email in logs. A full key appears once, in the POST response.
- User id comes from the session. Every admin method, GET included, calls `verifyAdminAccess`.
- A grant never changes `users.role`, `ctx.role` or prices, and never overrides disabled, suspended or SMS access.
- v2 request and response envelopes do not change.
- Migration number 0194: re-check against all branches and origin/main before Task 1 and again before applying.
- No push and no production SQL without the owner's OK.
- UI: navy `--primary`, dark mode, works at 500 px, `lg:` multi-column.
- The known 9 order-health test failures are the only accepted failures.

## Review Focus

1. Two tabs click Regenerate together: one pending key and one 409; the active key keeps working. (Tasks 1, 6)
2. A support number stored as `0559919037`: the link is `233559919037`, not a dead `wa.me/055...`. (Task 2)
3. The role becomes allowed while an access request is open: the user sees key cards, and the admin can still close the request. (Tasks 1, 6)
4. The notifier is down or slow: the request or decision still succeeds and is not repeated. (Tasks 6, 7)
5. A name, email or reason contains `&`, `#`, `<` or a newline: the WhatsApp text is intact and the HTML is escaped. (Tasks 2, 5)

## File map

| File | Responsibility |
|---|---|
| `migrations/0194_api_approval.sql`, `.selftest.sql` | Schema, decision functions, inbox context |
| `lib/api-v2/migration-0194-run.ts` | Builds the dry-run string |
| `lib/api-v2/approval-contact.ts` | Parse number/link, build wa.me link |
| `lib/api-v2/request-code.ts` | Request codes |
| `lib/api-v2/eligibility.ts` | The one eligibility rule |
| `lib/api-v2/log-reason.ts` | Log reason slug |
| `lib/api-v2/access-requests.ts` | Developer-side request DB work |
| `lib/api-v2/approvals.ts` | Admin-side RPC wrappers, inbox shaping |
| `lib/api-v2/admin-audit.ts` | Audit writes for non-RPC actions |
| `lib/admin-actions/flows/api-access.ts` | All messages |
| `components/developer/approval/*` | Waiting, rejected and access-request panels |
| `components/admin/api-keys/approvals/*` | Inbox, contact, grants, history |

---

### Task 1: Migration and atomic decisions

**Files:**
- Create: `migrations/0194_api_approval.sql`, `migrations/0194_api_approval.selftest.sql`, `lib/api-v2/migration-0194-run.ts`
- Test: `lib/api-v2/migration-0194.test.ts` (copy the PGlite loading and text checks of `lib/roles/migration-0187.test.ts`)

**Interfaces, produced:**

```sql
api_v2_approve_key(p_key uuid, p_actor uuid) returns jsonb
api_v2_reject_key(p_key uuid, p_actor uuid, p_reason text) returns jsonb
api_v2_approve_access(p_request uuid, p_actor uuid) returns jsonb
api_v2_reject_access(p_request uuid, p_actor uuid, p_reason text) returns jsonb
api_v2_remove_grant(p_user uuid, p_actor uuid, p_reason text) returns jsonb
api_v2_approval_context(p_users uuid[]) returns jsonb
-- success: {"ok":true,"user_id":...,"key_type"?:...,"replaced_key_id"?:...}
-- failure: {"ok":false,"code":"not_found"|"stale"|"suspended"|"not_eligible"|"bad_reason"}
-- context: {"<user>":{"topups_30d":numeric,"orders_30d":int}}
```

```ts
export function buildRunString(migrationSql: string, selftestSql: string): string
```

- [ ] **Step 1: Setup.** `npm ci` with the npm cache on B:. Run `npx vitest run lib/api-v2 lib/admin-actions lib/roles` and record the baseline.
- [ ] **Step 2: Write failing tests**, one `it` per line:

```
text: one BEGIN, both SET LOCALs, one COMMIT; run string has no COMMIT and ends RAISE 'SELFTEST_OK 0194'
indexes: active + pending in one slot allowed; second active refused; second pending refused (23505)
backfill: existing pending live key gets /^API-[A-Z0-9]{6}$/; active keys get none
approve_key: old -> revoked, new -> active, limits {"purchase":50} copied; existing overrides on new key kept
approve_key: suspended -> suspended, not_eligible -> not_eligible; in both cases old key still active
approve_key: grant + disallowed role -> ok
approve_key twice -> second is stale
approve_key after the active key was revoked by the user -> ok, replaced_key_id null
reject_key: revoked + rejected_at/by/reason; active key untouched; reason of 2 or 201 chars -> bad_reason
access: second pending request refused; approve inserts grant and creates no key; suspended refused
access: approve when role is already allowed -> ok
remove_grant: row gone, keys untouched; missing -> not_found
audit: each success writes exactly one admin_audit_log row api_key_approve | api_key_reject |
  api_access_approve | api_access_reject | api_grant_remove; a failure writes none; no hash or phone in it
privileges: anon and authenticated have no SELECT/INSERT on both tables and no EXECUTE on all six functions
```

- [ ] **Step 3: Run.** `npx vitest run lib/api-v2/migration-0194.test.ts`. Expected: FAIL, file not found.
- [ ] **Step 4: Write the migration** per §7 and §8.
  - `SET LOCAL lock_timeout = '5s'`, `statement_timeout = '60s'`. Create both new indexes before dropping `api_v2_keys_one_live_per_type`.
  - Decision functions lock with `FOR UPDATE` ordered by id.
  - Eligible in SQL: grant exists OR `users.role = ANY(api_v2_config.allowed_roles)`.
  - Context orders: the seven order tables in `admin_user_signals` (0174). Top-ups: credit transactions with source `wallet_topup` or `momo_claim`; list this source census in the PRE-CHECKS header.
- [ ] **Step 5: Write the selftest and builder** following `lib/roles/migration-0187-run.ts`.
- [ ] **Step 6: Run the test.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(api-v2): approval schema and atomic decisions`.

### Task 2: Contact link and request code

**Files:** Create `lib/api-v2/approval-contact.ts`, `lib/api-v2/request-code.ts`. Test: a `.test.ts` beside each.

**Interfaces, produced:**

```ts
export function parseApprovalContact(input: unknown): { ok: true; digits: string | null } | { ok: false; error: string }
export function resolveContact(configured: string | null, support: string | null): string | null
export function buildApprovalLink(digits: string, p: { code: string; email: string | null }): string
export function newRequestCode(randomInt?: (max: number) => number): string
```

- [ ] **Step 1: Failing tests.**

```ts
for (const v of ["0559919037", "+233 55 991 9037", "https://wa.me/233559919037",
  "https://api.whatsapp.com/send?phone=233559919037"])
  expect(parseApprovalContact(v)).toEqual({ ok: true, digits: "233559919037" })
expect(parseApprovalContact("")).toEqual({ ok: true, digits: null })
for (const v of ["https://wa.me/message/ABC", "https://chat.whatsapp.com/x", "https://wa.me.evil.com/233559919037",
  "https://wa.me@evil.com/233559919037", "javascript:alert(1)", "http://wa.me/233559919037", "12345", 7])
  expect(parseApprovalContact(v).ok).toBe(false)

expect(resolveContact(null, "0559919037")).toBe("233559919037")
expect(resolveContact(null, null)).toBeNull()

const url = new URL(buildApprovalLink("233559919037", { code: "API-7K3Q9M", email: "a+b&c#d@x.com" }))
expect(url.origin + url.pathname).toBe("https://wa.me/233559919037")
expect(url.searchParams.get("text"))
  .toBe("Hello, I've requested Datagod API approval. Code: API-7K3Q9M. Account: a+b&c#d@x.com.")

expect(newRequestCode()).toMatch(/^API-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/)
```

- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement.** Ghana numbers through `ghanaSignificant`; other international numbers are 8-15 digits entered with `+` or in a link. Default random source: `node:crypto` randomInt. `approval-contact.ts` must stay browser-safe.
- [ ] **Step 4: Run.** Expected: PASS. **Commit** `feat(api-v2): approval contact and request codes`.

### Task 3: Eligibility and allowed roles

**Files:**
- Create: `lib/api-v2/eligibility.ts`
- Modify: `lib/api-v2/{access,key-issue,handler,store,lifecycle}.ts`, `app/api/admin/api-v2/config/route.ts`, `components/admin/api-keys/FeatureControls.tsx`
- Test: the matching test files

**Interfaces, produced:**

```ts
export function isEligible(i: { hasGrant: boolean; role: string; allowedRoles: string[] }): boolean
export function canRequestKey(i: { hasGrant: boolean; role: string; allowedRoles: string[]; hasApiCapability: boolean }): boolean
// store.ts
export async function hasGrant(client: SupabaseLike, userId: string): Promise<boolean | "error">
// getConfig also returns approval_whatsapp: string | null
// AccessInput, canIssue and accessSummary inputs gain `hasGrant: boolean`; the last two also `hasApiCapability: boolean`
// parseConfigUpdate(input, activeRoles: readonly string[]) also accepts approval_whatsapp
// GET config adds { approval_whatsapp, roles: { slug, name }[] }
```

- [ ] **Step 1: Failing tests.**

```
isEligible: grant + "user" + ["dealer"] -> true; no grant -> false
canRequestKey: allowed role without capability -> false; grant without capability -> true
decideAccess: grant never beats disabled 503, suspended, pending, revoked, wrong key type
canIssue: grant + sms + hasSmsAccess false -> 403
runV2: allowed role -> hasGrant never called
runV2: disallowed + grant -> 200 and ctx.role === "user"
runV2: disallowed + "error" -> 503, handler never called
data pricing: granted "user" calls basePrices with "user"
parseConfigUpdate: active custom "reseller" accepted; unknown refused
config PUT: roles read error -> 503, no update
```

- [ ] **Step 2: Run the five test files.** Expected: FAIL.
- [ ] **Step 3: Implement** per §9. Remove `V2_ROLES`; active roles come from `roles` where `archived_at` is null. Denial order unchanged.
- [ ] **Step 4: Run `npx vitest run lib/api-v2`.** Expected: PASS. **Commit** `feat(api-v2): API-only grants and custom allowed roles`.

### Task 4: Request-log fix

**Files:** Create `lib/api-v2/log-reason.ts`. Modify `lib/api-v2/{handler,store}.ts`. Test: beside each.

**Interfaces, produced:**

```ts
export function logReason(status: number, message?: string): string | null
// V2Deps gains schedule(work: () => Promise<void>): void; logRequest input gains errorReason: string | null
```

- [ ] **Step 1: Failing tests.**

```ts
expect(logReason(200)).toBeNull()
expect(logReason(403, MSG_PENDING)).toBe("key_pending")
expect(logReason(403, MSG_REVOKED)).toBe("key_revoked")
expect(logReason(403, MSG_SUSPENDED)).toBe("account_suspended")
expect(logReason(403, MSG_ROLE_NOT_ALLOWED)).toBe("not_eligible")
expect(logReason(503, MSG_UNAVAILABLE)).toBe("unavailable")
expect(logReason(409, "OUTCOME_UNKNOWN: for 0241234567")).toBe("outcome_unknown")
expect(logReason(400, "SOME_0241234567: x")).toBe("http_400")   // not on the fixed list
expect(logReason(400, "bad phone 0241234567")).toBe("http_400")
```

  Plus: `runV2` schedules exactly one callback; a throwing schedule does not change the response.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Build the fixed code list by grepping `lib/api-v2` for the codes it emits. `withV2` passes `after` from `next/server`, imported statically.
- [ ] **Step 4: Run.** Expected: PASS. **Commit** `fix(api-v2): reliable request logs with safe reasons`.

### Task 5: Notifications

**Files:** Create `lib/admin-actions/flows/api-access.ts`. Modify `lib/admin-actions/{types,contexts,registry,notifier}.ts`. Test: `flows/api-access.test.ts`, existing `notifier.test.ts`.

**Interfaces, produced:**

```ts
export interface ApiAccessCtx {
  kind: "key" | "swap" | "access"
  code?: string; keyType?: "standard" | "commission" | "sms"; who?: string; reason?: string
}
// FlowId adds "api_access"; Outcome adds "requested" | "removed"; UserMessage.sms becomes optional
```

- [ ] **Step 1: Failing tests.**

```
adminAlert: subject has the code; url "/admin/api-keys?tab=approvals"; who "<img src=x>" is escaped
requested: email + inApp, no sms, no push; text contains "If this wasn't you, change your password and contact support."
approved, rejected: email + sms + push + inApp; sms contains no "dg2_"; rejection reason escaped in html
approved swap: text says the old key has stopped working
removed: email + inApp only
every other flow returns null for "requested" and "removed"
notifier: a message without sms never calls sendSMS
```

- [ ] **Step 2: Run `npx vitest run lib/admin-actions`.** Expected: FAIL.
- [ ] **Step 3: Implement** per §11.
- [ ] **Step 4: Run.** Expected: PASS. **Commit** `feat(admin-actions): API access notifications`.

### Task 6: Developer routes

**Files:**
- Create: `lib/api-v2/access-requests.ts`, `app/api/user/v2-api-access/route.ts`
- Modify: `lib/api-v2/store.ts` (createKey), `app/api/user/v2-keys/route.ts`, `lib/roles/capability-routes.ts`
- Test: `lib/api-v2/{access-requests,store}.test.ts`, a `route.test.ts` beside both routes

**Interfaces, consumed:** Tasks 2, 3, 5. **Produced:**

```ts
export async function createAccessRequest(client, userId: string, now: Date):
  Promise<{ ok: true; id: string; code: string; alert: boolean } | { ok: false; status: 409 | 429 | 500 }>
export async function cancelAccessRequest(client, userId: string): Promise<"cancelled" | "none" | "error">
export async function shouldAlertForKey(client, p: { userId; type; env; keyId; now }): Promise<boolean>
// createKey row adds request_code
// GET /api/user/v2-keys:
{ keys, access, smsAvailable,
  approval: { contact: string | null; email: string | null },
  rejections: { key_type: KeyType; reason: string; at: string }[],
  accessRequest: { code: string; status: "pending" | "rejected"; reason: string | null; retryAt: string | null } | null }
```

- [ ] **Step 1: Failing tests.**

```
createKey live: revokes pending only; test: revokes pending + active
createKey: request_code only for live; code collision retries (max 3); slot collision -> 409, active untouched
v2-keys POST: no grant + no capability -> 403; grant + no capability -> 201
v2-keys POST: capability or grant read error -> 503
v2-keys POST: notifier rejects -> still 201, one insert
v2-keys POST: second request in the slot within 24 h -> no admin alert and no owner notice
v2-keys GET: contact read throws -> 200, contact null; role now allowed + open request -> canGenerate true
v2-api-access: no session -> 401; body user_id ignored; disabled 503; suspended 403; already eligible 409
v2-api-access: open request -> 409; rejected 23 h ago -> 429; 25 h ago -> 201
v2-api-access: request, cancel, request inside 24 h -> 201, alert false
v2-api-access DELETE: only the caller's pending row
guard: lib/roles/capability-routes.guard.test.ts passes
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** per §10. Limits: access requests 5/hour per user, 10/hour per IP. Await the notifier after the insert, inside try/catch. Add `user/v2-api-access` to `UNGATED_SESSION_ROUTES`: "asking for API access is the point; grants are admin-decided".
- [ ] **Step 4: Run.** Expected: PASS. **Commit** `feat(api-v2): request approval and API access`.

### Task 7: Admin routes

**Files:**
- Create: `lib/api-v2/{approvals,admin-audit}.ts`, `app/api/admin/api-v2/approvals/route.ts`, `.../approvals/[id]/route.ts`, `.../approvals/history/route.ts`, `.../grants/route.ts`, `.../grants/[userId]/route.ts`
- Modify: `app/api/admin/api-v2/{config,keys/[id]}/route.ts`, `app/api/admin/api-keys/global-kill/route.ts`, `lib/api-v2/admin-actions.ts`
- Test: beside each lib and route

**Interfaces, consumed:** Task 1 functions, Task 5 flow. **Produced:**

```ts
export type DecisionCode = "not_found" | "stale" | "suspended" | "not_eligible" | "bad_reason" | "error"
export const DECISION_STATUS = { not_found: 404, stale: 409, suspended: 409, not_eligible: 409, bad_reason: 400, error: 500 }
export interface ApprovalItem {
  id: string; kind: "key" | "swap" | "access"; code: string; keyType: KeyType | null; createdAt: string
  owner: { id; name; email; phone; role; accountCreatedAt; phoneVerified; samePhoneAccounts; suspended; eligible }
  context: { balance: number; topups30d: number; orders30d: number } | null
}
export async function auditApi(client, r: { adminId; action; targetUserId?; before?; after? }): Promise<boolean>
// GET  approvals?q=&page=          -> { items: ApprovalItem[], total }
// POST approvals/[id]              { kind, action: "approve" | "reject", reason? }
// GET  approvals/history?page=     -> admin_audit_log rows with action like 'api\_%'
// GET  grants?page=  |  DELETE grants/[userId] { reason }
```

- [ ] **Step 1: Failing tests.**

```
every method of every route: non-admin -> auth response, client never queried
q "api-7k3q9m" finds the code; q with ",().%" cannot alter the filter; q matches name, email, phone
context RPC failure -> items with context null
each DecisionCode maps to its status
notifier not called on failure; called once on success; notifier throws -> still 200
PATCH keys/[id] approve calls api_v2_approve_key and never updates status directly
PATCH keys/[id] reject calls api_v2_reject_key, notifies once, and maps bad_reason to 400
revoke, set/reset limits, config save, global kill each write one api_* audit row with the verified admin id
audit failure -> action still succeeds and the response has auditFailed: true
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Page size 25. Balance, phone and account age come from `admin_user_signals`; chunk ids at 200.
- [ ] **Step 4: Run.** Expected: PASS. **Commit** `feat(api-v2): approval inbox routes and audit trail`.

### Task 8: Developer UI and docs

**Files:**
- Create: `components/developer/approval/{MessageAdminButton,WaitingForApproval,RejectedNotice,AccessRequestPanel}.tsx`
- Modify: `components/developer/{GenerateKeyDialog,V2KeyBlock,V2KeysCard,V2KeysPanel}.tsx`, `lib/api-v2/key-slots.ts`, `lib/api-v2/docs/registry.ts`, the sidebar rights input
- Test: `lib/api-v2/key-slots.test.ts`, registry and Postman drift tests

**Interfaces, produced:**

```ts
slotFor(keys, type, env): { state: SlotState; key: V2KeySummary | null; replacement: V2KeySummary | null }
```

- [ ] **Step 1: Failing tests.**

```
active + newer pending -> state active, key = active, replacement = pending
pending only -> state pending, replacement null
registry: mentions request code, "Message admin", and that the old live key works until approval
a user with a grant and without account.api sees the Developer nav item
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement screens A-D of §5 with its exact copy.** The button is an `<a target="_blank" rel="noopener noreferrer">`, rendered only with a contact; otherwise "Contact support". `role_not_allowed` shows the access panel. Expose `apiGrant: boolean` from `/api/user/role` for the nav; a read error there means false.
- [ ] **Step 4: Run, then screenshot A-D** at 500 px and 1280 px, light and dark. Expected: PASS, no overflow.
- [ ] **Step 5: Commit** `feat(developer): message admin for API approval`.

### Task 9: Admin UI

**Files:**
- Create: `components/admin/api-keys/approvals/{ApprovalsPanel,ApprovalCard,ContactSetting,GrantsList,HistoryList}.tsx`
- Modify: `components/admin/api-keys/{ConsoleView,use-console-data,KeyRow}.tsx`, `lib/api-v2/admin-view.ts`
- Test: `lib/api-v2/admin-view-ui.test.ts`

**Interfaces, produced:**

```ts
export function initialConsoleTab(p: { requested: string | null; waiting: number }): "approvals" | "keys" | "logs"
```

- [ ] **Step 1: Failing tests.**

```
waiting 2 -> approvals; waiting 0 -> keys; requested "logs" wins; unknown value ignored
reject disabled until the trimmed reason is 3-200 chars
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement screen E of §5.** Fixed text: "Match the code AND check the WhatsApp sender is the registered phone." Preview uses code `API-TEST22`. A 409 refreshes the list. Count includes access requests.
- [ ] **Step 4: Run, then screenshot** as in Task 8. **Commit** `feat(admin): API approvals inbox`.

### Task 10: Verify, review, roll out

- [ ] **Step 1:** Merge current origin/main into the branch; re-check the migration number.
- [ ] **Step 2:** `npx vitest run` (only known failures) and `npx next build` with placeholder env (exit 0).
- [ ] **Step 3:** Fresh security + database review of the whole branch, with an abuse-case pass over §13. Fix each finding with a failing test first.
- [ ] **Step 4:** Production pre-checks, then the code-built dry run. Expected error text starts `SELFTEST_OK 0194`. Show the owner.
- [ ] **Step 5: OWNER OK**, then apply, then run the privilege and index checks.
- [ ] **Step 6: OWNER OK**, then push to main. Confirm the Vercel deployment is READY and is the one serving.
- [ ] **Step 7:** Live probes (admin routes 401 without login; v2 envelope unchanged), then the supervised check in §16.4.
- [ ] **Step 8:** Update memory; give the owner the channel announcement with how-to steps (Post now / Hold).
