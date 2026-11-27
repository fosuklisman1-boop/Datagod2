# Clings voice & video calls (Nuance Live) — design

Date: 2026-11-27 · Status: draft for owner approval

## Why

Customers want to *speak with someone*, not type. Today they call or WhatsApp
about buying (which bundle, how), wallet/payment problems, shop/reseller help
and undelivered orders. Clings (the AI assistant, all 5 upgrade phases live)
already handles these in text. This adds a talking, on-screen Clings using
Nuance Live (a voice/video AI persona over LiveKit), so the same help is a
spoken conversation.

## Goals

- **Voice call** and **Video call** buttons in every Clings chat widget:
  home (public), storefront (shop visitors), dashboard (signed-in users and
  shop owners/sub-agents), admin.
- The call can do **everything text Clings can do in that context** — same
  tools, same Confirm cards, same guardrails — because the brain *is* text
  Clings.
- Credits are shared fairly: call length cap, calls-per-day caps, bot check
  for public visitors, graceful fallback to text chat.
- Everything admin-settable in the existing AI console; ships **dark** (master
  switch off).

## Non-goals

- Languages other than English (Nuance is English-only; refused at mint).
- USSD / SMS / WhatsApp voice — web only (needs a browser with WebRTC).
- New tools or new powers for Clings. Voice adds a channel, not capabilities.
- Results-checker PINs/serials, MoMo PINs, card/bank details spoken or sent
  through the call.

## Anti-goals (failure even if it "works")

- The persona (or anything Nuance runs) can place an order, move money or
  change an account without the user tapping a Confirm card.
- A full phone number (or any 7+ digit run) reaches Nuance in text we send —
  it ends the call and counts toward policy pauses for that user.
- One person/bot burns the day's credits and voice dies for everyone.
- A failure leaves the user stuck: every failure path lands in text chat.

## Constraints (from the Nuance docs, pasted 2026-11-27)

- Server mints a single-use session token (`POST /session-tokens`, API key
  `NUANCE_API_KEY`, server-only); browser must start within 60 s.
- English only; prompt + appends with non-English script refused.
- Any 7+ digit run (numerals or spelled out) in tool results / backend text
  can end the session with `reason: content`; repeated ends → `policy_curfew`
  per `end_user_id`.
- Prompt review refuses prompts that collect codes, passwords, ID numbers,
  card/bank details, or give financial advice. Our prompt must not ask for
  any of these.
- Daily credits + concurrent + hourly-start limits per plan (read via
  `GET usage`). Errors: `credits_spent` 429, `concurrency_limit` 409,
  `start_limit` 429, `capacity_unavailable` 429, `busy` 503.
- Append `content` ≤ 2,000 chars; prompt length capped (`prompt_too_long`).
- Persona doesn't speak first: send `response.create` on `avatar-presented`.
- Always send `end_user_id` (letters, digits, `_ . : -`; never email/name).

## Approaches considered

| | How | Trade-off |
|---|---|---|
| **A. Persona voice + Clings brain (chosen)** | `client` delegation. Persona hands off → our page sends the user's words to the existing Clings chat route → masked answer back to the persona as `session.commentary.append`. | Reuses every tool, card, guardrail, audience gate and the model the owner pays for. ~2–5 s extra per action; persona fills it. Two models per action. |
| B. Nuance backend calls our tools | `responses` delegation with Clings tools mirrored as Nuance function tools. | Faster, but 16-tool cap (admin has far more), two tool sets to keep in sync, Nuance reviews tool sets, backend writes phone numbers into call args → calls end. |
| C. Talk only | `none` delegation, persona answers from a site guide. | Fails "do everything Clings can do". |

Owner picked **A**.

## Decisions made with the owner

- Audiences: **public visitors, shop visitors, signed-in users, shop
  owners/sub-agents, admins** — each with its own on/off switch.
