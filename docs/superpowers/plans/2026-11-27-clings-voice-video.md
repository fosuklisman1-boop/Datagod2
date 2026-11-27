# Clings Voice & Video Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice call / Video call buttons in every Clings widget that start a Nuance Live persona whose "brain" is the existing Clings chat route, shipped dark.

**Architecture:** Server mints a single-use Nuance session token (`client` delegation, per-context persona prompt) after auth, switches, bot check and caps, and logs the call in `ai_voice_calls`. The browser runs `@nuancelabs/js-sdk`; on each hand-off it relays the call's settled transcript to `/api/ai/chat` (unchanged), renders any Confirm card on screen, and sends a digit-masked answer back as `session.commentary.append`. Settings live in the existing `ai_provider_config` under a new `voice` block.

**Tech Stack:** Next.js 15 App Router, Supabase (service role), Vitest 4, `@nuancelabs/js-sdk` (^0.40), existing `lib/turnstile.ts`, `lib/rate-limiter`, `lib/ai-console/*`, `components/ai/chat/*`.

**Spec:** `docs/superpowers/specs/2026-11-27-clings-voice-video-design.md`

## Global Constraints

- Work in a fresh worktree `B:/worktrees/dg-clings-voice`, branch `feat/clings-voice` off `origin/main` (see memory: B: drive worktrees; vitest needs uppercase drive path).
- `NUANCE_API_KEY` / `NUANCE_API_URL` (default `https://api.nuancelabs.ai`) are server-only; never `NEXT_PUBLIC_`, never in a command line or log.
- Everything we send to Nuance (prompt, appends, `response.create` instructions) passes `maskForVoice` and is English; ≤ 2,000 chars per append/instructions.
- Defaults: `voice.enabled=false`; audiences all false; `personaId="sam"`; `expressiveness=1`; `maxCallSeconds=300`; `dailyCalls={ dashboard: 5, public: 1, storefront: 1 }`; `visitorDailyTotal=30`; admins no daily cap.
- `end_user_id`: signed-in `u_<uuid>`; visitor `d_<first 32 hex of sha256(dg_vdid + NUANCE_DEVICE_SALT or SUPABASE_SERVICE_ROLE_KEY)>`.
- Cookie `dg_vdid`: HttpOnly, Secure, SameSite=Lax, Path=/, 1 year, 128-bit random hex.
- Day boundary = UTC (Ghana = UTC).
- Code edits with Edit/Write only — no sed (tell subagents).
- Navy brand accent; every new panel has an `lg:` wider two-column layout.
- The console card sits inside an existing page, so it gets a "New" badge on the card (no new sidebar item).
- Logs are PII-free: no phone numbers, emails, transcripts, tokens.

## Review Focus

1. **A Clings answer containing a phone number, order ref or MoMo number reaches Nuance unmasked** ("0241234567", "+233 24 123 4567", "zero two four one…", "Order 12345678") → call ends. Expect masked to "number ending 567" / "[number]". Pinned in Task 1 + Task 6.
2. **User taps Confirm after hanging up / connection drop** → card still works via `/api/ai/drafts/[id]`, nothing sent to Nuance, no crash. Pinned in Task 6.
3. **Visitor clears cookies to reset the 1/day cap; many visitors at once** → `visitorDailyTotal` stops visitor calls at 30, signed-in users still get calls. Pinned in Task 4 + Task 5.
4. **Nuance refuses (credits_spent / concurrency_limit / start_limit / capacity / policy_curfew / app_review_held) or browser lacks mic/WebRTC** → one friendly line and the text chat, never a dead button. Pinned in Task 4 + Task 7.
5. **Hand-off while the chat route is slow, 429s or errors** → persona says the generic "couldn't get that done" line, call continues. Pinned in Task 6.

---

### Task 1: Worktree, SDK, and `maskForVoice`

**Files:**
- Create: `lib/ai-voice/mask.ts`, `lib/ai-voice/mask.test.ts`
- Modify: `package.json` (add `@nuancelabs/js-sdk` ^0.40); commit spec + plan

**Interfaces:**
- Produces: `maskForVoice(text: string): string`; `clampForAppend(text: string, max = 2000): string` (mask, cut on a word boundary, mask again).

