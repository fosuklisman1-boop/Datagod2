# AI Chat Experience (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** One shared, navy chat experience across the four web AI widgets: welcome screen, suggestion chips, typing indicator, copy chips, no dead ends, human handoff, on-device history.

**Architecture:** `lib/ai-chat-ui/` pure helpers (node-tested) + `components/ai/chat/` thin components + `GET /api/ai/assistant-profile`; each widget adopts the kit.

**Tech Stack:** Next.js 15, React, Tailwind (navy `--primary`), lucide-react, Vitest 4 (node; no jsdom/RTL — logic lives in pure helpers).

**Spec:** `docs/superpowers/specs/2026-11-21-ai-phase4-chat-ux-design.md`

## Global Constraints
- Worktree `B:/worktrees/dg-ai-phase4`, branch `feat/ai-phase4-chat-ux`; vitest from `B:\worktrees\dg-ai-phase4` (UPPERCASE drive).
- Edit/Write only — never sed. No new dependencies.
- `lib/ai-prompts/golden.test.ts`, `lib/ai-tool-registry.snapshot.test.ts` untouched and green; no server prompt/tool changes.
- No PII in logs. Baseline: 12 pre-existing failures in 4 files.
- Navy brand accent; our own wording/icon (structure copied from a reference only).

## Review Focus
1. Chips/handoff sending anything other than plain user text.
2. Handoff thread creation: correct schema, user's own transcript only, failure fallback.
3. localStorage access throwing (private mode) breaking the widget.
4. Copy-chip regex false positives altering text or matching inside words.
5. Accessibility: buttons, live regions, focus, reduced motion.

---

### Task 1: Pure helpers + assistant-profile endpoint
**Files:** Create `lib/ai-chat-ui/{assistant-name,copy-chips,suggestions,handoff,history}.ts` + tests; `app/api/ai/assistant-profile/route.ts` + test.
- [ ] Failing tests: `copy_chips_detects_order_code_ussd_phone`, `copy_chips_ignores_inside_words`, `copy_chips_preserves_text`, `suggestions_per_context` (home/storefront/dashboard/admin; storefront respects sold services), `followups_per_context`, `handoff_message_last5_capped_2000`, `handoff_excludes_card_notes_and_system`, `history_key_per_widget_user_shop`, `history_trim_30`, `history_storage_throw_safe`, `assistant_profile_returns_default_name_cached`.
- [ ] Implement. Commit `feat(ai): chat UI helpers and assistant profile endpoint`.

### Task 2: UI kit components
**Files:** Create `components/ai/chat/{ChatWelcome,SuggestionChips,TypingIndicator,MessageText,ChatInput,HandoffButton,index}.tsx`.
- [ ] Thin components over Task 1 helpers; navy tokens; a11y per spec §5. Headless screenshot of a static harness (500/1280) for ChatWelcome + a message with copy chips + typing indicator.
- [ ] Commit `feat(ai): shared chat UI kit`.

### Task 3: Adopt in home + storefront widgets
**Files:** Modify `components/home/AIChatWidget.tsx`, `components/shop/AIChatWidget.tsx`.
- [ ] Welcome screen, chips, typing indicator, copy chips, error Try again + Talk to a person, guest handoff (WhatsApp), on-device history + New chat (fresh conversationKey). Screenshots.
- [ ] Commit `feat(ai): new chat experience on home and storefront`.

### Task 4: Adopt in dashboard + admin widgets
**Files:** Modify `components/dashboard/AIChatWidget.tsx`, `components/admin/AdminAIChatWidget.tsx`.
- [ ] Same kit; dashboard handoff creates a support thread (fallback WhatsApp); admin widget: no handoff link; admin gets on-device history; DraftCard rendering untouched. Screenshots.
- [ ] Commit `feat(ai): new chat experience on dashboard and admin`.

### Task 5: Verify + ship
- [ ] Full suite baseline only; tsc clean on touched files; placeholder `next build` exit 0.
- [ ] Final review (opus) → one fix wave → re-review; push protocol; deploy; smoke; memory.
