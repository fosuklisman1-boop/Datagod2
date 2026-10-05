# Hubtel USSD — Core + Main-Mode Data Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Hubtel Programmable Services channel end-to-end for the **main-mode data bundle** purchase: interaction endpoint, AddToCart payment, fulfilment webhook, callback via a fixed-IP DigitalOcean relay, status-check + retry crons, and the `/admin/ussd-hubtel` config page. Ships dark (kill switch off).

**Architecture:** A new self-contained `lib/ussd-hubtel/` module with its own router, Redis session, menus (real network names) and payment lifecycle keyed by a new `hubtel_transactions` table. It reuses pure catalog/price logic from the Uzo flow but does **not** modify the Uzo routers or the 1,642-line Paystack webhook. Outbound Hubtel calls (fulfilment callback, status check) go through a thin authenticated relay on a DigitalOcean droplet whose fixed IP is whitelisted by Hubtel.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, Supabase (service-role client), Upstash Redis, Vitest, plain Node `http` for the relay (run with `tsx` on the droplet).

**Spec:** `docs/superpowers/specs/2026-10-05-hubtel-ussd-design.md`

## Decomposition (read first)

The approved spec covers more than one plan's worth of work. It is split into three plans, each shipping working, testable software:

1. **This plan** — core infrastructure + main-mode **data bundles** (vertical slice). AFA/airtime/results-checker are hidden on the Hubtel menu until Plan 2; mode `shop` is rejected with "service unavailable" until Plan 3.
2. **Plan 2 (written after this ships)** — main-mode airtime, results checker (vouchers + "check my results"), AFA: one order-handler + menu flow each, registered into the `handlers` map built here.
3. **Plan 3** — shop mode: shop-code step, token deduction, shop product menus, `ussd_shop_orders` handler incl. shop profit.

### Deviations from the spec (decided during planning, after reading the code)

| Spec said | This plan does | Why |
|---|---|---|
| §4.4 extract the Paystack webhook post-payment block into a shared function | Hubtel owns `lib/ussd-hubtel/order-handlers.ts`, reusing the already-exported `fulfillUssdOrder`, `sendSMS`, etc. Paystack webhook is **not touched**. | The webhook is 1,642 lines with six order types inlined and tied to Paystack's `reference`/pesewa `amount`. Extraction risks regressing live payments for no Hubtel benefit. Cost: the small ussd_orders profit/SMS block is duplicated (noted as follow-up dedupe). |
| §4.1 verify IP on both endpoints | Secret (`?secret=`) required on both; Hubtel source-IP check on the **fulfilment** endpoint only, behind `HUBTEL_ENFORCE_FULFILLMENT_IP=true`. | Hubtel only publishes the three IPs for fulfilment payloads; interaction-request IPs are unpublished. |
| §9 admin page holds secrets | Secrets live in env vars; the page shows configured/not-configured status. | Never store credentials in DB-readable rows (spec §10). |
| §6 any mismatch → needs_review | **Under**-payment → needs_review; over-payment → fulfil. | Penalising an over-payer is wrong; under-payment is the real risk. |
| §3 hub fee | Order `amount` = our price (no Paystack fee added); match against Hubtel's `AmountAfterCharges`. | Hubtel's sample shows the customer pays price + Hubtel charge; **must be confirmed in Hubtel sandbox (runbook step)**. |

## Global Constraints

- Hubtel reply `Message` must contain **no special characters** (e.g. É): printable ASCII + `\n` only (spec §3).
- USSD-platform screens are truncated to **182 characters**; Webstore/Hubtel-App are not truncated.
- Hubtel reply `Type` ∈ `response` | `release` | `AddToCart`; `Label`, `DataType`, `FieldType` are mandatory on every reply (spec §3).
- Fulfilment callback to Hubtel must be sent **within 1 hour**; it **always** sends `ServiceStatus: "success"` (spec §8).
- Callback and status-check calls go **only** through the relay (fixed IP). No direct Vercel → Hubtel calls.
- Hubtel menus use **real network names** (MTN, Telecel, AT iShare, AT BigTime) and normal wording — never the Uzo nicknames or the "Browse Services" rebrand (spec §4.4).
- Fail closed: missing `HUBTEL_WEBHOOK_SECRET` ⇒ both Hubtel endpoints return 503.
- The channel ships **disabled** (`hubtel_ussd_config.enabled = false` by default).
- Credentials only in env vars: `HUBTEL_WEBHOOK_SECRET`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET` (Vercel); `RELAY_SECRET`, `HUBTEL_COLLECTION_ACCOUNT`, `HUBTEL_STATUS_BASIC_AUTH` (droplet).
- Do not modify `lib/ussd/router.ts`, `lib/ussd-shop/*`, or `app/api/webhooks/paystack/route.ts`. The only edit to existing Uzo code is adding `export` to two symbols in `lib/ussd/handlers/bundles.ts`.
- Tests: `npm run test:run`. Pure logic gets unit tests; I/O edges use hand-rolled fake clients (pattern in `lib/wa-delivery-notify.drain.test.ts`).
- Migrations are plain SQL files in `migrations/` (next number `0106`), applied manually via Supabase (see memory `reference-supabase-access`). New tables: service-role only, never bare `USING(true)`.

## Review Focus

Failure modes the spec implies but a task's happy path wouldn't exercise, most likely first. Each has a pinned test in the owning task.

1. **Duplicate fulfilment delivery** (Hubtel retries the webhook) must never fulfil twice → Task 7 (`duplicate` outcome via atomic claim).
2. **Redis miss / expired session mid-flow** must restart gracefully with the menu, not error → Task 6.
3. **Non-ASCII / over-length text** in replies (package names, long menus) must be sanitised/truncated per platform → Task 2.
4. **Relay down or Hubtel rejects the callback** must retry and finally mark `failed` before the 1-hour window closes, not loop forever → Task 8.
5. **Bad menu input** (letters, out-of-range digit, wrong-network recipient number, `233…` vs `0…` mobile formats) must re-prompt without losing the session or creating an order → Task 6.
6. **Under-payment** must hold fulfilment (still callbacks `success`) → Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0106_hubtel_ussd.sql` | `hubtel_transactions` table, indexes, RLS lockdown |
| `lib/ussd-hubtel/types.ts` | Shared types: request/reply, session, tx row, tx store interface |
| `lib/ussd-hubtel/protocol.ts` (+test) | Pure: sanitise/fit text, reply builders, request parser, phone helpers, secret/IP checks |
| `lib/ussd-hubtel/config.ts` (+test) | Read/write `hubtel_ussd_config` in `admin_settings` |
| `lib/ussd-hubtel/session.ts` (+test) | Redis session store (own key prefix) |
| `lib/ussd-hubtel/menus.ts` (+test) | Hubtel menu text (real network names) |
| `lib/ussd-hubtel/catalog.ts` (+test) | Bundle fetch re-export, tier/price decisions, caller + whitelist lookups |
| `lib/ussd-hubtel/router.ts` (+test) | Main-mode data-bundle state machine; AddToCart |
| `lib/ussd-hubtel/payment.ts` (+test) | Fulfilment payload parse, amount decision, idempotent orchestration |
| `lib/ussd-hubtel/tx-store.ts` | Supabase-backed `HubtelTxStore` |
| `lib/ussd-hubtel/order-handlers.ts` | Per-order-table post-payment + fail handlers (ussd_orders now) |
| `lib/ussd-hubtel/callbacks.ts` (+test) | Callback disposition + dispatch |
| `lib/ussd-hubtel/status-check.ts` (+test) | Status-check disposition + runner |
| `lib/ussd-hubtel/relay.ts` | Vercel-side relay client |
| `lib/ussd-hubtel/relay-handler.ts` (+test) | Pure relay request handler (runs on the droplet) |
| `scripts/hubtel-relay/server.ts`, `README.md` | Droplet HTTP server + deploy notes |
| `app/api/ussd-hubtel/interaction/route.ts` | Service Interaction URL |
| `app/api/ussd-hubtel/fulfillment/route.ts` | Service Fulfilment URL |
| `app/api/cron/hubtel-callbacks/route.ts`, `app/api/cron/hubtel-status-check/route.ts` | Crons |
| `app/api/admin/ussd-hubtel/{config,transactions,retry-callback}/route.ts` | Admin APIs |
| `app/admin/ussd-hubtel/page.tsx` | Admin config page |
| `components/layout/sidebar.tsx`, `vercel.json`, `lib/ussd/handlers/bundles.ts` | Small edits |
| `scripts/hubtel-simulate.ts`, `docs/hubtel-ussd-runbook.md` | Simulator + go-live runbook |

---

### Task 1: Migration and shared types

**Files:**
- Create: `migrations/0106_hubtel_ussd.sql`
- Create: `lib/ussd-hubtel/types.ts`

**Interfaces:**
- Produces (used by every later task): types `HubtelRequest`, `HubtelReply`, `HubtelPlatform`, `HubtelFieldType`, `HubtelStep`, `HubtelSession`, `HubtelTxRow`, `HubtelTxStore`, `HubtelFulfillmentInfo`, `HubtelTxState`, `HubtelCallbackStatus` — exact definitions below.

- [ ] **Step 1: Write the migration**

```sql
-- 0106_hubtel_ussd.sql
-- Hubtel Programmable Services payment lifecycle. One row per Hubtel session
-- that reached AddToCart. Service-role only (no grants to anon/authenticated).

CREATE TABLE IF NOT EXISTS hubtel_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            text NOT NULL UNIQUE,
  hubtel_order_id       text,
  platform              text NOT NULL DEFAULT 'USSD',
  order_table           text NOT NULL CHECK (order_table IN (
                          'ussd_orders','ussd_shop_orders','airtime_orders',
                          'results_checker_orders','results_check_requests','ussd_afa_orders')),
  order_id              uuid NOT NULL,
  mobile                text,
  expected_amount       numeric(10,2) NOT NULL,
  amount_paid           numeric(10,2),
  amount_after_charges  numeric(10,2),
  state                 text NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN (
                          'awaiting_payment','processing','fulfilled','needs_review','failed')),
  callback_status       text NOT NULL DEFAULT 'not_due' CHECK (callback_status IN (
                          'not_due','pending','sent','failed')),
  callback_attempts     int  NOT NULL DEFAULT 0,
  callback_last_error   text,
  callback_sent_at      timestamptz,
  status_check_attempts int  NOT NULL DEFAULT 0,
  last_status_check_at  timestamptz,
  paid_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_transactions_callback_idx
  ON hubtel_transactions (callback_status) WHERE callback_status = 'pending';
CREATE INDEX IF NOT EXISTS hubtel_transactions_awaiting_idx
  ON hubtel_transactions (created_at) WHERE state = 'awaiting_payment';
CREATE INDEX IF NOT EXISTS hubtel_transactions_order_idx
  ON hubtel_transactions (order_table, order_id);

ALTER TABLE hubtel_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_transactions FROM anon, authenticated;
-- No policies on purpose: only the service role (which bypasses RLS) may touch this table.
```

- [ ] **Step 2: Write the shared types**

```ts
// lib/ussd-hubtel/types.ts
export type HubtelPlatform = "USSD" | "Webstore" | "Hubtel-App"
export type HubtelRequestType = "Initiation" | "Response" | "Timeout"
export type HubtelFieldType = "text" | "phone" | "email" | "number" | "decimal" | "textarea"

/** Normalised inbound Service Interaction request. */
export interface HubtelRequest {
  Type: HubtelRequestType
  Mobile: string
  SessionId: string
  ServiceCode: string
  Message: string
  Operator: string
  Sequence: number
  ClientState: string
  Platform: HubtelPlatform
}

export interface HubtelReply {
  SessionId: string
  Type: "response" | "release" | "AddToCart"
  Message: string
  Label: string
  DataType: "display" | "input"
  FieldType: HubtelFieldType
  ClientState?: string
  Item?: { ItemName: string; Qty: number; Price: number }
}

export type HubtelStep = "MAIN" | "SELECT_NETWORK" | "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM"

export interface HubtelSession {
  step: HubtelStep
  dialingPhone: string // E.164-style, e.g. +233200585542
  platform: HubtelPlatform
  dataBlocked?: boolean
  network?: string // packages.network value: MTN | Telecel | AT-iShare | AT-BigTime
  effectivePriceTier?: string // regular | dealer | sub_agent
  subAgentParentShopId?: string
  userId?: string
  bundlePage?: number
  bundleId?: string
  bundleSize?: string
  bundlePrice?: number
  recipientPhone?: string // local 0XXXXXXXXX
}

export type HubtelTxState = "awaiting_payment" | "processing" | "fulfilled" | "needs_review" | "failed"
export type HubtelCallbackStatus = "not_due" | "pending" | "sent" | "failed"

export interface HubtelTxRow {
  session_id: string
  hubtel_order_id: string | null
  platform: string
  order_table: string
  order_id: string
  mobile: string | null
  expected_amount: number | string
  amount_paid: number | null
  amount_after_charges: number | null
  state: HubtelTxState
  callback_status: HubtelCallbackStatus
  callback_attempts: number
  callback_last_error: string | null
  callback_sent_at: string | null
  status_check_attempts: number
  last_status_check_at: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
}

export interface HubtelTxStore {
  findBySession(sessionId: string): Promise<HubtelTxRow | null>
  /** Atomically moves awaiting_payment → processing. true only for the caller that won. */
  claim(sessionId: string): Promise<boolean>
  update(sessionId: string, patch: Partial<HubtelTxRow>): Promise<void>
  listPendingCallbacks(limit: number): Promise<HubtelTxRow[]>
  listAwaitingPayment(limit: number): Promise<HubtelTxRow[]>
}

/** What we extract from a fulfilment webhook or a status-check "Paid" response. */
export interface HubtelFulfillmentInfo {
  sessionId: string
  hubtelOrderId: string | null
  amountPaid: number
  amountAfterCharges: number
  isSuccessful: boolean
}
```

- [ ] **Step 3: Typecheck the new file**

Run: `npx tsc --noEmit 2>&1 | grep "ussd-hubtel" || echo "no ussd-hubtel type errors"`
Expected: `no ussd-hubtel type errors`

- [ ] **Step 4: Apply the migration** (manual, per `reference-supabase-access`: Supabase SQL editor or Management API SQL endpoint), then verify.

Run in SQL: `select count(*) from hubtel_transactions;`
Expected: `0`. Also confirm `select has_table_privilege('authenticated','hubtel_transactions','SELECT');` returns `false`.

- [ ] **Step 5: Commit**

```bash
git add migrations/0106_hubtel_ussd.sql lib/ussd-hubtel/types.ts
git commit -m "feat(hubtel): hubtel_transactions table and shared types

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Protocol helpers (pure)

**Files:**
- Create: `lib/ussd-hubtel/protocol.ts`
- Test: `lib/ussd-hubtel/protocol.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces:
  - `sanitizeMessage(text: string): string`
  - `fitMessage(text: string, platform: HubtelPlatform): string`
  - `respond(sessionId: string, message: string, opts?: { label?: string; fieldType?: HubtelFieldType; clientState?: string; platform?: HubtelPlatform }): HubtelReply`
  - `release(sessionId: string, message: string, opts?: { label?: string; platform?: HubtelPlatform }): HubtelReply`
  - `addToCart(sessionId: string, args: { itemName: string; price: number; message: string; platform?: HubtelPlatform }): HubtelReply`
  - `parseHubtelRequest(body: unknown): HubtelRequest | null`
  - `toLocalPhone(mobile: string): string` (`233200585542`/`+233…`/`0…` → `0200585542`)
  - `toE164(mobile: string): string` (→ `+233200585542`)
  - `secretsMatch(provided: string | null, expected: string | undefined): boolean`
  - `getClientIp(headers: Headers): string | null`
  - `HUBTEL_FULFILLMENT_IPS: readonly string[]`, `isHubtelFulfillmentIp(ip: string | null): boolean`
  - `USSD_SCREEN_LIMIT = 182`

- [ ] **Step 1: Write the failing tests**

```ts
// lib/ussd-hubtel/protocol.test.ts
import { describe, it, expect } from "vitest"
import {
  sanitizeMessage, fitMessage, respond, release, addToCart, parseHubtelRequest,
  toLocalPhone, toE164, secretsMatch, getClientIp, isHubtelFulfillmentIp, USSD_SCREEN_LIMIT,
} from "./protocol"

describe("sanitizeMessage", () => {
  it("strips diacritics and non-ASCII but keeps newlines", () => {
    expect(sanitizeMessage("Café\nÉtoile ₵5 ✓")).toBe("Cafe\nEtoile 5 ")
  })
})

describe("fitMessage", () => {
  const long = "x".repeat(400)
  it("truncates to the USSD limit on USSD", () => {
    const out = fitMessage(long, "USSD")
    expect(out.length).toBe(USSD_SCREEN_LIMIT)
    expect(out.endsWith("...")).toBe(true)
  })
  it("does not truncate on Webstore / Hubtel-App", () => {
    expect(fitMessage(long, "Webstore").length).toBe(400)
    expect(fitMessage(long, "Hubtel-App").length).toBe(400)
  })
})

