# Text-to-Buy SIM replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let Text-to-Buy replies be sent from the forwarder phone's own SIM through an SM4-encrypted call to the phone's SmsForwarder HTTP server, with automatic Hubtel fallback. Ships dark (per-line transport defaults to `hubtel`).

**Architecture:** A pure SM4 envelope module and a small phone client (injected fetch), plus a transport router that is a drop-in replacement for the `send` function `sendReply` already takes. Settings and admin controls follow the existing `ttb_calls_enabled` pattern. No migration.

**Tech Stack:** Next.js 15, TypeScript, Vitest, Node `crypto` (`sm4-cbc` is built in), Supabase (admin_settings, ttb_messages).

**Spec:** `docs/superpowers/specs/2026-11-15-text-to-buy-sim-replies-design.md` (binding; read it first).

## Global Constraints
- Reply text is already GSM-7, one segment (enforced by `sendReply`); the router must not change that.
- Never log phone numbers, message text, the SM4 key, or `SMS_PHONE_URL`. One fixed log line per fallback with only a reason code.
- Env: `SMS_PHONE_URL` (e.g. `http://host:port`, no trailing slash) and `SMS_PHONE_SM4_KEY` (32 hex chars). Missing or malformed -> fall back to Hubtel, never throw.
- No `sed`/shell edits of code; use the Edit/Write tools. Tests first (TDD). Logic lives in `lib/`.
- Default behaviour with no settings changed must be byte-for-byte identical to today (transport `hubtel`).
- Do not touch `.env*` files. Use unique fake phone numbers and a fake key in tests (never the real key).

## Review Focus
- A `sim` send that times out after the request was written must NOT fall back (no duplicate to the customer); a connect failure MUST fall back.
- Over the rolling cap the reply still goes out (via Hubtel), never dropped.
- Garbage/oversized/undecryptable phone response never throws and falls back.
- A shop-paid reply is charged exactly once whichever transport carries it (accounting is in `sendReply`, outside the router).
- Settings with invalid values (slot 3, cap 0, transport "x") are rejected by the admin API and ignored by the reader (defaults).

---

### Task 1: SM4 envelope, phone client, transport router

**Files:**
- Create: `lib/text-to-buy/phone-sms/sm4.ts`, `lib/text-to-buy/phone-sms/sm4.test.ts`
- Create: `lib/text-to-buy/phone-sms/client.ts`, `lib/text-to-buy/phone-sms/client.test.ts`
- Create: `lib/text-to-buy/phone-sms/router.ts`, `lib/text-to-buy/phone-sms/router.test.ts`
- Modify: `lib/text-to-buy/settings.ts` (fields below), `lib/text-to-buy/settings.test.ts`

**Interfaces:**
- Produces in `sm4.ts`:
  - `parseKey(hex: string): Buffer | null` (null unless exactly 32 hex chars)
  - `buildSendBody(key: Buffer, keyHex: string, p: { simSlot: 1 | 2; to: string; text: string; nowMs: number }): string` returns the hex ciphertext body
  - `decodeResponse(key: Buffer, hexBody: string): { code: number; msg?: string } | null` (null on any decode/parse failure)
- Produces in `client.ts`:
  - `type PhoneSendResult = { kind: "sent" } | { kind: "refused" } | { kind: "unreachable" } | { kind: "ambiguous" }`
  - `sendViaPhone(cfg: { url: string; keyHex: string }, p: { simSlot: 1 | 2; to: string; text: string }, deps?: { fetch?: typeof fetch; now?: () => number; connectTimeoutMs?: number; totalTimeoutMs?: number }): Promise<PhoneSendResult>`
  - Classification: `sent` = HTTP 200, decodes, `code === 200`. `refused` = decodes with `code !== 200`, or HTTP non-200, or undecryptable body (the phone answered and said no). `unreachable` = fetch rejected before any response (DNS, refused, connect timeout via AbortController at connectTimeoutMs, default 3000). `ambiguous` = request was written but the total timeout (default 8000) fired before a response.
  - Distinguish connect-phase vs read-phase abort by tracking whether response headers arrived and by which timer fired.
- Produces in `router.ts`:
  - `createReplySend(args: { db: SupabaseClient; line: Line; settings: TtbSettings; env?: NodeJS.ProcessEnv; hubtel?: typeof sendSMS; phone?: typeof sendViaPhone; now?: () => Date }): typeof sendSMS`
  - Behaviour exactly as spec "Transport router" items 1-7. Rolling cap = count of rows in `ttb_messages` with `direction = 'out'` for that `line` and `created_at >= now - 30 min`; a count error means treat as over the cap (use Hubtel).
- Settings additions (`TtbSettings` in `settings.ts`): `replyTransportMain`, `replyTransportShop`: `"hubtel" | "sim"`; `simSlotMain`, `simSlotShop`: `1 | 2`; `simMaxPer30Min`: number. Keys `ttb_reply_transport_main`, `ttb_reply_transport_shop`, `ttb_sim_slot_main`, `ttb_sim_slot_shop`, `ttb_sim_max_per_30min`; defaults `hubtel`, `hubtel`, 2, 1, 20; invalid stored values fall back to defaults. Follow the existing reader pattern for `callsEnabled` and the text/number helpers in that file.

