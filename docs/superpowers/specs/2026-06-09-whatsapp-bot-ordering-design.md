# WhatsApp Bot Ordering — Design Spec

**Date:** 2026-06-09
**Status:** Approved
**Branch:** feat/whatsapp-bot-ordering (to be created)

---

## Overview

A WhatsApp ordering bot that mirrors the existing USSD flow — same 4 services (Data Bundles, Airtime, AFA Registration, Results Checker), same numbered-text menus, same payment options (Datagod Wallet or MoMo prompt). Built as a thin adapter over the existing USSD step handlers rather than a rewrite, giving near-zero business logic duplication.

The bot coexists with the existing WhatsApp AI support chat. The AI detects when a user wants to place an order and hands off to the bot by calling a `start_ordering_bot` tool. Once the ordering session is active, every subsequent message is routed to the bot until the user exits or the session expires.

---

## Architecture

### Message routing

```
Incoming WhatsApp message
  → POST /api/whatsapp/webhook
      ↓
  Check Redis: wa:session:{phone}
      ├─ Session exists  → WhatsApp Bot Router → USSD step handler → reply
      └─ No session      → WhatsApp AI (called directly from webhook route
                         |  using lib/ai-providers.ts + lib/ai-tools.ts context="whatsapp")
                              └─ Ordering intent? → call start_ordering_bot tool
                                                       → set session {step: 'MAIN'}
                                                       → send main menu
```

### Session lifecycle

- **Created:** when the AI calls `start_ordering_bot`
- **Key:** `wa:session:{phone}` in Redis (same Upstash instance as USSD)
- **TTL:** 1800 s (30 min) — reset on each message
- **Deleted:** when user presses `0` to exit, when a final order confirmation is sent (`ussdServiceOp: 17`), or on natural TTL expiry
- **On TTL expiry:** next message from user goes to AI; bot sends no session-expired message proactively

The session uses the existing `USSDSession` type from `lib/ussd/types.ts` unchanged, plus one new field `momoPhone` (see Payment section).

---

## Bot Router

`lib/whatsapp-bot/router.ts` — takes `{ phone, text }`, reads the active session from Redis, and delegates to USSD step handlers exactly as `lib/ussd/router.ts` does, with two differences:

1. `sessionID` = phone number (WhatsApp number acts as session ID)
2. Inserts the `WA_ENTER_PAYMENT_PHONE` step when MoMo is selected (see Payment section)

The router does **not** call `lib/ussd/router.ts` directly — it duplicates only the switch statement (dispatching to handlers), not the USSD-specific `op=1` re-dial logic.

All 20 USSD step handlers are called unchanged:
`handleMain`, `handleSelectNetwork`, `handleSelectBundle`, `handleEnterRecipient`, `handleConfirm`, `handlePaymentMethod`, `handleSubmitOtp`, `handleStatus`, `handleAfaEnterName`, `handleAfaEnterCard`, `handleAfaEnterLocation`, `handleAfaEnterRegion`, `handleAfaConfirm`, `handleAirtimeEnterRecipient`, `handleAirtimeSelectNetwork`, `handleAirtimeEnterAmount`, `handleAirtimeConfirm`, `handleAirtimePaymentMethod`, all RC handlers, `handleOtpSubmit`.

---

## Webhook Route

**File:** `app/api/whatsapp/webhook/route.ts`

### GET — Meta webhook verification
```
Query params: hub.mode, hub.verify_token, hub.challenge
Verify: hub.mode === 'subscribe' && hub.verify_token === process.env.WHATSAPP_VERIFY_TOKEN
Return: hub.challenge as plain text (200) or 403
```

### POST — Inbound message
```
1. Parse Meta webhook body → extract phone (entry[0].changes[0].value.messages[0].from)
                                       and text (messages[0].text.body)
2. Immediately return 200 OK (Meta requires < 5 s)
3. Process in after() (Next.js deferred execution):
   a. Log inbound message to whatsapp_messages table
   b. Check Redis for wa:session:{phone}
   c. If session → waRouter(phone, text) → sendWhatsAppText(phone, reply)
   d. If no session → call AI directly (lib/ai-providers.ts, context="whatsapp") → sendWhatsAppText(phone, reply)
   e. Log outbound message to whatsapp_messages table
4. Ignore non-text message types (status updates, reactions, etc.)
```

