# API rebuild, Release 1: approval

Date: 2026-11-22. Base: main `21d1fb33`. Status: approved by owner 2026-11-22.
Roadmap: [2026-11-22-api-rebuild-roadmap.md](2026-11-22-api-rebuild-roadmap.md).
Items marked **(call)** were decided by the designer and can be overruled by the owner.

## 1. Why

People who request an API key should be told to contact the admin and get a button that opens the admin's WhatsApp.
Today there is no button, nobody is alerted about a request or an approval, there is no reject, and regenerating a live
key takes the developer offline until an admin approves the replacement.

## 2. Owner decisions

- Live keys need approval. Test keys stay instant for anyone eligible.
- The admin sets the WhatsApp link.
- People who are not eligible see "Message admin for access". Approval gives API access only: role and prices unchanged.
- On a key swap the old live key works until the new one is approved.
- Approval inbox with reject and reason, alerts both ways, admin audit trail.

## 3. Non-goals

Visual redesign (Releases 2-4), spend cap, pause controls, webhooks, and any change to prices or the money engines.

## 4. Approaches

Release order is in the roadmap (A chosen). Access for non-eligible users:

| Option | Trade-off | Decision |
|---|---|---|
| API-only grant per person | Small new table and one more access check; prices untouched | **Chosen by owner** |
| Upgrade the role | No new code; gives away that role's prices and rights | Not chosen |
| Offer both | Flexible; easy to give dealer prices by accident | Not chosen |

## 5. What people see

### A. Eligible, requests a live key

The key is still shown once. The dialog and the key card both show:

    Waiting for approval                     Request code: API-7K3Q9M
    This key can't make requests until an admin approves it.
    Contact the admin for approval.
    [ Message admin on WhatsApp ]

### B. Not eligible

    API access needs admin approval
    [ Request API access ]

After the click (two steps, because a window opened after an awaited request is blocked as a pop-up):

    Access requested                         Request code: API-M4T8WX
    Contact the admin for approval.
    [ Message admin on WhatsApp ]

Once granted they get the normal key cards. A live key still needs its own approval.

### C. Replacing an active live key

    Live key   dg2_live_ab12...  Active, works until the new key is approved   [ Revoke now ]
    New key    dg2_live_cd34...  Waiting for approval  API-Q2N7RB
               [ Message admin on WhatsApp ]  [ Cancel request ]

The regenerate confirmation no longer warns of downtime. It says that a leaked key should be revoked now.

### D. Rejected

    Request not approved: <reason>
    [ Request again ]  [ Message admin on WhatsApp ]

### E. Admin, new "Approvals" tab (first tab while anything is waiting)

    Search code, name, email, phone
    API-7K3Q9M  New live key | Key swap | API access              12 min ago
    Name, email, REGISTERED phone, role
    Account age, wallet balance, top-ups and orders in the last 30 days
    "Match the code AND check the WhatsApp sender is the registered phone."
    [ Approve ]  [ Reject (reason required) ]

Also: an "Approval contact" setting with a preview button, a "Granted access" list with Remove, and a "History" list.

## 6. WhatsApp link

- Admin may paste a phone number, `https://wa.me/<number>` or `https://api.whatsapp.com/send?phone=<number>`.
  Store digits only in `api_v2_config.approval_whatsapp`. Build the link ourselves.
- Reject other hosts, group links and `wa.me/message/...` links (those cannot carry a pre-filled message) with a
  message that says what to paste instead.
- Empty means fall back to `readSupportWhatsapp()` (`lib/text-to-buy/call/support.ts`). Neither present: no button, show
  "Contact support". A read error must never block key creation.
- The number is returned only by the signed-in `GET /api/user/v2-keys`, not by a public route.
- Pre-filled text, URL-encoded, never containing a key or key prefix:
  "Hello, I've requested Datagod API approval. Code: API-7K3Q9M. Account: <email>."
- Open with `target="_blank" rel="noopener noreferrer"`.