- [ ] **Step 1:** `git worktree add B:/worktrees/dg-clings-voice -b feat/clings-voice origin/main`; copy `.env.local` from the main checkout; `npm ci`; `npm i @nuancelabs/js-sdk@^0.40`. Copy the spec and this plan in; commit `docs: clings voice & video spec + plan`.
- [ ] **Step 2: Write the failing tests** in `mask.test.ts`:
```ts
expect(maskForVoice("Sent to 0241234567")).toBe("Sent to number ending 567")
expect(maskForVoice("call +233 24 123 4567 now")).toBe("call number ending 567 now")
expect(maskForVoice("024-123-4567")).toBe("number ending 567")
expect(maskForVoice("zero two four one two three four five six seven")).toBe("[number]")
expect(maskForVoice("Order 12345678 is done")).toBe("Order [number] is done")
expect(maskForVoice("on 2026-11-27 at 10:30")).toBe("on 2026-11-27 at 10:30")
expect(maskForVoice("GHS 1,250.50 for 2GB or 1000MB")).toBe("GHS 1,250.50 for 2GB or 1000MB")
expect(maskForVoice("ref 123456")).toBe("ref 123456")
expect(clampForAppend("a ".repeat(1500)).length).toBeLessThanOrEqual(2000)
expect(clampForAppend("x".repeat(1995) + " 0241234567")).not.toMatch(/\d{7}/)
```
- [ ] **Step 3:** Run `npx vitest run lib/ai-voice/mask.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement. Phone-shaped (→ "number ending NNN") = after stripping separators: 10 digits starting `0`, or 12 digits starting `233`. Other 7+ digit runs → `[number]`. Separators: spaces, `.`, `-`, Unicode dashes (normalise first), `(`, `)`, leading `+`. A `YYYY-MM-DD` date starting a run is kept. Spelled runs of 7+ digit words → `[number]`.
- [ ] **Step 5:** Run → PASS. Commit `feat(voice): maskForVoice + clampForAppend`.

### Task 2: Voice settings in the AI config

**Files:**
- Create: `lib/ai-voice/settings.ts`, `lib/ai-voice/settings.test.ts`
- Modify: `lib/ai-provider-config.ts` (optional `voice?` on `AIProviderConfig`), `app/api/admin/ai-config/route.ts` (accept/validate/save `voice`), `app/api/ai/assistant-profile/route.ts` + `route.test.ts`

**Interfaces:**
- Produces:
```ts
export type VoiceAudience = "public" | "storefront" | "dashboard" | "admin"
export interface VoiceSettings {
  enabled: boolean
  audiences: Record<VoiceAudience, boolean>
  personaId: "sam" | "sonia" | "mira"
  expressiveness: number            // 0..2
  maxCallSeconds: number            // 60..1800
  dailyCalls: { dashboard: number; public: number; storefront: number } // 0..50
  visitorDailyTotal: number         // 0..1000
}
export const DEFAULT_VOICE_SETTINGS: VoiceSettings
export const voiceSettingsInputSchema // zod, partial VoiceSettings
export function resolveVoiceSettings(cfg: unknown): VoiceSettings
export function voiceAudienceForContext(context: string): VoiceAudience | null // home→public; storefront; dashboard; admin; else null
export function voiceAvailable(s: VoiceSettings, a: VoiceAudience): boolean    // enabled && audiences[a]
```
- Profile route response gains `voice: Record<VoiceAudience, boolean>` (all false unless master on).

- [ ] **Step 1: Failing tests:** `resolveVoiceSettings(null)` equals the Global Constraints defaults; bad values fall back per field (`expressiveness: 5 → 1`, `personaId: "emma" → "sam"`, `maxCallSeconds: 10 → 300`); `voiceAvailable` false when `enabled=false` even with audience true; `voiceAudienceForContext("whatsapp") === null`. Profile test: no config → `voice` all false; `voice.enabled` + `audiences.dashboard` → only dashboard true; `name`/`audiences` unchanged.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement following `lib/ai-console/settings.ts` (`resolveAssistantSettings`). Admin route: merge `voice` only when it parses; other fields untouched; `resetAIConfigCache()` after save as today.
- [ ] **Step 4:** `npx vitest run lib/ai-voice app/api/ai/assistant-profile app/api/admin/ai-config` → PASS (existing tests too).
- [ ] **Step 5:** Commit `feat(voice): voice settings in ai_provider_config`.

### Task 3: `ai_voice_calls` migration

**Files:**
- Create: `migrations/0201_ai_voice_calls.sql`, `migrations/0201_ai_voice_calls.selftest.sql` (use the next free number if 0201 is taken at build time)

**Interfaces:**
- Produces `public.ai_voice_calls(id uuid pk default gen_random_uuid(), user_id uuid null references auth.users on delete cascade, device_hash text null, context text not null check (context in ('home','storefront','dashboard','admin')), mode text not null check (mode in ('voice','video')), persona_id text not null, shop_id uuid null, created_at timestamptz not null default now(), started_at timestamptz, ended_at timestamptz, end_reason text, conversation_id text, max_seconds int not null, check (user_id is not null or device_hash is not null))`; indexes `(user_id, created_at desc)`, `(device_hash, created_at desc)`, `(context, created_at desc)`; RLS on, no policies; `revoke all … from anon, authenticated`.

- [ ] **Step 1:** Selftest (`begin … rollback`): insert with neither id errors; `has_table_privilege('anon'|'authenticated', …)` all false; the three indexes exist; prints `SELFTEST_OK`.
- [ ] **Step 2:** Run both via PGlite (memory: reference-pglite-sql-tests) → applies, `SELFTEST_OK`.
- [ ] **Step 3:** Commit `feat(voice): ai_voice_calls table (0201)`. Not applied to prod here — Task 10.

### Task 4: Nuance client, call caps, persona prompt

**Files:**
- Create: `lib/ai-voice/nuance.ts`, `lib/ai-voice/gate.ts`, `lib/ai-voice/prompt.ts` + a `.test.ts` beside each

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
```ts
// nuance.ts
export type FallbackReason = "disabled" | "daily_cap" | "visitor_cap" | "bot" | "suspended" | "shop_unavailable"
  | "credits" | "busy" | "policy" | "review_pending" | "unavailable"