describe("reply builders", () => {
  it("respond sets mandatory fields", () => {
    const r = respond("S1", "Pick:\n1. A", { clientState: "MAIN" })
    expect(r).toMatchObject({ SessionId: "S1", Type: "response", DataType: "input", FieldType: "number", ClientState: "MAIN" })
    expect(r.Label).toBeTruthy()
  })
  it("release is display/text", () => {
    expect(release("S1", "Bye")).toMatchObject({ Type: "release", DataType: "display", FieldType: "text" })
  })
  it("addToCart carries a sanitised item with 2dp price", () => {
    const r = addToCart("S1", { itemName: "5GB MTN Données", price: 12.3456, message: "Submitted" })
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Donnees", Qty: 1, Price: 12.35 })
    expect(r.DataType).toBe("display")
  })
})

describe("parseHubtelRequest", () => {
  const base = { Type: "Initiation", Mobile: "233200585542", SessionId: "abc", ServiceCode: "713", Message: "*713#", Operator: "mtn", Sequence: 1, ClientState: "", Platform: "USSD" }
  it("parses a valid initiation", () => {
    expect(parseHubtelRequest(base)).toMatchObject({ Type: "Initiation", SessionId: "abc", Platform: "USSD" })
  })
  it("is case-insensitive on Type and defaults unknown Platform to USSD", () => {
    expect(parseHubtelRequest({ ...base, Type: "response", Platform: "weird" })).toMatchObject({ Type: "Response", Platform: "USSD" })
  })
  it("keeps Webstore and Hubtel-App platforms", () => {
    expect(parseHubtelRequest({ ...base, Platform: "Webstore" })?.Platform).toBe("Webstore")
    expect(parseHubtelRequest({ ...base, Platform: "Hubtel-App" })?.Platform).toBe("Hubtel-App")
  })
  it("rejects missing SessionId / Mobile / bad Type / non-objects", () => {
    expect(parseHubtelRequest({ ...base, SessionId: "" })).toBeNull()
    expect(parseHubtelRequest({ ...base, Mobile: undefined })).toBeNull()
    expect(parseHubtelRequest({ ...base, Type: "Nope" })).toBeNull()
    expect(parseHubtelRequest(null)).toBeNull()
    expect(parseHubtelRequest("x")).toBeNull()
  })
})

describe("phone helpers", () => {
  it("normalises every Ghana format", () => {
    for (const m of ["233200585542", "+233200585542", "0200585542"]) {
      expect(toLocalPhone(m)).toBe("0200585542")
      expect(toE164(m)).toBe("+233200585542")
    }
  })
})

describe("secretsMatch", () => {
  it("matches only equal non-empty secrets", () => {
    expect(secretsMatch("abc", "abc")).toBe(true)
    expect(secretsMatch("abd", "abc")).toBe(false)
    expect(secretsMatch(null, "abc")).toBe(false)
    expect(secretsMatch("abc", undefined)).toBe(false)
    expect(secretsMatch("", "")).toBe(false)
  })
})

describe("ip helpers", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(getClientIp(new Headers({ "x-forwarded-for": "52.50.116.54, 10.0.0.1" }))).toBe("52.50.116.54")
    expect(getClientIp(new Headers())).toBeNull()
  })
  it("recognises Hubtel fulfilment IPs", () => {
    expect(isHubtelFulfillmentIp("18.202.122.131")).toBe(true)
    expect(isHubtelFulfillmentIp("1.2.3.4")).toBe(false)
    expect(isHubtelFulfillmentIp(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/protocol.test.ts`
Expected: FAIL (cannot resolve `./protocol`).

- [ ] **Step 3: Implement**

```ts
// lib/ussd-hubtel/protocol.ts
import crypto from "crypto"
import type { HubtelFieldType, HubtelPlatform, HubtelReply, HubtelRequest, HubtelRequestType } from "./types"

export const USSD_SCREEN_LIMIT = 182
export const HUBTEL_FULFILLMENT_IPS = ["52.50.116.54", "18.202.122.131", "52.31.15.68"] as const

/** Printable ASCII + \n only. Hubtel rejects special characters (UUE error). */
export function sanitizeMessage(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E\n]/g, "")
}

export function fitMessage(text: string, platform: HubtelPlatform): string {
  const clean = sanitizeMessage(text)
  if (platform !== "USSD" || clean.length <= USSD_SCREEN_LIMIT) return clean
  return clean.slice(0, USSD_SCREEN_LIMIT - 3) + "..."
}

export function respond(
  sessionId: string,
  message: string,
  opts: { label?: string; fieldType?: HubtelFieldType; clientState?: string; platform?: HubtelPlatform } = {}
): HubtelReply {
  return {
    SessionId: sessionId,
    Type: "response",
    Message: fitMessage(message, opts.platform ?? "USSD"),
    Label: opts.label ?? "Menu",
    DataType: "input",
    FieldType: opts.fieldType ?? "number",
    ClientState: opts.clientState ?? "",
  }
}

export function release(
  sessionId: string,
  message: string,
  opts: { label?: string; platform?: HubtelPlatform } = {}
): HubtelReply {
  return {
    SessionId: sessionId,
    Type: "release",
    Message: fitMessage(message, opts.platform ?? "USSD"),
    Label: opts.label ?? "Done",
    DataType: "display",
    FieldType: "text",
  }
}

export function addToCart(
  sessionId: string,
  args: { itemName: string; price: number; message: string; platform?: HubtelPlatform }
): HubtelReply {
  const message = fitMessage(args.message, args.platform ?? "USSD")
  return {
    SessionId: sessionId,
    Type: "AddToCart",
    Message: message,
    Label: message,
    DataType: "display",
    FieldType: "text",
    Item: {
      ItemName: sanitizeMessage(args.itemName),
      Qty: 1,
      Price: Math.round(args.price * 100) / 100,
    },
  }
}

export function parseHubtelRequest(body: unknown): HubtelRequest | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const rawType = typeof b.Type === "string" ? b.Type.toLowerCase() : ""
  const type: HubtelRequestType | null =
    rawType === "initiation" ? "Initiation" : rawType === "response" ? "Response" : rawType === "timeout" ? "Timeout" : null
  if (!type) return null
  if (typeof b.SessionId !== "string" || !b.SessionId) return null
  if (typeof b.Mobile !== "string" || !b.Mobile) return null
  const platform: HubtelPlatform = b.Platform === "Webstore" || b.Platform === "Hubtel-App" ? b.Platform : "USSD"
  return {
    Type: type,
    Mobile: b.Mobile,
    SessionId: b.SessionId,
    ServiceCode: String(b.ServiceCode ?? ""),
    Message: typeof b.Message === "string" ? b.Message : "",
    Operator: String(b.Operator ?? ""),
    Sequence: Number(b.Sequence ?? 0) || 0,
    ClientState: typeof b.ClientState === "string" ? b.ClientState : "",
    Platform: platform,
  }
}

export function toLocalPhone(mobile: string): string {
  const m = mobile.trim().replace(/\s+/g, "")
  if (m.startsWith("+233")) return "0" + m.slice(4)
  if (m.startsWith("233")) return "0" + m.slice(3)
  return m
}

export function toE164(mobile: string): string {
  const local = toLocalPhone(mobile)
  return local.startsWith("0") ? "+233" + local.slice(1) : mobile
}

export function secretsMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function getClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")
  if (!xff) return null
  return xff.split(",")[0].trim() || null
}

export function isHubtelFulfillmentIp(ip: string | null): boolean {
  return !!ip && (HUBTEL_FULFILLMENT_IPS as readonly string[]).includes(ip)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/protocol.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/protocol.ts lib/ussd-hubtel/protocol.test.ts
git commit -m "feat(hubtel): protocol helpers (reply builders, sanitiser, parser)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Config store

**Files:**
- Create: `lib/ussd-hubtel/config.ts`
- Test: `lib/ussd-hubtel/config.test.ts`

**Interfaces:**
- Produces:
  - `HUBTEL_USSD_CONFIG_KEY = "hubtel_ussd_config"`
  - `interface HubtelUssdConfig { enabled: boolean; mode: "main" | "shop"; visibility: { data: boolean; afa: boolean; airtime: boolean; resultsChecker: boolean } }`
  - `getHubtelUssdConfig(supabase: SupabaseClient): Promise<HubtelUssdConfig>` — defaults `{ enabled: false, mode: "main", visibility: all true }`; a missing/partial row never enables the channel.
  - `setHubtelUssdConfig(supabase, patch: { enabled?: boolean; mode?: "main" | "shop"; visibility?: Partial<HubtelUssdConfig["visibility"]> }): Promise<HubtelUssdConfig>` — read-modify-write; throws `Error("invalid mode")` for other modes.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ussd-hubtel/config.test.ts
import { describe, it, expect } from "vitest"
import { getHubtelUssdConfig, setHubtelUssdConfig } from "./config"

function fakeSupabase(initial: unknown) {
  let stored = initial
  const client: any = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored === undefined ? null : { value: stored }, error: null }) }) }),
      upsert: async (row: any) => { stored = row.value; return { error: null } },
    }),
  }
  return { client, read: () => stored }
}