Shared secret: `process.env.WHATSAPP_VERIFY_TOKEN` — set in Meta dashboard and env.

---

## WhatsApp Send Client

**File:** `lib/whatsapp-bot/send.ts`

```typescript
export async function sendWhatsAppText(to: string, body: string): Promise<void>
```

Posts to `https://graph.facebook.com/v25.0/{WHATSAPP_PHONE_NUMBER_ID}/messages`:
```json
{
  "messaging_product": "whatsapp",
  "to": "{to}",
  "type": "text",
  "text": { "body": "{body}" }
}
```
Authorization: `Bearer {WHATSAPP_ACCESS_TOKEN}`

Logs errors but does not throw — a failed send should not crash the webhook handler.

---

## Payment Flow

### Wallet (option 1) — unchanged
Debit wallet balance immediately. No extra steps.

### MoMo prompt (option 2) — new `WA_ENTER_PAYMENT_PHONE` step

On USSD the billing number is the dialing phone (MSISDN), auto-provided by the telecom. On WhatsApp there is no automatic billing number — the user must enter it.

**New session step:** `WA_ENTER_PAYMENT_PHONE`

**Flow:**
```
User selects "2. MoMo prompt"
  → Bot router intercepts before calling Paystack charge
  → Sets step = WA_ENTER_PAYMENT_PHONE
  → Sends: "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel"

User replies with number (e.g. "0244123456")
  → Validate: Ghanaian mobile number format (10 digits starting with 0)
  → Store as session.momoPhone
  → Continue into the standard MoMo charge + OTP flow
```

**Applies to:** Data Bundles (`PAYMENT_METHOD`), Airtime (`AIRTIME_PAYMENT_METHOD`), Results Checker (`RC_PAYMENT_METHOD`).

**Session type addition:**
```typescript
// Added to USSDSession in lib/ussd/types.ts
momoPhone?: string   // WhatsApp-only: MoMo number entered by user
```

**`WA_ENTER_PAYMENT_PHONE` added to `USSDStep` union type.**

**Future improvement (not in v1):** offer to pre-fill from the user's WhatsApp number — "Charge 0559919037? 1. Yes  2. Enter different number" — saves a step for users whose WhatsApp = MoMo number.

---

## OTP Flow

On USSD, users close the session and redial the USSD code to enter their OTP — the `op=1` init logic detects pending OTP orders. On WhatsApp, the session stays alive in `SUBMIT_OTP` step and the user simply replies with their OTP in the same chat. The existing `handleSubmitOtp` and `handleOtpSubmit` handlers work unchanged — they read `pendingOrderId` from the session.

No re-dial detection logic is needed on WhatsApp.

---

## 160-char Truncation Fix

`lib/ussd/menus.ts` currently truncates all messages at 160 characters (USSD screen limit). WhatsApp supports up to 4096 characters. The fix: add an optional `limit` parameter to `cont()` and `end()` with a default of 160, and export a `WHATSAPP_MSG_LIMIT = 4096` constant. The WhatsApp bot router passes this limit when calling any menu function that builds variable-length content (primarily `bundleMenu`).

The change is backwards-compatible — all existing USSD callers are unaffected.

---

## AI Tool: `start_ordering_bot`

Added to the `whatsapp` context tools in `lib/ai-tools.ts`:

```typescript
{
  name: "start_ordering_bot",
  description: "Switch the conversation to the structured ordering menu. Call this when the user expresses intent to buy a data bundle, airtime, AFA registration, or results checker vouchers.",
  input_schema: {
    type: "object",
    properties: {
      phone: { type: "string", description: "User's WhatsApp phone number e.g. '233559919037'" }
    },
    required: ["phone"]
  }
}
```

