# SMS Platform Rebuild — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 2,035-line customer SMS page with six focused pages (milestone 3a), then build real policy enforcement, held-campaign release/reject, and the controlled flip of `sms_policy_enforced` (milestone 3b).

**Architecture:** `/dashboard/sms` becomes Home with five sub-routes sharing a layout. Pure logic lives in `app/dashboard/sms/_lib/view.ts` (unit-tested; vitest only includes `.test.ts`, no DOM env). A few small read endpoints are added where screens lack data. 3b adds enforcement inside `enqueueSend` behind the existing `policyEnforced` setting (default false), so shipping 3b changes nothing until the flag is flipped.

**Tech Stack:** Next.js 15 App Router, React, shadcn/ui, Supabase (service-role routes, Bearer auth via `resolveAccount`), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-sms-platform-rebuild-phase3-design.md`. **Facts report (line maps, route shapes):** the controller's scratchpad `phase3-facts.md`; its content is copied into each task file when dispatching.

**Conventions (same as Phases 1–2):** branch `worktree-customer-ui-rebuild`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; baseline 9 known failures in `lib/order-health-service.test.ts`; live SQL is applied by the controller only (subagents never touch the live DB or log into the app); gates per milestone = `npx tsc --noEmit`, `npm run test:run`, placeholder-env `npx next build`, then push branch, `git fetch origin main`, `git push origin HEAD:main`. Run git/node commands as plain separate commands (the worktree guard refuses compound ones). No Python on this machine; CRLF files need CRLF-aware scripted edits.

**Deviation from Phase 2's plan style (stated honestly):** UI tasks (6–11) give structure, props, behaviour, and the exact monolith line ranges to port, instead of reproducing ~2,000 lines of JSX here. Pure logic, SQL, services, routes and tests are given in full.

## Findings that shaped this plan
1. `enqueueSend` has **no enforcement path**: policy is evaluated only into `policy_shadow`; no code creates a `held` log; no release/reject exists (facts §3.4). 3b therefore builds enforcement, not just a flag flip.
2. `GET /api/sms/account` returns neither `mode` nor `review_hold`, and ignores nothing useful in `transactions` except 20 raw rows. `GET /api/sms/logs` has no paging/filter; `logs/[id]` omits delivery/refund columns.
3. `POST /api/shop/sms/send` returns no `sendLogId`/status/held flag; the UI cannot tell a held send from a queued one.
4. `campaign_send` ledger rows have `ref` and `send_log_id` NULL, so the ledger cannot link a debit to its campaign (Task 2 fixes this going forward).
5. Sidebar active-state is an exact `pathname ===` match, so sub-routes would not highlight SMS (Task 11).
6. `/api/sms/units/purchase` (any amount) stays in the backend; the UI stops calling it (P3-4).

## File structure
```
migrations/20261012_sms_customer_reads.sql          sms_customer_stats RPC; sms_send_logs.campaign link for ledger
lib/sms/customer-reads.ts (+test)                   home summary, records page, ledger page, limits
lib/sms/compose-preview.ts (+test)                  draft policy evaluation (no send, no debit)
app/api/sms/home/route.ts                           mode, limits, 30-day stats, recent ledger, featureEnabled
app/api/sms/logs/route.ts (modify)                  ?status=&page= paging
app/api/sms/logs/[id]/route.ts (modify)             + delivery_status, refunded, counts
app/api/sms/ledger/route.ts                         paged credit history
app/api/sms/compose/preview/route.ts                POST draft → decision/reason/flags
app/dashboard/sms/layout.tsx                        shared header, account context, disabled banner
app/dashboard/sms/page.tsx                          Home            (replaces monolith)
app/dashboard/sms/{compose,records,contacts,credits,business}/page.tsx, records/[id]/page.tsx
app/dashboard/sms/_lib/{api.ts,view.ts,view.test.ts,useSmsAccount.tsx}
app/dashboard/sms/_components/{...per page}
lib/sms/enforcement.ts (+test)                      3b: applyPolicyDecision for enqueueSend
lib/sms/held-service.ts (+test)                     3b: release/reject held campaigns
app/api/admin/sms-platform/flags/held/[id]/route.ts 3b: POST {action:"release"|"reject"}
```

---

# Milestone 3a — Customer pages

### Task 1: Read model — migration, services, routes

**Files:** Create `migrations/20261012_sms_customer_reads.sql`, `lib/sms/customer-reads.ts`, `lib/sms/customer-reads.test.ts`, `app/api/sms/home/route.ts`, `app/api/sms/ledger/route.ts`; Modify `app/api/sms/logs/route.ts`, `app/api/sms/logs/[id]/route.ts`.

- [ ] **Step 1: Migration** (controller applies live after review via `sq.js`):
```sql
BEGIN;
CREATE OR REPLACE FUNCTION sms_customer_stats(p_account_id uuid, p_days int DEFAULT 30)
RETURNS TABLE(campaigns bigint, recipients bigint, credits_used bigint)
LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint,
         COALESCE(sum(recipients_count),0)::bigint,
         COALESCE(sum(credits_used),0)::bigint
    FROM sms_send_logs
   WHERE sms_account_id = p_account_id
     AND created_at >= now() - make_interval(days => GREATEST(p_days,1))
     AND status NOT IN ('blocked','scheduled');