export async function mintNuanceToken(input: {
  systemPrompt: string; personaId: string; expressiveness: number; endUserId: string; camera: boolean
}, fetchImpl?: typeof fetch): Promise<{ ok: true; token: string; warnings: string[] } | { ok: false; reason: FallbackReason; status: number; code?: string }>
export function mapNuanceError(status: number, code?: string, errorCode?: string): FallbackReason
export async function getNuanceUsage(fetchImpl?: typeof fetch): Promise<{ creditsLeft: number | null; renewsAt: string | null } | null> // cached 60 s
// gate.ts
export interface CallCounts { mineToday: number; visitorsToday: number }
export function checkCallCaps(a: VoiceAudience, s: VoiceSettings, c: CallCounts): { ok: true } | { ok: false; reason: "daily_cap" | "visitor_cap" }
export function endUserIdFor(userId: string | null, deviceId: string | null, salt: string): string
// prompt.ts
export function buildPersonaPrompt(p: { assistantName: string; context: "home" | "storefront" | "dashboard" | "admin"; tone?: string }): string
```
- Mint body: `{ interface: "nuance_live", personality: { system_prompt, persona_id }, expressiveness, end_user_id, interface_setup: { delegation: { type: "client" }, runtime_tools: { end_call: true, call_time: true }, video: { input: { camera } } } }`.

- [ ] **Step 1: Failing tests.**
  - `mapNuanceError`: `(429,"credits_spent")→"credits"`, `(409,"concurrency_limit")→"busy"`, `(429,"start_limit")→"busy"`, `(429,"capacity_unavailable")→"busy"`, `(503,"busy")→"busy"`, `(403,undefined,"policy_curfew")→"policy"`, `(403,undefined,"organization_paused")→"policy"`, `(400,undefined,"app_review_held")→"review_pending"`, `(500)→"unavailable"`.
  - `mintNuanceToken` with fake fetch: `Authorization: Bearer <env key>` to `${NUANCE_API_URL}/session-tokens`; body matches the shape (camera false for voice); 200 → token; refusal → `ok:false` + mapped reason; thrown fetch → `unavailable`; spied `console.error` output contains no `nk_` and no prompt text.
  - `checkCallCaps`: admin always ok; dashboard `mineToday=5` (cap 5) → `daily_cap`; public `mineToday=0, visitorsToday=30` → `visitor_cap`; storefront `visitorsToday=29` → ok; dashboard ignores `visitorsToday`.
  - `endUserIdFor`: `("abc-123",…)→"u_abc-123"`; device → `/^d_[0-9a-f]{32}$/`, stable for the same input; always `/^[A-Za-z0-9_.:-]{1,128}$/`.
  - `buildPersonaPrompt`: contains the name; < 2500 chars for every context; `maskForVoice(out) === out`; ASCII only; includes "hand", "never ask for", "card on your screen"; deterministic; admin ≠ home.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Prompt covers spec §3 + builder-check §1 ("an action is only done when the screen says so"). Audience line per context (home: visitors — browsing, how-to, buying needs sign-in; storefront: this shop's customers; dashboard: signed-in customers and shop owners; admin: Datagod staff).
- [ ] **Step 4:** Run → PASS. Commit `feat(voice): nuance client, call caps, persona prompt`.

### Task 5: `POST /api/ai/voice/token` and `POST /api/ai/voice/end`

**Files:**
- Create: `app/api/ai/voice/token/route.ts` + test, `app/api/ai/voice/end/route.ts` + test, `lib/ai-voice/device-cookie.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `loadAIConfig`, `resolveAssistantSettings`; `isTurnstileEnabled`, `verifyTurnstileToken`, `getRequestIp` (`lib/turnstile.ts`); `applyRateLimit`; the same auth / suspension / admin-role / storefront-shop checks `/api/ai/chat` uses (extract a shared helper only as a straight move).
- Produces:
  - Token request `{ context: "home"|"storefront"|"dashboard"|"admin"; mode: "voice"|"video"; shopSlug?: string; turnstileToken?: string }`, `Authorization: Bearer <jwt>` for dashboard/admin.
  - 200 `{ token: string; callId: string; maxSeconds: number }` | 200 `{ fallback: "text"; reason: FallbackReason }`; 400 bad body; 401 dashboard/admin unauthenticated; 403 admin context for non-admin; 429 rate limited.
  - End request `{ callId: string; reason: string; conversationId?: string; started?: boolean }` → 204, idempotent; 404 when the row isn't the caller's (user id or device hash).
  - `getOrSetDeviceId(req: NextRequest, res: NextResponse): string`.

