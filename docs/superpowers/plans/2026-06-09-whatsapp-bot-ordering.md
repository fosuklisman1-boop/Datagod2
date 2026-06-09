# WhatsApp Bot Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a menu-driven WhatsApp ordering bot that mirrors the USSD flow — Data Bundles, Airtime, AFA Registration, Results Checker — by thinly adapting the existing USSD step handlers.

**Architecture:** A new webhook route (`app/api/whatsapp/webhook`) receives Meta Cloud API messages. If an active Redis session exists for the sender's phone number, the WhatsApp bot router handles the message by delegating to the existing USSD step handlers. If not, the existing WhatsApp AI handles it; when the AI detects ordering intent it calls a new `start_ordering_bot` tool which creates the session and sends the main menu. One WhatsApp-specific step (`WA_ENTER_PAYMENT_PHONE`) is inserted when MoMo payment is selected — it asks the user to type their billing number since WhatsApp cannot auto-derive it like USSD does.

**Tech Stack:** Next.js 15 `after()` for deferred processing, Upstash Redis (shared with USSD), Meta WhatsApp Cloud API v25.0, Supabase, existing `runAgenticLoop` + `executeToolCall` from the AI layer.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/ussd/types.ts` | Modify | Add `momoPhone` field + `WA_ENTER_PAYMENT_PHONE` step |
| `lib/whatsapp-bot/session.ts` | Create | Redis session helpers — same key namespace as USSD, 1800 s TTL |
| `lib/whatsapp-bot/send.ts` | Create | Send a text message via Meta Cloud API |
| `lib/whatsapp-bot/router.ts` | Create | Route message → USSD handler; intercept MoMo step; tag channels |
| `lib/ai-tools.ts` | Modify | Add `start_ordering_bot` tool + its `executeToolCall` case |
| `app/api/whatsapp/webhook/route.ts` | Create | GET (verify), POST (parse → bot or AI → reply → log) |
| `migrations/20260609_whatsapp_bot_ordering.sql` | Create | Add `channel` col to `ussd_orders` |

---

## Task 1: DB Migration — add `channel` to `ussd_orders`

**Files:**
- Create: `migrations/20260609_whatsapp_bot_ordering.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/20260609_whatsapp_bot_ordering.sql
ALTER TABLE ussd_orders
  ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'ussd';
```

- [ ] **Step 2: Run it against the database**

Open the Supabase dashboard → SQL Editor → paste and run the migration.
Expected: command completes without error; `ussd_orders` now has a `channel` column defaulting to `'ussd'`.

- [ ] **Step 3: Commit**

```bash
git add migrations/20260609_whatsapp_bot_ordering.sql
git commit -m "feat(db): add channel column to ussd_orders"
```

---

## Task 2: Type additions

**Files:**
- Modify: `lib/ussd/types.ts`

- [ ] **Step 1: Add `momoPhone` to `USSDSession` and `WA_ENTER_PAYMENT_PHONE` to `USSDStep`**

In `lib/ussd/types.ts`, make the following two edits:

Add `'WA_ENTER_PAYMENT_PHONE'` to the `USSDStep` union — append it after `'RC_VOUCHER_DETAIL'`:

```typescript
  | 'RC_MY_VOUCHERS'
  | 'RC_VOUCHER_DETAIL'
  | 'WA_ENTER_PAYMENT_PHONE'
```

Add `momoPhone` to `USSDSession` — append it after `rcSelectedOrderId`:

```typescript
  rcSelectedOrderId?: string
  // WhatsApp-only: MoMo billing number entered by the user at WA_ENTER_PAYMENT_PHONE step
  momoPhone?: string
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors related to these type changes.

- [ ] **Step 3: Commit**

```bash
git add lib/ussd/types.ts
git commit -m "feat(types): add WA_ENTER_PAYMENT_PHONE step and momoPhone session field"
```

---

## Task 3: WhatsApp session module

**Files:**
- Create: `lib/whatsapp-bot/session.ts`

**Key design note:** WhatsApp sessions use the **same** Redis key prefix as USSD (`ussd:session:{phone}`). This means the existing USSD handlers' `setSession()` calls transparently update the correct key. After every handler call the WhatsApp router extends the TTL to 1800 s (the USSD handlers reset it to 120 s).