describe("hubtel ussd config", () => {
  it("defaults to disabled/main/all visible when unseeded", async () => {
    const { client } = fakeSupabase(undefined)
    expect(await getHubtelUssdConfig(client)).toEqual({
      enabled: false, mode: "main",
      visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
    })
  })

  it("fills missing fields from defaults and ignores a bad mode", async () => {
    const { client } = fakeSupabase({ enabled: true, mode: "bogus", visibility: { afa: false } })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg.enabled).toBe(true)
    expect(cfg.mode).toBe("main")
    expect(cfg.visibility).toEqual({ data: true, afa: false, airtime: true, resultsChecker: true })
  })

  it("set merges a partial patch and persists", async () => {
    const { client, read } = fakeSupabase({ enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } })
    const cfg = await setHubtelUssdConfig(client, { enabled: true, visibility: { airtime: false } })
    expect(cfg).toEqual({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } })
    expect(read()).toEqual(cfg)
  })

  it("rejects an invalid mode", async () => {
    const { client } = fakeSupabase(undefined)
    await expect(setHubtelUssdConfig(client, { mode: "weird" as any })).rejects.toThrow("invalid mode")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/config.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// lib/ussd-hubtel/config.ts
// Single JSON blob in admin_settings (key/value convention — NOT the app_settings
// singleton row; see the app_settings table-collision incident). Caller owns the client.
import type { SupabaseClient } from "@supabase/supabase-js"

export const HUBTEL_USSD_CONFIG_KEY = "hubtel_ussd_config"

export interface HubtelUssdConfig {
  enabled: boolean
  mode: "main" | "shop"
  visibility: { data: boolean; afa: boolean; airtime: boolean; resultsChecker: boolean }
}

const DEFAULT_CONFIG: HubtelUssdConfig = {
  enabled: false,
  mode: "main",
  visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
}

export async function getHubtelUssdConfig(supabase: SupabaseClient): Promise<HubtelUssdConfig> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", HUBTEL_USSD_CONFIG_KEY)
    .maybeSingle()
  if (error) throw error
  const stored = data?.value && typeof data.value === "object" ? (data.value as Partial<HubtelUssdConfig>) : {}
  return {
    // Only an explicit `true` enables the channel.
    enabled: stored.enabled === true,
    mode: stored.mode === "shop" ? "shop" : "main",
    visibility: { ...DEFAULT_CONFIG.visibility, ...(stored.visibility ?? {}) },
  }
}

export async function setHubtelUssdConfig(
  supabase: SupabaseClient,
  patch: { enabled?: boolean; mode?: "main" | "shop"; visibility?: Partial<HubtelUssdConfig["visibility"]> }
): Promise<HubtelUssdConfig> {
  if (patch.mode !== undefined && patch.mode !== "main" && patch.mode !== "shop") {
    throw new Error("invalid mode")
  }
  const current = await getHubtelUssdConfig(supabase)
  const next: HubtelUssdConfig = {
    enabled: patch.enabled ?? current.enabled,
    mode: patch.mode ?? current.mode,
    visibility: { ...current.visibility, ...(patch.visibility ?? {}) },
  }
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: HUBTEL_USSD_CONFIG_KEY,
      value: next,
      description: "Hubtel USSD channel: kill switch, main/shop mode, per-service visibility.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
  return next
}
```

- [ ] **Step 4: Run** `npx vitest run lib/ussd-hubtel/config.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/config.ts lib/ussd-hubtel/config.test.ts
git commit -m "feat(hubtel): config store (kill switch, mode, visibility)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Session store

**Files:**
- Create: `lib/ussd-hubtel/session.ts`
- Test: `lib/ussd-hubtel/session.test.ts`

**Interfaces:**
- Consumes: `HubtelSession` (Task 1).
- Produces: `interface HubtelSessionStore { get(id: string): Promise<HubtelSession | null>; set(id: string, s: HubtelSession): Promise<void>; del(id: string): Promise<void> }` and `export const sessionStore: HubtelSessionStore`. Redis key `ussd-hubtel:session:{id}`, TTL 120 s. In-memory fallback **only** when Redis is not configured at all (never on a Redis error — see the 2026-09-30 session-timeout investigation: a silent per-instance fallback hides outages).

- [ ] **Step 1: Write the failing test** (vitest env has no Upstash vars → fallback path)

```ts
// lib/ussd-hubtel/session.test.ts
import { describe, it, expect } from "vitest"
import { sessionStore } from "./session"
import type { HubtelSession } from "./types"

const s: HubtelSession = { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" }

describe("hubtel session store (no redis configured)", () => {
  it("round-trips and deletes", async () => {
    expect(await sessionStore.get("a1")).toBeNull()
    await sessionStore.set("a1", s)
    expect(await sessionStore.get("a1")).toEqual(s)
    await sessionStore.del("a1")
    expect(await sessionStore.get("a1")).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/session.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// lib/ussd-hubtel/session.ts
import { Redis } from "@upstash/redis"
import type { HubtelSession } from "./types"

const SESSION_TTL = 120 // seconds

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  } else {
    console.warn("[HUBTEL-SESSION] Upstash env vars not set — using in-process sessions (dev only)")
  }
} catch (e) {
  console.error("[HUBTEL-SESSION] Failed to initialise Redis:", e)
}

const memory = new Map<string, { data: HubtelSession; expires: number }>()
const key = (id: string) => `ussd-hubtel:session:${id}`

export interface HubtelSessionStore {
  get(id: string): Promise<HubtelSession | null>
  set(id: string, s: HubtelSession): Promise<void>
  del(id: string): Promise<void>
}

export const sessionStore: HubtelSessionStore = {
  async get(id) {
    if (redis) {
      try {
        return (await redis.get<HubtelSession>(key(id))) ?? null
      } catch (e) {
        console.error("[HUBTEL-SESSION] get error for", id, ":", e)
        return null // router restarts the menu; never fall back to per-instance memory
      }
    }
    const m = memory.get(id)
    return m && m.expires > Date.now() ? m.data : null
  },
  async set(id, s) {
    if (redis) {
      try {
        await redis.setex(key(id), SESSION_TTL, JSON.stringify(s))
      } catch (e) {
        console.error("[HUBTEL-SESSION] set error for", id, ":", e)
      }
      return
    }
    memory.set(id, { data: s, expires: Date.now() + SESSION_TTL * 1000 })
  },
  async del(id) {
    if (redis) {
      try { await redis.del(key(id)) } catch (e) { console.error("[HUBTEL-SESSION] del error for", id, ":", e) }
      return
    }
    memory.delete(id)
  },
}
```

- [ ] **Step 4: Run** the test → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/session.ts lib/ussd-hubtel/session.test.ts
git commit -m "feat(hubtel): redis session store

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Menus and catalog

**Files:**
- Modify: `lib/ussd/handlers/bundles.ts:23` (`const PAGE_SIZE` → `export const PAGE_SIZE`) and `lib/ussd/handlers/bundles.ts:32` (`async function fetchBundles` → `export async function fetchBundles`). No other change.
- Create: `lib/ussd-hubtel/menus.ts`, `lib/ussd-hubtel/catalog.ts`
- Test: `lib/ussd-hubtel/menus.test.ts`, `lib/ussd-hubtel/catalog.test.ts`

**Interfaces:**
- Consumes: `MenuItemDef`, `resolveMenuItems`, `renderMenuText`, `keyForDigit` from `@/lib/ussd/menu-items`; `BundleOption` from `@/lib/ussd/types`.
- Produces (`menus.ts`):
  - `type MainMenuKey = "data" | "afa" | "airtime" | "resultsChecker"`
  - `IMPLEMENTED_SERVICES: Record<MainMenuKey, boolean>` (data only, in this plan)
  - `resolveMainMenu(visibility: Record<MainMenuKey, boolean>, dataBlocked: boolean): ResolvedMenuItem<MainMenuKey>[]`
  - `mainMenuText(resolved): string`
  - `HUBTEL_NETWORKS: readonly { digit: string; dbName: string; label: string }[]`, `networkMenuText(): string`
  - `formatSize(size: string): string`
  - `bundleMenuText(bundles: BundleOption[], page: number, total: number, pageSize: number): string`
  - `recipientPromptText(): string`
  - `confirmMenuText(networkLabel: string, size: string, price: number, recipientLocal: string, dialingLocal: string): string`
- Produces (`catalog.ts`):
  - re-exports `fetchBundles`, `PAGE_SIZE` from `@/lib/ussd/handlers/bundles`
  - `interface CallerContext { effectivePriceTier: string; subAgentParentShopId?: string; userId?: string }`
  - `decideTier(defaultTier: string, role: string | undefined, parentShopId: string | null | undefined): { tier: string; parentShopId?: string }`
  - `priceForTier(pkg: { price: number | string; dealer_price?: number | string | null }, tier: string, catalogRow?: { parent_price: number | string; wholesale_margin: number | string } | null): { price: number; parentProfit: number | null }`
  - `resolveCaller(supabase: SupabaseClient, dialingPhone: string): Promise<CallerContext>`
  - `isDataBlocked(supabase: SupabaseClient, msisdn: string): Promise<boolean>`

- [ ] **Step 1: Export the two Uzo symbols**

In `lib/ussd/handlers/bundles.ts` change `const PAGE_SIZE = 5` to `export const PAGE_SIZE = 5` and `async function fetchBundles(` to `export async function fetchBundles(`.

- [ ] **Step 2: Write the failing menu tests**

```ts
// lib/ussd-hubtel/menus.test.ts
import { describe, it, expect } from "vitest"
import { resolveMainMenu, mainMenuText, networkMenuText, bundleMenuText, confirmMenuText, formatSize, recipientPromptText, HUBTEL_NETWORKS, IMPLEMENTED_SERVICES } from "./menus"

const allOn = { data: true, afa: true, airtime: true, resultsChecker: true }

describe("main menu", () => {
  it("shows only implemented services and renumbers", () => {
    const r = resolveMainMenu(allOn, false)
    expect(r.map(i => i.key)).toEqual(Object.entries(IMPLEMENTED_SERVICES).filter(([, v]) => v).map(([k]) => k))
    expect(mainMenuText(r)).toContain("1. Buy Data Bundle")
  })
  it("hides data when the caller is whitelist-blocked or admin-hidden", () => {
    expect(resolveMainMenu(allOn, true)).toEqual([])
    expect(resolveMainMenu({ ...allOn, data: false }, false)).toEqual([])
  })
})

describe("network menu", () => {
  it("uses real network names, never the Uzo nicknames", () => {
    const t = networkMenuText()
    for (const n of ["MTN", "Telecel", "AT iShare", "AT BigTime"]) expect(t).toContain(n)
    for (const nick of ["Yellow Plans", "Instant Blue", "Delay Blue", "Tele\n"]) expect(t).not.toContain(nick)
    expect(HUBTEL_NETWORKS.map(n => n.dbName)).toEqual(["MTN", "Telecel", "AT-iShare", "AT-BigTime"])
  })
})

describe("formatSize", () => {
  it("adds GB to bare numbers and leaves units alone", () => {
    expect(formatSize("5")).toBe("5GB")
    expect(formatSize("1.5")).toBe("1.5GB")
    expect(formatSize("500MB")).toBe("500MB")
    expect(formatSize("5GB")).toBe("5GB")
  })
})

describe("bundle menu", () => {
  const bundles = [{ id: "a", size: "1", price: 5 }, { id: "b", size: "2", price: 9.5 }]
  it("numbers across pages and offers More only when there is more", () => {
    expect(bundleMenuText(bundles, 0, 2, 5)).toBe("Select Package:\n1. 1GB - GHS 5.00\n2. 2GB - GHS 9.50\n0. Back")
    expect(bundleMenuText(bundles, 1, 12, 5)).toContain("6. 1GB - GHS 5.00")
    expect(bundleMenuText(bundles, 0, 12, 5)).toContain("3. More...")
  })
})

describe("confirm menu", () => {
  it("states amount, recipient and payer, with real network label", () => {
    const t = confirmMenuText("MTN", "5", 20, "0244123456", "0200585542")
    expect(t).toContain("5GB MTN")
    expect(t).toContain("To: 0244123456")
    expect(t).toContain("GHS 20.00")
    expect(t).toContain("1. Pay now")
    expect(recipientPromptText()).toContain("recipient")
  })
})
```

- [ ] **Step 3: Write the failing catalog tests**

```ts
// lib/ussd-hubtel/catalog.test.ts
import { describe, it, expect } from "vitest"
import { decideTier, priceForTier } from "./catalog"

describe("decideTier", () => {
  it("falls back to the global default for unknown callers", () => {
    expect(decideTier("regular", undefined, null)).toEqual({ tier: "regular" })
    expect(decideTier("dealer", undefined, null)).toEqual({ tier: "dealer" })
  })
  it("dealers get dealer pricing", () => {
    expect(decideTier("regular", "dealer", null)).toEqual({ tier: "dealer" })
  })
  it("sub_agents with a parent shop get sub_agent; without one get regular", () => {
    expect(decideTier("regular", "sub_agent", "shop-1")).toEqual({ tier: "sub_agent", parentShopId: "shop-1" })
    expect(decideTier("regular", "sub_agent", null)).toEqual({ tier: "regular" })
  })
  it("any other registered user is regular", () => {
    expect(decideTier("dealer", "user", null)).toEqual({ tier: "regular" })
  })
})

describe("priceForTier", () => {
  const pkg = { price: 10, dealer_price: 8 }
  it("regular uses price", () => expect(priceForTier(pkg, "regular")).toEqual({ price: 10, parentProfit: null }))
  it("dealer uses dealer_price when set and > 0", () => {
    expect(priceForTier(pkg, "dealer").price).toBe(8)
    expect(priceForTier({ price: 10, dealer_price: 0 }, "dealer").price).toBe(10)
    expect(priceForTier({ price: 10, dealer_price: null }, "dealer").price).toBe(10)
  })
  it("sub_agent uses the catalog parent_price and wholesale_margin", () => {
    expect(priceForTier(pkg, "sub_agent", { parent_price: "9", wholesale_margin: "1.5" })).toEqual({ price: 9, parentProfit: 1.5 })
  })
  it("sub_agent without a catalog row falls back to package price", () => {
    expect(priceForTier(pkg, "sub_agent", null)).toEqual({ price: 10, parentProfit: null })
  })
})
```

- [ ] **Step 4: Run both** — `npx vitest run lib/ussd-hubtel/menus.test.ts lib/ussd-hubtel/catalog.test.ts` → Expected: FAIL (modules missing).

- [ ] **Step 5: Implement `menus.ts`**

```ts
// lib/ussd-hubtel/menus.ts
// Hubtel menu text. Deliberately separate from lib/ussd/menus.ts: Hubtel uses REAL
// network names and normal wording (no Uzo nicknames / "Browse Services" rebrand).
import { MenuItemDef, ResolvedMenuItem, renderMenuText, resolveMenuItems } from "@/lib/ussd/menu-items"
import type { BundleOption } from "@/lib/ussd/types"

export type MainMenuKey = "data" | "afa" | "airtime" | "resultsChecker"

const MAIN_ITEMS: MenuItemDef<MainMenuKey>[] = [
  { key: "data", label: "Buy Data Bundle" },
  { key: "afa", label: "AFA Registration" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

/** Flip each to true as its flow ships (Plan 2). Admin visibility is ANDed with this. */
export const IMPLEMENTED_SERVICES: Record<MainMenuKey, boolean> = {
  data: true,
  afa: false,
  airtime: false,
  resultsChecker: false,
}

export function resolveMainMenu(
  visibility: Record<MainMenuKey, boolean>,
  dataBlocked: boolean
): ResolvedMenuItem<MainMenuKey>[] {
  const visible: Record<MainMenuKey, boolean> = {
    data: visibility.data && IMPLEMENTED_SERVICES.data && !dataBlocked,
    afa: visibility.afa && IMPLEMENTED_SERVICES.afa,
    airtime: visibility.airtime && IMPLEMENTED_SERVICES.airtime,
    resultsChecker: visibility.resultsChecker && IMPLEMENTED_SERVICES.resultsChecker,
  }
  return resolveMenuItems(MAIN_ITEMS, visible)
}

export function mainMenuText(resolved: ResolvedMenuItem<MainMenuKey>[]): string {
  return renderMenuText("Welcome to Datagod", resolved, "0. Exit")
}

export const HUBTEL_NETWORKS = [
  { digit: "1", dbName: "MTN", label: "MTN" },
  { digit: "2", dbName: "Telecel", label: "Telecel" },
  { digit: "3", dbName: "AT-iShare", label: "AT iShare" },
  { digit: "4", dbName: "AT-BigTime", label: "AT BigTime" },
] as const

export function networkMenuText(): string {
  return "Select Network:\n" + HUBTEL_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

/** Bare numbers are GB; strings that already carry a unit are left alone. */
export function formatSize(size: string): string {
  return /^\d+(\.\d+)?$/.test(size.trim()) ? `${size.trim()}GB` : size.trim()
}

export function bundleMenuText(bundles: BundleOption[], page: number, total: number, pageSize: number): string {
  const offset = page * pageSize
  const lines = bundles.map((b, i) => `${offset + i + 1}. ${formatSize(b.size)} - GHS ${b.price.toFixed(2)}`)
  if (offset + bundles.length < total) lines.push(`${offset + bundles.length + 1}. More...`)
  lines.push("0. Back")
  return "Select Package:\n" + lines.join("\n")
}

export function recipientPromptText(): string {
  return "Enter recipient number\n(who gets the bundle):\n0. Back"
}

export function confirmMenuText(
  networkLabel: string,
  size: string,
  price: number,
  recipientLocal: string,
  dialingLocal: string
): string {
  return (
    `Confirm order:\n${formatSize(size)} ${networkLabel}\nTo: ${recipientLocal}\n` +
    `GHS ${price.toFixed(2)} from ${dialingLocal}\n1. Pay now\n2. Cancel`
  )
}
```

- [ ] **Step 6: Implement `catalog.ts`**

```ts
// lib/ussd-hubtel/catalog.ts
import type { SupabaseClient } from "@supabase/supabase-js"

// Bundle listing is shared with the Uzo flow (pure DB read, no payment coupling).
export { fetchBundles, PAGE_SIZE } from "@/lib/ussd/handlers/bundles"

export interface CallerContext {
  effectivePriceTier: string
  subAgentParentShopId?: string
  userId?: string
}

/** Mirrors the tier logic inline in lib/ussd/handlers/bundles.ts handleSelectNetwork (minus wallet lookups). */
export function decideTier(
  defaultTier: string,
  role: string | undefined,
  parentShopId: string | null | undefined
): { tier: string; parentShopId?: string } {
  if (role === undefined) return { tier: defaultTier }
  if (role === "dealer") return { tier: "dealer" }
  if (role === "sub_agent" && parentShopId) return { tier: "sub_agent", parentShopId }
  return { tier: "regular" }
}

/** Mirrors the price verification in lib/ussd/handlers/bundles.ts handleConfirm. */
export function priceForTier(
  pkg: { price: number | string; dealer_price?: number | string | null },
  tier: string,
  catalogRow?: { parent_price: number | string; wholesale_margin: number | string } | null
): { price: number; parentProfit: number | null } {
  if (tier === "sub_agent") {
    return {
      price: catalogRow ? Number(catalogRow.parent_price) : Number(pkg.price),
      parentProfit: catalogRow ? Number(catalogRow.wholesale_margin) : null,
    }
  }
  const useDealer = tier === "dealer" && pkg.dealer_price && Number(pkg.dealer_price) > 0
  return { price: useDealer ? Number(pkg.dealer_price) : Number(pkg.price), parentProfit: null }
}

export async function resolveCaller(supabase: SupabaseClient, dialingPhone: string): Promise<CallerContext> {
  const local = dialingPhone.startsWith("+233") ? "0" + dialingPhone.slice(4) : dialingPhone
  const [{ data: userRow }, { data: settingsRow }] = await Promise.all([
    supabase.from("users").select("id, role").eq("phone_number", local).maybeSingle(),
    supabase.from("app_settings").select("ussd_price_tier").is("key", null).single(),
  ])
  const defaultTier = settingsRow?.ussd_price_tier ?? "regular"
  let parentShopId: string | null = null
  if (userRow?.role === "sub_agent") {
    const { data: shopRow } = await supabase
      .from("user_shops").select("parent_shop_id").eq("user_id", userRow.id).not("parent_shop_id", "is", null).maybeSingle()
    parentShopId = shopRow?.parent_shop_id ?? null
  }
  const { tier, parentShopId: parent } = decideTier(defaultTier, userRow?.role, parentShopId)
  return { effectivePriceTier: tier, subAgentParentShopId: parent, userId: userRow?.id }
}

/** Same whitelist gate the Uzo main menu applies at initiation. */
export async function isDataBlocked(supabase: SupabaseClient, msisdn: string): Promise<boolean> {
  const local = msisdn.startsWith("+233") ? "0" + msisdn.slice(4) : msisdn.startsWith("233") ? "0" + msisdn.slice(3) : msisdn
  const [{ data: setting }, { data: purchased }] = await Promise.all([
    supabase.from("admin_settings").select("value").eq("key", "ussd_data_whitelist_enabled").maybeSingle(),
    supabase.rpc("has_completed_purchase", { local_phone: local, msisdn }),
  ])
  return setting?.value?.enabled === true && purchased !== true
}
```

- [ ] **Step 7: Run** `npx vitest run lib/ussd-hubtel/menus.test.ts lib/ussd-hubtel/catalog.test.ts` → Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/ussd/handlers/bundles.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/menus.test.ts lib/ussd-hubtel/catalog.ts lib/ussd-hubtel/catalog.test.ts
git commit -m "feat(hubtel): menus (real network names) and catalog helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Router (main-mode data bundles → AddToCart)

**Files:**
- Create: `lib/ussd-hubtel/router.ts`
- Test: `lib/ussd-hubtel/router.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 exports.
- Produces:
  - `interface RouterDeps { supabase: SupabaseClient; getConfig(): Promise<HubtelUssdConfig>; sessions: HubtelSessionStore; fetchBundles: (network: string, page: number, tier: string, parentShopId?: string) => Promise<{ bundles: BundleOption[]; total: number }>; resolveCaller: (phone: string) => Promise<CallerContext>; isDataBlocked: (msisdn: string) => Promise<boolean>; getPrefixConfig: () => Promise<PrefixValidationConfig>; pageSize: number }`
  - `hubtelRouter(req: HubtelRequest, deps: RouterDeps): Promise<HubtelReply>`
  - `defaultRouterDeps(supabase: SupabaseClient): RouterDeps`

Behaviour contract: `Timeout` → delete session + release. Disabled or `mode !== "main"` → release "Service unavailable. Please try again later." Initiation → menu. `Response` with no session → restart with `"Session expired.\n"` prefix. CONFIRM `1` → re-verify package + price, insert `ussd_orders` (`amount` = our price, `payment_status: 'pending'`), insert `hubtel_transactions` (`order_table: 'ussd_orders'`, `expected_amount` = price), delete the session, reply `AddToCart`. If the `hubtel_transactions` insert fails, mark the order failed and release an error.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ussd-hubtel/router.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "./router"
import type { HubtelRequest, HubtelSession } from "./types"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"

function fakeSupabase(opts: { pkg?: any; txError?: boolean } = {}) {
  const inserts: Record<string, any[]> = {}
  const updates: Array<{ table: string; patch: any }> = []
  const client: any = {
    from(table: string) {
      const b: any = {
        select() { return b }, eq() { return b }, is() { return b }, not() { return b }, in() { return b },
        single: async () => ({ data: table === "packages" ? opts.pkg : null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        insert(rows: any) {
          ;(inserts[table] ??= []).push(...([] as any[]).concat(rows))
          const ib: any = {
            select() { return ib },
            single: async () => ({ data: { id: "11111111-1111-1111-1111-111111111111" }, error: null }),
            then: (res: any) => res({ error: table === "hubtel_transactions" && opts.txError ? { message: "boom" } : null }),
          }
          return ib
        },
        update(patch: any) { updates.push({ table, patch }); return b },
        then: (res: any) => res({ error: null }),
      }
      return b
    },
  }
  return { client, inserts, updates }
}

function makeDeps(over: Partial<RouterDeps> = {}, sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })) {
  const store = new Map<string, HubtelSession>()
  const deps: RouterDeps = {
    supabase: sup.client,
    getConfig: async () => ({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }),
    sessions: {
      get: async id => store.get(id) ?? null,
      set: async (id, s) => { store.set(id, s) },
      del: async id => { store.delete(id) },
    },
    fetchBundles: async () => ({ bundles: [{ id: "pkg-1", size: "5", price: 10 }], total: 1 }),
    resolveCaller: async () => ({ effectivePriceTier: "regular" }),
    isDataBlocked: async () => false,
    getPrefixConfig: async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES }),
    pageSize: 5,
    ...over,
  }
  return { deps, store, sup }
}

const req = (over: Partial<HubtelRequest>): HubtelRequest => ({
  Type: "Response", Mobile: "233200585542", SessionId: "S1", ServiceCode: "713",
  Message: "", Operator: "vodafone", Sequence: 2, ClientState: "", Platform: "USSD", ...over,
})

describe("hubtelRouter: entry guards", () => {
  it("releases when the channel is disabled", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("release")
  })
  it("releases in shop mode (not built yet)", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    expect((await hubtelRouter(req({ Type: "Initiation" }), deps)).Type).toBe("release")
  })
  it("Timeout deletes the session", async () => {
    const { deps, store } = makeDeps()
    store.set("S1", { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Type: "Timeout" }), deps)
    expect(r.Type).toBe("release")
    expect(store.has("S1")).toBe(false)
  })
})

describe("hubtelRouter: initiation and recovery", () => {
  it("shows the main menu and stores a MAIN session with E.164 phone", async () => {
    const { deps, store } = makeDeps()
    const r = await hubtelRouter(req({ Type: "Initiation", Message: "*713#" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("1. Buy Data Bundle")
    expect(r.ClientState).toBe("MAIN")
    expect(store.get("S1")).toMatchObject({ step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
  })
  it("releases politely when no service is available to this caller", async () => {
    const { deps } = makeDeps({ isDataBlocked: async () => true })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
  it("Redis miss mid-flow restarts with 'Session expired' and the menu (review focus #2)", async () => {
    const { deps } = makeDeps()
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Session expired.")
    expect(r.Message).toContain("Buy Data Bundle")
  })
})

async function walkTo(step: "SELECT_BUNDLE" | "ENTER_RECIPIENT" | "CONFIRM", deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps) // data
  await hubtelRouter(req({ Message: "1" }), deps) // MTN
  if (step === "SELECT_BUNDLE") return
  await hubtelRouter(req({ Message: "1" }), deps) // first bundle
  if (step === "ENTER_RECIPIENT") return
  await hubtelRouter(req({ Message: "0244123456" }), deps)
}

describe("hubtelRouter: bad input keeps the session (review focus #5)", () => {
  it("re-shows the main menu on an out-of-range digit and on letters", async () => {
    const { deps, store } = makeDeps()
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    for (const bad of ["9", "abc"]) {
      const r = await hubtelRouter(req({ Message: bad }), deps)
      expect(r.Message).toContain("Buy Data Bundle")
      expect(store.get("S1")?.step).toBe("MAIN")
    }
  })
  it("rejects a malformed recipient and stays on ENTER_RECIPIENT with a phone field", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "12345" }), deps)
    expect(r.Message).toMatch(/invalid/i)
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
  })
  it("rejects a wrong-network recipient (prefix validation)", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    const r = await hubtelRouter(req({ Message: "0200000000" }), deps) // Telecel number for an MTN bundle
    expect(store.get("S1")?.step).toBe("ENTER_RECIPIENT")
    expect(r.Type).toBe("response")
  })
  it("accepts 233… and +233… recipient formats, normalised to local", async () => {
    const { deps, store } = makeDeps()
    await walkTo("ENTER_RECIPIENT", deps)
    await hubtelRouter(req({ Message: "233244123456" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "CONFIRM", recipientPhone: "0244123456" })
  })
})

describe("hubtelRouter: confirm → AddToCart", () => {
  it("creates the order + hubtel_transactions and returns AddToCart at our price", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps, store } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Data", Qty: 1, Price: 10 })
    expect(sup.inserts["ussd_orders"][0]).toMatchObject({
      dialing_phone: "+233200585542", recipient_phone: "0244123456", network: "MTN",
      package_id: "pkg-1", amount: 10, order_status: "pending", payment_status: "pending",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "ussd_orders", order_id: "11111111-1111-1111-1111-111111111111",
      expected_amount: 10, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("cancels without creating an order", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("refuses when the price changed since the menu was shown", async () => {
    const sup = fakeSupabase({ pkg: { price: 12, dealer_price: null, is_available: true } })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/price changed/i)
    expect(sup.inserts["ussd_orders"]).toBeUndefined()
  })
  it("marks the order failed and releases if hubtel_transactions cannot be written", async () => {
    const sup = fakeSupabase({ pkg: { price: 10, dealer_price: null, is_available: true }, txError: true })
    const { deps } = makeDeps({}, sup)
    await walkTo("CONFIRM", deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(sup.updates.some(u => u.table === "ussd_orders" && u.patch.order_status === "failed")).toBe(true)
  })
})

describe("hubtelRouter: other platforms", () => {
  it("serves Webstore without truncating long menus", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, size: "100", price: 99.99 }))
    const { deps } = makeDeps({ fetchBundles: async () => ({ bundles: many, total: 5 }) })
    await hubtelRouter(req({ Type: "Initiation", Platform: "Webstore" }), deps)
    await hubtelRouter(req({ Message: "1", Platform: "Webstore" }), deps)
    const r = await hubtelRouter(req({ Message: "1", Platform: "Webstore" }), deps)
    expect(r.Message.endsWith("...")).toBe(false)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/router.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// lib/ussd-hubtel/router.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import { keyForDigit } from "@/lib/ussd/menu-items"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { getPrefixValidationConfig, type PrefixValidationConfig } from "@/lib/network-prefix-config"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import { getHubtelUssdConfig, type HubtelUssdConfig } from "./config"
import { sessionStore, type HubtelSessionStore } from "./session"
import { fetchBundles, PAGE_SIZE, resolveCaller, isDataBlocked, priceForTier, type CallerContext } from "./catalog"
import {
  HUBTEL_NETWORKS, resolveMainMenu, mainMenuText, networkMenuText, bundleMenuText,
  recipientPromptText, confirmMenuText, type MainMenuKey,
} from "./menus"
import { addToCart, release, respond, toE164, toLocalPhone } from "./protocol"
import type { HubtelReply, HubtelRequest, HubtelSession, HubtelPlatform } from "./types"

export interface RouterDeps {
  supabase: SupabaseClient
  getConfig(): Promise<HubtelUssdConfig>
  sessions: HubtelSessionStore
  fetchBundles: (network: string, page: number, tier: string, parentShopId?: string) => Promise<{ bundles: BundleOption[]; total: number }>
  resolveCaller: (phone: string) => Promise<CallerContext>
  isDataBlocked: (msisdn: string) => Promise<boolean>
  getPrefixConfig: () => Promise<PrefixValidationConfig>
  pageSize: number
}

export function defaultRouterDeps(supabase: SupabaseClient): RouterDeps {
  return {
    supabase,
    getConfig: () => getHubtelUssdConfig(supabase),
    sessions: sessionStore,
    fetchBundles,
    resolveCaller: phone => resolveCaller(supabase, phone),
    isDataBlocked: msisdn => isDataBlocked(supabase, msisdn),
    getPrefixConfig: getPrefixValidationConfig,
    pageSize: PAGE_SIZE,
  }
}

const UNAVAILABLE = "Service unavailable. Please try again later."

export async function hubtelRouter(req: HubtelRequest, deps: RouterDeps): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform = req.Platform

  if (req.Type === "Timeout") {
    await deps.sessions.del(sid)
    return release(sid, "Session ended.", { platform })
  }

  const config = await deps.getConfig()
  // Shop mode ships in a later plan; treat it as unavailable until then.
  if (!config.enabled || config.mode !== "main") return release(sid, UNAVAILABLE, { platform })

  if (req.Type === "Initiation") return startSession(req, deps, config, "")

  const session = await deps.sessions.get(sid)
  if (!session) return startSession(req, deps, config, "Session expired.\n")

  const input = req.Message.trim()
  switch (session.step) {
    case "MAIN": return handleMain(input, req, deps, config, session)
    case "SELECT_NETWORK": return handleSelectNetwork(input, req, deps, config, session)
    case "SELECT_BUNDLE": return handleSelectBundle(input, req, deps, config, session)
    case "ENTER_RECIPIENT": return handleEnterRecipient(input, req, deps, config, session)
    case "CONFIRM": return handleConfirm(input, req, deps, session)
    default: return startSession(req, deps, config, "")
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
const cs = (step: string) => step // ClientState mirrors the step name (safety net if Redis blips)

function menuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveMainMenu(config.visibility as Record<MainMenuKey, boolean>, dataBlocked)
}

async function startSession(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  const resolved = menuFor(config, dataBlocked)
  if (resolved.length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, { step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked })
  return respond(req.SessionId, prefix + mainMenuText(resolved), { label: "Main menu", clientState: cs("MAIN"), platform: req.Platform })
}

function mainReply(req: HubtelRequest, config: HubtelUssdConfig, session: HubtelSession): HubtelReply {
  return respond(req.SessionId, mainMenuText(menuFor(config, session.dataBlocked === true)), {
    label: "Main menu", clientState: cs("MAIN"), platform: req.Platform,
  })
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function handleMain(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "Thank you for using Datagod.", { platform: req.Platform })
  }
  const key = keyForDigit(menuFor(config, session.dataBlocked === true), input)
  if (key === "data") {
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_NETWORK" })
    return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  return mainReply(req, config, session)
}

// ── SELECT_NETWORK ────────────────────────────────────────────────────────────
async function handleSelectNetwork(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.set(req.SessionId, { ...session, step: "MAIN" })
    return mainReply(req, config, session)
  }
  const net = HUBTEL_NETWORKS.find(n => n.digit === input)
  if (!net) return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })

  const caller = await deps.resolveCaller(session.dialingPhone)
  const { bundles, total } = await deps.fetchBundles(net.dbName, 0, caller.effectivePriceTier, caller.subAgentParentShopId)
  if (bundles.length === 0) {
    return respond(req.SessionId, `No ${net.label} packages available.\n` + networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    ...session, step: "SELECT_BUNDLE", network: net.dbName, bundlePage: 0,
    effectivePriceTier: caller.effectivePriceTier, subAgentParentShopId: caller.subAgentParentShopId, userId: caller.userId,
  })
  return respond(req.SessionId, bundleMenuText(bundles, 0, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
}

// ── SELECT_BUNDLE ─────────────────────────────────────────────────────────────
async function handleSelectBundle(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_NETWORK" })
    return respond(req.SessionId, networkMenuText(), { label: "Select network", clientState: cs("SELECT_NETWORK"), platform: req.Platform })
  }
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  // Re-fetch the current page: trusting a cached page goes stale when pages advance.
  const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
  const chosen = parseInt(input, 10)

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await deps.fetchBundles(session.network!, next, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    await deps.sessions.set(req.SessionId, { ...session, bundlePage: next })
    return respond(req.SessionId, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) {
    return respond(req.SessionId, bundleMenuText(bundles, page, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    ...session, step: "ENTER_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  })
  return respond(req.SessionId, recipientPromptText(), { label: "Recipient number", fieldType: "phone", clientState: cs("ENTER_RECIPIENT"), platform: req.Platform })
}

// ── ENTER_RECIPIENT ───────────────────────────────────────────────────────────
async function handleEnterRecipient(input: string, req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, session: HubtelSession): Promise<HubtelReply> {
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await deps.fetchBundles(session.network!, page, session.effectivePriceTier ?? "regular", session.subAgentParentShopId)
    await deps.sessions.set(req.SessionId, { ...session, step: "SELECT_BUNDLE" })
    return respond(req.SessionId, bundleMenuText(bundles, page, total, deps.pageSize), { label: "Select package", clientState: cs("SELECT_BUNDLE"), platform: req.Platform })
  }
  const local = toLocalPhone(input)
  const reprompt = (msg: string) =>
    respond(req.SessionId, `${msg}\n${recipientPromptText()}`, { label: "Recipient number", fieldType: "phone", clientState: cs("ENTER_RECIPIENT"), platform: req.Platform })

  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }

  await deps.sessions.set(req.SessionId, { ...session, step: "CONFIRM", recipientPhone: local })
  const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
  return respond(
    req.SessionId,
    confirmMenuText(net?.label ?? session.network!, session.bundleSize!, session.bundlePrice!, local, toLocalPhone(session.dialingPhone)),
    { label: "Confirm order", clientState: cs("CONFIRM"), platform: req.Platform }
  )
}

// ── CONFIRM → order + AddToCart ───────────────────────────────────────────────
async function handleConfirm(input: string, req: HubtelRequest, deps: RouterDeps, session: HubtelSession): Promise<HubtelReply> {
  const sid = req.SessionId
  const platform: HubtelPlatform = req.Platform

  if (input === "2") {
    await deps.sessions.del(sid)
    return release(sid, "Order cancelled.", { platform })
  }
  if (input !== "1") {
    const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
    return respond(
      sid,
      confirmMenuText(net?.label ?? session.network!, session.bundleSize!, session.bundlePrice!, session.recipientPhone!, toLocalPhone(session.dialingPhone)),
      { label: "Confirm order", clientState: cs("CONFIRM"), platform }
    )
  }

  const { supabase } = deps
  const { data: pkg } = await supabase.from("packages").select("price, dealer_price, is_available").eq("id", session.bundleId!).single()
  if (!pkg || !pkg.is_available) {
    await deps.sessions.del(sid)
    return release(sid, "Package no longer available. Please try again.", { platform })
  }

  const tier = session.effectivePriceTier ?? "regular"
  let catalogRow: { parent_price: number | string; wholesale_margin: number | string } | null = null
  if (tier === "sub_agent" && session.subAgentParentShopId) {
    const { data } = await supabase.from("sub_agent_catalog").select("parent_price, wholesale_margin")
      .eq("shop_id", session.subAgentParentShopId).eq("package_id", session.bundleId!).single()
    catalogRow = data
  }
  const { price, parentProfit } = priceForTier(pkg, tier, catalogRow)

  if (Math.abs(price - session.bundlePrice!) > 0.01) {
    await deps.sessions.del(sid)
    return release(sid, `Price changed to GHS ${price.toFixed(2)}. Please restart your order.`, { platform })
  }

  const { data: order, error: orderError } = await supabase
    .from("ussd_orders")
    .insert([{
      dialing_phone: session.dialingPhone,
      recipient_phone: session.recipientPhone,
      network: session.network,
      // Column is required by the table; the value is unused on the Hubtel channel (payment is Hubtel's).
      paystack_provider: paystackProviderFromPhone(session.dialingPhone) ?? "mtn",
      package_id: session.bundleId,
      package_size: session.bundleSize,
      amount: price, // our price only: the customer pays Hubtel's charge on top, at Hubtel
      price_tier: tier,
      parent_shop_id: session.subAgentParentShopId ?? null,
      parent_profit_amount: parentProfit,
      shop_owner_id: session.userId ?? null,
      order_status: "pending",
      payment_status: "pending",
    }])
    .select("id")
    .single()

  if (orderError || !order) {
    console.error("[HUBTEL-CONFIRM] Failed to create order:", orderError)
    return release(sid, "Error creating order. Please try again.", { platform })
  }

  const { error: txError } = await supabase.from("hubtel_transactions").insert({
    session_id: sid,
    platform,
    order_table: "ussd_orders",
    order_id: order.id,
    mobile: session.dialingPhone,
    expected_amount: price,
  })
  if (txError) {
    console.error("[HUBTEL-CONFIRM] hubtel_transactions insert failed:", txError)
    await supabase.from("ussd_orders")
      .update({ order_status: "failed", payment_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", order.id)
    return release(sid, "Error creating order. Please try again.", { platform })
  }

  await deps.sessions.del(sid)
  const net = HUBTEL_NETWORKS.find(n => n.dbName === session.network)
  return addToCart(sid, {
    itemName: `${session.bundleSize!.match(/^\d+(\.\d+)?$/) ? session.bundleSize + "GB" : session.bundleSize} ${net?.label ?? session.network} Data`,
    price,
    message: "Request submitted. Approve the payment prompt on your phone to complete your order.",
    platform,
  })
}
```

- [ ] **Step 4: Run** `npx vitest run lib/ussd-hubtel/router.test.ts` → Expected: PASS. If the wrong-network test fails because `0200000000` is considered valid for MTN under the repo's prefix map, replace it with a prefix that `validateNetworkPrefix("MTN", …, DEFAULT_NETWORK_PREFIXES)` rejects (check `DEFAULT_NETWORK_PREFIXES` in `lib/phone-format.ts:56`); do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/router.ts lib/ussd-hubtel/router.test.ts
git commit -m "feat(hubtel): main-mode data bundle router with AddToCart

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Payment lifecycle (webhook core, idempotent)

**Files:**
- Create: `lib/ussd-hubtel/payment.ts`, `lib/ussd-hubtel/tx-store.ts`, `lib/ussd-hubtel/order-handlers.ts`
- Test: `lib/ussd-hubtel/payment.test.ts`

**Interfaces:**
- Consumes: `HubtelTxStore`, `HubtelTxRow`, `HubtelFulfillmentInfo` (Task 1).
- Produces (`payment.ts`):
  - `parseFulfillmentPayload(body: unknown): HubtelFulfillmentInfo | null`
  - `decidePayment(expected: number, info: HubtelFulfillmentInfo): "fulfil" | "needs_review" | "unsuccessful"`
  - `type OrderHandlers = Record<string, (orderId: string) => Promise<void>>`
  - `type FulfillmentOutcome = "unknown_session" | "duplicate" | "unsuccessful" | "needs_review" | "fulfilled"`
  - `processFulfillment(store: HubtelTxStore, handlers: OrderHandlers, info: HubtelFulfillmentInfo): Promise<FulfillmentOutcome>`
- Produces (`tx-store.ts`): `createSupabaseTxStore(supabase: SupabaseClient): HubtelTxStore`
- Produces (`order-handlers.ts`): `createOrderHandlers(supabase: SupabaseClient): OrderHandlers` (`ussd_orders` now), `createFailHandlers(supabase): OrderHandlers` (`ussd_orders`: marks the order failed).

- [ ] **Step 1: Write the failing test**

```ts
// lib/ussd-hubtel/payment.test.ts
import { describe, it, expect, vi } from "vitest"
import { parseFulfillmentPayload, decidePayment, processFulfillment } from "./payment"
import type { HubtelTxRow, HubtelTxStore, HubtelFulfillmentInfo } from "./types"

const payload = {
  SessionId: "S1", OrderId: "O1", ExtraData: {},
  OrderInfo: {
    Status: "Paid",
    Payment: { AmountPaid: 11.5, AmountAfterCharges: 10, IsSuccessful: true },
  },
}

describe("parseFulfillmentPayload", () => {
  it("extracts the fields we use", () => {
    expect(parseFulfillmentPayload(payload)).toEqual({
      sessionId: "S1", hubtelOrderId: "O1", amountPaid: 11.5, amountAfterCharges: 10, isSuccessful: true,
    })
  })
  it("rejects payloads without SessionId or Payment", () => {
    expect(parseFulfillmentPayload({ OrderId: "O1" })).toBeNull()
    expect(parseFulfillmentPayload({ SessionId: "S1", OrderInfo: {} })).toBeNull()
    expect(parseFulfillmentPayload(null)).toBeNull()
  })
})

const info = (over: Partial<HubtelFulfillmentInfo> = {}): HubtelFulfillmentInfo =>
  ({ sessionId: "S1", hubtelOrderId: "O1", amountPaid: 11.5, amountAfterCharges: 10, isSuccessful: true, ...over })

describe("decidePayment", () => {
  it("fulfils on exact match, within a cent, and on over-payment", () => {
    expect(decidePayment(10, info())).toBe("fulfil")
    expect(decidePayment(10, info({ amountAfterCharges: 9.995 }))).toBe("fulfil")
    expect(decidePayment(10, info({ amountAfterCharges: 12 }))).toBe("fulfil")
  })
  it("holds under-payment for review (review focus #6)", () => {
    expect(decidePayment(10, info({ amountAfterCharges: 9 }))).toBe("needs_review")
  })
  it("never fulfils an unsuccessful payment", () => {
    expect(decidePayment(10, info({ isSuccessful: false }))).toBe("unsuccessful")
  })
})

function memoryStore(row: Partial<HubtelTxRow> | null) {
  let current: HubtelTxRow | null = row
    ? ({
        session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "ussd_orders", order_id: "ord-1",
        mobile: null, expected_amount: 10, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
        callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null,
        status_check_attempts: 0, last_status_check_at: null, paid_at: null, created_at: "", updated_at: "", ...row,
      } as HubtelTxRow)
    : null
  const store: HubtelTxStore = {
    findBySession: async () => current,
    claim: async () => {
      if (current && current.state === "awaiting_payment") { current = { ...current, state: "processing" }; return true }
      return false
    },
    update: async (_id, patch) => { if (current) current = { ...current, ...patch } },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
  }
  return { store, get: () => current! }
}

describe("processFulfillment", () => {
  it("unknown session → no side effects", async () => {
    const { store } = memoryStore(null)
    const h = vi.fn()
    expect(await processFulfillment(store, { ussd_orders: h }, info())).toBe("unknown_session")
    expect(h).not.toHaveBeenCalled()
  })

  it("fulfils once, marks callback pending, records amounts", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("fulfilled")
    expect(h).toHaveBeenCalledWith("ord-1")
    expect(m.get()).toMatchObject({
      state: "fulfilled", callback_status: "pending", hubtel_order_id: "O1", amount_paid: 11.5, amount_after_charges: 10,
    })
    expect(m.get().paid_at).toBeTruthy()
  })

  it("a duplicate delivery never fulfils twice (review focus #1)", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    await processFulfillment(m.store, { ussd_orders: h }, info())
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("duplicate")
    expect(h).toHaveBeenCalledTimes(1)
  })

  it("two concurrent deliveries: exactly one wins the claim", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockResolvedValue(undefined)
    const results = await Promise.all([
      processFulfillment(m.store, { ussd_orders: h }, info()),
      processFulfillment(m.store, { ussd_orders: h }, info()),
    ])
    expect(results.sort()).toEqual(["duplicate", "fulfilled"])
    expect(h).toHaveBeenCalledTimes(1)
  })

  it("under-payment: no fulfilment, state needs_review, callback still pending", async () => {
    const m = memoryStore({})
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ amountAfterCharges: 5 }))).toBe("needs_review")
    expect(h).not.toHaveBeenCalled()
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })

  it("unsuccessful payment: failed, no callback due", async () => {
    const m = memoryStore({})
    const h = vi.fn()
    expect(await processFulfillment(m.store, { ussd_orders: h }, info({ isSuccessful: false }))).toBe("unsuccessful")
    expect(m.get()).toMatchObject({ state: "failed", callback_status: "not_due" })
  })

  it("a throwing handler → needs_review with callback pending (always-success policy)", async () => {
    const m = memoryStore({})
    const h = vi.fn().mockRejectedValue(new Error("provider down"))
    expect(await processFulfillment(m.store, { ussd_orders: h }, info())).toBe("needs_review")
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })

  it("an order table without a handler yet → needs_review, callback pending", async () => {
    const m = memoryStore({ order_table: "airtime_orders" })
    expect(await processFulfillment(m.store, { ussd_orders: vi.fn() }, info())).toBe("needs_review")
    expect(m.get()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/payment.test.ts` → Expected: FAIL (module missing).

- [ ] **Step 3: Implement `payment.ts`**

```ts
// lib/ussd-hubtel/payment.ts
import type { HubtelFulfillmentInfo, HubtelTxStore } from "./types"

export type OrderHandlers = Record<string, (orderId: string) => Promise<void>>
export type FulfillmentOutcome = "unknown_session" | "duplicate" | "unsuccessful" | "needs_review" | "fulfilled"

export function parseFulfillmentPayload(body: unknown): HubtelFulfillmentInfo | null {
  if (!body || typeof body !== "object") return null
  const b = body as any
  if (typeof b.SessionId !== "string" || !b.SessionId) return null
  const payment = b.OrderInfo?.Payment
  if (!payment || typeof payment !== "object") return null
  const paid = Number(payment.AmountPaid)
  const after = Number(payment.AmountAfterCharges)
  if (!Number.isFinite(paid) || !Number.isFinite(after)) return null
  return {
    sessionId: b.SessionId,
    hubtelOrderId: typeof b.OrderId === "string" ? b.OrderId : null,
    amountPaid: paid,
    amountAfterCharges: after,
    isSuccessful: payment.IsSuccessful === true,
  }
}

/** Under-payment (beyond one pesewa) is held; over-payment is fulfilled. */
export function decidePayment(expected: number, info: HubtelFulfillmentInfo): "fulfil" | "needs_review" | "unsuccessful" {
  if (!info.isSuccessful) return "unsuccessful"
  if (info.amountAfterCharges < expected - 0.01) return "needs_review"
  return "fulfil"
}

export async function processFulfillment(
  store: HubtelTxStore,
  handlers: OrderHandlers,
  info: HubtelFulfillmentInfo
): Promise<FulfillmentOutcome> {
  const tx = await store.findBySession(info.sessionId)
  if (!tx) return "unknown_session"
  // Atomic awaiting_payment → processing. Only the winner proceeds (idempotency).
  if (!(await store.claim(info.sessionId))) return "duplicate"

  const base = {
    hubtel_order_id: info.hubtelOrderId,
    amount_paid: info.amountPaid,
    amount_after_charges: info.amountAfterCharges,
    paid_at: new Date().toISOString(),
  }
  const decision = decidePayment(Number(tx.expected_amount), info)

  if (decision === "unsuccessful") {
    await store.update(info.sessionId, { ...base, state: "failed" })
    return "unsuccessful"
  }

  const needsReview = async () => {
    // Callback is still due: always-success policy (spec §8); the order is resolved manually.
    await store.update(info.sessionId, { ...base, state: "needs_review", callback_status: "pending" })
    return "needs_review" as const
  }

  if (decision === "needs_review") return needsReview()
  const handler = handlers[tx.order_table]
  if (!handler) {
    console.error("[HUBTEL-PAYMENT] No handler for order table:", tx.order_table, "session:", info.sessionId)
    return needsReview()
  }
  try {
    await handler(tx.order_id)
  } catch (e) {
    console.error("[HUBTEL-PAYMENT] Order handler failed:", info.sessionId, e)
    return needsReview()
  }
  await store.update(info.sessionId, { ...base, state: "fulfilled", callback_status: "pending" })
  return "fulfilled"
}
```

- [ ] **Step 4: Implement `tx-store.ts`**

```ts
// lib/ussd-hubtel/tx-store.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelTxRow, HubtelTxStore } from "./types"

export function createSupabaseTxStore(supabase: SupabaseClient): HubtelTxStore {
  return {
    async findBySession(sessionId) {
      const { data, error } = await supabase.from("hubtel_transactions").select("*").eq("session_id", sessionId).maybeSingle()
      if (error) throw error
      return (data as HubtelTxRow | null) ?? null
    },
    async claim(sessionId) {
      const { data, error } = await supabase
        .from("hubtel_transactions")
        .update({ state: "processing", updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
        .eq("state", "awaiting_payment")
        .select("session_id")
      if (error) throw error
      return (data?.length ?? 0) === 1
    },
    async update(sessionId, patch) {
      const { error } = await supabase
        .from("hubtel_transactions")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("session_id", sessionId)
      if (error) throw error
    },
    async listPendingCallbacks(limit) {
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*").eq("callback_status", "pending")
        .order("paid_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
    async listAwaitingPayment(limit) {
      const { data, error } = await supabase
        .from("hubtel_transactions").select("*").eq("state", "awaiting_payment")
        .order("created_at", { ascending: true }).limit(limit)
      if (error) throw error
      return (data ?? []) as HubtelTxRow[]
    },
  }
}
```

- [ ] **Step 5: Implement `order-handlers.ts`**

This mirrors the `ussd_orders` post-payment block in `app/api/webhooks/paystack/route.ts:301-410` (mark paid → fulfil → parent profit → recipient SMS unless held → payer SMS if a different number). It is intentionally a copy (see Deviations); dedupe is a follow-up.

```ts
// lib/ussd-hubtel/order-handlers.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderHandlers } from "./payment"

const last9 = (p: string | null | undefined) => (p || "").replace(/\D/g, "").slice(-9)

async function ussdOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order } = await supabase.from("ussd_orders").select("*").eq("id", orderId).maybeSingle()
  if (!order) throw new Error(`ussd_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed

  // Mark paid; order_status stays pending until fulfilment resolves (same as the Paystack path).
  const { error: markErr } = await supabase
    .from("ussd_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", ["pending", "otp_required"])
  if (markErr) throw markErr

  let fulfillResult: { success: boolean; message: string; held?: boolean } | undefined
  try {
    const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
    fulfillResult = await fulfillUssdOrder(orderId, order.network, order.recipient_phone, order.package_size ?? "")
    if (!fulfillResult.success) console.error("[HUBTEL-ORDER] USSD fulfilment failed:", fulfillResult.message)
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger USSD fulfilment:", e)
    await supabase.from("ussd_orders").update({ order_status: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
  }

  if (order.parent_shop_id && Number(order.parent_profit_amount) > 0) {
    const { error: profitErr } = await supabase.from("shop_profits").insert([{
      shop_id: order.parent_shop_id,
      ussd_order_id: orderId,
      profit_amount: order.parent_profit_amount,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (profitErr) console.error("[HUBTEL-ORDER] Failed to insert parent profit:", profitErr)
  }

  const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
  if (!fulfillResult?.held) {
    try {
      const { getJoinCommunityLink } = await import("@/lib/app-settings")
      await sendSMS({
        phone: order.recipient_phone,
        message: SMSTemplates.ussdOrderConfirmed(order.package_size, order.network, await getJoinCommunityLink()),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] recipient SMS failed:", e) }
  }
  if (order.dialing_phone && last9(order.dialing_phone) && last9(order.dialing_phone) !== last9(order.recipient_phone)) {
    try {
      await sendSMS({
        phone: order.dialing_phone,
        message: SMSTemplates.ussdPaymentConfirmed(
          order.package_size, order.network,
          order.recipient_phone?.slice(-4).padStart(order.recipient_phone.length, "*") ?? ""
        ),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] payer SMS failed:", e) }
  }
}

export function createOrderHandlers(supabase: SupabaseClient): OrderHandlers {
  return {
    ussd_orders: orderId => ussdOrderPostPayment(supabase, orderId),
    // Plan 2/3 register: airtime_orders, results_checker_orders, results_check_requests, ussd_afa_orders, ussd_shop_orders
  }
}

/** Used when an AddToCart never gets paid (status-check window expired). */
export function createFailHandlers(supabase: SupabaseClient): OrderHandlers {
  return {
    ussd_orders: async orderId => {
      await supabase
        .from("ussd_orders")
        .update({ order_status: "failed", payment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId)
        .in("payment_status", ["pending", "otp_required"])
    },
  }
}
```

- [ ] **Step 6: Run** `npx vitest run lib/ussd-hubtel/payment.test.ts` → Expected: PASS. Then `npx tsc --noEmit 2>&1 | grep "ussd-hubtel" || echo ok` → `ok`.

- [ ] **Step 7: Commit**

```bash
git add lib/ussd-hubtel/payment.ts lib/ussd-hubtel/payment.test.ts lib/ussd-hubtel/tx-store.ts lib/ussd-hubtel/order-handlers.ts
git commit -m "feat(hubtel): idempotent fulfilment lifecycle and ussd_orders post-payment

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Relay (droplet handler, server, Vercel client) and callback dispatch

**Files:**
- Create: `lib/ussd-hubtel/relay-handler.ts`, `lib/ussd-hubtel/relay.ts`, `lib/ussd-hubtel/callbacks.ts`, `scripts/hubtel-relay/server.ts`, `scripts/hubtel-relay/README.md`
- Test: `lib/ussd-hubtel/relay-handler.test.ts`, `lib/ussd-hubtel/callbacks.test.ts`

**Interfaces:**
- Produces (`relay-handler.ts`): `interface RelayConfig { secret: string; collectionAccount: string; statusBasicAuth: string; fetchImpl?: typeof fetch; callbackUrl?: string; statusBaseUrl?: string }`, `interface RelayRequest { method: string; path: string; query: URLSearchParams; authorization: string | null; body: string }`, `createRelayHandler(cfg: RelayConfig): (req: RelayRequest) => Promise<{ status: number; body: unknown }>`. Relay responses: `{ ok: boolean; upstreamStatus: number; body: unknown }`.
- Produces (`relay.ts`): `sendFulfillmentCallback(p: { sessionId: string; orderId: string }): Promise<{ ok: boolean; error?: string }>`, `checkTransactionStatus(sessionId: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>`.
- Produces (`callbacks.ts`): `CALLBACK_WINDOW_MS = 55 * 60 * 1000`, `callbackDisposition(row: Pick<HubtelTxRow,"callback_status"|"paid_at">, now: number): "send" | "expire" | "skip"`, `type CallbackSender = (p: { sessionId: string; orderId: string }) => Promise<{ ok: boolean; error?: string }>`, `dispatchCallback(store: HubtelTxStore, send: CallbackSender, sessionId: string, now?: number): Promise<"sent" | "retry" | "expired" | "skipped">`.

- [ ] **Step 1: Write the failing relay-handler test**

```ts
// lib/ussd-hubtel/relay-handler.test.ts
import { describe, it, expect, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

function setup(upstream = { status: 200, json: { ok: 1 } }) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(upstream.json), { status: upstream.status }))
  const handler = createRelayHandler({
    secret: "s3cret", collectionAccount: "11684", statusBasicAuth: "BASICXYZ", fetchImpl: fetchImpl as any,
  })
  return { handler, fetchImpl }
}
const auth = "Bearer s3cret"

describe("relay handler", () => {
  it("rejects missing or wrong bearer", async () => {
    const { handler } = setup()
    expect((await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: null, body: "{}" })).status).toBe(401)
    expect((await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: "Bearer nope", body: "{}" })).status).toBe(401)
  })

  it("forwards only the four callback fields to the Hubtel callback URL", async () => {
    const { handler, fetchImpl } = setup()
    const res = await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null, evil: "x" }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, upstreamStatus: 200 })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://gs-callback.hubtel.com:9055/callback")
    expect(JSON.parse(init.body)).toEqual({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null })
  })

  it("rejects a callback missing SessionId or OrderId", async () => {
    const { handler } = setup()
    const res = await handler({ method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth, body: JSON.stringify({ SessionId: "S1" }) })
    expect(res.status).toBe(400)
  })

  it("status check builds the Hubtel URL with Basic auth and a validated reference", async () => {
    const { handler, fetchImpl } = setup({ status: 200, json: { data: { status: "Paid" } } })
    const res = await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "abc123" }), authorization: auth, body: "" })
    expect(res.body).toMatchObject({ ok: true, body: { data: { status: "Paid" } } })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://api-txnstatus.hubtel.com/transactions/11684/status?clientReference=abc123")
    expect(init.headers.Authorization).toBe("Basic BASICXYZ")
  })

  it("status check rejects unsafe references", async () => {
    const { handler } = setup()
    const res = await handler({ method: "GET", path: "/status", query: new URLSearchParams({ clientReference: "a/../b" }), authorization: auth, body: "" })
    expect(res.status).toBe(400)
  })

  it("reports upstream failure as ok:false without throwing", async () => {
    const { handler } = setup({ status: 500, json: { err: 1 } })
    const res = await handler({
      method: "POST", path: "/callback", query: new URLSearchParams(), authorization: auth,
      body: JSON.stringify({ SessionId: "S1", OrderId: "O1", ServiceStatus: "success", MetaData: null }),
    })
    expect(res.body).toMatchObject({ ok: false, upstreamStatus: 500 })
  })

  it("404s unknown paths", async () => {
    const { handler } = setup()
    expect((await handler({ method: "GET", path: "/nope", query: new URLSearchParams(), authorization: auth, body: "" })).status).toBe(404)
  })
})
```

- [ ] **Step 2: Write the failing callbacks test**

```ts
// lib/ussd-hubtel/callbacks.test.ts
import { describe, it, expect, vi } from "vitest"
import { callbackDisposition, dispatchCallback, CALLBACK_WINDOW_MS } from "./callbacks"
import type { HubtelTxRow, HubtelTxStore } from "./types"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

describe("callbackDisposition", () => {
  it("sends a fresh pending callback", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: iso(NOW - 60_000) }, NOW)).toBe("send")
  })
  it("expires once the 55-minute safety window has passed (review focus #4)", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: iso(NOW - CALLBACK_WINDOW_MS - 1) }, NOW)).toBe("expire")
  })
  it("skips anything that is not pending", () => {
    for (const s of ["sent", "failed", "not_due"] as const)
      expect(callbackDisposition({ callback_status: s, paid_at: iso(NOW) }, NOW)).toBe("skip")
  })
  it("treats a missing paid_at as fresh (sends)", () => {
    expect(callbackDisposition({ callback_status: "pending", paid_at: null }, NOW)).toBe("send")
  })
})

function store(row: Partial<HubtelTxRow>) {
  let cur = { session_id: "S1", hubtel_order_id: "O1", callback_status: "pending", callback_attempts: 0, callback_last_error: null, callback_sent_at: null, paid_at: iso(NOW - 1000), ...row } as HubtelTxRow
  const s: HubtelTxStore = {
    findBySession: async () => cur,
    claim: async () => false,
    update: async (_id, p) => { cur = { ...cur, ...p } },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
  }
  return { s, get: () => cur }
}

describe("dispatchCallback", () => {
  it("marks sent on success", async () => {
    const m = store({})
    const send = vi.fn().mockResolvedValue({ ok: true })
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("sent")
    expect(send).toHaveBeenCalledWith({ sessionId: "S1", orderId: "O1" })
    expect(m.get()).toMatchObject({ callback_status: "sent", callback_attempts: 1 })
    expect(m.get().callback_sent_at).toBeTruthy()
  })
  it("keeps pending and records the error on failure", async () => {
    const m = store({})
    const send = vi.fn().mockResolvedValue({ ok: false, error: "relay 502" })
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("retry")
    expect(m.get()).toMatchObject({ callback_status: "pending", callback_attempts: 1, callback_last_error: "relay 502" })
  })
  it("marks failed (and does not call the relay) after the window", async () => {
    const m = store({ paid_at: iso(NOW - CALLBACK_WINDOW_MS - 5) })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("expired")
    expect(send).not.toHaveBeenCalled()
    expect(m.get().callback_status).toBe("failed")
  })
  it("skips a row that is already sent", async () => {
    const m = store({ callback_status: "sent" })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("skipped")
    expect(send).not.toHaveBeenCalled()
  })
  it("fails the row when no Hubtel OrderId is known", async () => {
    const m = store({ hubtel_order_id: null })
    const send = vi.fn()
    expect(await dispatchCallback(m.s, send, "S1", NOW)).toBe("retry")
    expect(send).not.toHaveBeenCalled()
    expect(m.get().callback_last_error).toMatch(/order id/i)
  })
})
```

- [ ] **Step 3: Run both** — `npx vitest run lib/ussd-hubtel/relay-handler.test.ts lib/ussd-hubtel/callbacks.test.ts` → Expected: FAIL.

- [ ] **Step 4: Implement `relay-handler.ts`**

```ts
// lib/ussd-hubtel/relay-handler.ts
// Pure request handler for the DigitalOcean relay. No business logic, no queue.
// It exists so Hubtel sees a fixed (whitelisted) source IP for two outbound calls.
import crypto from "crypto"

export interface RelayConfig {
  secret: string
  collectionAccount: string
  statusBasicAuth: string // base64 "user:pass" credential, without the "Basic " prefix
  fetchImpl?: typeof fetch
  callbackUrl?: string
  statusBaseUrl?: string
}

export interface RelayRequest {
  method: string
  path: string
  query: URLSearchParams
  authorization: string | null
  body: string
}

const SAFE_REF = /^[A-Za-z0-9_-]{1,100}$/

function bearerOk(authorization: string | null, secret: string): boolean {
  if (!authorization?.startsWith("Bearer ") || !secret) return false
  const a = Buffer.from(authorization.slice(7))
  const b = Buffer.from(secret)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

export function createRelayHandler(cfg: RelayConfig) {
  const doFetch = cfg.fetchImpl ?? fetch
  const callbackUrl = cfg.callbackUrl ?? "https://gs-callback.hubtel.com:9055/callback"
  const statusBase = cfg.statusBaseUrl ?? "https://api-txnstatus.hubtel.com"

  return async function handle(req: RelayRequest): Promise<{ status: number; body: unknown }> {
    if (!bearerOk(req.authorization, cfg.secret)) return { status: 401, body: { error: "unauthorized" } }

    if (req.method === "POST" && req.path === "/callback") {
      let parsed: any
      try { parsed = JSON.parse(req.body) } catch { return { status: 400, body: { error: "invalid json" } } }
      if (typeof parsed?.SessionId !== "string" || typeof parsed?.OrderId !== "string") {
        return { status: 400, body: { error: "SessionId and OrderId required" } }
      }
      const payload = {
        SessionId: parsed.SessionId,
        OrderId: parsed.OrderId,
        ServiceStatus: parsed.ServiceStatus ?? "success",
        MetaData: parsed.MetaData ?? null,
      }
      try {
        const res = await doFetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
          body: JSON.stringify(payload),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    if (req.method === "GET" && req.path === "/status") {
      const ref = req.query.get("clientReference") ?? ""
      if (!SAFE_REF.test(ref)) return { status: 400, body: { error: "invalid clientReference" } }
      const url = `${statusBase}/transactions/${encodeURIComponent(cfg.collectionAccount)}/status?clientReference=${encodeURIComponent(ref)}`
      try {
        const res = await doFetch(url, { method: "GET", headers: { Authorization: `Basic ${cfg.statusBasicAuth}` } })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }

    return { status: 404, body: { error: "not found" } }
  }
}
```

- [ ] **Step 5: Implement `callbacks.ts` and `relay.ts`**

```ts
// lib/ussd-hubtel/callbacks.ts
import type { HubtelTxRow, HubtelTxStore } from "./types"

/** Hubtel requires the callback within 1h of fulfilment; stop retrying at 55 minutes. */
export const CALLBACK_WINDOW_MS = 55 * 60 * 1000

export type CallbackSender = (p: { sessionId: string; orderId: string }) => Promise<{ ok: boolean; error?: string }>

export function callbackDisposition(
  row: Pick<HubtelTxRow, "callback_status" | "paid_at">,
  now: number
): "send" | "expire" | "skip" {
  if (row.callback_status !== "pending") return "skip"
  const paid = row.paid_at ? new Date(row.paid_at).getTime() : now
  return now - paid > CALLBACK_WINDOW_MS ? "expire" : "send"
}

export async function dispatchCallback(
  store: HubtelTxStore,
  send: CallbackSender,
  sessionId: string,
  now: number = Date.now()
): Promise<"sent" | "retry" | "expired" | "skipped"> {
  const row = await store.findBySession(sessionId)
  if (!row) return "skipped"
  const disposition = callbackDisposition(row, now)
  if (disposition === "skip") return "skipped"
  if (disposition === "expire") {
    await store.update(sessionId, { callback_status: "failed", callback_last_error: row.callback_last_error ?? "callback window expired" })
    return "expired"
  }
  if (!row.hubtel_order_id) {
    await store.update(sessionId, { callback_attempts: row.callback_attempts + 1, callback_last_error: "no Hubtel order id on record" })
    return "retry"
  }
  const result = await send({ sessionId, orderId: row.hubtel_order_id })
  if (result.ok) {
    await store.update(sessionId, {
      callback_status: "sent", callback_attempts: row.callback_attempts + 1,
      callback_sent_at: new Date(now).toISOString(), callback_last_error: null,
    })
    return "sent"
  }
  await store.update(sessionId, { callback_attempts: row.callback_attempts + 1, callback_last_error: result.error ?? "callback failed" })
  return "retry"
}
```

```ts
// lib/ussd-hubtel/relay.ts
// Vercel-side client for the DO relay. Never calls Hubtel directly.
function relayConfig(): { url: string; secret: string } | null {
  const url = process.env.HUBTEL_RELAY_URL
  const secret = process.env.HUBTEL_RELAY_SECRET
  return url && secret ? { url: url.replace(/\/$/, ""), secret } : null
}

export async function sendFulfillmentCallback(p: { sessionId: string; orderId: string }): Promise<{ ok: boolean; error?: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.secret}` },
      // Always "success": spec §8 (failures are handled in our own admin / refunds, not via Hubtel).
      body: JSON.stringify({ SessionId: p.sessionId, OrderId: p.orderId, ServiceStatus: "success", MetaData: null }),
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}: ${JSON.stringify(json?.body ?? null).slice(0, 200)}` }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export async function checkTransactionStatus(
  sessionId: string
): Promise<{ ok: boolean; status?: string; data?: any; error?: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/status?clientReference=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    if (!res.ok || !json?.ok) return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}` }
    const data = json.body?.data
    return { ok: true, status: data?.status, data }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
```

- [ ] **Step 6: Droplet server and README**

```ts
// scripts/hubtel-relay/server.ts
// Run on the DigitalOcean droplet:  npx tsx server.ts
// Copy this file and lib/ussd-hubtel/relay-handler.ts side by side and fix the import below.
import http from "http"
import { createRelayHandler } from "./relay-handler"

const required = ["RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_STATUS_BASIC_AUTH"] as const
for (const k of required) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1) }

const handle = createRelayHandler({
  secret: process.env.RELAY_SECRET!,
  collectionAccount: process.env.HUBTEL_COLLECTION_ACCOUNT!,
  statusBasicAuth: process.env.HUBTEL_STATUS_BASIC_AUTH!,
})

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", c => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024) req.destroy() })
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", "http://relay")
    const out = await handle({
      method: req.method ?? "GET", path: url.pathname, query: url.searchParams,
      authorization: (req.headers.authorization as string | undefined) ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    })
    res.writeHead(out.status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(out.body))
  })
})
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () =>
  console.log(`hubtel relay listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8080}`))