- [ ] **Step 1: Write failing tests for `sm4.ts`:** round trip (encrypt body with a fake 32-hex key, decrypt with an independent `crypto.createDecipheriv("sm4-cbc", key, IV)` and check the envelope has `data.sim_slot`, `data.phone_numbers`, `data.msg_content`, integer-ms `timestamp`, and `sign` equal to `encodeURIComponent(base64(HMAC_SHA256(key, ts + "\n" + keyHex)))`); body is lowercase hex; `parseKey` rejects 31/33 chars and non-hex; `decodeResponse` returns null for non-hex, wrong-length, bad padding and non-JSON plaintext, and `{code}` for a valid encrypted `{"code":200,"msg":"success","data":"success","timestamp":1}`.
- [ ] **Step 2: Run them, see them fail.** `npx vitest run lib/text-to-buy/phone-sms/sm4.test.ts`
- [ ] **Step 3: Implement `sm4.ts`** with the exact constants from the spec (IV bytes, sm4-cbc, PKCS7 default, hex).
- [ ] **Step 4: Tests pass.**
- [ ] **Step 5: Write failing tests for `client.ts`** with a fake `fetch`: 200 + encrypted `code 200` -> sent; encrypted `code 500` -> refused; HTTP 500 -> refused; garbage body -> refused; rejected fetch before response -> unreachable; fetch that never resolves with total timeout 20 ms after the "request was started" -> ambiguous; connect timeout (fetch hangs, aborted by the connect timer before headers) -> unreachable; the body posted to `${url}/sms/send` is hex and content-type is `application/json`; the URL, key, number and text never appear in any console output.
- [ ] **Step 6: Implement `client.ts`; tests pass.** (Use injected timers via small timeouts in tests, no fake-timer tricks needed.)
- [ ] **Step 7: Write failing tests for `router.ts`:** transport `hubtel` -> hubtel called, phone never; `sim` + sent -> `{success:true}` and hubtel not called; `sim` + refused/unreachable -> hubtel called once; `sim` + ambiguous -> `{success:true}` and hubtel NOT called; missing/malformed env -> hubtel; cap reached (count >= cap) -> hubtel; count query error -> hubtel; slot mapping main=simSlotMain, shop=simSlotShop; a fixed single fallback log line with a reason code and no sensitive text; `skipped` results from hubtel are passed through unchanged.
- [ ] **Step 8: Implement `router.ts` and the settings fields; tests pass.** Then `npx vitest run lib/text-to-buy` (all green) and `npx tsc --noEmit` shows no new errors in touched files.
- [ ] **Step 9: Commit** `feat(ttb): SM4 phone client and reply transport router (dark)`.

### Task 2: Wire the router, admin API and UI

**Files:**
- Modify: `lib/text-to-buy/send-reply.ts` (default `send` becomes the router for the reply's line when no `deps.send` is given), `lib/text-to-buy/send-reply.test.ts`
- Modify: `lib/text-to-buy/admin-validate.ts` (+ test), `app/api/admin/text-to-buy/route.ts` (+ test if one exists), `lib/text-to-buy/admin-view.ts` (+ test)
- Modify: `app/admin/text-to-buy/_components/SettingsTab.tsx`, `OverviewTab.tsx`, `api.tsx` as needed
- Modify: `docs/text-to-buy/runbook.md` (new section 16)

**Interfaces:**
- Consumes: `createReplySend` and the five new settings from Task 1.
- `sendReply` keeps its exact signature and return contract; only the default for `send` changes: `deps.send ?? createReplySend({ db, line: r.line, settings: r.settings })`. With defaults (`hubtel`) the router returns the unchanged `sendSMS` path so existing tests pass untouched.
- Admin validation: accepts only transport values `hubtel|sim`, slots `1|2`, cap integer 1..30; rejects anything else with the existing error shape.

- [ ] **Step 1: Failing tests:** `sendReply` with default deps and transport `sim` calls the phone path (inject through the router's args or a module mock) and charges a shop payer exactly once whether the phone or the fallback carried it; an ambiguous result counts as sent and stores one out row; admin validate rejects slot 3, cap 0, cap 31, transport "x"; admin view exposes the five settings plus `env: { phoneConfigured: boolean }` (true only when both env vars are well-formed; never the values).
- [ ] **Step 2: Implement; make them pass.**
- [ ] **Step 3: UI:** a "Replies from the phone SIM" card in SettingsTab (two selects Hubtel/SIM per line, two slot selects, cap input, a warning line "Keep SIM airtime topped up; Hubtel is the automatic fallback"), and a one-line status in OverviewTab showing the transport per line and whether the phone link is configured. Match existing component patterns and the NEW-tag/desktop-layout conventions already in these files. No raw secrets in the UI.
- [ ] **Step 4: Runbook section 16** ("SIM replies"): how it works in plain words, the env vars, the phone setup (Server SM4 + only Send SMS/Query Battery on, Frpc entry, auto-start), how to switch a line on/off, the airtime and rate-cap warnings, how to rotate the key (generate a new 32-hex key, set it on the phone and in Vercel, redeploy), and the shared-relay risk.
- [ ] **Step 5: Full checks:** `npx vitest run lib/text-to-buy app/api/admin/text-to-buy app/admin/text-to-buy` green, `npx tsc --noEmit` no new errors in touched files.
- [ ] **Step 6: Commit** `feat(ttb): wire SIM reply transport, admin settings and runbook (dark)`.