- [ ] **Step 1: Create the session module**

```typescript
// lib/whatsapp-bot/session.ts
import { Redis } from "@upstash/redis"
import { USSDSession } from "@/lib/ussd/types"

const WA_SESSION_TTL = 1800 // 30 minutes

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
} catch (e) {
  console.error("[WA-SESSION] Failed to initialise Redis:", e)
}

// Same key format as lib/ussd/session.ts — USSD handlers call setSession(sessionId, ...)
// which writes to this same key, so handler state changes are visible here.
function sessionKey(phone: string): string {
  return `ussd:session:${phone}`
}

export async function getWaSession(phone: string): Promise<USSDSession | null> {
  if (!redis) return null
  try {
    return await redis.get<USSDSession>(sessionKey(phone))
  } catch (e) {
    console.error("[WA-SESSION] get error:", e)
    return null
  }
}

export async function setWaSession(phone: string, session: USSDSession): Promise<void> {
  if (!redis) return
  try {
    await redis.setex(sessionKey(phone), WA_SESSION_TTL, JSON.stringify(session))
  } catch (e) {
    console.error("[WA-SESSION] set error:", e)
  }
}

export async function deleteWaSession(phone: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(sessionKey(phone))
  } catch (e) {
    console.error("[WA-SESSION] delete error:", e)
  }
}

// Called after every USSD handler to restore the 30-min TTL
// (handlers internally call setSession which resets TTL to 120 s)
export async function extendWaSession(phone: string): Promise<void> {
  if (!redis) return
  try {
    await redis.expire(sessionKey(phone), WA_SESSION_TTL)
  } catch (e) {
    console.error("[WA-SESSION] extend error:", e)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/whatsapp-bot/session.ts
git commit -m "feat(whatsapp-bot): add session module (wa: prefix, 1800 s TTL)"
```

---

## Task 4: WhatsApp send client

**Files:**
- Create: `lib/whatsapp-bot/send.ts`

- [ ] **Step 1: Create the send module**

```typescript
// lib/whatsapp-bot/send.ts
const GRAPH_API_VERSION = "v25.0"

export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN

  if (!phoneNumberId || !token) {
    console.error("[WA-SEND] WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set")
    return
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error("[WA-SEND] API error:", res.status, err)
    }
  } catch (e) {
    console.error("[WA-SEND] fetch error:", e)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/whatsapp-bot/send.ts
git commit -m "feat(whatsapp-bot): add WhatsApp Cloud API text sender"
```

---

## Task 5: WhatsApp bot router

**Files:**
- Create: `lib/whatsapp-bot/router.ts`

This is the core file. It routes each message to the correct USSD handler, extends the session TTL after each call, intercepts the three MoMo payment steps to insert `WA_ENTER_PAYMENT_PHONE`, and tags completed orders with `channel: 'whatsapp'`. It also reconstructs bundle list menus from the session cache to avoid USSD's 160-char truncation.

- [ ] **Step 1: Create the router**