```

```markdown
# Hubtel relay (DigitalOcean)

Forwards two calls so Hubtel sees one fixed, whitelisted IP: the fulfilment callback and the
transaction status check. No business logic, no queue. Retries live in Vercel crons.

## Deploy
1. Create a droplet (Ubuntu, smallest size). Note its public IPv4 — give this to your Hubtel
   Retail Systems Engineer for whitelisting (callback + status-check endpoints).
2. `ufw allow 22,80,443/tcp && ufw enable`; install Node 20+ and Caddy.
3. Copy `server.ts` and `../../lib/ussd-hubtel/relay-handler.ts` into `/opt/hubtel-relay/`
   (keep them side by side; the import `./relay-handler` then resolves).
4. Env (systemd `EnvironmentFile`): `RELAY_SECRET` (long random; same value as Vercel
   `HUBTEL_RELAY_SECRET`), `HUBTEL_COLLECTION_ACCOUNT`, `HUBTEL_STATUS_BASIC_AUTH`
   (base64 of `apikey:secret`, no "Basic " prefix), optional `PORT`/`HOST`.
5. systemd unit: `ExecStart=/usr/bin/npx tsx /opt/hubtel-relay/server.ts`, `Restart=always`.
6. Caddy reverse-proxy `relay.<your-domain>` → `127.0.0.1:8080` (automatic TLS).
7. Vercel env: `HUBTEL_RELAY_URL=https://relay.<your-domain>`, `HUBTEL_RELAY_SECRET=<same secret>`.
8. Smoke test (expect 401 without the secret, 400 with a bad reference):
   `curl -i https://relay.<domain>/status?clientReference=x` and with `-H "Authorization: Bearer $SECRET"`.
