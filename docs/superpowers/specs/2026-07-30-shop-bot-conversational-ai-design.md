# WhatsApp Shop Bot — Conversational AI Design

**Date:** 2026-07-30
**Status:** Approved
**Goal:** Make the shop WhatsApp bot (sub-agent storefront bot on the dedicated shop number) feel human and interactive by adding an AI conversation layer — mirroring the main WhatsApp bot's proven AI architecture — while keeping every money-touching step deterministic.

## Background

The shop bot (`lib/whatsapp-bot/shop-router.ts` + `shop-menus.ts`) is a pure numbered-menu state machine ported from the USSD shop. It works, but feels robotic: terse prompts, no greeting, no tolerance for natural language. The main WhatsApp bot solved this with a hybrid: a deterministic menu router, plus an AI agentic loop (`runAgenticLoop`) that handles freetext and stages orders through a tool (`place_whatsapp_order`) that seeds the deterministic confirm screen — so AI never touches money. This design applies the same pattern to the shop bot, scoped per-storefront.

## Architecture

### Traffic split (in `shopWaRouter`)

1. **Digits and step-valid inputs** → existing menu state machine, unchanged. Menus keep working exactly as today.
2. **Natural-language equivalents mid-flow** → a `shopNaturalToDigit(step, input, session)` mapper (mirrors `router.ts`'s `naturalToDigit`) converts obvious phrases to digits without AI: network names ("mtn", "telecel", "airteltigo/at") at `SELECT_NETWORK`/`AIRTIME_SELECT_NETWORK`, bundle sizes ("2gb") at `SELECT_BUNDLE`, yes/pay/cancel words at `*_CONFIRM`.
3. **Off-script freetext** → escape to the shop AI handler. `shopWaRouter` returns the sentinel `''` (empty string means "AI should handle this"); the webhook's shop branch then calls `handleShopWithAI`. Before escaping, the current `WaShopSession` is deleted (mirrors main bot) — EXCEPT the shop identity (see Returning-customer memory), which survives independently of the flow session.
4. **Money steps never escape.** At `CONFIRM`, `AIRTIME_CONFIRM`, `RC_CONFIRM`, `ENTER_PAYMENT_PHONE`, `AIRTIME_ENTER_PAYMENT_PHONE`, `RC_ENTER_PAYMENT_PHONE`, and `SUBMIT_OTP`, unrecognized input gets a deterministic re-prompt of the same screen (with a gentle "reply 1 to pay or 2 to cancel" line) — never an AI escape, never a silent drop. This is the money fence.

### Shop AI handler — `lib/whatsapp-bot/shop-ai.ts` (new file)

`handleShopWithAI(phone, text, messageId): Promise<string>` mirrors the webhook's `handleWithAI`:

- **Provider/config:** same `loadAiConfig()` + `resolveProviderForContext("whatsapp", aiConfig)` — Anthropic fallback included, no new config surface.
- **History:** last 20 messages for this phone from `whatsapp_messages` (both directions), same as main bot.
- **Loop:** `runAgenticLoop` with `maxIterations`/`maxTokens` matching the main bot's WhatsApp usage.
- **Shop context:** resolved from returning-customer memory (below) or absent. Two prompt modes:
  - **Shop known:** system prompt speaks AS the shop — name, its actual networks (`fetchShopNetworks`), real bundle prices (`fetchShopBundles`, listed in the prompt so most price questions need zero tool calls), airtime on/off + limits, RC boards + prices. Hard rules: never invent a price; never mark anything paid; currency is GHS; keep replies short/warm/WhatsApp-styled.
  - **No shop known:** the AI greets, explains this is the shop line, and asks for the shop code. When the customer sends something that looks like a code, the AI calls `resolve_shop_code`.
- **Result handling:** if `place_shop_order` staged a confirm session THIS turn (and none existed at start), the exact confirm screen (`shopConfirmMenu`/`shopAirtimeConfirmMenu`/`shopRcConfirmMenu`) is appended/sent verbatim — same post-loop pattern as the main bot's `place_whatsapp_order` handling.

### Shop-scoped AI tools

Defined for the shop context only (the main bot's tool set — wallet, complaints, AFA, account verification — is NOT exposed; v1 keeps the storefront bot focused on browsing + buying; anything else the AI politely directs to the shop owner):

- **`resolve_shop_code(code)`** — validates via existing `resolveShopCode`; on success stores the phone→shop mapping (returning-customer memory) and returns shop name + product availability so the AI can greet properly. On failure returns the reason for the AI to relay naturally.
- **`get_shop_packages(network?)`** — returns this shop's verified bundles/prices via `fetchShopBundles` (+ airtime limits, RC boards/prices). The AI must quote from this, never from memory.
- **`place_shop_order(...)`** — the money fence. Args: `service` (`data` | `airtime` | `rc`) + service-specific fields (network+bundle+recipient / recipient+amount / board+qty) + `payment_phone`. Re-validates everything server-side through the SAME paths the menu flow uses (`verifyBundlePrice`, `validateNetworkPrefix` + prefix config, airtime limits + `detectAirtimeNetwork`, RC availability/qty caps), then writes a `WaShopSession` at the appropriate `*_CONFIRM` step with `pendingOrderTable` etc. set exactly as the menu flow would. Returns the staged summary. It never creates the order row and never charges — the customer must still tap "1. Pay now" on the deterministic confirm screen, which runs the existing CONFIRM handler unchanged.

### Returning-customer memory

New table (migration):

```sql
CREATE TABLE wa_shop_customer_prefs (
  phone TEXT PRIMARY KEY,
  shop_code_id UUID NOT NULL REFERENCES ussd_shop_codes(id) ON DELETE CASCADE,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

RLS: service-role only (matches the app's locked-down convention). Written on every successful shop-code resolution (menu path AND `resolve_shop_code` tool) and refreshed on order confirm. Read at the start of `shopWaRouter`/`handleShopWithAI` when no active flow session exists: a remembered shop pre-fills the session's shop identity, so a returning customer's "hi" gets "Welcome back to *Kofi's Data Hub* 👋 — need data, airtime or a results checker today?" instead of "Enter shop code:". Typing a different valid shop code (menu or AI path) switches shops and updates the row. If the referenced shop code has since been deactivated, fall back to the enter-code prompt.

### Webhook changes (`app/api/whatsapp/webhook/route.ts`)

The shop branch (`isShopWhatsAppNumber`) gains:
1. The same per-sender inbound rate cap the main number has (currently the shop branch returns before the cap — with AI attached, a flooder could burn tokens).
2. The escape handling: `shopWaRouter` returning `''` → `await handleShopWithAI(...)` and send its reply.
3. Typing indicator (`sendWaTyping`) before AI runs, matching the main bot.

### Error handling

- AI provider failure/timeout → send the existing product menu (or enter-code menu) so the customer is never dead-ended; log the error.
- `place_shop_order` validation failure → tool returns the specific reason; the AI relays it naturally and asks for the correction (never stages a broken session).
- Deactivated/invalid remembered shop → clear pref row, fall back to enter-code flow.

### Testing (Vitest, mocked AI loop — no live model calls)

- Routing: freetext escapes to AI only from non-money steps; digits/natural-language equivalents stay in the menu flow; money steps re-prompt deterministically.
- `place_shop_order`: stages the exact session shape the menu flow produces (per product), re-validates prices server-side, rejects invalid input without staging.
- `resolve_shop_code` + prefs: writes/updates/reads the mapping; deactivated-shop fallback.
- Webhook shop branch: rate cap applies; `''` sentinel triggers AI handler.

## Out of scope (v1)

- Complaints/handoff/wallet tools on the shop number.
- Rewriting the numbered menu copy (AI provides the warmth; menus stay as-is, matching the main bot precedent).
- Image/vision support on the shop number.
- WhatsApp native interactive buttons/lists.