```typescript
// lib/whatsapp-bot/router.ts
import { createClient } from "@supabase/supabase-js"
import { getWaSession, setWaSession, deleteWaSession, extendWaSession } from "./session"
import { USSDSession, UzoResponse } from "@/lib/ussd/types"
import { handleMain } from "@/lib/ussd/handlers/main"
import {
  handleSelectNetwork, handleSelectBundle, handleEnterRecipient,
  handleConfirm, handlePaymentMethod, handleSubmitOtp,
} from "@/lib/ussd/handlers/bundles"
import {
  handleAfaEnterName, handleAfaEnterCard, handleAfaEnterLocation,
  handleAfaEnterRegion, handleAfaConfirm,
} from "@/lib/ussd/handlers/afa"
import {
  handleAirtimeEnterRecipient, handleAirtimeSelectNetwork,
  handleAirtimeEnterAmount, handleAirtimeConfirm, handleAirtimePaymentMethod,
} from "@/lib/ussd/handlers/airtime"
import {
  handleRcMenu, handleRcSelectBoard, handleRcEnterQty, handleRcConfirm,
  handleRcPaymentMethod, handleRcMyVouchers, handleRcVoucherDetail,
} from "@/lib/ussd/handlers/results-checker"
import { handleOtpSubmit } from "@/lib/ussd/handlers/otp"
import { handleStatus } from "@/lib/ussd/handlers/status"
import {
  mainMenu, bundleMenu, paymentMethodMenu,
  airtimePaymentMethodMenu, rcPaymentMethodMenu,
} from "@/lib/ussd/menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function waRouter(phone: string, text: string): Promise<string> {
  const sessionId = phone
  const session = await getWaSession(sessionId)

  if (!session) {
    return 'Your session expired. Send a message to start a new order.'
  }

  const input = text.trim()
  let result: UzoResponse
  // Used to override the (possibly truncated) message from a handler
  let overrideMessage: string | null = null

  switch (session.step) {
    case 'MAIN':
      result = await handleMain(input, sessionId, session.dialingPhone ?? phone)
      break

    case 'SELECT_NETWORK':
      result = await handleSelectNetwork(input, sessionId, session)
      // Re-render bundle list from session cache to avoid 160-char USSD truncation
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'SELECT_BUNDLE' && s2.bundleCache) {
          overrideMessage = bundleMenu(s2.bundleCache, s2.bundlePage ?? 0, s2.bundleTotal ?? 0)
        }
      }
      break

    case 'SELECT_BUNDLE':
      result = await handleSelectBundle(input, sessionId, session)
      if (result.ussdServiceOp === 2) {
        const s2 = await getWaSession(sessionId)
        if (s2?.step === 'SELECT_BUNDLE' && s2.bundleCache) {
          overrideMessage = bundleMenu(s2.bundleCache, s2.bundlePage ?? 0, s2.bundleTotal ?? 0)
        }
      }
      break

    case 'ENTER_RECIPIENT':
      result = await handleEnterRecipient(input, sessionId, session)
      break

    case 'CONFIRM':
      result = await handleConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'ussd_orders', result.ussdServiceOp === 17)
      }
      break

    case 'PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handlePaymentMethod(input, sessionId, session)
      }
      break

    case 'SUBMIT_OTP':
      if (session.pendingOrderTable === 'airtime_orders' || session.pendingOrderTable === 'results_checker_orders') {
        result = await handleOtpSubmit(input, session.pendingOrderId!, session.pendingOrderTable)
      } else {
        result = await handleSubmitOtp(input, sessionId, session)
      }
      break

    case 'CHECK_STATUS':
      result = await handleStatus(input, sessionId, session)
      break

    case 'AFA_ENTER_NAME':
      result = await handleAfaEnterName(input, sessionId, session)
      break
    case 'AFA_ENTER_CARD':
      result = await handleAfaEnterCard(input, sessionId, session)
      break
    case 'AFA_ENTER_LOCATION':
      result = await handleAfaEnterLocation(input, sessionId, session)
      break
    case 'AFA_ENTER_REGION':
      result = await handleAfaEnterRegion(input, sessionId, session)
      break
    case 'AFA_CONFIRM_AFA':
      result = await handleAfaConfirm(input, sessionId, session)
      break

    case 'AIRTIME_ENTER_RECIPIENT':
      result = await handleAirtimeEnterRecipient(input, sessionId, session)
      break
    case 'AIRTIME_SELECT_NETWORK':
      result = await handleAirtimeSelectNetwork(input, sessionId, session)
      break
    case 'AIRTIME_ENTER_AMOUNT':
      result = await handleAirtimeEnterAmount(input, sessionId, session)
      break
    case 'AIRTIME_CONFIRM':
      result = await handleAirtimeConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'airtime_orders', false)
      }
      break
    case 'AIRTIME_PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleAirtimePaymentMethod(input, sessionId, session)
      }
      break

    case 'RC_MENU':
      result = await handleRcMenu(input, sessionId, session)
      break
    case 'RC_MY_VOUCHERS':
      result = await handleRcMyVouchers(input, sessionId, session)
      break
    case 'RC_VOUCHER_DETAIL':
      result = await handleRcVoucherDetail(input, sessionId, session)
      break
    case 'RC_SELECT_BOARD':
      result = await handleRcSelectBoard(input, sessionId, session)
      break
    case 'RC_ENTER_QTY':
      result = await handleRcEnterQty(input, sessionId, session)
      break
    case 'RC_CONFIRM':
      result = await handleRcConfirm(input, sessionId, session)
      if (input === '1') {
        void tagOrderChannel(sessionId, phone, 'results_checker_orders', false)
      }
      break
    case 'RC_PAYMENT_METHOD':
      if (input === '2') {
        await setWaSession(sessionId, { ...session, step: 'WA_ENTER_PAYMENT_PHONE' })
        result = { message: 'Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Cancel', ussdServiceOp: 2 }
      } else {
        result = await handleRcPaymentMethod(input, sessionId, session)
      }
      break

    case 'WA_ENTER_PAYMENT_PHONE':
      result = await handleWaEnterPaymentPhone(input, sessionId, session)
      break

    default:
      await setWaSession(sessionId, { step: 'MAIN', dialingPhone: phone })
      result = { message: mainMenu(), ussdServiceOp: 2 }
  }

  if (result.ussdServiceOp === 17) {
    await deleteWaSession(sessionId)
  } else {
    // USSD handlers call setSession() which resets TTL to 120 s — restore to 30 min
    await extendWaSession(sessionId)
  }

  return overrideMessage ?? result.message
}

// ── WA_ENTER_PAYMENT_PHONE ────────────────────────────────────────────────────

async function handleWaEnterPaymentPhone(
  input: string,
  sessionId: string,
  session: USSDSession
): Promise<UzoResponse> {
  // Determine originating payment step from pendingOrderTable
  const parentStep = session.pendingOrderTable === 'airtime_orders'
    ? 'AIRTIME_PAYMENT_METHOD'
    : session.pendingOrderTable === 'results_checker_orders'
      ? 'RC_PAYMENT_METHOD'
      : 'PAYMENT_METHOD'

  if (input.trim() === '0') {
    const amount = parentStep === 'PAYMENT_METHOD' ? (session.bundlePrice ?? 0)
      : parentStep === 'AIRTIME_PAYMENT_METHOD' ? (session.airtimeAmount ?? 0)
      : (session.rcTotal ?? 0)
    const balance = session.walletBalance ?? 0
    const menu = parentStep === 'PAYMENT_METHOD' ? paymentMethodMenu(amount, balance)
      : parentStep === 'AIRTIME_PAYMENT_METHOD' ? airtimePaymentMethodMenu(amount, balance)
      : rcPaymentMethodMenu(amount, balance)
    await setWaSession(sessionId, { ...session, step: parentStep as USSDSession['step'] })
    return { message: menu, ussdServiceOp: 2 }
  }

  const raw = input.trim().replace(/\s+/g, '')
  const local = raw.startsWith('+233') ? '0' + raw.slice(4)
    : raw.startsWith('233') ? '0' + raw.slice(3)
    : raw

  if (!/^0[0-9]{9}$/.test(local)) {
    return {
      message: 'Invalid number.\nEnter a valid Ghana\nMoMo number:\n(e.g. 0244123456)\n\n0. Cancel',
      ussdServiceOp: 2,
    }
  }

  // Overwrite dialingPhone with the entered MoMo number so USSD payment
  // handlers derive the correct Paystack provider and charge the right account.
  const updatedSession: USSDSession = {
    ...session,
    dialingPhone: local,
    momoPhone: local,
    step: parentStep as USSDSession['step'],
  }
  await setWaSession(sessionId, updatedSession)

  if (parentStep === 'PAYMENT_METHOD') return handlePaymentMethod('2', sessionId, updatedSession)
  if (parentStep === 'AIRTIME_PAYMENT_METHOD') return handleAirtimePaymentMethod('2', sessionId, updatedSession)
  return handleRcPaymentMethod('2', sessionId, updatedSession)
}

// ── Channel tagging ───────────────────────────────────────────────────────────

async function tagOrderChannel(
  sessionId: string,
  phone: string,
  table: 'ussd_orders' | 'airtime_orders' | 'results_checker_orders',
  isDirectCharge: boolean
): Promise<void> {
  try {
    const s2 = await getWaSession(sessionId)
    const orderId = s2?.pendingOrderId
    if (orderId) {
      await supabase.from(table).update({ channel: 'whatsapp' }).eq("id", orderId)
      return
    }
    if (isDirectCharge && table === 'ussd_orders') {
      // Direct charge path: order was created inside handler, pendingOrderId not set in session.
      // Find the most recently created order for this phone (within 30 s) and tag it.
      const cutoff = new Date(Date.now() - 30_000).toISOString()
      await supabase.from("ussd_orders")
        .update({ channel: 'whatsapp' })
        .eq("dialing_phone", phone)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
    }
  } catch (e) {
    console.warn("[WA-ROUTER] tagOrderChannel failed (non-fatal):", e)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If `handleStatus` import is missing, check `lib/ussd/handlers/status.ts` exports it as `handleStatus`.

- [ ] **Step 3: Commit**

```bash
git add lib/whatsapp-bot/router.ts
git commit -m "feat(whatsapp-bot): add bot router delegating to USSD handlers"
```

---

## Task 6: `start_ordering_bot` AI tool

**Files:**
- Modify: `lib/ai-tools.ts`

The `start_ordering_bot` tool is added to the `whatsapp` context tool list. Its `executeToolCall` case creates the WhatsApp session and returns the main menu text.

- [ ] **Step 1: Add the tool schema** — in `lib/ai-tools.ts`, find the `whatsapp` tool list (search for `if (context === "whatsapp") return [`) and add `startOrderingBotTool` to it.

First, define the tool near the top of the tools section (after the other tool definitions, around line 800):

```typescript
const startOrderingBotTool: Anthropic.Tool = {
  name: "start_ordering_bot",
  description: "Switch the conversation to the structured ordering menu. Call this when the user expresses intent to buy a data bundle, airtime, AFA registration, or results checker vouchers. Do not call this for general queries about pricing or services.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone: {
        type: "string",
        description: "The user's WhatsApp phone number as received from Meta webhook (e.g. '233559919037').",
      },
    },
    required: ["phone"],
  },
}
```

Then add it to the `whatsapp` context return array:

```typescript
if (context === "whatsapp") return [
  getAvailablePackagesTool,
  searchOrderStatusTool,
  getWalletBalanceTool,
  getWalletTransactionsTool,
  getOrderHistoryTool,
  placeWalletOrderTool,
  getSubscriptionPlansTool,
  notifySelfTool,
  getKnowledgeBaseTool,
  startOrderingBotTool,   // ← add this line
]
```

- [ ] **Step 2: Add the `executeToolCall` case** — in the `executeToolCall` function's `switch (name)`, add a new case. Place it after the `"place_wallet_order"` case:

```typescript
case "start_ordering_bot": {
  const { setWaSession } = await import("@/lib/whatsapp-bot/session")
  const { mainMenu } = await import("@/lib/ussd/menus")
  const phone = String(input.phone ?? "").trim()
  if (!phone) return { error: "phone is required" }
  await setWaSession(phone, { step: "MAIN", dialingPhone: phone })
  return { message: mainMenu() }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/ai-tools.ts
git commit -m "feat(ai-tools): add start_ordering_bot tool for WhatsApp ordering handoff"
```

---

## Task 7: Webhook route

**Files:**
- Create: `app/api/whatsapp/webhook/route.ts`

This is the Meta webhook endpoint. GET verifies the webhook with Meta. POST processes inbound messages: returns 200 immediately, then in `after()` logs the message, routes to bot or AI, sends the reply, and logs the outbound message.

For the AI path: loads conversation history from `whatsapp_messages`, builds a system prompt, calls `runAgenticLoop` with `context: "whatsapp"`. The AI's `start_ordering_bot` tool creates the Redis session; the AI's text response is the outbound message.

- [ ] **Step 1: Create the webhook route**

```typescript
// app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getWaSession } from "@/lib/whatsapp-bot/session"
import { waRouter } from "@/lib/whatsapp-bot/router"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { resolveProviderForContext, DEFAULT_CONFIG, AIProviderConfig } from "@/lib/ai-providers"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── GET: Meta webhook verification ───────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WA-WEBHOOK] Webhook verified")
    return new Response(challenge ?? "", { status: 200 })
  }
  return new Response("Forbidden", { status: 403 })
}