- Two buttons: **Voice call** (no user camera; persona video *not displayed*,
  shown as the Clings avatar icon, to save the user's mobile data) and
  **Video call** (user camera on, persona face shown).
- Starting limits (admin-settable): **5-minute calls; 5 calls/day for
  signed-in users and shop owners; 1 call/day per device for public & shop
  visitors; admins uncapped.**
- Public/shop visitors pass the **existing bot check** (`lib/bot-protection.ts`
  / `lib/turnstile.ts`) before a token is minted. No OTP.
- **Fallback to text**: credits spent, capacity/busy, over the daily cap,
  unsupported browser, mic denied, call ended by error → voice button shows a
  short reason and opens normal text chat.
- Persona look (`sam`/`sonia`/`mira`): admin setting; owner tries them in the
  Nuance Playground first. Default `sam` until chosen.

## Design

### 1. Call flow (approach A)

1. User taps **Voice call** or **Video call** in a Clings widget (a click, so
   the browser plays audio).
2. Page `POST /api/ai/voice/token` `{ context, mode, shopSlug? }`.
   Server: master switch + audience switch → identity (same auth as
   `/api/ai/chat` for that context; admin gate unchanged) → suspension →
   bot check (public/shop) → daily cap → mint token → insert call row →
   return `{ token, callId, maxSeconds }`. On any refusal: `{ fallback:
   "text", reason }`.
3. Page runs `@nuancelabs/js-sdk` `createNuanceConversation({ token,
   maxSessionSeconds, mediaDevices: { cameraEnabled: mode==='video' } })`,
   `connect()`. Voice mode: don't attach the persona's video track.
4. On `avatar-presented`: `response.create` → persona greets as Clings.
5. User speaks. Page keeps the settled user turns
   (`session.input_transcript.done`, honouring `replaces_event_id`) and the
   persona's words (`session.output_transcript.delta`) as the call's chat
   history, shown as live captions.
6. On `session.delegation.created` (target `client`): page sends
   `session.thinking.append` (delegation id, "Checking…") then calls the
   existing `/api/ai/chat` with the same `context` and the call's history
   (user turns + persona turns as assistant), reads the SSE to the end.
   - Any Confirm card the stream yields renders **on screen** under the call,
     exactly as in text chat. The user taps Confirm/Cancel there.
   - The final text is passed through `maskForVoice()` (below), cut to
     ≤ 2,000 chars, and sent as `session.commentary.append` with the
     delegation id. The persona says it in its own words.
   - Chat route error/timeout → commentary "I couldn't get that done right
     now, please try the text chat" (no numbers).
7. Card outcomes (confirmed / cancelled / already placed) are told to the
   persona via `session.thinking.append` (masked) so it can speak to them.
8. End: user taps Hang up → `disconnect()`; or time limit / persona
   `end_call` / error. Page `POST /api/ai/voice/end { callId, reason,
   conversationId }`. Call history stays in the widget as a text transcript
   so the user can carry on typing.

Why the page (not our server) relays to Clings: the chat route already
authenticates the user from their own session cookie; the page holds the
LiveKit connection. A tampered page can only affect that user's own call —
the server-side guards (auth, tools per context, cards, idempotency) are what
protect money, unchanged.

### 2. Phone numbers & sensitive digits

- `maskForVoice(text)` in `lib/ai-voice/mask.ts` (pure, unit-tested): every
  run of 7+ digits (allowing spaces, dots, dashes, brackets, `+`; and spelled
  digits "zero/oh/one…nine" 7+ in a row) → `number ending NNN` (last 3
  digits) — or `[number]` if it isn't phone-shaped. Keeps dates
  (`2026-11-27`), GHS amounts and bundle sizes. Applied to **everything** we
  send to Nuance: commentary, thinking, card outcomes, the greeting.
- The persona prompt says: never read out a full phone number, PIN, code or
  reference; refer to "the number ending …" and "the card on your screen".
- Numbers the *user* speaks reach Clings via the transcript (that's how a
  card gets its recipient); they're shown in full only on the Confirm card.
- Clings' system prompt is unchanged; a voice-specific line is added only to
  the *persona* prompt.

### 3. Persona prompt (mint-time `personality.system_prompt`)

Built in `lib/ai-voice/prompt.ts`, English, short (target < 2,500 chars),
deterministic per (assistant name, context, tone) so Nuance's review runs once
per variant, not per call. Content: you are {assistantName}, Datagod's
assistant for {audience}; plain spoken sentences; hand off **every** request
that needs facts about the user, orders, wallet, prices, shops or any action
("Let me check that…", never "Done!"); never ask for PINs, passwords, codes,
card or bank details; money actions are confirmed by the user on the screen
card; numbers as "ending …"; if unsure, say so and offer the text chat. No
user-specific data in the prompt (keeps it reviewable once and PII-free).
`runtime_tools: { end_call: true, call_time: true }`; delegation
`{ type: "client" }`.

### 4. Server

- `POST /api/ai/voice/token` — as in flow step 2. `end_user_id`: signed-in →
  `u_<user uuid>`; visitor → `d_<sha256(device id cookie + secret) first 32>`.
  `max_session_seconds` passed by the page from the response. Nuance errors
  mapped to `{ fallback: "text", reason }` (`credits_spent`,
  `concurrency_limit`, `start_limit`, `policy_curfew`, `organization_paused`,
  `app_review_held`, others → generic). Full Nuance error logged server-side,
  no PII.
- `POST /api/ai/voice/end` — owner-scoped (call row must belong to caller /
  device), records `ended_at`, `end_reason`, `conversation_id`. Idempotent.
- Rate limiting on both routes via `applyRateLimit` (existing).
- Daily cap counts call rows created today (Africa/Accra = UTC) for the
  user/device in that audience; admins skip it. Counted at mint, so a
  refused/failed start still counts (same as Nuance's hourly rule) — keeps
  retry-spam from minting tokens.

### 5. Data

Migration `ai_voice_calls` (service-role only, RLS on, no client grants):
`id`, `user_id` (nullable, FK CASCADE), `device_hash` (nullable), `context`,
`mode` (`voice|video`), `persona_id`, `created_at`, `started_at`, `ended_at`,
`end_reason`, `conversation_id`, `max_seconds`. Index on
(`user_id`, `created_at`) and (`device_hash`, `created_at`). 30-day
retention folded into the existing `ai-conversations-retention` cron.
No transcripts stored here — the Clings turns already flow through the
existing chat route (and its redacted conversation logging) like text chat.

### 6. Settings (AI console, `admin_settings` `ai_provider_config`)

New `voice` block, defaults = off:
`enabled` (master), per-audience `public / storefront / dashboard / admin`,
`personaId` (`sam`), `expressiveness` (1), `maxCallSeconds` (300),
`dailyCalls: { dashboard: 5, public: 1, storefront: 1 }`,
`visitorDailyTotal` (30). A "Voice & video"
card on the Settings tab; a short "Calls today / credits left" line read from
Nuance `GET usage` (server-side, cached ~60 s).

### 7. UI

- Each Clings widget (`components/ai/chat/*` kit) gets two round buttons in
  the header/welcome: phone icon (**Voice call**) and camera icon (**Video
  call**), shown only when voice is enabled for that audience (from
  `/api/ai/assistant-profile`, which gains `voice: { voice: bool, video:
  bool }`).
- Call panel replaces the message list while live: persona video (video
  mode) or the Clings avatar with a speaking pulse (voice mode); live
  captions; Mute, Hang up; time left; "Connecting… (can take up to 30 s)";
  Confirm cards appear under the captions. Navy brand accent; desktop gets a
  wider two-column panel (video | captions + cards).
- After the call, captions become normal chat messages and the input is back.
- Errors from `connect()` (`MediaAccessError`, `WebRTCUnavailableError`,
  `JoinTimeoutError`, `ApiError`, `PolicyCurfewError`…) → one friendly line +
  text chat.
- `session.closed` with `content` / `age_check` → show Nuance's `message`
  verbatim and don't offer another call in that session.

## Builder-check resolutions (my calls, owner may override)

1. **Card-bearing answers use fixed commentary.** When the Clings stream for
   a hand-off yields a Confirm card, the commentary sent to the persona is a
   template — "I've put a card on your screen with the details. Please check
   it and tap Confirm if it's right." (+ masked one-line summary, e.g.
   "2GB MTN to the number ending 567, GHS 12.00") — never Clings' free text.
   The persona prompt adds: an action is only done when the screen says so.
   Cards are ordinary server drafts (`/api/ai/drafts/[id]`): they stay usable
   after the call ends or drops, in the post-call chat, with their existing
   expiry/stale rules. A tap while the call is live sends the outcome as a
   masked `thinking.append` (`while_speaking: "finish"`); after the call,
   nothing is sent to Nuance.
2. **Auth + rate limit.** The page calls `/api/ai/chat` exactly as the text
   widget does today (same `Authorization: Bearer` session JWT for signed-in
   contexts, none for guests). Only *hand-offs* hit the chat route, not every
   spoken turn, so the existing `AI_CHAT` limit (20/min) fits a 5-minute call.
   A 429 from the chat route becomes the generic "couldn't get that done"
   commentary. No new bucket.
3. **Device identity.** New HttpOnly, Secure, SameSite=Lax cookie
   `dg_vdid` (random 128-bit, 1 year), set by `/api/ai/voice/token` if
   absent; `device_hash = sha256(dg_vdid + server secret)`. Clearing it
   resets the per-device cap — accepted; the backstop below covers it.
   **Backstop (owner decision 2026-11-27): a total daily cap on visitor
   calls** — all `home` + `storefront` calls combined, default **30/day**
   (UTC day), admin-settable as `voice.visitorDailyTotal`. Counted from
   `ai_voice_calls` rows at mint. Once hit, visitors get text chat plus
   "Sign in to call". Signed-in users and admins are never blocked by it.
   No per-IP cap (Ghana mobile users share carrier IPs).
   Turnstile runs **once per call** (each token mint).
4. **Admins.** No daily cap, but the same `maxCallSeconds` applies (credits).
   Each context has its own deterministic persona-prompt variant (home,
   storefront, dashboard, admin) → four one-time Nuance reviews.
5. **Call history sent to Clings.** Only settled user turns
   (`input_transcript.done`, honouring `replaces_event_id`) and *finished*
   persona replies (text collected up to each `output_audio.done`; an
   interrupted reply keeps the words that played). The route's 20-message /
   4,000-char window is fine for a 5-minute call.
6. **Shop owners/sub-agents** use the `dashboard` context, switch and cap.
   The token route refuses `storefront` calls for a shop that is missing,
   suspended or inactive (same checks the storefront chat uses).
7. **Branch.** Fresh `feat/clings-voice` worktree off `main` on B:; migration
   numbered after the highest applied at build time.

## Left to the builder

- Exact SDK version (≥ 0.40.0 for `reply:false`, pin caret), component split,
  how the page stitches transcript turns into Clings `messages`, SSE parsing
  reuse from the existing widget, icon choices, test layout.
- Whether `maskForVoice` lives client-side only or is also applied on a small
  server echo — client-side is sufficient (a tampered page only harms its own
  call).
- Copy wording for buttons, fallbacks and the persona greeting (English,
  no "data/bundle" restrictions apply here — that rule is USSD-only).

## Rollout

1. Build dark (master off), migration via the prod-change protocol.
2. Owner picks the persona in the Playground; Playground test that a spoken
   full number by the persona / in an append ends a call, and that
   `number ending 567` does not.
3. Owner live checks: admin voice call; dashboard voice call that prepares a
   small data order card → Confirm on screen → one order; video call;
   public call over cap falls back to text.
4. Flip master + chosen audiences on; add `NUANCE_API_KEY` to Vercel
   (rotate the key first — it was pasted in chat).
