# AI Prompt Caching + Knowledge Injection (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split web AI system prompts into a cacheable stable prefix + small volatile tail, cache the prefix on Anthropic, and inject the whole knowledge base when it fits a budget.

**Architecture:** `lib/ai-prompts/` builders return `{stable, volatile}`; `AIProvider.createMessage` accepts that shape (Anthropic: two system blocks with `cache_control` on the first); `lib/ai-prompts/knowledge.ts` renders `ai_knowledge` all-or-nothing under 12,000 chars with a 60 s cache.

**Tech Stack:** Next.js 15, TypeScript, `@anthropic-ai/sdk`, Supabase, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-21-ai-phase3-caching-design.md`

## Global Constraints
- Worktree `B:/worktrees/dg-ai-phase3`, branch `feat/ai-phase3-caching`; vitest from `B:\worktrees\dg-ai-phase3` (UPPERCASE drive).
- Edit/Write only — never sed.
- `lib/ai-tool-registry.snapshot.test.ts` must stay untouched and green.
- No per-request value in `stable`. No PII / prompt text in logs.
- Baseline: 12 pre-existing failures in 4 files.

## Review Focus
1. A per-request value leaking into `stable` (silent cache invalidator) → stable-identical tests.
2. A prompt rule lost in the move → golden line-containment tests.
3. OpenAI/Gemini path broken by the new system shape → provider tests.
4. Partial knowledge injected over budget → all-or-nothing test.
5. Card-results nonce rule moved into `stable` → assert it is in `volatile`.

---

### Task 1: Golden capture + builders + provider shape
**Files:** Create `lib/ai-prompts/{home,storefront,dashboard,admin,index}.ts`, `lib/ai-prompts/golden.test.ts`, `lib/ai-prompts/builders.test.ts`; Modify `app/api/ai/chat/route.ts`, `lib/ai-providers.ts`, `lib/ai-agentic-loop.ts`.
- [ ] FIRST commit `lib/ai-prompts/golden.test.ts` holding today's rendered system prompt text for each context with fixed inputs (pasted literals). Commit `test(ai): pin today's web system prompts`.
- [ ] Failing tests: `stable_identical_across_users_and_dates` (each context), `volatile_contains_name_and_date`, `nonce_rule_in_volatile`, `golden_lines_preserved`, provider `anthropic_two_system_blocks_cache_first`, `openai_gemini_joined_stable_first`, `string_system_unchanged`.
- [ ] Implement builders + provider + loop + route wiring. Commit `feat(ai): stable/volatile prompt split with Anthropic prompt caching`.

### Task 2: Knowledge injection
**Files:** Create `lib/ai-prompts/knowledge.ts` + test; Modify the four builders + route.
- [ ] Failing tests: `renders_whole_entries_sorted`, `over_budget_injects_nothing`, `read_error_returns_empty`, `cache_60s_per_label`, `knowledge_lands_in_stable`, `labels_match_tool`.
- [ ] Implement; add the one prompt line from spec §5.3. Commit `feat(ai): inject knowledge base into the cached prompt prefix`.

### Task 3: Cache observability + verify + ship
- [ ] PII-free debug log of cache usage fields in the Anthropic adapter (test).
- [ ] Full suite baseline only; tsc clean on touched files; placeholder `next build` exit 0.
- [ ] Final review (opus) → one fix wave → re-review; push protocol; deploy watch; smoke; memory update.
