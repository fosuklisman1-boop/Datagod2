# SMS Platform Rebuild — Phase 3 (Customer Pages + Enforcement) Design

Date: 2026-10-11
Status: Approved in brainstorming (user: sequencing, sections 1–3), pending spec review
Builds on: Phase 1 spec (§4 customer reference inventory, §5.3 policy engine) and Phase 2 spec (kill switch, admin console).

## 1. Goal
Replace the 2,035-line customer page `app/dashboard/sms/page.tsx` with the reference's six customer screens, then switch send-policy enforcement on. Two milestones, shipped separately:
- **3a — Customer pages** (enforcement stays record-only; nothing customers can do becomes newly blocked).
- **3b — Held-campaign handling + enforcement flip** (separate, deliberate release).

## 2. Decisions
| # | Decision |
|---|---|
| P3-1 | Pages first, enforcement last (user choice). `sms_policy_enforced` stays false for all of 3a. |
| P3-2 | `/dashboard/sms` becomes Home; Compose, Records, Contacts, Credits, Business & Sender ID are sub-routes under it. Shared layout (title, mode badge, Refresh, back link). |
| P3-3 | Nothing the monolith does is lost: `{shop_*}` tokens, MoMo verification, CSV import, templates, opt-outs, activation + welcome bonus move to their natural page. |
| P3-4 | "Buy any amount" is removed from the UI; Credits lists only the account mode's bundles. The quantity-purchase route stays in the backend (nothing in flight breaks) but is unreachable from the UI. |
| P3-5 | "Send later" (Compose) and the order-confirmation sender-ID toggle (Home) are Phase 4. The toggle renders disabled with a "coming soon" note. |
| P3-6 | Enforcement flip is controller-run (no UI toggle), after the Policy preview looks sane, with a documented rollback (set false; effective within ~60 s). |

## 3. Architecture (3a)
```
app/dashboard/sms/
  layout.tsx            shared header (title, mode badge, Refresh), back link, SMS_DISABLED banner
  page.tsx              Home
  compose/page.tsx  records/page.tsx  records/[id]/page.tsx
  contacts/page.tsx  credits/page.tsx  business/page.tsx
  _lib/                 api.ts (typed fetch), view.ts (+test: formatting, segment/cost math, recipient parsing/dedupe, status→badge, ledger labels)
  _components/          one folder per page; presentational, data in / JSX out
```
- Backend reused: `/api/sms/{account,activate,claim-bonus,bundles,units,logs,logs/[id],contacts,groups,templates,sender-ids,business,context}`. Additions only where a screen lacks data, each a small read: 30-day stats, recent credit activity, records list with status filter + paging, and a shadow-policy "would be blocked" preview for Compose.
- Existing pure logic in the monolith (recipient parsing, token resolution, sender suggestions) is lifted into `_lib/` with tests before the monolith is deleted.
- Design system: `DashboardLayout`, shadcn, navy `--primary`, clay utilities, mobile-first with `lg:` widening from the start; tables become stacked cards on phones.
- The old route's inbound links (`my-shop`, `customers`, `shop-profile`, dashboard home, `dashboard-nav-items`) keep pointing at `/dashboard/sms` (Home) — verified in the plan, not assumed.

## 4. Screens
- **Home:** balance hero (credits; Send SMS; Buy Credits; "Sending as X"); disabled order-confirmation toggle (P3-5); 30-day stats (Campaigns, Recipients, Credits used); tiles → Records / Contacts / Credits / Business & Sender ID; limits line from the mode's caps; Recent Credit Activity + View all. Unactivated accounts see the activation card (fee + welcome bonus) instead of the hero.
- **Compose:** credit pill; "Sending as" dropdown by mode rules (platform default / own KYC-free / pool; business own active IDs / pool); recipients tabs Paste / Groups / Mine / CSV with Ghana-only normalisation, de-duplication and an "n / cap" bar; message box with templates + Save template, `{shop_*}` tokens, GSM-7 vs Unicode segment counter, live phone preview; cost summary (recipients × segments = credits, wallet); Review & Send confirmation. Server rejection text is shown inline verbatim.
- **Records:** status chips All / Queued / Processing / Completed / Partial / Failed / Held; campaign cards; detail with delivery breakdown (delivered/failed/pending, refunds). Held shows "Under review" with no customer action; empty state "Send your first SMS".
- **Contacts:** groups and contacts, create/edit group, CSV import, opt-outs, MoMo-name verification.
- **Credits:** bundle cards for the mode (credits, price, ≈ GH₵/SMS, Buy; best value highlighted); note (paid from main wallet; 1 credit = 1 segment; failed deliveries refunded); Credit History ledger referencing campaigns.
- **Business & Sender ID:** stepper Register → In review → Approved → Sender ID; KYC form (name 2–120, description 10–2000, website, Ghana Card GHA-XXXXXXXXX-X, WhatsApp number, document uploads, Save draft, Submit); Your Sender IDs (request field 0/11 chars, rules, statuses); Platform vs Business comparison.

## 5. Milestone 3b — held campaigns and the flip
- Admin Flagged tab gains **Release** (send the held campaign) and **Reject** (full refund), both `{write:true}`, audited, idempotent, and not blocked by the kill switch for refunds.
- Customer sees status transitions in Records; refund appears in Credit History.
- **Flip procedure** (controller-run, recorded in the runbook): review the Policy preview over ≥ 7 days of real traffic → confirm top block codes are expected → set `sms_policy_enforced = true` → watch Messages/Flagged for an hour → rollback = set false.
- On flip: caps, content blocks, fraud flags, auto-suspend and review holds start applying with "what to change" messages. Admin broadcast and OTP/transactional stay exempt.

## 6. Error handling
Per-page loading/empty/error states; SMS_DISABLED (503/kill switch) shows a calm "SMS is temporarily unavailable" banner and disables Send/Buy; all destructive actions confirm; money numbers always come from the server, never recomputed client-side for charging (the client cost summary is advisory).

## 7. Testing
`_lib/view.ts` helpers unit-tested (segments, cost, parsing, dedupe, labels); new read endpoints tested against a fake DB; held release/reject tested for idempotency and refund correctness; fixture-driven throwaway preview for phone/desktop screenshots (never committed); gates: `tsc`, full vitest (9 known failures only), placeholder-env `next build`, final whole-implementation review per milestone.

## 8. Out of scope
Scheduled sends, billed order confirmations (Phase 4); removing the quantity-purchase backend route; admin changes other than Release/Reject.