$$;
REVOKE ALL ON FUNCTION sms_customer_stats(uuid,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sms_customer_stats(uuid,int) TO service_role;
COMMIT;
```
- [ ] **Step 2: Write failing tests** in `customer-reads.test.ts` using the fake-client pattern from `lib/sms/admin-lists.test.ts`: (a) `getHomeSummary` returns `{mode, limits:{perSend,perHour,perDay}, stats:{campaigns,recipients,creditsUsed}, recentLedger (5), featureEnabled}` and limits come from `loadSmsSettings().caps[mode]`; (b) `listRecords({status:"held"},page)` filters and returns `{rows,total,page,pageSize:25}` newest first with id tiebreaker; unknown status → treated as no filter; (c) `listLedger(page)` returns delivered rows with a `label` (see Task 2 `ledgerLabel`); (d) all functions throw (fail loud) on DB error — the route maps to 500 `{success:false,error}`.
- [ ] **Step 3:** Run `npx vitest run lib/sms/customer-reads.test.ts` → FAIL (module missing).
- [ ] **Step 4: Implement** `customer-reads.ts`: `getHomeSummary(accountId)`, `listRecords(accountId,{status,page})`, `listLedger(accountId,page)`, `getRecord(accountId,id)` (log + messages incl. `delivery_status`, `refunded`, plus `counts:{delivered,failed,pending,refunded}`). Use `supabaseAdmin` like sibling services, always `.eq("sms_account_id", accountId)`. Page size 25 constant `RECORDS_PAGE_SIZE`.
- [ ] **Step 5: Routes** — `GET /api/sms/home`, `GET /api/sms/ledger?page=`, extend `GET /api/sms/logs?status=&page=` (default behaviour unchanged when params absent: latest 30, same shape) and `logs/[id]` (add columns; existing keys unchanged so the monolith keeps working until Task 11). Use `resolveAccount` (not inline copies). Response envelope `{success:true,data}`. No kill-switch on reads.
- [ ] **Step 6:** `npx vitest run lib/sms/customer-reads.test.ts && npx tsc --noEmit` → PASS. Commit `feat(sms): customer read model (home, records, ledger)`.

### Task 2: Link send debits to campaigns in the ledger (forward-only)

**Files:** Modify `lib/sms/send-service.ts`; new migration `migrations/20261012_sms_ledger_campaign_link.sql`; Test `lib/sms/send-service.test.ts`.

Why: Credit History must show "Campaign #123" next to a debit. `debit_sms_for_send` writes `campaign_send` rows with NULL `ref`/`send_log_id`.
- [ ] **Step 1:** Inspect `debit_sms_for_send` (grep migrations). After the log insert in `enqueueSend`, run `UPDATE sms_unit_transactions SET send_log_id = <logId> WHERE id = <debit tx id>`; if the RPC does not return the tx id, add it to the RPC's return (migration) rather than guessing by timestamp.
- [ ] **Step 2: Failing test:** after a successful `enqueueSend`, the fake DB's debit row has `send_log_id` equal to the inserted log id; if the link update fails the send still succeeds and logs `[SMS-LEDGER]` (never blocks a paid send).
- [ ] **Step 3:** Implement, run tests, `tsc`, commit `feat(sms): link send debits to campaigns`. Older rows stay unlinked; the ledger label falls back to "SMS campaign".

### Task 3: Compose draft preview (shadow decision for a draft)

**Files:** Create `lib/sms/compose-preview.ts` (+test), `app/api/sms/compose/preview/route.ts`.
- [ ] **Step 1: Test:** `previewDraft({accountId, message, senderId, recipientCount, tokens})` returns `{decision, code, reason, flags}` from `evaluateSendPolicy` with the same inputs `shadowPolicy` builds (`loadAccountSnapshot`, `loadUsage`, `loadOwnDomains`, `resolveCampaignSender`, `prepareSmsMessage`); unknown sender → `{decision:"reject", code:"SENDER_NOT_ALLOWED"}`; never throws (returns `{decision:"allow",code:"OK",unavailable:true}` if the evaluator errors — preview is advisory); never writes `policy_shadow` or flags.
- [ ] **Step 2–4:** implement by composing the existing `policy-context` helpers (do not duplicate logic), route `POST /api/sms/compose/preview` body `{message, senderId?, recipientCount}` via `resolveAccount`, 400 on invalid body. Commit `feat(sms): compose draft policy preview`.

### Task 4: `_lib` — typed API, pure helpers, tests (TDD, full code)

**Files:** Create `app/dashboard/sms/_lib/view.ts`, `view.test.ts`, `api.ts`, `useSmsAccount.tsx`.

Lift from the monolith (lines 98–183) with identical behaviour, now exported and tested: `MAX_RECIPIENTS=5000`, `INSERT_CHIPS`, `resolveTokens`, `splitNumbers`, `parseRows`, `contactName`, `senderSuggestions`. Add:
```ts
export type Tone = "success" | "warning" | "danger" | "muted" | "info"
const LOG_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" }, sending: { label: "Processing", tone: "info" },
  sent: { label: "Completed", tone: "success" }, partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "danger" }, blocked: { label: "Blocked", tone: "danger" },
  held: { label: "Under review", tone: "warning" }, scheduled: { label: "Scheduled", tone: "muted" },
}
export function logStatus(s: string) { return LOG_STATUS[s] ?? { label: s, tone: "muted" as Tone } }
export const isInFlight = (s: string) => s === "queued" || s === "sending"