```

- [ ] **Step 7: Run** `npx vitest run lib/ussd-hubtel/relay-handler.test.ts lib/ussd-hubtel/callbacks.test.ts` → Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/ussd-hubtel/relay-handler.ts lib/ussd-hubtel/relay-handler.test.ts lib/ussd-hubtel/relay.ts lib/ussd-hubtel/callbacks.ts lib/ussd-hubtel/callbacks.test.ts scripts/hubtel-relay
git commit -m "feat(hubtel): DO relay handler/server, relay client, callback dispatch

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Status-check runner

**Files:**
- Create: `lib/ussd-hubtel/status-check.ts`
- Test: `lib/ussd-hubtel/status-check.test.ts`

**Interfaces:**
- Consumes: `HubtelTxStore`, `processFulfillment`, `OrderHandlers`, `checkTransactionStatus` shape from Task 8.
- Produces:
  - `STATUS_CHECK_MIN_AGE_MS = 5 * 60_000`, `STATUS_CHECK_MAX_AGE_MS = 60 * 60_000`, `STATUS_CHECK_MAX_ATTEMPTS = 6`, `STATUS_CHECK_GAP_MS = 5 * 60_000`
  - `statusCheckDisposition(row: Pick<HubtelTxRow, "created_at" | "status_check_attempts" | "last_status_check_at">, now: number): "skip" | "check" | "expire"`
  - `type StatusChecker = (sessionId: string) => Promise<{ ok: boolean; status?: string; data?: any; error?: string }>`
  - `runStatusChecks(args: { store: HubtelTxStore; handlers: OrderHandlers; failHandlers: OrderHandlers; check: StatusChecker; now?: number; limit?: number }): Promise<{ checked: number; paid: number; expired: number }>`

Behaviour: for each `awaiting_payment` row — skip if younger than 5 min or checked within 5 min; expire (mark `failed`, run the fail handler, no callback) if older than 60 min or attempts exhausted; otherwise call the checker, bump attempts. Hubtel status `Paid` → `processFulfillment` with `hubtelOrderId = data.transactionId` and `amountAfterCharges = data.amountAfterCharges`. **Open item (runbook):** confirm with Hubtel that `transactionId` is accepted as the callback `OrderId` when the fulfilment webhook never arrived.

- [ ] **Step 1: Write the failing test**

```ts
// lib/ussd-hubtel/status-check.test.ts
import { describe, it, expect, vi } from "vitest"
import { statusCheckDisposition, runStatusChecks, STATUS_CHECK_MAX_ATTEMPTS } from "./status-check"
import type { HubtelTxRow, HubtelTxStore } from "./types"

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0)
const mins = (n: number) => new Date(NOW - n * 60_000).toISOString()

