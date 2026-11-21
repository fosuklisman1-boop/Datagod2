# AI Guardrails (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI tool rules structural and test-enforced (typed registry + invariants + context-scoped execution), refuse suspended accounts every request, harden the tool-result fence, and normalise chat history.

**Architecture:** A single `TOOL_REGISTRY` in `lib/ai-tool-registry.ts` declares every tool once with contexts / adminOnly / acts / background; `aiTools()` and `executeToolCall`'s allow-check derive from it. Small pure helpers for suspension, fence and history.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service-role `supabaseAdmin`), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-21-ai-phase2-guardrails-design.md`

## Global Constraints

- Work in `B:/worktrees/dg-ai-phase2` on branch `feat/ai-phase2-guardrails`; run vitest from `B:\worktrees\dg-ai-phase2` (UPPERCASE drive letter).
- Edit/Write only — never sed for code edits.
- Today's per-context tool lists must not change (snapshot test).
- Forbidden tool names (must never exist): `place_wallet_order`, `adjust_wallet_balance`, `manage_withdrawal`, `suspend_user`, `update_user_role`, `bulk_update_order_status`.
- No PII in logs. Baseline: 12 pre-existing test failures in 4 files (order-health-service, admin-users migration, pricing migration, standard-bundles runtime).

## Review Focus

1. A tool silently dropped from or added to a context by the refactor → snapshot test (Task 1/2).
2. WhatsApp / shop-bot / cron callers not passing `context` → every tool refused there → caller tests (Task 2).
3. Suspended user with a still-valid token chats or confirms → Task 3 tests.
4. DB text containing `</data>` breaks the fence → Task 4 test.
5. Normalisation drops the user's real latest message → Task 4 test.

---

### Task 1: Snapshot today's tool lists

**Files:** Create `lib/ai-tool-registry.snapshot.test.ts`.
- [ ] Write a test that records, for each context (`home`, `storefront` with each of the 8 sellsData/sellsAirtime/sellsResultsChecker combinations, `dashboard`, `admin`, `whatsapp`, `whatsapp_shop`) the ordered tool NAMES from today's `aiTools()`, as a literal expected object in the test (generate the literal once by running the current code, paste it in — do not use vitest's auto snapshot files).
- [ ] Also record today's background filters' outputs: `withoutPrepareTools(aiTools('dashboard'))` and `adminBackgroundTools(aiTools('admin'))` names.
- [ ] Run → PASS against current code. Commit `test(ai): pin today's per-context tool lists`.

### Task 2: Registry, invariants, context-scoped execution

**Files:** Create `lib/ai-tool-registry.ts`, `lib/ai-tool-registry.test.ts`; Modify `lib/ai-tools.ts` (aiTools → wrapper; ADMIN_ONLY_TOOLS derived; executeToolCall allow-check; runtime ctx gains `context`), `lib/ai-scheduled/tools.ts` (filters derived), every caller of `executeToolCall` / `runAgenticLoop` to pass `context` (chat route, cron, WhatsApp webhook, lib/whatsapp-bot/shop-ai.ts — grep).

**Interfaces — Produces:** `TOOL_REGISTRY`, `toolsFor(context, flags?)`, `isToolAllowed(name, context)`, types `ToolCtx`, `ActsKind`, `ToolEntry` (spec §5.1).

- [ ] Write failing invariant tests: `names_unique`, `every_tool_has_a_context`, `admin_only_only_in_admin`, `forbidden_names_absent`, `no_money_tool_in_customer_web_contexts` (dashboard/storefront/home), `visible_equals_callable_per_context` (for each context every name from toolsFor is isToolAllowed and vice-versa), `execute_refuses_tool_outside_context` (e.g. `get_all_orders` with context dashboard → tool_not_available, no handler side effect).
- [ ] Implement; Task 1 snapshot test must stay green unchanged.
- [ ] Caller tests: WhatsApp and cron paths still execute their tools (one test each that a known tool for that context is allowed and runs).
- [ ] Full suite: no new failures. Commit `feat(ai): typed tool registry with invariants and context-scoped execution`.

### Task 3: Suspension refused every request

**Files:** Create `lib/auth/suspension.ts` + test; Modify `app/api/ai/chat/route.ts`, `lib/ai-drafts/http.ts` (or the confirm/recheck routes).
- [ ] Failing tests: `is_suspended_true`, `read_error_fails_closed`; chat route `suspended_user_gets_fixed_message_no_model_call`; draft routes `suspended_confirm_403`, `suspended_recheck_403`, `suspended_get_allowed`.
- [ ] Implement per spec §5.3. Commit `feat(ai): refuse suspended accounts on every AI request`.

### Task 4: Fence hardening + history normalisation

**Files:** Modify `lib/ai-agentic-loop.ts`; Create `lib/ai-history.ts` + test; Modify `app/api/ai/chat/route.ts`.
- [ ] Failing tests: `fence_neutralises_closing_tag` (tool result string containing `</data>` and `<DATA x>`), `normalise_drops_leading_assistant`, `normalise_merges_same_role`, `normalise_drops_empty`, `normalise_keeps_latest_user_message`, chat route `history_normalised_before_provider`.
- [ ] Implement per spec §5.4–5.5. Commit `feat(ai): unbreakable data fence; normalised chat history`.

### Task 5: Verify and ship

- [ ] Full suite (baseline only), `npx tsc --noEmit` (no errors in touched files), placeholder-env `npm run build` (exit 0).
- [ ] Final whole-branch review (opus) → one fix wave → scoped re-review.
- [ ] `git fetch`; merge origin/main; re-run tests/build if anything merged; push `HEAD:main`; watch Vercel READY; smoke (draft routes 401 unauthenticated, `/` 200).
- [ ] Update memory (project note + MEMORY.md line).