export function addNumbers(existing: string[], raw: string, cap = MAX_RECIPIENTS): { list: string[]; added: number; capped: boolean } {
  const seen = new Set(existing); const list = [...existing]; let added = 0; let capped = false
  for (const n of splitNumbers(raw)) {
    if (seen.has(n)) continue
    if (list.length >= cap) { capped = true; break }
    seen.add(n); list.push(n); added++
  }
  return { list, added, capped }
}
export function costSummary(recipients: number, segmentsPerRecipient: number, balance: number) {
  const total = recipients * segmentsPerRecipient
  return { total, short: Math.max(0, total - balance), overBudget: total > balance }
}
export const perSms = (priceGhs: number, units: number) => (units > 0 ? priceGhs / units : 0)
export function bestValueId(bundles: { id: string; price_ghs: number; units: number }[]) {
  let best: string | null = null; let low = Infinity
  for (const b of bundles) { const p = perSms(b.price_ghs, b.units); if (p > 0 && p < low) { low = p; best = b.id } }
  return bundles.length > 1 ? best : null
}
export function ledgerLabel(reason: string, sendLogId: number | null): string {
  switch (reason) {
    case "bundle_wallet": case "bundle_paystack": return "Credits purchased"
    case "welcome_bonus": return "Welcome bonus"
    case "admin_alloc": return "Credits added by support"
    case "campaign_send": return sendLogId ? `SMS campaign #${sendLogId}` : "SMS campaign"
    case "campaign_refund": return sendLogId ? `Refund — campaign #${sendLogId}` : "Refund — failed delivery"
    default: return "Credit adjustment"
  }
}
export function sendErrorMessage(code: string | undefined, reason?: string, fallback?: string): string {
  switch (code) {
    case "INSUFFICIENT_CREDITS": return "Not enough SMS credits — buy more and try again."
    case "SMS_DISABLED": return "SMS is temporarily unavailable. Please try again later."
    case "BLOCKED": return reason ? `Message blocked: ${reason}` : "This message was blocked by our content rules."
    case "NOT_ACTIVATED": return "Activate SMS before sending."
    case "SUSPENDED": return "Your SMS account is suspended. Contact support."
    case "NO_VALID_RECIPIENTS": return "No valid Ghana numbers to send to."
    case "INVALID_SENDER_ID": return "That sender ID isn't available on your account."
    case "TOO_MANY_RECIPIENTS": return `You can send to at most ${MAX_RECIPIENTS.toLocaleString("en-US")} recipients at once.`
    case "SEND_ERROR": return "Sending failed — please try again."
    default: return fallback ?? code ?? "Something went wrong"
  }
}
export const limitsLine = (l: { perSend: number; perHour: number; perDay: number }) =>
  `${l.perSend.toLocaleString("en-US")} recipients/send · ${l.perHour.toLocaleString("en-US")} sends/hour · ${l.perDay.toLocaleString("en-US")} recipients/day`