**Tool execution** (handled inside the new webhook route `app/api/whatsapp/webhook/route.ts`):
1. Call `setWaSession(phone, { step: 'MAIN', dialingPhone: phone })`
2. Return `mainMenu()` text as the tool result
3. AI sends main menu text to the user

After this, the next user message finds an active session and routes to the bot.

---

## Order Channel Tagging

All WhatsApp-originated orders are tagged `channel: 'whatsapp'`:

| Table | Channel column | Current values | Change |
|-------|----------------|---------------|--------|
| `ussd_orders` | Does not exist | — | Add column, default `'ussd'` |
| `airtime_orders` | Exists | `'ussd'` | Pass `'whatsapp'` from WA handlers |
| `results_checker_orders` | Exists | `'ussd'` | Pass `'whatsapp'` from WA handlers |

The USSD router's `op=1` OTP-resume query already filters `airtime_orders` and `results_checker_orders` by `channel: 'ussd'`, so WhatsApp orders are not accidentally picked up by USSD re-dial logic.

---

## Database Migration

```sql
-- Add channel column to ussd_orders (data bundle orders)
ALTER TABLE ussd_orders
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'ussd';
```

No other schema changes. The `whatsapp_conversations` and `whatsapp_messages` tables already exist from the earlier migration.

---

## Environment Variables

| Variable | Value | Note |
|----------|-------|------|
| `WHATSAPP_ACCESS_TOKEN` | Meta access token | Rotate periodically |
| `WHATSAPP_PHONE_NUMBER_ID` | `1221459431043932` | From Meta dashboard |
| `WHATSAPP_VERIFY_TOKEN` | Custom secret | Set in both Meta dashboard and env |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `9824428731161933` | Optional — for future use |

---

## New & Modified Files

### New files (4)
```
app/api/whatsapp/webhook/route.ts   — Meta webhook endpoint
lib/whatsapp-bot/session.ts         — Redis session helpers (wa: prefix, 1800s TTL)
lib/whatsapp-bot/send.ts            — WhatsApp Cloud API text sender
lib/whatsapp-bot/router.ts          — Bot router + WA_ENTER_PAYMENT_PHONE handler
```

### Modified files (3)
```
lib/ussd/menus.ts    — Add optional limit param to cont()/end()
lib/ussd/types.ts    — Add momoPhone field + WA_ENTER_PAYMENT_PHONE step
lib/ai-tools.ts      — Add start_ordering_bot tool to whatsapp context
```

### Migration (1)
```
migrations/20260609_whatsapp_bot_ordering.sql — Add channel col to ussd_orders
```

---

## Full Conversation Example

```
User:  "I want to buy data"
AI:    [calls start_ordering_bot({phone: "233559919037"})]
       "Welcome to Datagod
        1. Buy Data Bundle
        2. Buy Airtime
        3. AFA Registration
        4. Results Checker
        0. Exit"

User:  "1"
Bot:   "Select Network:
        1. MTN
        2. Telecel
        3. AirtelTigo
        4. AT-iShare
        0. Back"

User:  "1"
Bot:   "Select Bundle:
        1. 500MB - GHS 3.50
        2. 1GB - GHS 6.50
        3. 2GB - GHS 12.00
        4. 5GB - GHS 28.00
        5. 10GB - GHS 50.00
        6. More...
        0. Back"

User:  "2"
Bot:   "Enter recipient number
        (who gets the data):
        0. Back"

User:  "0244123456"
Bot:   "Confirm:
        1GB MTN
        To: 0244123456
        GHS 6.50 from 0559919037

        1. Pay now
        2. Cancel"

User:  "1"
Bot:   "Pay GHS 6.50
        1. Datagod Wallet (GHS 20.00)
        2. MoMo prompt
        0. Cancel"

User:  "2"
Bot:   "Enter MoMo number to charge:
        (e.g. 0244123456)

        0. Cancel"

User:  "0559919037"
Bot:   "Enter the OTP sent
        to your phone:

        0. Cancel"

User:  "123456"
Bot:   "✅ Order placed! 1GB MTN bundle sent to 0244123456."
       [session deleted — next message goes to AI]
```