// ── POST: Inbound message ─────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ status: "ok" }, { status: 200 })
  }

  // Return 200 immediately — Meta requires a response within 5 s
  after(async () => {
    try {
      await processInbound(body)
    } catch (e) {
      console.error("[WA-WEBHOOK] processInbound error:", e)
    }
  })

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ── Core processing ───────────────────────────────────────────────────────────

async function processInbound(body: unknown): Promise<void> {
  const entry = (body as any)?.entry?.[0]
  const change = entry?.changes?.[0]?.value
  const messages: any[] = change?.messages ?? []
  if (messages.length === 0) return // status update or other event — ignore

  const msg = messages[0]
  if (msg.type !== "text") return // ignore non-text (images, reactions, etc.)

  const from: string = msg.from   // e.g. "233559919037"
  const text: string = msg.text?.body ?? ""
  if (!from || !text.trim()) return

  console.log("[WA-WEBHOOK] Inbound:", { from, text: text.slice(0, 60) })

  // Log inbound message
  await logMessage(from, "inbound", text, msg.id)

  // Route: bot session active → bot router; else → AI
  const session = await getWaSession(from)
  let reply: string

  if (session) {
    reply = await waRouter(from, text)
  } else {
    reply = await handleWithAI(from, text)
  }

  if (reply) {
    await sendWhatsAppText(from, reply)
    await logMessage(from, "outbound", reply, null)
  }
}