describe("statusCheckDisposition", () => {
  const base = { status_check_attempts: 0, last_status_check_at: null as string | null }
  it("skips orders younger than 5 minutes", () => expect(statusCheckDisposition({ ...base, created_at: mins(2) }, NOW)).toBe("skip"))
  it("checks orders between 5 and 60 minutes old", () => expect(statusCheckDisposition({ ...base, created_at: mins(8) }, NOW)).toBe("check"))
  it("skips when checked less than 5 minutes ago", () =>
    expect(statusCheckDisposition({ ...base, created_at: mins(20), last_status_check_at: mins(2) }, NOW)).toBe("skip"))
  it("expires after 60 minutes or after the attempt cap", () => {
    expect(statusCheckDisposition({ ...base, created_at: mins(61) }, NOW)).toBe("expire")
    expect(statusCheckDisposition({ ...base, created_at: mins(20), status_check_attempts: STATUS_CHECK_MAX_ATTEMPTS }, NOW)).toBe("expire")
  })
})

function store(rows: Partial<HubtelTxRow>[]) {
  const state = new Map<string, HubtelTxRow>(
    rows.map(r => [r.session_id!, {
      hubtel_order_id: null, platform: "USSD", order_table: "ussd_orders", order_id: "ord-" + r.session_id, mobile: null,
      expected_amount: 10, amount_paid: null, amount_after_charges: null, state: "awaiting_payment",
      callback_status: "not_due", callback_attempts: 0, callback_last_error: null, callback_sent_at: null,
      status_check_attempts: 0, last_status_check_at: null, paid_at: null, updated_at: "", ...r,
    } as HubtelTxRow])
  )
  const s: HubtelTxStore = {
    findBySession: async id => state.get(id) ?? null,
    claim: async id => { const r = state.get(id); if (r && r.state === "awaiting_payment") { state.set(id, { ...r, state: "processing" }); return true } return false },
    update: async (id, p) => { const r = state.get(id); if (r) state.set(id, { ...r, ...p }) },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [...state.values()].filter(r => r.state === "awaiting_payment"),
  }
  return { s, state }
}