export const MOMO_PHONE = /^0?\d{9}$/
```
- [ ] **Step 1: Failing tests** in `view.test.ts` (vitest): `addNumbers` dedupes, respects cap and reports `capped`; `costSummary(3,2,5)` → `{total:6,short:1,overBudget:true}`; `bestValueId` picks lowest per-SMS and is `null` for a single bundle; `ledgerLabel("campaign_send",12)` → `"SMS campaign #12"`; `sendErrorMessage("BLOCKED","phishing link")`; `logStatus("held").label === "Under review"`; `limitsLine` formatting; ported-helper cases: `resolveTokens` keeps literal token when value empty and returns msg for null tokens, `parseRows` skips a header row, `splitNumbers("a, b\nc")`, `senderSuggestions("Kofi's Data Hub")` first entry is `KOFISDATAHUB`-style compact upper ≤ 11 chars.
- [ ] **Step 2:** `npx vitest run app/dashboard/sms` → FAIL. **Step 3:** implement `view.ts` (port helper bodies verbatim from the monolith line ranges). **Step 4:** PASS.
- [ ] **Step 5:** `api.ts`: `token()` via `supabase.auth.getSession`, `smsFetch<T>(path, init)` adding Bearer and returning `{ok,status,data|error,code}`; `useSmsAccount.tsx`: React context provider loading `/api/sms/account` + `/api/sms/home` (+ wallet balances like monolith `loadWallets` 324–343), exposing `{account, mode, limits, stats, recentLedger, featureEnabled, walletBalance, profitBalance, reload, loading, error, notEntitled}`; 403 ⇒ `notEntitled` (same semantics as monolith line 282–304).
- [ ] **Step 6:** `tsc`, commit `feat(sms): customer _lib (view helpers, api, account context)`.

### Task 5: Shared layout

**Files:** Create `app/dashboard/sms/layout.tsx`, `_components/SmsShell.tsx`, `_components/ActivationCard.tsx`, `_components/MomoDialog.tsx`.
- Layout wraps children in `DashboardLayout` + `SmsAccountProvider`; shell renders header (title "SMS", mode badge, Refresh → `reload`), back link to Home on sub-pages, suspended alert (monolith 1038–1043), "SMS temporarily unavailable" banner when `featureEnabled === false`, the loading skeleton and "not available" card (monolith 991–1024) when `notEntitled`.
- `ActivationCard` ports 1185–1226 + welcome-bonus banner 1170–1183 (activate wallet/paystack, claim bonus; error mapping from monolith 451–478). `MomoDialog` ports 1863–1987 and handlers 531–647 (activation only; `openMomo("credits")` was dead code — drop it).
- Container `p-4 md:p-6 space-y-6 max-w-4xl lg:max-w-5xl`; navy tokens, clay utilities; no hard-coded `#1b388b` (use `bg-primary`).
- [ ] Verify with `tsc`; commit `feat(sms): customer shell, activation card, MoMo dialog`.