## 7. Data (one additive migration)

The next free number is 0194 as of writing (0193 is taken on an unmerged branch). Re-check at plan time.

- `api_v2_config.approval_whatsapp text null`.
- `api_v2_keys`: `request_code text unique null`, `rejected_at`, `rejected_by`, `reject_reason`.
  Backfill a code for existing pending live keys. A rejected key has `status='revoked'` plus `rejected_at` **(call)**,
  so no existing status reader changes.
- Replace `api_v2_keys_one_live_per_type` with two partial unique indexes on `(user_id, key_type, environment)`:
  one `WHERE status='active'`, one `WHERE status='pending'`.
- `api_v2_access_requests`: id, user_id, request_code unique, status (pending, approved, rejected, cancelled), reason,
  created_at, decided_at, decided_by. One pending row per user.
- `api_v2_access_grants`: user_id primary key, granted_by, granted_at, request_id. Removing deletes the row; the audit
  row keeps the history.
- `api_v2_logs.error_reason text null`.
- Audit: reuse `admin_audit_log` **(call)** with `api_*` actions. No key, hash or phone in old/new values.
- New tables: RLS on, no policies, REVOKE ALL from PUBLIC, anon, authenticated; service role only (0060 grants
  authenticated CRUD by default).

Codes: `API-` + 6 characters from an alphabet without 0, O, 1, I, L, from a cryptographic random source; retry on collision.

## 8. Atomic operations

All are SECURITY DEFINER functions with a fixed search_path, executable by service_role only. Each writes its audit row
in the same transaction and returns a conflict (409) for a stale state.

- **Approve key:** lock the user's keys for that type and environment; require still pending, owner not suspended and
  still eligible; revoke the active key; copy its `rate_limits` to the new key unless that key already has overrides;
  activate the new key. The old key is never revoked unless the new one activates.
- **Reject key:** pending only, reason 3-200 characters. The active key is untouched.
- **Approve access:** pending only, not suspended; insert grant, close request. Creates no key.
- **Reject access:** pending only, reason required.
- **Remove grant:** delete it. Keys are not revoked; they stop on the next request if the role is not allowed, and
  work again if re-granted.

`createKey`: for live, replace only an existing *pending* key. For test, behaviour is unchanged. Revoking the active key
leaves a pending replacement pending. Global kill still revokes both.

Orders, idempotency and lookups are keyed by user, so references and order lookups survive a swap.

A data order on the old key that reaches `place_api_v2_order` just after approval fails with no charge (the function
requires an active key and holds it FOR SHARE). That is safe; the developer retries the same reference on the new key.

## 9. Access rule

One pure rule, used by `accessSummary`, `canIssue`, `decideAccess` and approval:

    eligible = has grant OR (role in allowed_roles)
    to create a key, also: has grant OR the role has the account.api capability

- Order is otherwise unchanged: disabled, suspended, key status, key type, eligibility.
- A grant never overrides disabled or suspended, and never grants SMS access (SMS keys keep `hasSmsAccess`).
- In the request path read the grant only when the role is not allowed, so the common path gains no query.
  A failed grant read is 503, never "not permitted" and never allowed.
- The dashboard page must render case B for a user without `account.api`. Their sidebar item appears once granted;
  before that they arrive from `/developers` **(call)**.
- `ctx.role` is unchanged, so every price is the person's own role or custom price. `place_api_v2_order` checks key,
  user and price but not allowed roles, so it needs no change.
- Allowed roles: validate against active rows in `roles` instead of the fixed `V2_ROLES` list, and render the admin
  choices from the same source, so custom tiers can be selected. A roles read error refuses the save.

## 10. Routes

- `lib/roles/capability-routes.guard.test.ts` requires every session route to be in exactly one map and gated files to
  call `requireCapability` with a literal capability. `user/v2-keys` POST calls `requireCapability` only when there is
  no grant. `user/v2-api-access` goes in `UNGATED_SESSION_ROUTES` with the reason (asking for access is the point).