describe("runStatusChecks", () => {
  it("fulfils a Paid transaction found by the status check", async () => {
    const m = store([{ session_id: "A", created_at: mins(10) }])
    const handler = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({
      store: m.s, handlers: { ussd_orders: handler }, failHandlers: {},
      check: async () => ({ ok: true, status: "Paid", data: { status: "Paid", transactionId: "T9", amount: 11.5, amountAfterCharges: 10 } }),
      now: NOW,
    })
    expect(res).toMatchObject({ checked: 1, paid: 1, expired: 0 })
    expect(handler).toHaveBeenCalledWith("ord-A")
    expect(m.state.get("A")).toMatchObject({ state: "fulfilled", hubtel_order_id: "T9", callback_status: "pending" })
  })

  it("leaves Unpaid rows waiting and records the attempt", async () => {
    const m = store([{ session_id: "B", created_at: mins(10) }])
    await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid" } }), now: NOW })
    expect(m.state.get("B")).toMatchObject({ state: "awaiting_payment", status_check_attempts: 1 })
    expect(m.state.get("B")!.last_status_check_at).toBeTruthy()
  })

  it("a failed check call still counts as an attempt and never throws", async () => {
    const m = store([{ session_id: "C", created_at: mins(10) }])
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: {}, check: async () => ({ ok: false, error: "relay down" }), now: NOW })
    expect(res.checked).toBe(1)
    expect(m.state.get("C")!.status_check_attempts).toBe(1)
  })

  it("expires stale unpaid orders: row failed, order failed, no callback", async () => {
    const m = store([{ session_id: "D", created_at: mins(90) }])
    const fail = vi.fn().mockResolvedValue(undefined)
    const res = await runStatusChecks({ store: m.s, handlers: {}, failHandlers: { ussd_orders: fail }, check: vi.fn(), now: NOW })
    expect(res.expired).toBe(1)
    expect(fail).toHaveBeenCalledWith("ord-D")
    expect(m.state.get("D")).toMatchObject({ state: "failed", callback_status: "not_due" })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/status-check.test.ts` → Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// lib/ussd-hubtel/status-check.ts
import { processFulfillment, type OrderHandlers } from "./payment"
import type { HubtelTxRow, HubtelTxStore } from "./types"

export const STATUS_CHECK_MIN_AGE_MS = 5 * 60_000
export const STATUS_CHECK_MAX_AGE_MS = 60 * 60_000
export const STATUS_CHECK_MAX_ATTEMPTS = 6
export const STATUS_CHECK_GAP_MS = 5 * 60_000

export type StatusChecker = (sessionId: string) => Promise<{ ok: boolean; status?: string; data?: any; error?: string }>

export function statusCheckDisposition(
  row: Pick<HubtelTxRow, "created_at" | "status_check_attempts" | "last_status_check_at">,
  now: number
): "skip" | "check" | "expire" {
  const age = now - new Date(row.created_at).getTime()
  if (age > STATUS_CHECK_MAX_AGE_MS || row.status_check_attempts >= STATUS_CHECK_MAX_ATTEMPTS) return "expire"
  if (age < STATUS_CHECK_MIN_AGE_MS) return "skip"
  if (row.last_status_check_at && now - new Date(row.last_status_check_at).getTime() < STATUS_CHECK_GAP_MS) return "skip"
  return "check"
}

export async function runStatusChecks(args: {
  store: HubtelTxStore
  handlers: OrderHandlers
  failHandlers: OrderHandlers
  check: StatusChecker
  now?: number
  limit?: number
}): Promise<{ checked: number; paid: number; expired: number }> {
  const now = args.now ?? Date.now()
  const rows = await args.store.listAwaitingPayment(args.limit ?? 50)
  const out = { checked: 0, paid: 0, expired: 0 }

  for (const row of rows) {
    const disposition = statusCheckDisposition(row, now)
    if (disposition === "skip") continue

    if (disposition === "expire") {
      try {
        const fail = args.failHandlers[row.order_table]
        if (fail) await fail(row.order_id)
      } catch (e) { console.error("[HUBTEL-STATUS] fail handler error:", row.session_id, e) }
      // Never paid ⇒ no fulfilment, so no callback is due.
      await args.store.update(row.session_id, { state: "failed", callback_status: "not_due" })
      out.expired++
      continue
    }

    out.checked++
    const res = await args.check(row.session_id)
    await args.store.update(row.session_id, {
      status_check_attempts: row.status_check_attempts + 1,
      last_status_check_at: new Date(now).toISOString(),
    })
    if (!res.ok || res.status !== "Paid") continue

    const d = res.data ?? {}
    const outcome = await processFulfillment(args.store, args.handlers, {
      sessionId: row.session_id,
      hubtelOrderId: typeof d.transactionId === "string" ? d.transactionId : null,
      amountPaid: Number(d.amount ?? 0),
      amountAfterCharges: Number(d.amountAfterCharges ?? 0),
      isSuccessful: true,
    })
    if (outcome === "fulfilled" || outcome === "needs_review") out.paid++
  }
  return out
}
```

- [ ] **Step 4: Run** `npx vitest run lib/ussd-hubtel/status-check.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/status-check.ts lib/ussd-hubtel/status-check.test.ts
git commit -m "feat(hubtel): status-check runner with expiry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Endpoints and crons

**Files:**
- Create: `app/api/ussd-hubtel/interaction/route.ts`, `app/api/ussd-hubtel/fulfillment/route.ts`, `app/api/cron/hubtel-callbacks/route.ts`, `app/api/cron/hubtel-status-check/route.ts`
- Modify: `vercel.json` (add two cron entries)

**Interfaces:**
- Consumes: everything above. Auth on Hubtel-facing routes: `secretsMatch(searchParams.get("secret") ?? header "x-hubtel-secret", process.env.HUBTEL_WEBHOOK_SECRET)`; missing env ⇒ 503. Crons: `verifyCronAuth` from `@/lib/cron-auth`.
- These are thin glue over unit-tested modules; verification is typecheck + the simulator in Task 12 (project convention: no route-level tests for glue).

- [ ] **Step 1: Interaction route**

```ts
// app/api/ussd-hubtel/interaction/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { parseHubtelRequest, release, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { hubtelRouter, defaultRouterDeps } from "@/lib/ussd-hubtel/router"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Hubtel Service Interaction URL: https://<domain>/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>
export async function POST(request: NextRequest) {
  const expected = process.env.HUBTEL_WEBHOOK_SECRET
  if (!expected) {
    console.error("[HUBTEL] HUBTEL_WEBHOOK_SECRET not set — failing closed")
    return NextResponse.json({ error: "Service not configured" }, { status: 503 })
  }
  const provided = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-hubtel-secret")
  if (!secretsMatch(provided, expected)) {
    console.warn("[HUBTEL] Rejected interaction request with invalid secret")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const req = parseHubtelRequest(body)
  if (!req) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  console.log("[HUBTEL] Incoming:", { sid: req.SessionId, type: req.Type, platform: req.Platform, seq: req.Sequence, input: req.Message })
  try {
    const reply = await hubtelRouter(req, defaultRouterDeps(supabase))
    console.log("[HUBTEL] Reply:", { type: reply.Type, msg: reply.Message.slice(0, 60) })
    return NextResponse.json(reply)
  } catch (e) {
    console.error("[HUBTEL] Router error:", e)
    // Always answer with a well-formed reply so the user sees our message, not Hubtel's UUE error.
    return NextResponse.json(release(req.SessionId, "Service unavailable. Please try again.", { platform: req.Platform }))
  }
}
```

- [ ] **Step 2: Fulfilment route**

```ts
// app/api/ussd-hubtel/fulfillment/route.ts
import { after, NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getClientIp, isHubtelFulfillmentIp, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { parseFulfillmentPayload, processFulfillment } from "@/lib/ussd-hubtel/payment"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Hubtel Service Fulfilment URL: https://<domain>/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>
export async function POST(request: NextRequest) {
  const expected = process.env.HUBTEL_WEBHOOK_SECRET
  if (!expected) return NextResponse.json({ error: "Service not configured" }, { status: 503 })
  const provided = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-hubtel-secret")
  if (!secretsMatch(provided, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (process.env.HUBTEL_ENFORCE_FULFILLMENT_IP === "true" && !isHubtelFulfillmentIp(getClientIp(request.headers))) {
    console.warn("[HUBTEL-FULFILL] Rejected: source IP not in Hubtel allowlist:", getClientIp(request.headers))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const info = parseFulfillmentPayload(body)
  if (!info) return NextResponse.json({ error: "Invalid payload" }, { status: 400 })

  const store = createSupabaseTxStore(supabase)
  const outcome = await processFulfillment(store, createOrderHandlers(supabase), info)
  console.log("[HUBTEL-FULFILL]", info.sessionId, "→", outcome)

  if (outcome === "fulfilled" || outcome === "needs_review") {
    // Immediate attempt; the callbacks cron retries if this fails.
    after(async () => {
      try { await dispatchCallback(store, sendFulfillmentCallback, info.sessionId) }
      catch (e) { console.error("[HUBTEL-FULFILL] immediate callback error:", e) }
    })
  }
  // Always 200 for handled/duplicate/unknown so Hubtel does not hammer retries.
  return NextResponse.json({ received: true, outcome })
}
```

- [ ] **Step 3: Cron routes**

```ts
// app/api/cron/hubtel-callbacks/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const store = createSupabaseTxStore(supabase)
  const rows = await store.listPendingCallbacks(50)
  const counts: Record<string, number> = {}
  for (const row of rows) {
    try {
      const r = await dispatchCallback(store, sendFulfillmentCallback, row.session_id)
      counts[r] = (counts[r] ?? 0) + 1
    } catch (e) { console.error("[HUBTEL-CRON] callback error:", row.session_id, e) }
  }
  return NextResponse.json({ processed: rows.length, ...counts })
}
```

```ts
// app/api/cron/hubtel-status-check/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers, createFailHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { runStatusChecks } from "@/lib/ussd-hubtel/status-check"
import { checkTransactionStatus } from "@/lib/ussd-hubtel/relay"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const result = await runStatusChecks({
    store: createSupabaseTxStore(supabase),
    handlers: createOrderHandlers(supabase),
    failHandlers: createFailHandlers(supabase),
    check: checkTransactionStatus,
  })
  return NextResponse.json(result)
}
```

- [ ] **Step 4: Register the crons** — in `vercel.json`, inside the `"crons": [` array add:

```json
    {
      "path": "/api/cron/hubtel-callbacks",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/hubtel-status-check",
      "schedule": "*/2 * * * *"
    },
```

- [ ] **Step 5: Typecheck and test**

Run: `npx tsc --noEmit 2>&1 | grep -E "ussd-hubtel|hubtel-" || echo "no hubtel type errors"` → Expected: `no hubtel type errors`.
Run: `npm run test:run` → Expected: whole suite PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add app/api/ussd-hubtel app/api/cron/hubtel-callbacks app/api/cron/hubtel-status-check vercel.json
git commit -m "feat(hubtel): interaction + fulfilment endpoints and crons

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Admin API and `/admin/ussd-hubtel` page

**Files:**
- Create: `app/api/admin/ussd-hubtel/config/route.ts`, `app/api/admin/ussd-hubtel/transactions/route.ts`, `app/api/admin/ussd-hubtel/retry-callback/route.ts`, `app/admin/ussd-hubtel/page.tsx`
- Modify: `components/layout/sidebar.tsx` (add link after the "USSD Shops" `<Link>` block, ~line 1058)

**Interfaces:**
- Consumes: `verifyAdminAccess` (`@/lib/admin-auth`), `getHubtelUssdConfig`/`setHubtelUssdConfig`, `createSupabaseTxStore`, `dispatchCallback`, `sendFulfillmentCallback`.
- Produces API contracts used by the page:
  - `GET /api/admin/ussd-hubtel/config` → `{ config: HubtelUssdConfig; env: { webhookSecret: boolean; relayUrl: boolean; relaySecret: boolean } }`
  - `POST /api/admin/ussd-hubtel/config` body `{ enabled?: boolean; mode?: "main"|"shop"; visibility?: Partial<…> }` → `{ config }`. Rejects `mode: "shop"` with 400 until Plan 3.
  - `GET /api/admin/ussd-hubtel/transactions` → `{ transactions: HubtelTxRow[]; counts: { needs_review: number; callback_pending: number; callback_failed: number; awaiting_payment: number } }`
  - `POST /api/admin/ussd-hubtel/retry-callback` body `{ sessionId: string }` → `{ result: "sent"|"retry"|"expired"|"skipped" }`; resets a `failed` callback to `pending` with fresh attempt state before dispatching.

- [ ] **Step 1: Config API**

```ts
// app/api/admin/ussd-hubtel/config/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getHubtelUssdConfig, setHubtelUssdConfig } from "@/lib/ussd-hubtel/config"

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  try {
    const config = await getHubtelUssdConfig(adminClient())
    return NextResponse.json({
      config,
      env: {
        webhookSecret: !!process.env.HUBTEL_WEBHOOK_SECRET,
        relayUrl: !!process.env.HUBTEL_RELAY_URL,
        relaySecret: !!process.env.HUBTEL_RELAY_SECRET,
      },
    })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config GET error:", e)
    return NextResponse.json({ error: "Failed to load Hubtel USSD config" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }

  if (body?.mode !== undefined && body.mode !== "main") {
    return NextResponse.json({ error: "Only 'main' mode is available yet" }, { status: 400 })
  }
  if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
  }
  const vis = body?.visibility
  if (vis !== undefined) {
    const valid = ["data", "afa", "airtime", "resultsChecker"]
    if (typeof vis !== "object" || vis === null || Object.entries(vis).some(([k, v]) => !valid.includes(k) || typeof v !== "boolean")) {
      return NextResponse.json({ error: "invalid visibility" }, { status: 400 })
    }
  }

  const client = adminClient()
  try {
    const before = await getHubtelUssdConfig(client)
    const config = await setHubtelUssdConfig(client, { enabled: body.enabled, mode: body.mode, visibility: body.visibility })
    client.from("admin_audit_log").insert([{
      admin_id: userId, action: "hubtel_ussd_config_update", target_user_id: null,
      old_value: before, new_value: config, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel config log failed:", error.message) })
    return NextResponse.json({ config })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config POST error:", e)
    return NextResponse.json({ error: "Failed to update Hubtel USSD config" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Transactions and retry APIs**

```ts
// app/api/admin/ussd-hubtel/transactions/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const [recent, review, cbPending, cbFailed, awaiting] = await Promise.all([
    supabase.from("hubtel_transactions").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "needs_review"),
    supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "pending"),
    supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "failed"),
    supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "awaiting_payment"),
  ])
  if (recent.error) return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
  return NextResponse.json({
    transactions: recent.data ?? [],
    counts: {
      needs_review: review.count ?? 0, callback_pending: cbPending.count ?? 0,
      callback_failed: cbFailed.count ?? 0, awaiting_payment: awaiting.count ?? 0,
    },
  })
}
```

```ts
// app/api/admin/ussd-hubtel/retry-callback/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  const { sessionId } = (await request.json().catch(() => ({}))) as { sessionId?: string }
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

  const store = createSupabaseTxStore(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!))
  const row = await store.findBySession(sessionId)
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (row.state === "awaiting_payment" || row.state === "failed") {
    return NextResponse.json({ error: "Nothing to call back for this transaction" }, { status: 409 })
  }
  // Re-arm: a manual retry gets a fresh window from now (Hubtel may still reject past 1h — surfaced in the error).
  if (row.callback_status === "failed") {
    await store.update(sessionId, { callback_status: "pending", paid_at: new Date().toISOString(), callback_last_error: null })
  }
  const result = await dispatchCallback(store, sendFulfillmentCallback, sessionId)
  return NextResponse.json({ result })
}
```

- [ ] **Step 3: Admin page**

```tsx
// app/admin/ussd-hubtel/page.tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import type { HubtelUssdConfig } from "@/lib/ussd-hubtel/config"
import type { HubtelTxRow } from "@/lib/ussd-hubtel/types"

type EnvStatus = { webhookSecret: boolean; relayUrl: boolean; relaySecret: boolean }
type Counts = { needs_review: number; callback_pending: number; callback_failed: number; awaiting_payment: number }

const SERVICES: { key: keyof HubtelUssdConfig["visibility"]; label: string; live: boolean }[] = [
  { key: "data", label: "Data Bundle", live: true },
  { key: "afa", label: "AFA Registration", live: false },
  { key: "airtime", label: "Buy Airtime", live: false },
  { key: "resultsChecker", label: "Results Checker", live: false },
]

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("No authentication token available")
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || "Request failed")
  return json
}

export default function AdminUssdHubtelPage() {
  const [config, setConfig] = useState<HubtelUssdConfig | null>(null)
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [txs, setTxs] = useState<HubtelTxRow[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([authed("/api/admin/ussd-hubtel/config"), authed("/api/admin/ussd-hubtel/transactions")])
      setConfig(c.config); setEnv(c.env); setTxs(t.transactions); setCounts(t.counts)
    } catch (e: any) { toast.error(e.message || "Failed to load Hubtel USSD") }
  }, [])
  useEffect(() => { load() }, [load])

  const save = async (patch: object, label: string) => {
    setBusy(label)
    try {
      const res = await authed("/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(patch) })
      setConfig(res.config); toast.success("Saved")
    } catch (e: any) { toast.error(e.message || "Save failed") } finally { setBusy(null) }
  }

  const retry = async (sessionId: string) => {
    setBusy(sessionId)
    try {
      const res = await authed("/api/admin/ussd-hubtel/retry-callback", { method: "POST", body: JSON.stringify({ sessionId }) })
      toast.success(`Callback: ${res.result}`); await load()
    } catch (e: any) { toast.error(e.message || "Retry failed") } finally { setBusy(null) }
  }

  const envOk = env && env.webhookSecret && env.relayUrl && env.relaySecret

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner title="Hubtel USSD" subtitle="One Hubtel code serving the main menu. Configure the channel and watch payments." />

        <Card>
          <CardHeader>
            <CardTitle>Channel</CardTitle>
            <CardDescription>The kill switch ships OFF. Turn it on only after the runbook checks pass.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!config ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Hubtel USSD enabled</span>
                  <Switch checked={config.enabled} disabled={busy === "enabled" || (!config.enabled && !envOk)} aria-label="Toggle Hubtel USSD"
                    onCheckedChange={v => save({ enabled: v }, "enabled")} />
                </div>
                {!envOk && <p className="text-xs text-amber-600">Cannot enable until all environment variables below are configured.</p>}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Mode</span>
                  <Select value={config.mode} onValueChange={v => save({ mode: v }, "mode")}>
                    <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="main">Main USSD</SelectItem>
                      <SelectItem value="shop" disabled>Shop USSD (coming soon)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="divide-y rounded-lg border">
                  {SERVICES.map(s => (
                    <div key={s.key} className="flex items-center justify-between p-3">
                      <span className="text-sm">{s.label}{!s.live && <Badge variant="outline" className="ml-2">not built yet</Badge>}</span>
                      <Switch checked={config.visibility[s.key]} disabled={busy === s.key} aria-label={`Toggle ${s.label}`}
                        onCheckedChange={v => save({ visibility: { [s.key]: v } }, s.key)} />
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Environment</CardTitle><CardDescription>Secrets live in env vars; this only shows whether they are set.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {env && ([["HUBTEL_WEBHOOK_SECRET", env.webhookSecret], ["HUBTEL_RELAY_URL", env.relayUrl], ["HUBTEL_RELAY_SECRET", env.relaySecret]] as const).map(([k, ok]) => (
              <Badge key={k} variant={ok ? "default" : "destructive"}>{k}: {ok ? "set" : "missing"}</Badge>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Payments</CardTitle>
              {counts && <CardDescription>
                {counts.awaiting_payment} awaiting · {counts.needs_review} need review · {counts.callback_pending} callbacks pending · {counts.callback_failed} callbacks failed
              </CardDescription>}
            </div>
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="w-4 h-4" /></Button>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground">
                <th className="p-2">Time</th><th className="p-2">Platform</th><th className="p-2">Mobile</th><th className="p-2">Expected</th>
                <th className="p-2">Paid</th><th className="p-2">State</th><th className="p-2">Callback</th><th className="p-2" />
              </tr></thead>
              <tbody>
                {txs.map(t => (
                  <tr key={t.session_id} className="border-t">
                    <td className="p-2">{new Date(t.created_at).toLocaleString()}</td>
                    <td className="p-2">{t.platform}</td>
                    <td className="p-2">{t.mobile}</td>
                    <td className="p-2">GHS {Number(t.expected_amount).toFixed(2)}</td>
                    <td className="p-2">{t.amount_after_charges != null ? `GHS ${Number(t.amount_after_charges).toFixed(2)}` : "-"}</td>
                    <td className="p-2"><Badge variant={t.state === "needs_review" || t.state === "failed" ? "destructive" : "secondary"}>{t.state}</Badge></td>
                    <td className="p-2" title={t.callback_last_error ?? ""}><Badge variant={t.callback_status === "failed" ? "destructive" : "outline"}>{t.callback_status}</Badge></td>
                    <td className="p-2">
                      {(t.callback_status === "pending" || t.callback_status === "failed") && (
                        <Button size="sm" variant="outline" disabled={busy === t.session_id} onClick={() => retry(t.session_id)}>Retry callback</Button>
                      )}
                    </td>
                  </tr>
                ))}
                {txs.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No Hubtel transactions yet.</td></tr>}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 4: Sidebar link** — in `components/layout/sidebar.tsx`, immediately after the closing `</Link>` of the `/admin/ussd-shops` block (the block that ends with `{isOpen && "USSD Shops"}` / `</Button>` / `</Link>`), add the same structure for `/admin/ussd-hubtel`:

```tsx
              <Link href="/admin/ussd-hubtel" onClick={() => handleNavigation("/admin/ussd-hubtel")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    pathname === "/admin/ussd-hubtel" ? c.navLinkActive : c.navLinkInactive,
                    !isOpen && "justify-center",
                    loadingPath === "/admin/ussd-hubtel" && "opacity-70"
                  )}
                  title={!isOpen ? "Hubtel USSD" : undefined}
                  disabled={loadingPath === "/admin/ussd-hubtel"}
                >
                  {loadingPath === "/admin/ussd-hubtel" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Smartphone className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Hubtel USSD"}
                </Button>
              </Link>
```

- [ ] **Step 5: Typecheck, build the page, smoke test**

Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo "no hubtel type errors"` → `no hubtel type errors`.
Run: `npm run dev`, sign in as admin, open `/admin/ussd-hubtel`. Expected: page renders; toggles persist after refresh; "enabled" switch is disabled with the amber note while env vars are missing; Shop mode option is disabled. (Use the `run` / `webapp-testing` skill for a screenshot if desired.)

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/ussd-hubtel app/admin/ussd-hubtel components/layout/sidebar.tsx
git commit -m "feat(hubtel): admin config page, APIs and sidebar link

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Simulator and go-live runbook

**Files:**
- Create: `scripts/hubtel-simulate.ts`, `docs/hubtel-ussd-runbook.md`

- [ ] **Step 1: Simulator** — replays Hubtel's documented payloads against a running dev server.

```ts
// scripts/hubtel-simulate.ts
// Usage: HUBTEL_WEBHOOK_SECRET=x BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts [USSD|Webstore|Hubtel-App]
// Walks the data-bundle flow with the given inputs, prints each reply, then (if AddToCart) posts a Paid fulfilment.
const BASE = process.env.BASE_URL ?? "http://localhost:3000"
const SECRET = process.env.HUBTEL_WEBHOOK_SECRET ?? ""
const platform = process.argv[2] ?? "USSD"
const mobile = process.env.MOBILE ?? "233200585542"
const recipient = process.env.RECIPIENT ?? "0244123456"
const sessionId = "sim" + Date.now().toString(16)

let seq = 1
async function interact(type: "Initiation" | "Response", message: string, clientState = "") {
  const res = await fetch(`${BASE}/api/ussd-hubtel/interaction?secret=${SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Type: type, Mobile: mobile, SessionId: sessionId, ServiceCode: "713", Message: message, Operator: "vodafone", Sequence: seq++, ClientState: clientState, Platform: platform }),
  })
  const json = await res.json()
  console.log(`> ${message}\n< [${json.Type}] ${json.Message}\n`)
  return json
}

async function main() {
  await interact("Initiation", "*713#")
  await interact("Response", "1")          // Buy Data Bundle
  await interact("Response", "1")          // MTN
  await interact("Response", "1")          // first package
  await interact("Response", recipient)    // recipient
  const cart = await interact("Response", "1") // Pay now
  if (cart.Type !== "AddToCart") return console.log("No AddToCart — stopping.")
  const price = cart.Item.Price
  const res = await fetch(`${BASE}/api/ussd-hubtel/fulfillment?secret=${SECRET}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      SessionId: sessionId, OrderId: "simorder" + Date.now().toString(16), ExtraData: {},
      OrderInfo: { CustomerMobileNumber: mobile, Status: "Paid", Currency: "GHS", Subtotal: price + 1,
        Items: [{ Name: cart.Item.ItemName, Quantity: 1, UnitPrice: price }],
        Payment: { PaymentType: "mobilemoney", AmountPaid: price + 1, AmountAfterCharges: price, IsSuccessful: true } },
    }),
  })
  console.log("fulfilment →", res.status, await res.json())
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Runbook** — create `docs/hubtel-ussd-runbook.md` with exactly these sections and content:

```markdown
# Hubtel USSD — go-live runbook (Plan 1: main-mode data bundles)

## 0. Prerequisites you do manually
- [ ] Hubtel merchant account; note the **Collection Account Number** and API credentials.
- [ ] DigitalOcean droplet running the relay (`scripts/hubtel-relay/README.md`); give its **public IPv4** to your Hubtel Retail Systems Engineer to whitelist for the callback + status-check endpoints.
- [ ] Vercel env (production): `HUBTEL_WEBHOOK_SECRET` (long random), `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`. Optional `HUBTEL_ENFORCE_FULFILLMENT_IP=true` once the callbacks are confirmed arriving from `52.50.116.54 / 18.202.122.131 / 52.31.15.68`.
- [ ] Migration `0106_hubtel_ussd.sql` applied.

## 1. Register the service in Hubtel
- Service Interaction URL: `https://<domain>/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>`
- Service Fulfilment URL:  `https://<domain>/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>`
- Request a USSD code and attach the service on the Merchant Dashboard.
- The app must be on the **apex or canonical host** that serves the API without a redirect (a www/apex redirect broke webhook delivery for Bundle Portal before).

## 2. Verify before enabling (all with the kill switch OFF unless stated)
1. Relay: `curl -i https://relay.<domain>/status?clientReference=x` → 401; with the bearer → 400 (bad ref) proves auth + routing.
2. Simulator (dev or preview, channel enabled there): `npx tsx scripts/hubtel-simulate.ts USSD`, then `Webstore`, then `Hubtel-App` → every reply is a well-formed `response`/`AddToCart`; the order shows `payment_status=completed` after the simulated fulfilment; a second identical fulfilment POST returns `outcome: "duplicate"` and does not fulfil twice.
3. **Fee assumption (money-critical):** with Hubtel sandbox / a GHS 1 live test, confirm the fulfilment payload's `AmountAfterCharges` equals the AddToCart `Price` (customer pays Hubtel's charge on top). If it equals `AmountPaid` instead, STOP — orders will be flagged `needs_review`; adjust `decidePayment` before enabling.
4. **Callback OrderId (status-check path):** ask Hubtel whether the status-check `transactionId` is accepted as the callback `OrderId` when the fulfilment webhook never arrived. Until confirmed, orders recovered by the status-check cron may show `callback_failed`; use the admin "Retry callback" button.
5. Confirm the relay IP is whitelisted: a real callback returns `ok:true` (check `callback_status=sent` on `/admin/ussd-hubtel`).
6. USSD length: dial on a real handset; confirm no screen is cut mid-word (limit 182 chars).

## 3. Enable
`/admin/ussd-hubtel` → toggle **Hubtel USSD enabled** (disabled until all env vars are set). Make one real GHS purchase end to end; confirm: order completed, SMS received, `callback_status=sent`, no `needs_review`.

## 4. Operate
- `needs_review` rows: under-payment or a failed handler. Fulfil/refund manually (existing `/admin/orders` manual fulfilment; refunds via `/admin/refunds`). The callback has already been sent as `success` (policy: always success).
- `callback_failed`: Retry callback button (re-arms a fresh window; Hubtel may reject after 1 hour).
- Rollback: toggle the channel OFF; Uzo codes are unaffected.

## 5. Known limitations (Plan 1)
AFA, airtime, results checker and shop mode are not on the Hubtel menu yet (Plans 2 and 3).
```

- [ ] **Step 3: End-to-end dry run** (dev server, relay not configured): run `npm run dev`, enable the channel via the admin page after setting `HUBTEL_WEBHOOK_SECRET` locally, run the simulator. Expected: replies print for each step; `AddToCart` appears; fulfilment returns `{ received: true, outcome: "fulfilled" }`; the row shows `callback_status=pending` (relay unconfigured ⇒ immediate attempt records a "relay not configured" error and the order stays pending, which is the intended retry behaviour). Run the simulator's fulfilment step twice (copy the printed curl, or re-run with the same session) and confirm `outcome: "duplicate"`.

- [ ] **Step 4: Full verification**

Run: `npm run test:run` → Expected: all PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo "no hubtel type errors"` → `no hubtel type errors`.

- [ ] **Step 5: Commit**

```bash
git add scripts/hubtel-simulate.ts docs/hubtel-ussd-runbook.md
git commit -m "docs(hubtel): simulator and go-live runbook

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review (spec coverage)

| Spec section | Covered by |
|---|---|
| §2 payment = Hubtel only | Router returns `AddToCart`; no wallet/OTP steps (T6) |
| §2 fee: customer pays | Order `amount` = our price; match on `AmountAfterCharges` (T6, T7); runbook verification step 3 |
| §2 DO thin relay | T8 (`relay-handler`, `server.ts`, README) |
| §2 services admin-selectable | `visibility` config + `IMPLEMENTED_SERVICES` (T3, T5); only data live in this plan — AFA/airtime/RC → Plan 2 |
| §2 mode toggle main/shop | Config + page (T3, T11); shop behaviour → Plan 3 (router releases "unavailable") |
| §2 Uzo alongside | No Uzo router edits; only two `export` keywords (T5) |
| §2 always `success` callback | `sendFulfillmentCallback` hard-codes it (T8); failures → needs_review + callback pending (T7) |
| §3/§5.1 all platforms + mandatory fields | `Platform` parsed; `Label/DataType/FieldType` on every reply (T2, T6); simulator runs all three (T12) |
| §4.2 mode pinned into session | **Gap noted:** this plan reads config on every request instead of pinning mode into the session, and shop mode is blocked anyway. Pinning belongs to Plan 3 when mode can differ mid-session. |
| §4.3 ClientState safety net | ClientState echoes step (T6); recovery uses restart-with-menu rather than rebuilding from ClientState (simpler; data-bundle sessions carry state ClientState can't hold) |
| §6 idempotency, amount check | T7 (atomic claim, `decidePayment`) |
| §7 crons | T9 + T10 (callback retry 55-min cap; status check) |
| §9 admin page | T11 |
| §10 security | Secret on both endpoints, fail closed, optional fulfilment-IP allowlist, relay bearer + field whitelist + reference validation, service-role-only table (T1, T2, T8, T10) |
| §11 testing | Unit tests per task; simulator (T12) |
| Review Focus 1–6 | #1 T7 duplicate/concurrent, #2 T6 Redis miss, #3 T2 sanitise/truncate, #4 T8 window/expiry, #5 T6 bad input/phone formats, #6 T7 under-payment |

Placeholder scan: no TBD/TODO steps. Type consistency: `HubtelTxStore` methods (`findBySession`, `claim`, `update`, `listPendingCallbacks`, `listAwaitingPayment`), `OrderHandlers`, `CallbackSender`, `StatusChecker`, `RouterDeps`, `HubtelUssdConfig` are defined once and referenced identically across tasks.