### Task 6: Home (`/dashboard/sms`)
Hero: SMS credits + pending, `Send SMS` → `/dashboard/sms/compose`, `Buy Credits` → `credits`, "Sending as X" (default sender else platform name); wallet cards (profit/main) from monolith 1049–1071; disabled order-confirmation toggle with "Coming soon" note; 30-day stats; tiles Records / Contacts / Credits / Business & Sender ID; `limitsLine`; Recent Credit Activity (5, `ledgerLabel`, +/- delta, time) with View all → `credits`. Unactivated accounts show `ActivationCard` instead of hero. Commit.

### Task 7: Compose
Port monolith 1255–1470 + templates 1474–1502 + handlers 649–770: From select (active senders; label platform default / pool / own), group select, recipients tabs Paste / Groups / Mine (`/api/sms/context` customers) / CSV, chips, message + `INSERT_CHIPS` + Textarea(1000), `calculateSegments` meter, live phone preview, cost summary (`costSummary`; advisory), Save template + Templates drawer (load into message), group-send confirm AlertDialog (`/groups/{id}/preview`). **New:** debounced (600 ms) `POST /api/sms/compose/preview`; show reason inline as a non-blocking amber note ("When rules are enforced this message would be blocked: …") only while `decision` is not `allow`; once Task 13's enforcement is live the same endpoint's text is the real rejection reason. After send, navigate to `records` (toast `sendErrorMessage` on failure). Remove `scam-rules` card in favour of the preview note + link to Business & Sender ID. Commit.

### Task 8: Records and detail
List: status chips All / Queued / Processing / Completed / Partial / Failed / Held (`logStatus`), cards (message, recipients, credits, status badge, time), paging 25, in-flight poll every 7 s (monolith 408–448), empty state "Send your first SMS". Detail page `records/[id]`: counts (delivered/failed/pending/refunded), per-recipient table, 5 s poll while in flight (monolith 1795–1860); `held` shows "Under review — you'll be notified" and no actions. Commit.

### Task 9: Contacts
Port monolith 1505–1693, handlers 788–964, dialogs 1990–2031 unchanged in behaviour (groups, single add, CSV, bulk paste, opt-out toggle, delete, verify poll ≤ 30 iterations with 8 s/1.5 s backoff, `verifyGroupRef` guard). Split into `GroupsList`, `AddContacts`, `ContactsTable`. Commit.

### Task 10: Credits
Bundle cards from `GET /api/sms/bundles` (already filtered by account mode): credits, price, ≈ GH₵/SMS via `perSms`, best-value highlight via `bestValueId`, affordability pill and Buy (wallet if `walletBalance >= price` else Paystack redirect) — port 1696–1743 and `buyBundle` 505–530 (`/units/purchase-wallet`, `/units/purchase-paystack`; **never** `/units/purchase`). Note text per spec. Credit History: paged `GET /api/sms/ledger` with `ledgerLabel`, running `balance_after`. Commit.