- [ ] **Step 1: Failing tests** (fake Supabase pattern, memory: reference-testing): master off → `reason:"disabled"`, Nuance not called; home with bad Turnstile (when enabled) → `bot`; dashboard user with 5 rows today → `daily_cap`; 30 visitor rows today → home gets `visitor_cap` while a dashboard user still gets a token; suspended → `suspended`; storefront inactive/missing shop → `shop_unavailable`; admin context with non-admin JWT → 403; success inserts one row (context, mode, persona, max_seconds, user_id or device_hash) before minting and returns settings `maxCallSeconds`; Nuance `credits_spent` → `reason:"credits"` and the row still exists; first home call sets `dg_vdid` with HttpOnly/Secure/SameSite=Lax. End: other user's callId → 404; second call → 204 without re-writing `ended_at`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement in this order: rate limit (`ai_voice_token`, 10/min, keyed by user or device) → parse → config + `voiceAvailable` → identity/admin gate → suspension → shop check → Turnstile (home/storefront) → counts (today, user/device in that audience; visitor total over home+storefront) → `checkCallCaps` → insert row → `mintNuanceToken` (camera = mode==="video") → respond. Log only `[voice] mint refused <status> <code>`.
- [ ] **Step 4:** Run → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(voice): token + end routes`.

### Task 6: Call session engine (browser, framework-agnostic)

**Files:**
- Create: `lib/ai-voice/transcript.ts`, `lib/ai-voice/call-session.ts` + a `.test.ts` beside each

**Interfaces:**
- Consumes: Task 1.
- Produces:
```ts
// transcript.ts
export interface Turn { role: "user" | "assistant"; content: string; eventId?: string }
export class CallTranscript {
  onEvent(ev: { type: string } & Record<string, unknown>): void // input_transcript.done (+replaces_event_id), output_transcript.delta, output_audio.done
  turns(): Turn[]     // settled user turns + finished persona replies
  captions(): Turn[]  // turns() + the in-progress persona reply
}
// call-session.ts
export interface ChatRelay { ask(history: Turn[]): Promise<{ text: string; cards: Array<{ id: string; summary: string }> }> }
export interface LiveLink { send(ev: Record<string, unknown>): Promise<void>; connected(): boolean }
export function createCallSession(deps: { link: LiveLink; relay: ChatRelay; transcript: CallTranscript; timeoutMs?: number /* 45000 */ }): {
  onInterfaceEvent(ev: { type: string } & Record<string, unknown>): Promise<void>
  onCardOutcome(o: { summary: string; outcome: "confirmed" | "cancelled" | "already_placed" | "failed" }): Promise<void>
}
export const CARD_COMMENTARY = "I've put a card on your screen with the details. Please check it and tap Confirm if it's right."
export const FAILURE_COMMENTARY = "I couldn't get that done right now. Please try again, or use the text chat."
```

- [ ] **Step 1: Failing tests** (fake link/relay):
  - `session.delegation.created {delegation:{id:"del_1",target:"client"}}` → sends `session.thinking.append {delegation_id:"del_1", content:"Checking…"}`, then calls `relay.ask(transcript.turns())`, then sends `session.commentary.append {delegation_id:"del_1", content: maskForVoice(text)}`.
  - relay returns a card → commentary = `CARD_COMMENTARY + " " + maskForVoice(card.summary)`; relay text never sent.
  - relay text "Sent 2GB to 0241234567" → commentary contains "number ending 567", no `\d{7}`.
  - relay rejects / passes `timeoutMs` → `FAILURE_COMMENTARY`.
  - `onCardOutcome` while connected → `session.thinking.append {delegation_id:null, while_speaking:"finish"}` with masked text; disconnected → nothing sent, no throw.
  - `target:"responses"` hand-off → ignored.
  - Transcript: `input_transcript.done` A then one with `replaces_event_id: A.event_id` → one user turn with the new text; persona deltas until `output_audio.done` → one assistant turn; an interrupted reply keeps the words received; deltas without `output_audio.done` appear in `captions()` only.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Commit `feat(voice): call session engine + transcript`.

### Task 7: Call UI in the four widgets

**Files:**
- Create: `components/ai/voice/VoiceCallButtons.tsx`, `components/ai/voice/CallPanel.tsx`, `components/ai/voice/useVoiceCall.ts`, `lib/ai-voice/chat-relay.ts` + test, `lib/ai-voice/connect-errors.ts` + test
- Modify: `components/home/AIChatWidget.tsx`, `components/shop/AIChatWidget.tsx`, `components/dashboard/AIChatWidget.tsx`, `components/admin/AdminAIChatWidget.tsx`, `components/ai/chat/index.ts`, `components/ai/chat/useAssistantName.ts` (expose profile `voice`)

**Interfaces:**
- Consumes: Tasks 5–6; existing DraftCard, each widget's auth header + `context` / `shopSlug`, existing SSE parsing (move to `lib/ai-chat-ui/` only as a straight move).
- Produces:
  - `createChatRelay(opts: { context: string; shopSlug?: string; authHeader?: () => Promise<string | undefined>; fetchImpl?: typeof fetch }): ChatRelay`
  - `connectErrorMessage(err: unknown, reason?: FallbackReason): string` — `credits|busy|unavailable|review_pending` → "Calls are busy right now — you can keep chatting here."; `daily_cap` → "You've used today's calls. You can keep chatting here."; `visitor_cap` → "Calls are full for today. Sign in to call, or keep chatting here."; `policy` → "Calls are paused for this account for a while."; `MediaAccessError` → "Allow the microphone (and camera for video) to call."; `WebRTCUnavailableError` → "This browser can't make calls. Try Chrome, or keep chatting here."; `JoinTimeoutError` → "Couldn't connect the call. A VPN or data saver can block calls."; else "Couldn't start the call — keep chatting here."
  - `useVoiceCall({ context, shopSlug?, authHeader?, assistantName })` → `{ state: "idle"|"starting"|"live"|"ended"; mode; captions; cards; secondsLeft; muted; endMessage?: string; start(mode); hangUp(); toggleMute() }`.

- [ ] **Step 1: Failing tests:** relay posts `{messages, context, shopSlug}` to `/api/ai/chat` with the bearer header and parses a recorded SSE fixture (copied from the chat route tests) into `{text, cards}`; non-200 rejects. `connectErrorMessage` maps each case above.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement relay + errors → PASS.
- [ ] **Step 4:** `useVoiceCall`: token route (Turnstile token for home/storefront via the widgets' existing helper); `{fallback}` → `endMessage`, stay in text. Else `createNuanceConversation({ token: async () => token, maxSessionSeconds, mediaDevices: { cameraEnabled: mode === "video" } })`; subscribe `onInterfaceEvent` (→ transcript + session engine) before `connect()`; on `avatar-presented` send `response.create {response:{instructions: maskForVoice("Greet the user as <name> and ask how you can help.")}}`; voice mode never attaches the persona video track; on end → `POST /api/ai/voice/end`; `content`/`age_check` → show Nuance's `message` verbatim and hide call buttons for this page session; captions become chat messages after the call; cards stay. Hang up → `disconnect()`.
- [ ] **Step 5:** UI: phone + camera round buttons in the header/welcome only when available for that audience; CallPanel = persona video (video) or Clings avatar with speaking pulse (voice), captions, Mute, Hang up, time left, "Connecting… this can take up to 30 seconds", cards under captions; `lg:` two columns (video | captions + cards); navy. Wire into all four widgets.
- [ ] **Step 6:** `npx vitest run lib/ai-voice components` → PASS; `npx tsc --noEmit` clean; headless screenshots at 500px and 1280px of the dashboard widget in a mocked live state (memory: reference-headless-screenshots).
- [ ] **Step 7:** Commit `feat(voice): call UI in all Clings widgets`.

### Task 8: AI console "Voice & video" card

**Files:**
- Create: `app/admin/ai-assistant/_components/voice-card.tsx`, `app/api/admin/ai-voice/usage/route.ts` + test
- Modify: `app/admin/ai-assistant/_components/settings-tab.tsx`

**Interfaces:**
- Consumes: `voiceSettingsInputSchema`, `getNuanceUsage`, existing sticky "Save changes" flow.
- Produces: `GET /api/admin/ai-voice/usage` (admin via `verifyAdminAccess`) → `{ callsToday: { total: number; visitors: number; dashboard: number; admin: number }; creditsLeft: number | null; renewsAt: string | null }`.

- [ ] **Step 1: Failing test:** non-admin → refused; admin → today's counts + Nuance usage via fake fetch; Nuance down → `creditsLeft: null`, still 200.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement → PASS.
- [ ] **Step 4:** Card: master switch; four audience switches (Public visitors, Shop visitors, Signed-in users & shop owners, Admins); persona select (Sam / Sonia / Mira — "try them in the Nuance Playground"); expressiveness 0–2; max call length (minutes); daily calls per signed-in user, per visitor device; total visitor calls per day; usage line "Calls today: N · Credits left: N (renews HH:MM UTC)"; "New" badge.
- [ ] **Step 5:** Screenshots 500px + 1280px. Commit `feat(voice): AI console voice card + usage`.

### Task 9: Retention

**Files:**
- Modify: `app/api/cron/ai-conversations-retention/route.ts` + its test

- [ ] **Step 1: Failing test:** `ai_voice_calls` rows older than 30 days deleted, newer kept, existing retention unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** Add the delete. **Step 4:** PASS. Commit `feat(voice): 30-day retention for ai_voice_calls`.

### Task 10: Verification, review, prod

- [ ] **Step 1:** `npx vitest run` — only the 9 known order-health failures may fail (memory: feedback-testing-discipline).
- [ ] **Step 2:** `npx tsc --noEmit`; placeholder-env `next build`.
- [ ] **Step 3:** Fresh whole-branch reviewer (opus): token route auth/caps, nothing money-related reachable from Nuance, masking everywhere we send, PII-free logs.
- [ ] **Step 4:** Migration via prod-change protocol: precheck → self-rolling-back dry run (`SELFTEST_OK`) → **owner OK** → apply → verify grants.
- [ ] **Step 5:** `NUANCE_API_KEY` (rotated by owner) + `NUANCE_API_URL` into Vercel production env via the Management API (secret never on a command line). Check local main for other sessions' commits, merge, push; confirm `www.datagod.store` serves our deployment.
- [ ] **Step 6:** Live smoke, switch OFF: token route → `{fallback:"text",reason:"disabled"}`; profile `voice` all false.
- [ ] **Step 7:** Update memory (project file + index); ready-to-paste channel post (Post now / Hold). Owner live checks from the spec's Rollout stay with the owner.