// ── AI handler (non-bot messages) ────────────────────────────────────────────

async function handleWithAI(phone: string, text: string): Promise<string> {
  // Load AI config
  let aiConfig: AIProviderConfig = DEFAULT_CONFIG
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "ai_provider_config")
      .maybeSingle()
    if (data?.value) aiConfig = data.value as AIProviderConfig
  } catch {}

  const { provider, model } = resolveProviderForContext("whatsapp", aiConfig)

  // Load matched user (if phone is a registered Datagod user)
  let userId: string | undefined
  const localPhone = phone.startsWith("233") ? "0" + phone.slice(3) : phone
  try {
    const { data: userRow } = await supabase
      .from("users")
      .select("id")
      .eq("phone_number", localPhone)
      .maybeSingle()
    userId = userRow?.id
  } catch {}

  // Load last 20 messages for conversation history
  const { data: history } = await supabase
    .from("whatsapp_messages")
    .select("direction, message")
    .eq("phone_number", phone)
    .in("direction", ["inbound", "outbound"])
    .order("created_at", { ascending: false })
    .limit(20)

  const messages: Array<{ role: "user" | "assistant"; content: string }> = (history ?? [])
    .reverse()
    .filter(m => m.message)
    .map(m => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.message! }))

  // Append current message
  messages.push({ role: "user", content: text })

  const system = `You are the Datagod assistant on WhatsApp. Datagod is a data bundle reseller in Ghana.
You help users with: buying data bundles, airtime, AFA registration, and results checker vouchers.
The user's WhatsApp number is ${phone}${userId ? " and they have a registered Datagod account" : ""}.
When the user wants to buy something, call the start_ordering_bot tool — do not describe menus in text.
For support questions, order status, and account queries, answer directly.`

  const result = await runAgenticLoop({
    provider,
    model,
    system,
    context: "whatsapp",
    messages,
    toolCtx: {
      userId,
      userRole: userId ? "dashboard" : "guest",
      baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    },
    maxIterations: 5,
    maxTokens: 600,
  })

  return result.text
}