### Task 11: Business & Sender ID
Stepper (Register → In review → Approved → Sender ID) driven by `GET /api/sms/business` (`profile.status`, `mode`). KYC form: name 2–120, description 10–2000, website, Ghana Card `GHA-XXXXXXXXX-X` (validate client-side; server stores last 4 only), WhatsApp number, document uploads (`POST /api/sms/business/documents` multipart `kind`, `file`), Save draft (`PUT /api/sms/business`), Submit (`POST …/submit`); show server `fields` errors; rejected → show `rejection_reason` + edit. Sender IDs list/request (port monolith 1076–1168 and `requestSenderId` 772; maxLength 11 uppercase, `senderSuggestions`, statuses incl. paused/revoked). Platform vs Business comparison card. Commit.

### Task 12: Navigation, monolith removal, whole-3a gates
- [ ] Sidebar active state: change `components/layout/sidebar.tsx` lines ~334 and ~387 from `pathname === item.href` to `pathname === item.href || (item.href === "/dashboard/sms" && pathname.startsWith("/dashboard/sms/"))`; add a case to `lib/dashboard-nav-items.test.ts` only if it tests matching (otherwise unit-test a small exported `isNavActive(pathname, href)` helper and use it in both places).
- [ ] Confirm `lib/custom-domains.ts` prefix `"/dashboard/sms"` already covers sub-routes (facts §4); add one test line in `lib/custom-domains.test.ts` for `/dashboard/sms/compose`.
- [ ] Delete the monolith content (page.tsx is replaced by Home in Task 6; ensure no import remains). `git grep -n "SmsDashboardPage"` returns nothing.
- [ ] Gates: `npx tsc --noEmit`; `npm run test:run` (9 known failures only); placeholder-env `npx next build` exit 0.
- [ ] Visual check: throwaway fixture preview under `app/preview-sms-customer/` (patch `window.fetch` like the Phase 2 preview), production build + `next start -p 4300`, `shoot2.ps1` at 500 px and 1400 px for all six pages + held/disabled variants; fix defects; **delete the preview dir**; confirm `git status` clean.
- [ ] Final whole-3a review (feature-dev:code-reviewer, opus): feature parity vs. the monolith checklist (every handler in facts §1.5 has a home), no use of `/units/purchase`, no server imports in client code, no PII leaks, kill-switch UX. Fix findings; ship (`git push` branch, fetch main, `git push origin HEAD:main`). Update runbook + memory. Enforcement still OFF.

---

# Milestone 3b — Enforcement, held campaigns, flip

### Task 13: Enforcement in `enqueueSend`

**Files:** Create `lib/sms/enforcement.ts` (+test); Modify `lib/sms/send-service.ts`, `app/api/shop/sms/send/route.ts`.

