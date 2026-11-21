# AI Chat Experience (Phase 4 of the AI assistant upgrade) — Design

Date: 2026-11-21 · Status: approved under the owner's standing pre-approval
(2026-11-21 00:51). Visual target chosen by the owner 2026-11-21 11:05:
a competitor's welcome screen layout, in Datagod's **navy** brand colour
(not the reference's gradient). Copy the structure only — our own wording,
icon and name.

## 1. Intent

The four web chat widgets (home, shop storefront, dealer dashboard, admin)
open on a plain greeting bubble, give no hints what to ask, can strand a user
on an error, have no way to reach a person, and (except the dashboard) forget
the conversation on reload. Phase 4 gives all four one shared chat experience.

## 2. Goals

1. **Shared chat UI kit** `components/ai/chat/`: `ChatWelcome`,
   `SuggestionChips`, `TypingIndicator`, `MessageText` (copy chips),
   `ChatInput`, `HandoffButton`. Pure helpers in `lib/ai-chat-ui/` with node
   tests.
2. **Welcome screen** (empty conversation): round icon avatar (navy ring),
   title "Hi, I am {assistantName}." (signed-in: "Hi {firstName}, I am
   {assistantName}."), one-line subtitle per context, a "TRY IT" example
   question bubble that sends when tapped, and 3–4 suggested-question chips
   that send when tapped. Input placeholder "Ask {assistantName} anything…",
   rounded, round send button.
3. **Assistant name**: `lib/ai-chat-ui/assistant-name.ts` exports
   `DEFAULT_ASSISTANT_NAME = "DATAGOD AI"`; client hook `useAssistantName()`
   reads `GET /api/ai/assistant-profile` (public, `Cache-Control` 60 s) which
   returns `{ name }` = default for now. Phase 5 adds the admin setting behind
   the same endpoint. Storefront widget keeps using the shop's name.
4. **Typing indicator**: three animated dots in an assistant bubble from send
   until the first streamed text (respects `prefers-reduced-motion`),
   `aria-live="polite"` label "{name} is typing".
5. **Copy chips**: in assistant messages, order codes, transaction codes, USSD
   codes (`*…#`), and 10-digit Ghana phone numbers render as tappable chips
   that copy the exact text and show "Copied" for 1.5 s. Detection is a pure
   function with tests; displayed text otherwise unchanged.
6. **No dead ends**: on request error/timeout the bubble shows "Something went
   wrong." + **Try again** (resends the last user message) + **Talk to a
   person**; after each assistant reply with no model action buttons, up to 3
   static context follow-up chips; a persistent **Talk to a person** link in
   the chat header (not in the admin widget).
7. **Web human handoff** (`HandoffButton`): signed-in dashboard users → create
   a support thread via the existing `POST /api/support/threads` (read its
   schema; general category, subject "From AI chat", first message = the
   last ≤5 messages as "Me:"/"AI:" lines, ≤2,000 chars) and open the thread
   page; on failure fall back to WhatsApp. Guests (home, storefront) → open
   WhatsApp support from the existing `GET /api/support-config`
   `support_whatsapp` (storefront: the shop's own support contact if the shop
   has one, else platform).
8. **History on the device** for home, storefront and admin (dashboard
   already has it): localStorage, last 30 messages, keyed per widget + user id
   (guests per device; storefront per shop), "New chat" clears it and starts a
   fresh `conversationKey`. All storage access in try/catch.

## 3. Non-goals
Server-side transcripts and the admin Conversations view (Phase 5); admin
settings for name / tone (Phase 5); WhatsApp bot UI; daily limits (excluded).

## 4. Anti-goals
- No change to tool lists (Phase-2 snapshot) or system prompts (Phase-3
  frozen golden + strict tests stay green and untouched).
- Chips and handoff only ever send plain user messages; never card notes or
  system text.
- No PII in logs.

## 5. Accessibility & layout
Real `<button>`s; chips keyboard-focusable; live regions polite; visible
focus; works at 320 px, widens at `lg:` (docs/ui-conventions.md); navy
`--primary`; dark-mode tokens.

## 6. Testing
Node tests for every pure helper; route test for `/api/ai/assistant-profile`;
headless screenshots (500 px, 1280 px) of each widget's welcome screen; full
suite baseline only (12 pre-existing failures in 4 files).

## 7. Shipping
No migration. Placeholder `next build`, origin/main check, push, deploy
watch, smoke (`/` 200, `/api/ai/assistant-profile` 200 JSON).