- `GET /api/user/v2-keys`: add contact number, request codes, latest rejection per slot, access-request state.
- `POST /api/user/v2-api-access`, `DELETE` to cancel: user id from the session only. One open request, 24 h wait after
  a rejection, per-user and per-IP limits.
- `GET /api/admin/api-v2/approvals`, decision routes, grants list/remove, history: `verifyAdminAccess` on every method,
  including GET. Paginated.
- `PATCH /api/admin/api-v2/keys/[id]`: approve goes through the atomic function; add reject.
- `PUT /api/admin/api-v2/config`: accept and audit the contact. Revoke, limits, enable/disable, role changes and global
  kill are audited too.

## 11. Alerts

Add an `api_access` flow to `lib/admin-actions/`. Await it, and only after the state change applied; a send failure
never undoes the change.

- Request, to admins: email + push **(call: no SMS, to avoid cost and spam)**. At most one per user and slot per 24 h.
- Request, to the account owner: email + in-app "A live key / API access was requested. If this wasn't you, change your
  password and contact support." **(call)** This catches a hijacked account asking for a key.
- Approved, rejected: email + SMS + push + in-app to the developer. SMS is clipped and holds no key.
- Grant removed: email + in-app.
- Escape names and reasons in HTML.
- The notifier's `Outcome` type has no "requested" or "removed". Add both. Every existing flow returns null for them,
  with a test proving no other flow starts sending.

## 12. Request-log fix

- Schedule `logRequest` and `touchLastUsed` with `after()` from the Next adapter (`withV2`), keeping `runV2` testable.
- `error_reason` is a slug from a fixed list (leading error code such as OUTCOME_UNKNOWN, or access reasons such as
  key_pending), otherwise `http_<status>`. Never store free text, bodies, phones or keys.
- Logging failure never affects a response.

## 13. Abuse cases

| Attack | Defence |
|---|---|
| Edited WhatsApp text claims another account | Code lookup shows the true account; inbox tells admin to match the registered phone |
| Hijacked account requests a live key | Owner notice, approval, inbox context; old key is not killed by a request |
| Request or alert flooding | One open request, cooldown, rate limits, alert de-duplication |
| Link field used for phishing | Digits stored, link built by us |
| User approves or grants themselves | Service-role-only tables and functions; admin check on every route |
| Grant used to obtain cheaper prices | Role untouched; regression test on prices |
| Two admins act at once | Row locks and 409 |
| Suspended after requesting | Approval refuses; every request re-checks |

## 14. Docs

Update the registry text for live-key approval, the access request and key swaps. Postman and both docs views follow.

## 15. Testing (failing test first)

- Pure: link parser, eligibility matrix, code generator, slots holding active + pending, reason slugs.
- SQL on PGlite with a self-rolling-back selftest: both indexes, swap, limit copy, reject, races, grants, privileges.
- Routes: auth on every method, owner scoping, cooldown, 409, fail-closed reads, notifier failure.
- Regression: a granted `user` pays user prices; test keys stay instant; v2 envelopes unchanged.
- `next build` with placeholder env. Screenshots at 500 px and desktop, light and dark.

## 16. Review and rollout

1. Fresh reviewer (auth + schema, mandatory), findings fixed with failing tests.
2. Production precheck, code-asserted self-rolling-back dry run, owner OK, apply, verify.
3. Deploy code after the migration. Old code is compatible with the new schema: it revokes both keys before insert.
4. Live check: set the number, request from a non-admin account, message, approve, swap, confirm the old key worked
   until approval. Owner does any real-money check.
5. Channel announcement with how-to steps (Post now / Hold).

Rollback: revert the code and keep the schema. Before reverting, list slots holding active + pending keys: the old
approve code would hit the active unique index on those, so reject or approve them first.

## 17. Left to the builder

Component split, exact copy polish, function names, pagination sizes and rate-limit numbers.
