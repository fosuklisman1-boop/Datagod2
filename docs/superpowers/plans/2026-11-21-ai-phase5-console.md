# AI Assistant Console (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One admin console for the AI assistant (name, tone, engine with priced model cards, audience switches, max steps, knowledge, redacted conversations, flags), plus an eval harness and review routine.

**Architecture:** Settings extend the existing `admin_settings` `ai-config` JSON (no migration); transcripts/flags in two new service-role-only tables (migration 0189); pure helpers in `lib/ai-console/`; UI at `/admin/ai-assistant`.

**Tech Stack:** Next.js 15, Supabase, Tailwind (navy), Vitest 4, PGlite for SQL tests.

**Spec:** `docs/superpowers/specs/2026-11-21-ai-phase5-console-design.md`

## Global Constraints
- Worktree `B:/worktrees/dg-ai-phase5`, branch `feat/ai-phase5-console`; vitest from `B:\worktrees\dg-ai-phase5` (UPPERCASE drive).
- Edit/Write only — never sed. No new dependencies.
- Default settings ⇒ byte-identical prompts: `lib/ai-prompts/golden.test.ts`, `lib/ai-prompts/strict.test.ts` expectations and `lib/ai-tool-registry.snapshot.test.ts` untouched and green.
- No PII in logs; transcripts stored only after redaction; API keys never unmasked to clients.
- Migration follows the 0187/0188 convention (BEGIN…COMMIT file + selftest DO block + run-string builder with tests; PGlite run).
- Baseline: 12 pre-existing failures in 4 files. Never `git add -f` under .superpowers.

## Review Focus
1. Default settings changing any prompt/behaviour.
2. Audience switch bypass (route must enforce, not only the widget).
3. Redaction gaps (phones/emails stored raw), card notes/nonce/tool results stored.
4. Transcript write failure breaking chat; unbounded table growth (retention).
5. Admin-only access on every new route; key masking.

---

### Task 1: Settings schema + server wiring
**Files:** `lib/ai-console/settings.ts` (+test) — zod schema for {assistant_name, tone, audiences, max_tool_steps} inside ai-config with defaults; `lib/ai-console/tone.ts` (fixed preset lines); prompt builders (home/dashboard/admin) accept optional {name, tone} → extra stable line only when non-default; `app/api/ai/chat/route.ts` (audience gate 403 assistant_off; maxIterations from setting); `app/api/ai/assistant-profile/route.ts` (name + audiences from config, 60 s cache); `app/api/admin/ai-config/route.ts` (read/write new fields, validation).
- [ ] Tests first: defaults_identical_prompts, custom_name_stable_line, tone_line_stable, audience_off_403_no_provider, admin_audience_off, max_steps_bounds, profile_returns_audiences, ai_config_put_validates_and_masks.
- [ ] Commit `feat(ai): assistant name, tone, audiences and max steps settings`.

### Task 2: Name everywhere + widgets respect audiences
**Files:** cron prompt + push/email titles (`app/api/cron/run-ai-tasks`, `app/api/user/notify-self`), WhatsApp + shop-bot prompt builders, four widgets (hide when audience off via assistant-profile).
- [ ] Tests: cron/notify titles use configured name (default "DATAGOD AI"), whatsapp prompt name, widget visibility helper.
- [ ] Commit `feat(ai): configured assistant name across surfaces; widgets respect audiences`.

### Task 3: Migration 0189 transcripts + capture + retention
**Files:** `migrations/0189_ai_conversations.sql` + selftest + run builder (+test, PGlite); `lib/ai-console/redact.ts` (+test); `lib/ai-console/transcripts.ts` (append, flag) (+test); chat route hook; `app/api/ai/conversation-events/route.ts` (handoff/error pings from widgets, auth-optional, rate-limited, conversationKey-scoped); retention cron route + registration.
- [ ] Tests first: redaction cases, never stores card notes/nonce, append failure doesn't break chat, flag rules, retention deletes >30 d only, PGlite selftest.
- [ ] Commit `feat(ai): redacted conversation transcripts with flags and retention`.

### Task 4: Console page — Settings + Knowledge tabs
**Files:** `app/admin/ai-assistant/page.tsx` + tab components; `lib/ai-models/catalog.ts` (+test, verified prices with dates/sources); redirects from `/admin/ai-settings`, `/admin/ai-knowledge`; sidebar link (NEW tag).
- [ ] Engine card (name preview, tone cards with examples, provider, model cards, other model, API key), Advanced overrides, Who can use it, Max steps, sticky save. Knowledge tab = existing editor moved. Screenshots.
- [ ] Commit `feat(ai): AI Assistant console settings and knowledge`.

### Task 5: Conversations + Flags tabs
**Files:** admin APIs (list/view/mark-reviewed; admin-gated) + tabs UI.
- [ ] Tests for APIs; screenshots.
- [ ] Commit `feat(ai): conversations and flags review in the console`.

### Task 6: Eval harness + review routine
**Files:** `scripts/ai-eval/{run.ts,scenarios.json,assert.ts}` (+assert tests), `docs/ai-assistant-review-routine.md`.
- [ ] Commit `feat(ai): tool-stubbed eval harness and review routine`.

### Task 7: Verify + ship
- [ ] Full suite baseline only; tsc; placeholder build. Final review (opus) → one fix wave → re-review. Migration dry run → apply → verify. Merge origin/main; push; confirm production alias is ours; smoke; memory.