Behaviour when `settings.policyEnforced === true` (otherwise exactly today's behaviour, byte-for-byte):
- `evaluateSendPolicy` runs **before** `debit_sms_for_send`. Decision map: `allow` → proceed; `reject`/`unavailable` → no debit, no log, return `{ok:false, error:"POLICY_REJECTED", code, reason}` (HTTP 400, 503 for `FEATURE_DISABLED`); `block` → write a `blocked` log (credits 0, `flagged`, `policy_shadow` with `enforced:true`), record fraud flags, return `BLOCKED` with `reason`; `hold` → debit, insert log with `status='held'`, insert messages **un-dispatched** (status `pending`, not claimed), skip `dispatchCampaign`, return success with `held:true, sendLogId`.
- Fraud flags: call the Phase 1 atomic flag-recording DB function (locate in `moderation-service.ts` / `20261010_*` migration — **do not re-implement counting**); it increments `fraud_flag_count`, auto-suspends at `autoSuspendFlags`, sets `review_hold` at `flagReviewThreshold`.
- `POST /api/shop/sms/send` response gains `data.held`, `data.sendLogId`; error mapping adds `POLICY_REJECTED` (400 with `reason`).
- `enqueueSendBatched`: a held/blocked/rejected first chunk stops the run and returns that outcome; no later chunks.
- [ ] **TDD:** tests for each decision (allow unchanged; reject → zero DB writes; block → blocked log + flag recorded, no debit; hold → debit + held log + messages undispatched + no provider call; flag at threshold suspends; enforced=false → no behaviour change incl. identical fake-DB write sequence to today). Use the `send-service.test.ts` fake DB.
- [ ] Customer UI: Compose maps `POLICY_REJECTED` reason into the error toast; Records shows held with "Under review". Commit `feat(sms): enforce send policy behind sms_policy_enforced (off)`.

### Task 14: Held campaigns — release / reject

**Files:** Create `lib/sms/held-service.ts` (+test), `app/api/admin/sms-platform/flags/held/[id]/route.ts`; Modify `app/admin/sms/_components/FlaggedTab.tsx`, `lib/sms/admin-lists.ts` (flags list includes held campaigns with a stable id like `held:<logId>`), `app/admin/sms/_lib/api.ts`.
- `releaseHeldCampaign(adminId, logId)`: only if status `held`; atomically `held → queued` (conditional update; second call is a no-op returning `{ok:true, already:true}`), claim + `dispatchCampaign`, recompute result, clear nothing else; audit `sms_held_release`. Not blocked by kill switch? **Release is a send → respects `isSmsEnabled()`** (returns an error telling the admin to enable SMS first); reject is never blocked.
- `rejectHeldCampaign(adminId, logId, reason)`: reason required (≥ 3 chars); conditional `held → failed`; refund every undelivered message via `refund_sms_message` (idempotent per message) or `adjust_sms_units` with ref `held_reject:<logId>` for the full `credits_reserved`; notify the customer in-app/SMS-free (existing notification helper); audit `sms_held_reject`.
- Route `POST {action,reason?}` with `adminGuard({write:true})`; FlaggedTab gets Release/Reject buttons with confirm dialogs (reject reason input). TDD for idempotency (double release/reject), wrong-status refusal, refund sum, kill-switch behaviour. Commit.

### Task 15: Flip runbook, review, ship dark
- [ ] Append "Phase 3 — enforcement flip" to the rollout runbook: pre-checks (Policy preview over ≥ 7 days: top block codes sane, `would be held` count small), the flip SQL (`UPDATE tenant_global_settings SET value='true' WHERE key='sms_policy_enforced'` — verify exact key/column name from `platform-settings.ts` before writing), watch list (Messages/Flagged for 1 hour), **rollback** (`value='false'`; effective ≤ 60 s), and communications note for customers.
- [ ] Gates (`tsc`, tests, build), final whole-3b review (focus: enforced=false byte-identical behaviour; refund correctness; no double-debit on hold→release; hold path never calls the provider; flag counting not duplicated), fix findings, ship to main with `policyEnforced` still false. The flip itself is a controller-run step after the user's explicit go-ahead.

---

## Self-review (spec coverage)
- §3 architecture → Tasks 1–5, 12. §4 Home/Compose/Records/Contacts/Credits/Business → Tasks 6–11. P3-4 (no buy-any-amount in UI) → Task 10 + Task 12 review. P3-5 (Phase 4 hooks disabled) → Task 6. §5 held release/reject + flip procedure → Tasks 13–15 (enforcement build added after discovering it was missing). §6 SMS_DISABLED UX → Task 5. §7 testing → each task; visual → Task 12.
- Type consistency: `RECORDS_PAGE_SIZE` (Task 1) is the page size used by Task 8; `logStatus`/`ledgerLabel`/`sendErrorMessage` defined in Task 4 are the only label sources used in Tasks 6–11; `held` outcome fields `held`,`sendLogId` introduced in Task 13 are consumed in Tasks 7–8.
- Known open items to resolve in-task, not guessed: exact key/column names of the settings table and the flag-recording function (Tasks 13, 15); whether `debit_sms_for_send` returns the tx id (Task 2).
