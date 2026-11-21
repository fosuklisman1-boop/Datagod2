# AI Assistant Console (Phase 5 of the AI assistant upgrade) — Design

Date: 2026-11-21 · Status: approved under the owner's standing pre-approval
(2026-11-21 00:51). Owner design choices 2026-11-21 11:02–11:09: admin can
rename the assistant; one "AI Assistant" page with tabs Settings / Knowledge /
Conversations / Flags (reference screenshots of a competitor's console —
copy the structure only, our own wording); add Tone presets, Model cards with
prices, Max tool steps; existing AI Settings and AI Knowledge pages move in;
daily limits / token ceiling stay EXCLUDED; DeepSeek and Groq are already
supported providers.

## 1. Intent

AI controls are scattered (`/admin/ai-settings`, `/admin/ai-knowledge`), the
assistant's name is hard-coded in ~15 places, there is no way to switch the
assistant off for one audience, and admins cannot see what the assistant
actually said to customers. Phase 5 gives the owner one console to run the
assistant, and a way to review its conversations safely.

## 2. Goals

1. **One page `/admin/ai-assistant`** with tabs Settings / Knowledge /
   Conversations / Flags. `/admin/ai-settings` and `/admin/ai-knowledge`
   redirect to the matching tab. Sidebar shows one "AI Assistant" link (NEW
   tag per lib/nav-new.ts) replacing the two old links. Admin-only (existing
   admin gate + capability used by the old pages).
2. **Settings tab** (sticky "Save changes" bar, "Changes apply within about 60
   seconds"):
   - **Engine card**: Assistant **name** (2–24 letters/numbers/spaces/hyphens,
     live preview "Hi Ama, I am {name}"); **Tone** presets Professional /
     Friendly / Fun / Strict / Concise each with a one-line description and an
     example reply, plus "Default (current behaviour)"; **Provider** select
     (anthropic, openai, gemini, deepseek, groq — existing); **Model cards** for
     the chosen provider: name, model id, price in/out per 1M tokens, rough
     cost per 1,000 messages (assume ~3,000 in + 400 out per message, stated
     on the page), "Tools" badge where tool use is confirmed, a "Recommended"
     badge, and an "Other model" free-text option; **API key** write-only,
     masked "Saved (ends in xxxx)".
   - **Advanced (per chat)**: the existing per-context provider/model overrides
     (home/storefront, dashboard, admin, WhatsApp) — kept, collapsed.
   - **Who can use it**: four independent switches — Admins, Signed-in users,
     Shop visitors (storefront guests), Public visitors (home + other public
     pages). Off = the widget is hidden for that audience AND the chat route
     refuses it (403 `{error:"assistant_off"}`). Defaults: all ON (today's
     behaviour).
   - **Max tool steps per answer**: 3–25; empty = today's behaviour (admin 20,
     others 10).
3. **Settings flow into the product**:
   - `GET /api/ai/assistant-profile` returns `{ name, audiences: {admins,
     signedIn, shopVisitors, publicVisitors} }` (public, cached 60 s); widgets
     hide when their audience is off.
   - Name + tone reach the web prompts in the **stable** part only when they
     differ from the defaults, so default settings keep prompts byte-identical
     (Phase-3 frozen golden + strict tests stay green, untouched). Name also
     reaches: dashboard/admin/home greetings (already via the endpoint), cron
     task prompt + push/email titles ("{name}" instead of "DATAGOD AI"),
     WhatsApp + shop-bot prompts. Storefront keeps the shop's own name.
   - Tone presets are fixed server-side instruction lines (one short paragraph
     each) — never admin free text. Every preset keeps: "an upset customer
     always gets a calm, serious reply", money/complaint topics never joked
     about.
4. **Conversations tab**: server-side transcripts of web chats.
   - New tables (migration): `ai_conversations` (id, conversation_key,
     context, user_id nullable, shop_id nullable, started_at, last_at,
     message_count, flagged bool, flag_reasons text[], reviewed_at,
     reviewed_by) and `ai_conversation_messages` (conversation_id, role
     user|assistant, text, created_at). RLS on, no client grants
     (service-role only), indexes on last_at / flagged.
   - The chat route appends each user message and the final assistant text
     **after redaction**: phone numbers (Ghana 0/233/+233), emails, 6+ digit
     runs, card/MoMo-like numbers are replaced with tokens ("[phone]",
     "[email]", "[number]"). Card notes, nonce blocks, system text and tool
     results are never stored. Redaction is a pure tested function.
     Storage failure never breaks the chat (fire-and-forget with a PII-free
     log marker).
   - Retention: 30 days, deleted by a daily cron route (Vercel cron or the
     cron-job.org batch per project convention — note in the report).
   - Tab: list (context, audience, started, messages, flagged badge), filters
     (context, flagged, date), open a conversation to read it.
5. **Flags tab**: conversations auto-flagged with reasons: `handoff` (user
   tapped Talk to a person — widget pings a tiny endpoint), `error` (stream
   error/timeout), `refusal` (assistant reply matched the apology/refusal
   heuristic), `card_failed` (a draft card finished failed/unknown in that
   conversation). List + "Mark reviewed". A "Weekly review" checklist
   card at the top (count of unreviewed flags this week, link to docs).
6. **Eval harness** (`scripts/ai-eval/`): fixed scenarios (JSON) run through
   `runAgenticLoop` with **stubbed tools** (no DB, no money) against the
   configured provider; assertions such as "never claims an order was placed
   without a card", "uses prepare_wallet_order for a buy request", "refuses
   admin tools as a dealer", "answers delivery-time policy from knowledge".
   Run manually: `npx tsx scripts/ai-eval/run.ts --provider anthropic` →
   pass/fail table. Not in CI (costs money). Unit-test the assertion helpers.
7. **Review routine**: `docs/ai-assistant-review-routine.md` — weekly
   checklist (open Flags, read 10 random conversations, run the eval harness
   after any prompt/model change, check cache debug once a month).

## 3. Non-goals
Daily limits / token ceilings (excluded by owner); WhatsApp transcript capture
(WhatsApp has its own inbox); editing knowledge content (existing editor moves
as-is); per-shop assistant names.

## 4. Anti-goals
- No PII in stored transcripts beyond what redaction misses; no raw phone /
  email in logs.
- Default settings change nothing (prompts, tools, behaviour identical).
- Tool lists unchanged (Phase-2 snapshot untouched).
- API keys never returned to the client unmasked.

## 5. Model price data
`lib/ai-models/catalog.ts`: provider → models with id, label, inUsdPerM,
outUsdPerM, tools: boolean, recommended?, checkedOn, sourceUrl. Prices must be
read from each provider's own pricing page at build time (record the date);
a model whose price could not be confirmed shows "price not checked". Anthropic
prices per the claude-api reference (cached 2026-11-03).

## 6. Testing
TDD. Pure tests: settings schema + defaults, prompt name/tone injection
(default → identical; custom → stable-only line), audience gating, redaction,
flag rules, retention query builder, price per-1,000 math, eval assertions.
Route tests: settings GET/PUT (admin only, key masking), assistant-profile,
chat route 403 when audience off, transcript append (redacted, never breaks
chat), flags/mark-reviewed. Migration: PGlite selftest + prod self-rolling-back
dry run. Screenshots of the console tabs (500/1280). Full suite baseline only.

## 7. Shipping
Migration 0189 dry run → apply → push → deploy (verify production alias is
ours) → smoke (assistant-profile includes audiences; old admin URLs redirect;
chat still works). Retention cron registered per project convention.