// ── DB logging ────────────────────────────────────────────────────────────────

async function logMessage(
  phone: string,
  direction: "inbound" | "outbound",
  message: string,
  metaMessageId: string | null
): Promise<void> {
  try {
    // Upsert conversation record
    const { data: conv } = await supabase
      .from("whatsapp_conversations")
      .upsert({ phone_number: phone }, { onConflict: "phone_number" })
      .select("id")
      .maybeSingle()

    const conversationId = conv?.id ?? null

    await supabase.from("whatsapp_messages").insert({
      conversation_id: conversationId,
      direction,
      phone_number: phone,
      message,
      meta_message_id: metaMessageId,
      status: "sent",
    })

    // Update conversation preview
    const updatePayload: Record<string, unknown> = {
      last_message_preview: message.slice(0, 100),
      updated_at: new Date().toISOString(),
    }
    if (direction === "inbound") updatePayload.latest_inbound_at = new Date().toISOString()
    else updatePayload.latest_outbound_at = new Date().toISOString()

    if (conversationId) {
      await supabase.from("whatsapp_conversations")
        .update(updatePayload)
        .eq("id", conversationId)
    }
  } catch (e) {
    console.warn("[WA-WEBHOOK] logMessage failed (non-fatal):", e)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Add the three new env vars to `.env.local`**

```
WHATSAPP_ACCESS_TOKEN=<your Meta access token>
WHATSAPP_PHONE_NUMBER_ID=1221459431043932
WHATSAPP_VERIFY_TOKEN=<choose a random secret string>
```

- [ ] **Step 4: Commit**

```bash
git add app/api/whatsapp/webhook/route.ts
git commit -m "feat(whatsapp): add webhook route — bot routing + AI fallback + message logging"
```

---

## Task 8: Build verification

- [ ] **Step 1: Run the Next.js build to catch any remaining type or import errors**

```bash
npm run build
```

Expected: build completes without errors. Warnings about unused variables are acceptable; actual errors must be fixed before proceeding.

- [ ] **Step 2: Start the dev server**

```bash
npm run dev
```

Expected: server starts on port 3000 without errors.

- [ ] **Step 3: Verify the GET verification endpoint works locally**

```bash
curl "http://localhost:3000/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test123"
```

Expected: response body is `test123`.

- [ ] **Step 4: Test the POST endpoint with a simulated inbound message** (no real Meta webhook needed yet)

```bash
curl -X POST http://localhost:3000/api/whatsapp/webhook \
  -H "Content-Type: application/json" \
  -d '{"entry":[{"changes":[{"value":{"messages":[{"from":"233559919037","type":"text","text":{"body":"hi"},"id":"test-id"}]}}]}]}'
```

Expected: `{"status":"ok"}` — no crash. Check dev server logs for `[WA-WEBHOOK] Inbound:` entry.

- [ ] **Step 5: Commit**

```bash
git commit -m "build: verify WhatsApp bot builds and webhook endpoint responds"
```

---

## Task 9: Register webhook with Meta

These are manual steps in the Meta developer dashboard.

- [ ] **Step 1: Deploy to a public URL** (Vercel, or use `ngrok` for local testing)

For local testing:
```bash
npx ngrok http 3000
```
Note the `https://xxxx.ngrok-free.app` URL.

- [ ] **Step 2: Register the webhook in Meta dashboard**

1. Go to https://developers.facebook.com → your app → WhatsApp → Configuration
2. Under **Webhook**, click **Edit**
3. Set **Callback URL**: `https://YOUR_DOMAIN/api/whatsapp/webhook`
4. Set **Verify token**: the value of `WHATSAPP_VERIFY_TOKEN` from your env
5. Click **Verify and save** — Meta calls GET on your URL; it should return the challenge
6. Under **Webhook fields**, subscribe to **messages**

- [ ] **Step 3: Send a test message to +233 55 991 9037**

Send "hi" from your personal WhatsApp. Expected: the bot's AI replies with a greeting.
Send "I want to buy data". Expected: AI calls `start_ordering_bot` and you see the main ordering menu.

- [ ] **Step 4: Walk through a full data bundle order**

1. Reply `1` → Select Network menu
2. Reply `1` (MTN) → Bundle list (should show full bundles, not truncated at 160 chars)
3. Reply `1` → Enter recipient prompt
4. Reply a valid number (e.g. `0244123456`) → Confirm screen
5. Reply `1` → Payment method screen
6. Reply `2` (MoMo) → "Enter MoMo number" prompt
7. Reply a valid number → OTP prompt
8. Reply `0` (cancel) → Session ends

Expected at each step: correct menu text, no truncation on bundle list, session cleans up after cancel.

---

## Post-implementation notes

- **Token rotation:** The Meta access token shown in the dashboard screenshot is temporary. Generate a permanent system user token in Meta Business Manager → System Users.
- **Phone number verification:** The Meta dashboard shows a warning to verify the phone number `+233 55 991 9037`. Complete phone number verification in the Meta dashboard before testing with real users.
- **v2 improvement:** Add WhatsApp number pre-fill at MoMo step — "Charge 0559919037? 1. Yes  2. Enter different number" — reduces one step for users whose WhatsApp = MoMo number.
- **v2 improvement:** Add `channel: 'whatsapp'` tagging to `ussd_orders` direct-charge path by storing `pendingOrderId` in session inside `handleConfirm` (requires a minor change to `lib/ussd/handlers/bundles.ts`).
