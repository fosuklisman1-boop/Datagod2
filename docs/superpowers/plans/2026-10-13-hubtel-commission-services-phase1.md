# Hubtel Commission Services — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared Hubtel Commission Services plumbing (client, ledger, callback, status-check, float safety, admin page) that ships dark and that Phases 2–4 (airtime/data provider, utility bills, bots) plug into.

**Architecture:** A `lib/hubtel-cs/` module with a pure state machine, a store interface (Supabase impl + in-memory test impl), a client that persists the ledger row *before* calling Hubtel and never resends an unknown POST, a per-transaction HMAC-authenticated callback route, and a cron that reconciles via the existing relay `/status`. Config lives in `admin_settings`. Products attach through an `OrderAdapter` registry (no real adapters in Phase 1).

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service role), Vitest (`npm run test:run`), existing DigitalOcean Hubtel relay, shadcn UI.

**Spec:** `docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase1-design.md` (read it first). API reference: `docs/hubtel-commission-services/api-reference.md`.

**Spec deltas discovered while planning (this plan wins over the spec text):**
- Migrations are `0113` and `0114` (main is already at `0112`).
- Relay passthrough path is `/cs/<serviceId>` (relay env supplies the Disbursement account), not `/cs/<disbursement>/<serviceId>`.
- The float balance endpoint ALREADY exists: relay `/balance` + `fetchDisbursementBalance()` in `lib/ussd-hubtel/relay.ts` (added for SMS). Reuse it for the low-balance alert. **The Disbursement float is shared with Hubtel SMS** — the alert text must say so.
- Status checks reuse `checkTransactionStatus()` from `lib/ussd-hubtel/relay.ts` unchanged (relay `/status`).
- Env `HUBTEL_DISBURSEMENT_ACCOUNT` already exists on the relay; Vercel direct mode needs it too.

## Global Constraints

- Ships **dark**: master `enabled` defaults `false`; nothing customer-facing is built in Phase 1.
- Config key is `hubtel_cs_config` in `admin_settings` — **never** `app_settings`.
- **Never auto-resend** a POST. Timeout / `0005` / unparsable response → `needs_review`.
- **Never auto-refund.** Failures only surface in the review queue; refunds are a manual admin action through a registered `OrderAdapter`.
- Persist the ledger row (`state='created'`) **before** the POST.
- `client_reference` matches `^[A-Za-z0-9_-]{1,100}$`, format `HCS-{serviceKey}-{16 hex}`.
- Callback URL carries `?ref=<ref>&sig=<hex HMAC-SHA256(ref, HUBTEL_CS_CALLBACK_SECRET)>`; verify with timing-safe compare; empty secret ⇒ always 401 (fail closed). Hubtel callback IP: `18.202.122.131` (enforced only when `HUBTEL_CS_ENFORCE_CALLBACK_IP === "true"`).
- States: `created | pending | fulfilled | failed | needs_review`. Terminal (`fulfilled`/`failed`) never changes except via explicit admin resolve.
- Status-check failure rule: `isFulfilled === false` counts as failed only after **2 consecutive negative observations AND ≥10 min** since submission. `isFulfilled` null/undefined resets the negative counter. `pending` older than **24 h** → `needs_review`. `created` older than **2 min** → `needs_review`. Status check only for `pending` rows older than **5 min**.
- Airtime max GHS 100 per request; amounts have ≤2 decimals; admin test-purchase capped at **GHS 5**.
- Tables are service-role only: RLS on, `REVOKE ALL … FROM anon, authenticated`, no policies. Events retained 30 days.
- Hubtel `TransactionId` values can carry leading/trailing spaces — trim. Bundle `Value`s are sent **exactly as Hubtel returned them** (Telecel values have leading spaces).
- Route files export only HTTP handlers / route config (`maxDuration`, `dynamic`); shared constants live in `lib/`.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Working directory for every command: `C:\Users\User2\.gemini\antigravity-ide\scratch\Datagod2\.claude\worktrees\hubtel-commission-services` (branch `worktree-hubtel-commission-services`, based on `origin/main` be0e2de1). Never `cd` out of it.

## Review Focus

Failure modes the spec implies but a happy-path test would miss (each is pinned by a named test in the owning task):

1. Hubtel replies with HTML / a 5xx / JSON without `ResponseCode` → must be `needs_review`, never `failed` (Task 2 "no ResponseCode", Task 7 "5xx html body").
2. Late or duplicate callback after the row is terminal or admin-resolved → ignored, hook not re-fired (Task 6 "duplicate", "resolved by admin").
3. `x-forwarded-for` with several addresses / missing IP while IP enforcement is on (Task 6 "ip enforcement").
4. Float-noise amounts (`0.1 + 0.2`) accepted as `0.30`; 3-decimal amounts rejected; Telecel bundle `" 5.7 GB"` sent unmodified (Task 7).
5. Service paused (4075) while older transactions are still `pending` → those must still resolve via callback/status check (Task 9 "pending rows still reconcile while paused").

---

### Task 1: Types and service registry

**Files:**
- Create: `lib/hubtel-cs/types.ts`
- Create: `lib/hubtel-cs/services.ts`
- Create: `lib/hubtel-cs/errors.ts`
- Test: `lib/hubtel-cs/services.test.ts`

**Interfaces:**
- Produces: `HubtelCsTx`, `HubtelCsPatch`, `NewHubtelCsTx`, `HubtelCsState`, `HubtelCsKind`, `HubtelCsEvent`, `ParsedCallback`, `HubtelQueryItem` (types.ts); `HubtelCsServiceKey`, `HubtelCsService`, `HUBTEL_CS_SERVICES`, `HUBTEL_CS_SERVICE_KEYS`, `getService(key)`, `isServiceKey(v)` (services.ts); `HubtelDisabledError`, `HubtelServiceDisabledError`, `HubtelPausedError`, `HubtelNotConfiguredError`, `HubtelValidationError` (errors.ts).

- [ ] **Step 1: Write the failing test** — `lib/hubtel-cs/services.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS, getService, isServiceKey } from "./services"

describe("hubtel-cs service registry", () => {
  it("every service id is a 32-char hex id and ids are unique", () => {
    const ids = HUBTEL_CS_SERVICE_KEYS.map(k => HUBTEL_CS_SERVICES[k].serviceId)
    for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("maps the documented ServiceIDs", () => {
    expect(getService("airtime_mtn").serviceId).toBe("fdd76c884e614b1c8f669a3207b09a98")
    expect(getService("airtime_telecel").serviceId).toBe("f4be83ad74c742e185224fdae1304800")
    expect(getService("airtime_at").serviceId).toBe("dae2142eb5a14c298eace60240c09e4b")
    expect(getService("data_mtn").serviceId).toBe("b230733cd56b4a0fad820e39f66bc27c")
    expect(getService("data_telecel").serviceId).toBe("fa27127ba039455da04a2ac8a1613e00")
    expect(getService("data_at").serviceId).toBe("06abd92da459428496967612463575ca")
    expect(getService("bill_ecg").serviceId).toBe("e6d6bac062b5499cb1ece1ac3d742a84")
    expect(getService("bill_ghana_water").serviceId).toBe("6c1e8a82d2e84feeb8bfd6be2790d71d")
    expect(getService("bill_dstv").serviceId).toBe("297a96656b5846ad8b00d5d41b256ea7")
    expect(getService("bill_gotv").serviceId).toBe("e6ceac7f3880435cb30b048e9617eb41")
    expect(getService("bill_startimes").serviceId).toBe("6598652d34ea4112949c93c079c501ce")
    expect(getService("bill_telecel_broadband").serviceId).toBe("b9a1aa246ba748f9ba01ca4cdbb3d1d3")
  })

  it("airtime is capped at GHS 100, has no query and needs no bundle", () => {
    for (const k of ["airtime_mtn", "airtime_telecel", "airtime_at"] as const) {
      const s = getService(k)
      expect(s.maxAmount).toBe(100)
      expect(s.hasQuery).toBe(false)
      expect(s.needsBundle).toBe(false)
      expect(s.kind).toBe("airtime")
    }
  })

  it("data, ecg, ghana water and broadband need a bundle; tv does not", () => {
    for (const k of ["data_mtn", "data_telecel", "data_at", "bill_ecg", "bill_ghana_water", "bill_telecel_broadband"] as const) {
      expect(getService(k).needsBundle).toBe(true)
    }
    for (const k of ["bill_dstv", "bill_gotv", "bill_startimes"] as const) {
      expect(getService(k).needsBundle).toBe(false)
      expect(getService(k).hasQuery).toBe(true)
    }
  })

  it("broadband is registered but disabled by default", () => {
    expect(getService("bill_telecel_broadband").defaultEnabled).toBe(false)
    expect(getService("airtime_mtn").defaultEnabled).toBe(true)
  })

  it("isServiceKey rejects unknown and inherited keys", () => {
    expect(isServiceKey("airtime_mtn")).toBe(true)
    expect(isServiceKey("constructor")).toBe(false)
    expect(isServiceKey("toString")).toBe(false)
    expect(isServiceKey(42)).toBe(false)
  })

  it("getService throws on an unknown key", () => {
    expect(() => getService("nope" as any)).toThrow(/unknown hubtel service/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/services.test.ts`
Expected: FAIL — cannot resolve `./services`.

- [ ] **Step 3: Implement** — create the three files.

`lib/hubtel-cs/types.ts`:
```ts
export type HubtelCsKind = "airtime" | "data" | "bill"
export type HubtelCsState = "created" | "pending" | "fulfilled" | "failed" | "needs_review"

/** One row of hubtel_cs_transactions (snake_case, exactly as PostgREST returns it). */
export interface HubtelCsTx {
  id: string
  client_reference: string
  service_key: string
  kind: HubtelCsKind
  destination: string
  amount: number
  bundle: string | null
  extra: Record<string, unknown> | null
  state: HubtelCsState
  response_code: string | null
  response_message: string | null
  failure_reason: string | null
  hubtel_transaction_id: string | null
  external_transaction_id: string | null
  commission: number | null
  charges: number | null
  amount_debited: number | null
  order_table: string | null
  order_id: string | null
  submitted_at: string | null
  completed_at: string | null
  callback_received_at: string | null
  status_check_attempts: number
  negative_checks: number
  last_status_check_at: string | null
  review_reason: string | null
  resolved_by: string | null
  resolved_at: string | null
  resolution_note: string | null
  created_at: string
  updated_at: string
}

export type HubtelCsPatch = Partial<Omit<HubtelCsTx, "id" | "client_reference" | "created_at">>

export type NewHubtelCsTx = Pick<HubtelCsTx, "client_reference" | "service_key" | "kind" | "destination" | "amount"> &
  Partial<Pick<HubtelCsTx, "bundle" | "extra" | "order_table" | "order_id">>

export interface HubtelCsEvent {
  client_reference: string | null
  direction: "request" | "response" | "callback" | "status_check"
  http_status?: number | null
  ok?: boolean | null
  payload?: unknown
  error?: string | null
  source_ip?: string | null
}

/** A Hubtel final-callback body, normalised. */
export interface ParsedCallback {
  responseCode: string
  clientReference: string
  transactionId: string | null
  externalTransactionId: string | null
  description: string | null
  amountDebited: number | null
  charges: number | null
  commission: number | null
}

/** One entry of a Hubtel query response `Data` array. */
export interface HubtelQueryItem {
  Display: string
  Value: string
  Amount: number
}
```

`lib/hubtel-cs/errors.ts`:
```ts
export class HubtelDisabledError extends Error {
  constructor() { super("Hubtel Commission Services is disabled"); this.name = "HubtelDisabledError" }
}
export class HubtelServiceDisabledError extends Error {
  constructor(public serviceKey: string) { super(`Hubtel service ${serviceKey} is disabled`); this.name = "HubtelServiceDisabledError" }
}
export class HubtelPausedError extends Error {
  constructor(public reason: string | null) { super(`Hubtel Commission Services is paused${reason ? `: ${reason}` : ""}`); this.name = "HubtelPausedError" }
}
export class HubtelNotConfiguredError extends Error {
  constructor(public missing: string[]) { super(`Hubtel Commission Services not configured: missing ${missing.join(", ")}`); this.name = "HubtelNotConfiguredError" }
}
export class HubtelValidationError extends Error {
  constructor(message: string) { super(message); this.name = "HubtelValidationError" }
}
```

`lib/hubtel-cs/services.ts`:
```ts
import type { HubtelCsKind } from "./types"

export type HubtelCsServiceKey =
  | "airtime_mtn" | "airtime_telecel" | "airtime_at"
  | "data_mtn" | "data_telecel" | "data_at"
  | "bill_ecg" | "bill_ghana_water" | "bill_dstv" | "bill_gotv" | "bill_startimes" | "bill_telecel_broadband"

export interface HubtelCsService {
  key: HubtelCsServiceKey
  label: string
  /** The 32-hex ServiceID in the Commission Services URL. */
  serviceId: string
  kind: HubtelCsKind
  network: "mtn" | "telecel" | "at" | null
  /** A GET query endpoint exists (bundle list / account lookup). */
  hasQuery: boolean
  /** The POST needs Extradata.bundle (bundle value, meter number or broadband account). */
  needsBundle: boolean
  /** Hubtel's documented per-request cap. */
  maxAmount?: number
  /** Initial per-service switch (the master switch still ships off). */
  defaultEnabled: boolean
}

export const HUBTEL_CS_SERVICES: Record<HubtelCsServiceKey, HubtelCsService> = {
  airtime_mtn:     { key: "airtime_mtn",     label: "MTN Airtime",     serviceId: "fdd76c884e614b1c8f669a3207b09a98", kind: "airtime", network: "mtn",     hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  airtime_telecel: { key: "airtime_telecel", label: "Telecel Airtime", serviceId: "f4be83ad74c742e185224fdae1304800", kind: "airtime", network: "telecel", hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  airtime_at:      { key: "airtime_at",      label: "AirtelTigo Airtime", serviceId: "dae2142eb5a14c298eace60240c09e4b", kind: "airtime", network: "at",    hasQuery: false, needsBundle: false, maxAmount: 100, defaultEnabled: true },
  data_mtn:        { key: "data_mtn",        label: "MTN Data",        serviceId: "b230733cd56b4a0fad820e39f66bc27c", kind: "data",    network: "mtn",     hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  data_telecel:    { key: "data_telecel",    label: "Telecel Data",    serviceId: "fa27127ba039455da04a2ac8a1613e00", kind: "data",    network: "telecel", hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  data_at:         { key: "data_at",         label: "AirtelTigo Data", serviceId: "06abd92da459428496967612463575ca", kind: "data",    network: "at",      hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  bill_ecg:        { key: "bill_ecg",        label: "ECG (Prepaid & Postpaid)", serviceId: "e6d6bac062b5499cb1ece1ac3d742a84", kind: "bill", network: null, hasQuery: true, needsBundle: true,  defaultEnabled: true },
  bill_ghana_water:{ key: "bill_ghana_water",label: "Ghana Water",     serviceId: "6c1e8a82d2e84feeb8bfd6be2790d71d", kind: "bill",    network: null,      hasQuery: true,  needsBundle: true,  defaultEnabled: true },
  bill_dstv:       { key: "bill_dstv",       label: "DSTV",            serviceId: "297a96656b5846ad8b00d5d41b256ea7", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_gotv:       { key: "bill_gotv",       label: "GOtv",            serviceId: "e6ceac7f3880435cb30b048e9617eb41", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_startimes:  { key: "bill_startimes",  label: "StarTimes TV",    serviceId: "6598652d34ea4112949c93c079c501ce", kind: "bill",    network: null,      hasQuery: true,  needsBundle: false, defaultEnabled: true },
  bill_telecel_broadband: { key: "bill_telecel_broadband", label: "Telecel Broadband", serviceId: "b9a1aa246ba748f9ba01ca4cdbb3d1d3", kind: "bill", network: null, hasQuery: true, needsBundle: true, defaultEnabled: false },
}

export const HUBTEL_CS_SERVICE_KEYS = Object.keys(HUBTEL_CS_SERVICES) as HubtelCsServiceKey[]

export function isServiceKey(v: unknown): v is HubtelCsServiceKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HUBTEL_CS_SERVICES, v)
}

export function getService(key: HubtelCsServiceKey): HubtelCsService {
  if (!isServiceKey(key)) throw new Error(`Unknown Hubtel service: ${String(key)}`)
  return HUBTEL_CS_SERVICES[key]
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/services.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/types.ts lib/hubtel-cs/errors.ts lib/hubtel-cs/services.ts lib/hubtel-cs/services.test.ts
git commit -m "feat(hubtel-cs): types, errors and service registry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: State machine (pure)

**Files:**
- Create: `lib/hubtel-cs/state-machine.ts`
- Create: `lib/hubtel-cs/testing/fixtures.ts`
- Test: `lib/hubtel-cs/state-machine.test.ts`

**Interfaces:**
- Consumes: `HubtelCsTx`, `HubtelCsPatch`, `HubtelCsState`, `ParsedCallback` from Task 1.
- Produces:
  - `type Transition = { ignored: string } | { next: HubtelCsState; patch: HubtelCsPatch & { state: HubtelCsState }; float?: boolean }`
  - `type PostResult = { httpStatus: number; body: unknown } | { error: string }`
  - `interface StatusObservation { ok: boolean; status?: string | null; isFulfilled?: boolean | null }`
  - `classifyCode(code: unknown): "success"|"pending"|"unknown"|"float"|"failed"`, `parseCommission(v: unknown): number | null`
  - `applyPostResponse(tx, res: PostResult, now: Date): Transition`
  - `applyCallback(tx, cb: ParsedCallback, now: Date): Transition`
  - `applyStatusCheck(tx, obs: StatusObservation, now: Date): Transition`
  - `sweepStale(tx, now: Date): Transition`
  - `applyResolve(tx, outcome: "fulfilled"|"failed", note: string, adminId: string, now: Date): Transition`
  - constants `CREATED_STALE_MS`, `PENDING_STALE_MS`, `NEGATIVE_CONFIRM_AGE_MS`, `NEGATIVE_CONFIRM_COUNT`
  - test fixtures `makeTx(over?)`, `T0`, `minutesAfter(m)`.

- [ ] **Step 1: Write fixtures and the failing test**

`lib/hubtel-cs/testing/fixtures.ts`:
```ts
import type { HubtelCsTx } from "../types"

export const T0 = new Date("2026-10-13T10:00:00.000Z")
export const minutesAfter = (m: number) => new Date(T0.getTime() + m * 60_000)

export function makeTx(over: Partial<HubtelCsTx> = {}): HubtelCsTx {
  const ts = T0.toISOString()
  return {
    id: "tx-1", client_reference: "HCS-airtime_mtn-TESTREF1", service_key: "airtime_mtn", kind: "airtime",
    destination: "233246912184", amount: 5, bundle: null, extra: null, state: "created",
    response_code: null, response_message: null, failure_reason: null,
    hubtel_transaction_id: null, external_transaction_id: null,
    commission: null, charges: null, amount_debited: null, order_table: null, order_id: null,
    submitted_at: null, completed_at: null, callback_received_at: null,
    status_check_attempts: 0, negative_checks: 0, last_status_check_at: null,
    review_reason: null, resolved_by: null, resolved_at: null, resolution_note: null,
    created_at: ts, updated_at: ts,
    ...over,
  }
}
```

`lib/hubtel-cs/state-machine.test.ts`:
```ts
import { describe, it, expect } from "vitest"
import {
  applyCallback, applyPostResponse, applyResolve, applyStatusCheck, classifyCode, parseCommission, sweepStale,
} from "./state-machine"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"
import type { ParsedCallback } from "./types"

const cb = (over: Partial<ParsedCallback> = {}): ParsedCallback => ({
  responseCode: "0000", clientReference: "HCS-airtime_mtn-TESTREF1", transactionId: "hub-1",
  externalTransactionId: "ext-1", description: "ok", amountDebited: 5, charges: 0, commission: 0.0198, ...over,
})
const next = (t: any) => { expect("next" in t).toBe(true); return t as Extract<typeof t, { next: any }> }

describe("classifyCode / parseCommission", () => {
  it("classifies Hubtel codes", () => {
    expect(classifyCode("0000")).toBe("success")
    expect(classifyCode("0001")).toBe("pending")
    expect(classifyCode("0005")).toBe("unknown")
    expect(classifyCode(undefined)).toBe("unknown")
    expect(classifyCode("4075")).toBe("float")
    expect(classifyCode("2001")).toBe("failed")
    expect(classifyCode("4010")).toBe("failed")
  })
  it("parses commission strings", () => {
    expect(parseCommission("0.0198")).toBe(0.0198)
    expect(parseCommission(" 0.35 ")).toBe(0.35)
    expect(parseCommission("0.0000")).toBe(0)
    expect(parseCommission(null)).toBeNull()
    expect(parseCommission("abc")).toBeNull()
    expect(parseCommission("-1")).toBeNull()
  })
})

describe("applyPostResponse", () => {
  const ok = { httpStatus: 200, body: { ResponseCode: "0001", Message: "Transaction pending.", Data: { TransactionId: " abc123 ", Meta: { Commission: "0.0198" } } } }

  it("0001 -> pending, stores trimmed transaction id and commission", () => {
    const t = next(applyPostResponse(makeTx(), ok, T0))
    expect(t.next).toBe("pending")
    expect(t.patch.hubtel_transaction_id).toBe("abc123")
    expect(t.patch.commission).toBe(0.0198)
    expect(t.patch.submitted_at).toBe(T0.toISOString())
  })
  it("0000 -> fulfilled", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "0000", Data: {} } }, T0))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.completed_at).toBeTruthy()
  })
  it("4075 -> failed and flags float", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "4075", Message: "Insufficient prepaid balance." } }, T0))
    expect(t.next).toBe("failed")
    expect(t.float).toBe(true)
    expect(t.patch.failure_reason).toMatch(/prepaid balance/i)
  })
  it("definite error codes -> failed with Hubtel's message", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 400, body: { ResponseCode: "4010", Message: "Validation errors" } }, T0))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toBe("Validation errors")
  })
  it("0005 -> needs_review (state unknown)", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 200, body: { ResponseCode: "0005", Message: "HTTP failure" } }, T0))
    expect(t.next).toBe("needs_review")
    expect(t.patch.review_reason).toMatch(/do not resend/i)
  })
  it("transport error -> needs_review", () => {
    const t = next(applyPostResponse(makeTx(), { error: "timeout" }, T0))
    expect(t.next).toBe("needs_review")
    expect(t.patch.review_reason).toMatch(/timeout/)
  })
  it("no ResponseCode (html / 5xx body) -> needs_review, NOT failed", () => {
    const t = next(applyPostResponse(makeTx(), { httpStatus: 502, body: "<html>Bad gateway</html>" }, T0))
    expect(t.next).toBe("needs_review")
  })
  it("ignores a row that is not in created", () => {
    expect(applyPostResponse(makeTx({ state: "pending" }), ok, T0)).toEqual({ ignored: "state is pending" })
  })
})

describe("applyCallback", () => {
  it("0000 on a pending row -> fulfilled with ids, charges and commission", () => {
    const t = next(applyCallback(makeTx({ state: "pending" }), cb(), T0))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.external_transaction_id).toBe("ext-1")
    expect(t.patch.commission).toBe(0.0198)
    expect(t.patch.callback_received_at).toBe(T0.toISOString())
  })
  it("non-0000 -> failed with the Description as reason", () => {
    const t = next(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "2001", description: "The receiving user is not registered" }), T0))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toBe("The receiving user is not registered")
  })
  it("0005 in a callback -> needs_review", () => {
    expect(next(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "0005" }), T0)).next).toBe("needs_review")
  })
  it("a terminal row ignores late/duplicate callbacks", () => {
    expect(applyCallback(makeTx({ state: "fulfilled" }), cb({ responseCode: "2001" }), T0)).toEqual({ ignored: "already fulfilled" })
    expect(applyCallback(makeTx({ state: "failed" }), cb(), T0)).toEqual({ ignored: "already failed" })
  })
  it("a row resolved by an admin ignores callbacks", () => {
    expect(applyCallback(makeTx({ state: "needs_review", resolved_at: T0.toISOString() }), cb(), T0)).toEqual({ ignored: "resolved by admin" })
  })
  it("an unresolved needs_review row can still be settled by a callback", () => {
    expect(next(applyCallback(makeTx({ state: "needs_review" }), cb(), T0)).next).toBe("fulfilled")
  })
  it("an interim 0001 callback is ignored", () => {
    expect(applyCallback(makeTx({ state: "pending" }), cb({ responseCode: "0001" }), T0)).toEqual({ ignored: "interim 0001 callback" })
  })
})

describe("applyStatusCheck", () => {
  const pending = (over = {}) => makeTx({ state: "pending", submitted_at: T0.toISOString(), ...over })

  it("Paid + isFulfilled=true -> fulfilled", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Paid", isFulfilled: true }, minutesAfter(6)))
    expect(t.next).toBe("fulfilled")
    expect(t.patch.status_check_attempts).toBe(1)
  })
  it("a single negative observation never fails the row", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(12)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(1)
  })
  it("second consecutive negative after 10 min -> failed", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(12)))
    expect(t.next).toBe("failed")
    expect(t.patch.failure_reason).toMatch(/not fulfilled/i)
  })
  it("second negative before 10 min stays pending", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Unpaid", isFulfilled: false }, minutesAfter(6)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(2)
  })
  it("isFulfilled null resets the negative counter and keeps polling", () => {
    const t = next(applyStatusCheck(pending({ negative_checks: 1 }), { ok: true, status: "Paid", isFulfilled: null }, minutesAfter(12)))
    expect(t.next).toBe("pending")
    expect(t.patch.negative_checks).toBe(0)
  })
  it("a failed check call only bumps attempts", () => {
    const t = next(applyStatusCheck(pending(), { ok: false }, minutesAfter(6)))
    expect(t.next).toBe("pending")
    expect(t.patch.status_check_attempts).toBe(1)
    expect(t.patch.negative_checks).toBeUndefined()
  })
  it("pending older than 24h -> needs_review", () => {
    const t = next(applyStatusCheck(pending(), { ok: true, status: "Paid", isFulfilled: null }, minutesAfter(24 * 60 + 1)))
    expect(t.next).toBe("needs_review")
  })
  it("ignores fulfilled / failed rows and admin-resolved rows", () => {
    expect("ignored" in applyStatusCheck(makeTx({ state: "fulfilled" }), { ok: true }, T0)).toBe(true)
    expect("ignored" in applyStatusCheck(makeTx({ state: "needs_review", resolved_at: T0.toISOString() }), { ok: true }, T0)).toBe(true)
  })
})

describe("sweepStale", () => {
  it("created older than 2 minutes -> needs_review", () => {
    expect(next(sweepStale(makeTx({ state: "created" }), minutesAfter(3))).next).toBe("needs_review")
  })
  it("created younger than 2 minutes is left alone", () => {
    expect(sweepStale(makeTx({ state: "created" }), minutesAfter(1))).toEqual({ ignored: "not stale" })
  })
  it("pending older than 24h -> needs_review", () => {
    expect(next(sweepStale(makeTx({ state: "pending", submitted_at: T0.toISOString() }), minutesAfter(24 * 60 + 1))).next).toBe("needs_review")
  })
})

describe("applyResolve", () => {
  it("admin can resolve a needs_review row as fulfilled or failed", () => {
    const f = next(applyResolve(makeTx({ state: "needs_review" }), "fulfilled", "confirmed with Hubtel", "admin-1", T0))
    expect(f.next).toBe("fulfilled")
    expect(f.patch.resolved_by).toBe("admin-1")
    expect(f.patch.resolution_note).toBe("confirmed with Hubtel")
    const x = next(applyResolve(makeTx({ state: "needs_review" }), "failed", "never delivered", "admin-1", T0))
    expect(x.patch.failure_reason).toBe("never delivered")
  })
  it("resolving the same way twice is a no-op", () => {
    expect("ignored" in applyResolve(makeTx({ state: "fulfilled", resolved_at: T0.toISOString() }), "fulfilled", "x", "a", T0)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/state-machine.test.ts`
Expected: FAIL — cannot resolve `./state-machine`.

- [ ] **Step 3: Implement** — `lib/hubtel-cs/state-machine.ts`

```ts
import type { HubtelCsPatch, HubtelCsState, HubtelCsTx, ParsedCallback } from "./types"

type StatePatch = HubtelCsPatch & { state: HubtelCsState }
export type Transition =
  | { ignored: string }
  | { next: HubtelCsState; patch: StatePatch; float?: boolean }

export type PostResult = { httpStatus: number; body: unknown } | { error: string }
export interface StatusObservation { ok: boolean; status?: string | null; isFulfilled?: boolean | null }

export const CREATED_STALE_MS = 2 * 60_000
export const PENDING_STALE_MS = 24 * 60 * 60_000
export const NEGATIVE_CONFIRM_AGE_MS = 10 * 60_000
export const NEGATIVE_CONFIRM_COUNT = 2

export type CodeClass = "success" | "pending" | "unknown" | "float" | "failed"

export function classifyCode(code: unknown): CodeClass {
  const c = typeof code === "string" ? code.trim() : typeof code === "number" ? String(code) : ""
  if (c === "0000") return "success"
  if (c === "0001") return "pending"
  if (c === "" || c === "0005") return "unknown"
  if (c === "4075") return "float"
  return "failed"
}

/** Hubtel returns commission as a string with 4 decimals ("0.0198"). */
export function parseCommission(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(String(v).trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const isTerminal = (s: HubtelCsState) => s === "fulfilled" || s === "failed"
const ageMs = (tx: HubtelCsTx, now: Date) => now.getTime() - Date.parse(tx.submitted_at ?? tx.created_at)

export function applyPostResponse(tx: HubtelCsTx, res: PostResult, now: Date): Transition {
  if (tx.state !== "created") return { ignored: `state is ${tx.state}` }
  const ts = now.toISOString()
  if ("error" in res) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: `No response from Hubtel (${res.error}). State unknown - do not resend; check the status first.` } }
  }
  const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, any>
  const data = (b.Data && typeof b.Data === "object" ? b.Data : {}) as Record<string, any>
  const code = b.ResponseCode !== undefined && b.ResponseCode !== null ? String(b.ResponseCode).trim() : null
  const message = textOrNull(b.Message)
  const base: HubtelCsPatch = {
    response_code: code, response_message: message,
    hubtel_transaction_id: textOrNull(data.TransactionId),
    commission: parseCommission(data.Meta?.Commission),
    submitted_at: ts, updated_at: ts,
  }
  switch (classifyCode(code)) {
    case "pending": return { next: "pending", patch: { ...base, state: "pending" } }
    case "success": return { next: "fulfilled", patch: { ...base, state: "fulfilled", completed_at: ts } }
    case "float":
      return { next: "failed", float: true, patch: { ...base, state: "failed", completed_at: ts, failure_reason: "Insufficient Hubtel prepaid balance (4075)" } }
    case "unknown":
      return { next: "needs_review", patch: { ...base, state: "needs_review", review_reason: `Hubtel returned an unknown state (${code ?? "no code"}, HTTP ${res.httpStatus}). Do not resend; check the status first.` } }
    default:
      return { next: "failed", patch: { ...base, state: "failed", completed_at: ts, failure_reason: message ?? `Hubtel error ${code}` } }
  }
}

export function applyCallback(tx: HubtelCsTx, cb: ParsedCallback, now: Date): Transition {
  if (tx.resolved_at) return { ignored: "resolved by admin" }
  if (isTerminal(tx.state)) return { ignored: `already ${tx.state}` }
  const cls = classifyCode(cb.responseCode)
  if (cls === "pending") return { ignored: "interim 0001 callback" }
  const ts = now.toISOString()
  const common: HubtelCsPatch = {
    callback_received_at: ts, updated_at: ts, response_code: cb.responseCode,
    hubtel_transaction_id: cb.transactionId ?? tx.hubtel_transaction_id,
    external_transaction_id: cb.externalTransactionId,
    amount_debited: cb.amountDebited, charges: cb.charges, commission: cb.commission ?? tx.commission,
  }
  if (cls === "success") {
    return { next: "fulfilled", patch: { ...common, state: "fulfilled", completed_at: ts, review_reason: null, failure_reason: null } }
  }
  if (cls === "unknown") {
    return { next: "needs_review", patch: { ...common, state: "needs_review", review_reason: `Hubtel callback reported an unknown state (${cb.responseCode}). Check the status first.` } }
  }
  return { next: "failed", patch: { ...common, state: "failed", completed_at: ts, review_reason: null, failure_reason: cb.description ?? `Hubtel code ${cb.responseCode}` } }
}

export function applyStatusCheck(tx: HubtelCsTx, obs: StatusObservation, now: Date): Transition {
  if (tx.resolved_at) return { ignored: "resolved by admin" }
  if (tx.state !== "pending" && tx.state !== "needs_review") return { ignored: `state is ${tx.state}` }
  const ts = now.toISOString()
  const age = ageMs(tx, now)
  const base: HubtelCsPatch = { status_check_attempts: tx.status_check_attempts + 1, last_status_check_at: ts, updated_at: ts }
  const open = (extra: HubtelCsPatch = {}): Transition => {
    if (tx.state === "pending" && age >= PENDING_STALE_MS) {
      return { next: "needs_review", patch: { ...base, ...extra, state: "needs_review", review_reason: "Still unresolved 24h after submission - confirm with Hubtel." } }
    }
    return { next: tx.state, patch: { ...base, ...extra, state: tx.state } }
  }
  if (!obs.ok) return open()
  if (obs.isFulfilled === true && String(obs.status ?? "").toLowerCase() === "paid") {
    return { next: "fulfilled", patch: { ...base, state: "fulfilled", completed_at: ts, negative_checks: 0, review_reason: null, failure_reason: null } }
  }
  if (obs.isFulfilled === false) {
    const neg = tx.negative_checks + 1
    if (neg >= NEGATIVE_CONFIRM_COUNT && age >= NEGATIVE_CONFIRM_AGE_MS) {
      return { next: "failed", patch: { ...base, state: "failed", completed_at: ts, negative_checks: neg, review_reason: null, failure_reason: "Hubtel status check: transaction not fulfilled" } }
    }
    return open({ negative_checks: neg })
  }
  return open({ negative_checks: 0 })
}

export function sweepStale(tx: HubtelCsTx, now: Date): Transition {
  const ts = now.toISOString()
  if (tx.state === "created" && ageMs(tx, now) >= CREATED_STALE_MS) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: "Request never completed (process interrupted before Hubtel replied). State unknown - check the status before any retry." } }
  }
  if (tx.state === "pending" && ageMs(tx, now) >= PENDING_STALE_MS) {
    return { next: "needs_review", patch: { state: "needs_review", updated_at: ts, review_reason: "Still unresolved 24h after submission - confirm with Hubtel." } }
  }
  return { ignored: "not stale" }
}

export function applyResolve(tx: HubtelCsTx, outcome: "fulfilled" | "failed", note: string, adminId: string, now: Date): Transition {
  if (tx.resolved_at && tx.state === outcome) return { ignored: `already resolved as ${outcome}` }
  const ts = now.toISOString()
  return {
    next: outcome,
    patch: {
      state: outcome, resolved_by: adminId, resolved_at: ts, resolution_note: note, review_reason: null,
      completed_at: tx.completed_at ?? ts,
      failure_reason: outcome === "failed" ? (tx.failure_reason ?? note) : null,
      updated_at: ts,
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/state-machine.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/state-machine.ts lib/hubtel-cs/state-machine.test.ts lib/hubtel-cs/testing/fixtures.ts
git commit -m "feat(hubtel-cs): pure transaction state machine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migrations (ledger, events, stats RPC)

**Files:**
- Create: `migrations/0113_hubtel_cs_transactions.sql`
- Create: `migrations/0114_hubtel_cs_events.sql`

**Interfaces:**
- Produces: tables `hubtel_cs_transactions`, `hubtel_cs_events`; RPC `hubtel_cs_stats()` returning one row `(total, in_flight, needs_review, failed, fulfilled, commission_earned)`.

- [ ] **Step 1: Write `migrations/0113_hubtel_cs_transactions.sql`**

```sql
-- 0113_hubtel_cs_transactions.sql
-- Hubtel Commission Services ledger: one row per POST to cs.hubtel.com (airtime, data, bills).
-- ADDITIVE; service-role only (RLS on, no policies, no grants to anon/authenticated), like 0106.

CREATE TABLE IF NOT EXISTS hubtel_cs_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_reference        text NOT NULL UNIQUE CHECK (client_reference ~ '^[A-Za-z0-9_-]{1,100}$'),
  service_key             text NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('airtime','data','bill')),
  destination             text NOT NULL,
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  bundle                  text,
  extra                   jsonb,
  state                   text NOT NULL DEFAULT 'created'
                            CHECK (state IN ('created','pending','fulfilled','failed','needs_review')),
  response_code           text,
  response_message        text,
  failure_reason          text,
  hubtel_transaction_id   text,
  external_transaction_id text,
  commission              numeric(12,6),
  charges                 numeric(12,4),
  amount_debited          numeric(12,2),
  order_table             text,
  order_id                uuid,
  submitted_at            timestamptz,
  completed_at            timestamptz,
  callback_received_at    timestamptz,
  status_check_attempts   int NOT NULL DEFAULT 0,
  negative_checks         int NOT NULL DEFAULT 0,
  last_status_check_at    timestamptz,
  review_reason           text,
  resolved_by             uuid,
  resolved_at             timestamptz,
  resolution_note         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_cs_tx_open_idx
  ON hubtel_cs_transactions (state, created_at) WHERE state IN ('created','pending','needs_review');
CREATE INDEX IF NOT EXISTS hubtel_cs_tx_order_idx
  ON hubtel_cs_transactions (order_table, order_id);
CREATE INDEX IF NOT EXISTS hubtel_cs_tx_created_idx
  ON hubtel_cs_transactions (created_at DESC);

ALTER TABLE hubtel_cs_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_cs_transactions FROM anon, authenticated;

-- Aggregates in SQL (PostgREST caps selects at 1000 rows, so never sum in app code).
CREATE OR REPLACE FUNCTION hubtel_cs_stats()
RETURNS TABLE (total bigint, in_flight bigint, needs_review bigint, failed bigint, fulfilled bigint, commission_earned numeric)
LANGUAGE sql STABLE AS $$
  SELECT count(*),
         count(*) FILTER (WHERE state IN ('created','pending')),
         count(*) FILTER (WHERE state = 'needs_review'),
         count(*) FILTER (WHERE state = 'failed'),
         count(*) FILTER (WHERE state = 'fulfilled'),
         COALESCE(sum(commission) FILTER (WHERE state = 'fulfilled'), 0)
  FROM hubtel_cs_transactions
$$;
REVOKE ALL ON FUNCTION hubtel_cs_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hubtel_cs_stats() TO service_role;
```

- [ ] **Step 2: Write `migrations/0114_hubtel_cs_events.sql`**

```sql
-- 0114_hubtel_cs_events.sql
-- Audit trail per Hubtel Commission Services call. ADDITIVE; the app logs best-effort and stays
-- silent (one warning per process) until this table exists. Service-role only. Retention 30 days
-- (purged by the hubtel-cs-status-check cron). Payloads never contain credentials or callback signatures.

CREATE TABLE IF NOT EXISTS hubtel_cs_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  client_reference text,
  direction        text NOT NULL CHECK (direction IN ('request','response','callback','status_check')),
  http_status      int,
  ok               boolean,
  payload          jsonb,
  error            text,
  source_ip        text
);

CREATE INDEX IF NOT EXISTS hubtel_cs_events_ref_idx ON hubtel_cs_events (client_reference, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_cs_events_created_idx ON hubtel_cs_events (created_at DESC);

ALTER TABLE hubtel_cs_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_cs_events FROM anon, authenticated;
```

- [ ] **Step 3: Sanity-check the SQL parses** (no DB needed): `git diff --stat` shows two new files; review once for typos. **Do NOT apply to the production database in this task** — applying is a gated step in Task 14.

- [ ] **Step 4: Commit**

```bash
git add migrations/0113_hubtel_cs_transactions.sql migrations/0114_hubtel_cs_events.sql
git commit -m "feat(hubtel-cs): ledger, events tables and stats RPC (migrations 0113/0114)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store (Supabase impl + in-memory test impl) and `applyAndCommit`

**Files:**
- Create: `lib/hubtel-cs/store.ts`
- Create: `lib/hubtel-cs/testing/memory-store.ts`
- Create: `lib/hubtel-cs/apply.ts`
- Test: `lib/hubtel-cs/store.test.ts`, `lib/hubtel-cs/apply.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `Transition`, fixtures.
- Produces:
```ts
export interface ListOpts { state?: HubtelCsState | "attention"; q?: string; limit: number; offset: number }
export interface HubtelCsStats { total: number; in_flight: number; needs_review: number; failed: number; fulfilled: number; commission_earned: number }
export interface HubtelCsStore {
  insert(row: NewHubtelCsTx): Promise<HubtelCsTx>                       // throws on duplicate client_reference
  getByRef(ref: string): Promise<HubtelCsTx | null>
  updateGuarded(id: string, expectedState: HubtelCsState, patch: HubtelCsPatch): Promise<HubtelCsTx | null> // null = guard failed
  listByStates(states: HubtelCsState[], o: { olderThan?: string; limit: number; orderBy?: "created_at" | "last_status_check_at" }): Promise<HubtelCsTx[]>
  listForAdmin(o: ListOpts): Promise<{ rows: HubtelCsTx[]; total: number }>
  stats(): Promise<HubtelCsStats>
  logEvent(ev: HubtelCsEvent): Promise<void>                            // never throws
  purgeEventsOlderThan(iso: string): Promise<void>
}
export function createSupabaseHubtelCsStore(db: SupabaseClient): HubtelCsStore
export function createMemoryStore(): HubtelCsStore & { rows: HubtelCsTx[]; events: HubtelCsEvent[]; seed(tx: HubtelCsTx): HubtelCsTx }
export function applyAndCommit(store, tx, transition, onTransition): Promise<{ tx: HubtelCsTx; changed: boolean }>
```
`onTransition(tx)` fires only when the row **enters** `fulfilled` or `failed`; it must not throw (callers wrap it).

- [ ] **Step 1: Write the failing tests**

`lib/hubtel-cs/store.test.ts` (contract tests against the memory store; the Supabase impl mirrors the same contract):
```ts
import { describe, it, expect } from "vitest"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, T0 } from "./testing/fixtures"

describe("memory store contract", () => {
  it("insert creates a created row and rejects a duplicate client_reference", async () => {
    const s = createMemoryStore()
    const tx = await s.insert({ client_reference: "HCS-a-1", service_key: "airtime_mtn", kind: "airtime", destination: "233246912184", amount: 5 })
    expect(tx.state).toBe("created")
    await expect(s.insert({ client_reference: "HCS-a-1", service_key: "airtime_mtn", kind: "airtime", destination: "x", amount: 1 })).rejects.toThrow(/duplicate/i)
  })

  it("updateGuarded only applies when the expected state still matches", async () => {
    const s = createMemoryStore()
    const tx = s.seed(makeTx({ state: "pending" }))
    expect(await s.updateGuarded(tx.id, "created", { state: "fulfilled" })).toBeNull()
    expect((await s.getByRef(tx.client_reference))!.state).toBe("pending")
    const ok = await s.updateGuarded(tx.id, "pending", { state: "fulfilled" })
    expect(ok!.state).toBe("fulfilled")
  })

  it("listByStates filters by state and age and orders never-checked rows first", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "A", state: "pending", created_at: "2026-10-13T09:00:00.000Z", last_status_check_at: "2026-10-13T09:50:00.000Z" }))
    s.seed(makeTx({ id: "b", client_reference: "B", state: "pending", created_at: "2026-10-13T09:10:00.000Z", last_status_check_at: null }))
    s.seed(makeTx({ id: "c", client_reference: "C", state: "pending", created_at: "2026-10-13T09:59:00.000Z" }))
    s.seed(makeTx({ id: "d", client_reference: "D", state: "fulfilled", created_at: "2026-10-13T09:00:00.000Z" }))
    const rows = await s.listByStates(["pending"], { olderThan: "2026-10-13T09:55:00.000Z", limit: 10, orderBy: "last_status_check_at" })
    expect(rows.map(r => r.id)).toEqual(["b", "a"])
  })

  it("listForAdmin supports the attention filter and free-text search", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "REF-AAA", state: "needs_review", destination: "233246912184" }))
    s.seed(makeTx({ id: "b", client_reference: "REF-BBB", state: "failed", destination: "233200000001" }))
    s.seed(makeTx({ id: "c", client_reference: "REF-CCC", state: "fulfilled", destination: "233200000002" }))
    expect((await s.listForAdmin({ state: "attention", limit: 10, offset: 0 })).total).toBe(2)
    expect((await s.listForAdmin({ q: "6912184", limit: 10, offset: 0 })).rows.map(r => r.id)).toEqual(["a"])
  })

  it("stats aggregates states and fulfilled commission", async () => {
    const s = createMemoryStore()
    s.seed(makeTx({ id: "a", client_reference: "A", state: "fulfilled", commission: 0.5 }))
    s.seed(makeTx({ id: "b", client_reference: "B", state: "fulfilled", commission: 0.25 }))
    s.seed(makeTx({ id: "c", client_reference: "C", state: "pending", commission: 9 }))
    s.seed(makeTx({ id: "d", client_reference: "D", state: "needs_review" }))
    expect(await s.stats()).toEqual({ total: 4, in_flight: 1, needs_review: 1, failed: 0, fulfilled: 2, commission_earned: 0.75 })
  })

  it("logEvent never throws", async () => {
    const s = createMemoryStore()
    await expect(s.logEvent({ client_reference: "A", direction: "request" })).resolves.toBeUndefined()
    expect(s.events).toHaveLength(1)
    void T0
  })
})
```

`lib/hubtel-cs/apply.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest"
import { applyAndCommit } from "./apply"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx } from "./testing/fixtures"

describe("applyAndCommit", () => {
  it("fires the hook once when a row enters a terminal state", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "pending" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { next: "fulfilled", patch: { state: "fulfilled" } }, hook)
    expect(out.changed).toBe(true)
    expect(out.tx.state).toBe("fulfilled")
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it("does not fire the hook for a non-terminal update (e.g. status-check bookkeeping)", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "pending" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { next: "pending", patch: { state: "pending", status_check_attempts: 1 } }, hook)
    expect(out.changed).toBe(true)
    expect(hook).not.toHaveBeenCalled()
  })

  it("ignored transitions change nothing", async () => {
    const store = createMemoryStore()
    const tx = store.seed(makeTx({ state: "fulfilled" }))
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, tx, { ignored: "already fulfilled" }, hook)
    expect(out).toEqual({ tx, changed: false })
    expect(hook).not.toHaveBeenCalled()
  })

  it("loses a race gracefully: guard fails, current row returned, hook not fired", async () => {
    const store = createMemoryStore()
    const stale = makeTx({ state: "pending" })
    store.seed({ ...stale, state: "fulfilled" })            // someone else already settled it
    const hook = vi.fn(async () => {})
    const out = await applyAndCommit(store, stale, { next: "failed", patch: { state: "failed" } }, hook)
    expect(out.changed).toBe(false)
    expect(out.tx.state).toBe("fulfilled")
    expect(hook).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/hubtel-cs/store.test.ts lib/hubtel-cs/apply.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`lib/hubtel-cs/store.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { HubtelCsEvent, HubtelCsPatch, HubtelCsState, HubtelCsTx, NewHubtelCsTx } from "./types"

export interface ListOpts { state?: HubtelCsState | "attention"; q?: string; limit: number; offset: number }
export interface HubtelCsStats { total: number; in_flight: number; needs_review: number; failed: number; fulfilled: number; commission_earned: number }

export interface HubtelCsStore {
  insert(row: NewHubtelCsTx): Promise<HubtelCsTx>
  getByRef(ref: string): Promise<HubtelCsTx | null>
  updateGuarded(id: string, expectedState: HubtelCsState, patch: HubtelCsPatch): Promise<HubtelCsTx | null>
  listByStates(states: HubtelCsState[], o: { olderThan?: string; limit: number; orderBy?: "created_at" | "last_status_check_at" }): Promise<HubtelCsTx[]>
  listForAdmin(o: ListOpts): Promise<{ rows: HubtelCsTx[]; total: number }>
  stats(): Promise<HubtelCsStats>
  logEvent(ev: HubtelCsEvent): Promise<void>
  purgeEventsOlderThan(iso: string): Promise<void>
}

const T = "hubtel_cs_transactions"
const E = "hubtel_cs_events"

/** Strip characters that would break a PostgREST `.or()` filter or act as ilike wildcards. */
const safeSearch = (q: string) => q.replace(/[,()%*\\]/g, "").trim()

export function createSupabaseHubtelCsStore(db: SupabaseClient): HubtelCsStore {
  let warned = false
  return {
    async insert(row) {
      const { data, error } = await db.from(T).insert(row).select().single()
      if (error) throw error
      return data as HubtelCsTx
    },
    async getByRef(ref) {
      const { data, error } = await db.from(T).select("*").eq("client_reference", ref).maybeSingle()
      if (error) throw error
      return (data as HubtelCsTx | null) ?? null
    },
    async updateGuarded(id, expectedState, patch) {
      const { data, error } = await db.from(T).update(patch).eq("id", id).eq("state", expectedState).select().maybeSingle()
      if (error) throw error
      return (data as HubtelCsTx | null) ?? null
    },
    async listByStates(states, o) {
      let q = db.from(T).select("*").in("state", states)
      if (o.olderThan) q = q.lte("created_at", o.olderThan)
      const { data, error } = await q.order(o.orderBy ?? "created_at", { ascending: true, nullsFirst: true }).limit(o.limit)
      if (error) throw error
      return (data ?? []) as HubtelCsTx[]
    },
    async listForAdmin(o) {
      let q = db.from(T).select("*", { count: "exact" })
      if (o.state === "attention") q = q.in("state", ["needs_review", "failed"])
      else if (o.state) q = q.eq("state", o.state)
      const term = o.q ? safeSearch(o.q) : ""
      if (term) q = q.or(`client_reference.ilike.%${term}%,destination.ilike.%${term}%,hubtel_transaction_id.ilike.%${term}%`)
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(o.offset, o.offset + o.limit - 1)
      if (error) throw error
      return { rows: (data ?? []) as HubtelCsTx[], total: count ?? 0 }
    },
    async stats() {
      const { data, error } = await db.rpc("hubtel_cs_stats")
      if (error) throw error
      const r: any = Array.isArray(data) ? data[0] : data
      return {
        total: Number(r?.total ?? 0), in_flight: Number(r?.in_flight ?? 0), needs_review: Number(r?.needs_review ?? 0),
        failed: Number(r?.failed ?? 0), fulfilled: Number(r?.fulfilled ?? 0), commission_earned: Number(r?.commission_earned ?? 0),
      }
    },
    async logEvent(ev) {
      try {
        const { error } = await db.from(E).insert(ev)
        if (error && !warned) { warned = true; console.warn("[hubtel-cs] event log insert failed (migration 0114 applied?):", error.message) }
      } catch (e: any) {
        if (!warned) { warned = true; console.warn("[hubtel-cs] event log threw:", e?.message ?? e) }
      }
    },
    async purgeEventsOlderThan(iso) {
      try { await db.from(E).delete().lt("created_at", iso) } catch { /* retention is best-effort */ }
    },
  }
}
```

`lib/hubtel-cs/testing/memory-store.ts`:
```ts
import { randomUUID } from "crypto"
import type { HubtelCsStats, HubtelCsStore, ListOpts } from "../store"
import type { HubtelCsEvent, HubtelCsPatch, HubtelCsState, HubtelCsTx, NewHubtelCsTx } from "../types"
import { makeTx } from "./fixtures"

export function createMemoryStore(): HubtelCsStore & { rows: HubtelCsTx[]; events: HubtelCsEvent[]; seed(tx: HubtelCsTx): HubtelCsTx } {
  const rows: HubtelCsTx[] = []
  const events: HubtelCsEvent[] = []
  const nowIso = () => new Date().toISOString()
  return {
    rows, events,
    seed(tx) { rows.push({ ...tx }); return tx },
    async insert(row: NewHubtelCsTx) {
      if (rows.some(r => r.client_reference === row.client_reference)) throw new Error("duplicate key value violates unique constraint (client_reference)")
      const tx = makeTx({ ...row, id: randomUUID(), state: "created", bundle: row.bundle ?? null, extra: row.extra ?? null, order_table: row.order_table ?? null, order_id: row.order_id ?? null, created_at: nowIso(), updated_at: nowIso() })
      rows.push(tx)
      return { ...tx }
    },
    async getByRef(ref) { const r = rows.find(x => x.client_reference === ref); return r ? { ...r } : null },
    async updateGuarded(id, expectedState: HubtelCsState, patch: HubtelCsPatch) {
      const r = rows.find(x => x.id === id && x.state === expectedState)
      if (!r) return null
      Object.assign(r, patch)
      return { ...r }
    },
    async listByStates(states, o) {
      const out = rows
        .filter(r => states.includes(r.state) && (!o.olderThan || r.created_at <= o.olderThan))
        .sort((a, b) => {
          const k = o.orderBy ?? "created_at"
          const av = (a as any)[k] as string | null, bv = (b as any)[k] as string | null
          if (av === bv) return 0
          if (av === null) return -1
          if (bv === null) return 1
          return av < bv ? -1 : 1
        })
        .slice(0, o.limit)
      return out.map(r => ({ ...r }))
    },
    async listForAdmin(o: ListOpts) {
      const term = (o.q ?? "").toLowerCase()
      const filtered = rows
        .filter(r => (o.state === "attention" ? r.state === "needs_review" || r.state === "failed" : o.state ? r.state === o.state : true))
        .filter(r => !term || [r.client_reference, r.destination, r.hubtel_transaction_id ?? ""].some(v => v.toLowerCase().includes(term)))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      return { rows: filtered.slice(o.offset, o.offset + o.limit).map(r => ({ ...r })), total: filtered.length }
    },
    async stats(): Promise<HubtelCsStats> {
      const count = (f: (r: HubtelCsTx) => boolean) => rows.filter(f).length
      return {
        total: rows.length,
        in_flight: count(r => r.state === "created" || r.state === "pending"),
        needs_review: count(r => r.state === "needs_review"),
        failed: count(r => r.state === "failed"),
        fulfilled: count(r => r.state === "fulfilled"),
        commission_earned: rows.filter(r => r.state === "fulfilled").reduce((s, r) => s + (r.commission ?? 0), 0),
      }
    },
    async logEvent(ev) { events.push(ev) },
    async purgeEventsOlderThan() { /* memory store keeps no timestamps */ },
  }
}
```

`lib/hubtel-cs/apply.ts`:
```ts
import type { HubtelCsStore } from "./store"
import type { Transition } from "./state-machine"
import type { HubtelCsTx } from "./types"

/**
 * Commit a state-machine transition with a state guard, then fire the order hook when the row
 * ENTERS fulfilled/failed. If another writer moved the row first (guard fails) nothing is
 * written and the current row is returned. `onTransition` must not throw (see adapters.notifyAdapter).
 */
export async function applyAndCommit(
  store: HubtelCsStore,
  tx: HubtelCsTx,
  transition: Transition,
  onTransition: (tx: HubtelCsTx) => Promise<void>
): Promise<{ tx: HubtelCsTx; changed: boolean }> {
  if ("ignored" in transition) return { tx, changed: false }
  const updated = await store.updateGuarded(tx.id, tx.state, transition.patch)
  if (!updated) return { tx: (await store.getByRef(tx.client_reference)) ?? tx, changed: false }
  const entered = updated.state !== tx.state && (updated.state === "fulfilled" || updated.state === "failed")
  if (entered) await onTransition(updated)
  return { tx: updated, changed: true }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run lib/hubtel-cs/store.test.ts lib/hubtel-cs/apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/store.ts lib/hubtel-cs/apply.ts lib/hubtel-cs/testing/memory-store.ts lib/hubtel-cs/store.test.ts lib/hubtel-cs/apply.test.ts
git commit -m "feat(hubtel-cs): ledger store (supabase + memory) and guarded transition commit

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Config in `admin_settings`

**Files:**
- Create: `lib/hubtel-cs/config.ts`
- Test: `lib/hubtel-cs/config.test.ts`

**Interfaces:**
- Consumes: `HUBTEL_CS_SERVICES`, `HUBTEL_CS_SERVICE_KEYS`, `isServiceKey` (Task 1).
- Produces:
```ts
export const HUBTEL_CS_CONFIG_KEY = "hubtel_cs_config"
export type HubtelCsMode = "direct" | "relay"
export interface HubtelCsConfig { enabled: boolean; mode: HubtelCsMode; paused: boolean; pausedReason: string | null; pausedAt: string | null; lowBalanceThreshold: number | null; services: Record<HubtelCsServiceKey, boolean> }
export interface ConfigPatch { enabled?: boolean; mode?: HubtelCsMode; lowBalanceThreshold?: number | null; services?: Partial<Record<HubtelCsServiceKey, boolean>>; paused?: false }
export function resolveConfig(stored: unknown): HubtelCsConfig
export function validateConfigPatch(input: unknown): { ok: true; patch: ConfigPatch } | { ok: false; error: string }
export function hubtelCsEnvReady(mode: HubtelCsMode, env?: Record<string, string | undefined>): { ready: boolean; missing: string[] }
export function getHubtelCsConfig(db: SupabaseClient): Promise<HubtelCsConfig>
export function setHubtelCsConfig(db: SupabaseClient, patch: ConfigPatch): Promise<HubtelCsConfig>
export function setHubtelCsPaused(db: SupabaseClient, reason: string | null): Promise<HubtelCsConfig>   // reason=null resumes
```

- [ ] **Step 1: Write the failing test** — `lib/hubtel-cs/config.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { hubtelCsEnvReady, resolveConfig, validateConfigPatch } from "./config"

describe("resolveConfig", () => {
  it("defaults dark: disabled, direct, unpaused, per-service defaults", () => {
    const c = resolveConfig(undefined)
    expect(c.enabled).toBe(false)
    expect(c.mode).toBe("direct")
    expect(c.paused).toBe(false)
    expect(c.lowBalanceThreshold).toBeNull()
    expect(c.services.airtime_mtn).toBe(true)
    expect(c.services.bill_telecel_broadband).toBe(false)
  })
  it("only an explicit true enables; only 'relay' selects relay", () => {
    expect(resolveConfig({ enabled: "true" }).enabled).toBe(false)
    expect(resolveConfig({ enabled: true }).enabled).toBe(true)
    expect(resolveConfig({ mode: "relay" }).mode).toBe("relay")
    expect(resolveConfig({ mode: "weird" }).mode).toBe("direct")
  })
  it("ignores unknown service keys and non-boolean values; keeps valid overrides", () => {
    const c = resolveConfig({ services: { airtime_mtn: false, bill_ecg: "yes", nope: true } })
    expect(c.services.airtime_mtn).toBe(false)
    expect(c.services.bill_ecg).toBe(true)
    expect((c.services as any).nope).toBeUndefined()
  })
  it("a bad or non-positive threshold resolves to null", () => {
    expect(resolveConfig({ lowBalanceThreshold: 250 }).lowBalanceThreshold).toBe(250)
    expect(resolveConfig({ lowBalanceThreshold: 0 }).lowBalanceThreshold).toBeNull()
    expect(resolveConfig({ lowBalanceThreshold: "x" }).lowBalanceThreshold).toBeNull()
  })
  it("carries the pause state", () => {
    const c = resolveConfig({ paused: true, pausedReason: "4075", pausedAt: "2026-10-13T10:00:00.000Z" })
    expect(c.paused).toBe(true)
    expect(c.pausedReason).toBe("4075")
  })
})

describe("validateConfigPatch", () => {
  it("accepts valid patches", () => {
    expect(validateConfigPatch({ enabled: true, mode: "relay", lowBalanceThreshold: 100, services: { airtime_mtn: false }, paused: false }))
      .toEqual({ ok: true, patch: { enabled: true, mode: "relay", lowBalanceThreshold: 100, services: { airtime_mtn: false }, paused: false } })
    expect(validateConfigPatch({ lowBalanceThreshold: null })).toEqual({ ok: true, patch: { lowBalanceThreshold: null } })
  })
  it("rejects bad types, unknown keys and unknown services", () => {
    expect(validateConfigPatch(null).ok).toBe(false)
    expect(validateConfigPatch({ enabled: "yes" }).ok).toBe(false)
    expect(validateConfigPatch({ mode: "tunnel" }).ok).toBe(false)
    expect(validateConfigPatch({ lowBalanceThreshold: -5 }).ok).toBe(false)
    expect(validateConfigPatch({ lowBalanceThreshold: Infinity }).ok).toBe(false)
    expect(validateConfigPatch({ services: { nope: true } }).ok).toBe(false)
    expect(validateConfigPatch({ services: { airtime_mtn: "on" } }).ok).toBe(false)
    expect(validateConfigPatch({ surprise: 1 }).ok).toBe(false)
  })
  it("an admin can only clear the pause, never set it", () => {
    expect(validateConfigPatch({ paused: true }).ok).toBe(false)
    expect(validateConfigPatch({ paused: false }).ok).toBe(true)
  })
})

describe("hubtelCsEnvReady", () => {
  const base = { HUBTEL_CS_CALLBACK_SECRET: "s", NEXT_PUBLIC_APP_URL: "https://x", HUBTEL_RELAY_URL: "https://r", HUBTEL_RELAY_SECRET: "rs" }
  it("direct mode also needs the CS credentials", () => {
    expect(hubtelCsEnvReady("direct", base).missing.sort()).toEqual(["HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT"])
    expect(hubtelCsEnvReady("direct", { ...base, HUBTEL_CS_BASIC_AUTH: "a", HUBTEL_DISBURSEMENT_ACCOUNT: "11691" }).ready).toBe(true)
  })
  it("relay mode needs only the shared env (credentials live on the droplet)", () => {
    expect(hubtelCsEnvReady("relay", base).ready).toBe(true)
  })
  it("status checks always use the relay, so relay env is required in both modes", () => {
    expect(hubtelCsEnvReady("relay", { ...base, HUBTEL_RELAY_URL: "" }).missing).toEqual(["HUBTEL_RELAY_URL"])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/hubtel-cs/config.ts`

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS, isServiceKey, type HubtelCsServiceKey } from "./services"

export const HUBTEL_CS_CONFIG_KEY = "hubtel_cs_config"
export type HubtelCsMode = "direct" | "relay"

export interface HubtelCsConfig {
  enabled: boolean
  mode: HubtelCsMode
  paused: boolean
  pausedReason: string | null
  pausedAt: string | null
  lowBalanceThreshold: number | null
  services: Record<HubtelCsServiceKey, boolean>
}
export interface ConfigPatch {
  enabled?: boolean
  mode?: HubtelCsMode
  lowBalanceThreshold?: number | null
  services?: Partial<Record<HubtelCsServiceKey, boolean>>
  /** Admins may only CLEAR the pause; pausing is done by the 4075 handler. */
  paused?: false
}

export function resolveConfig(stored: unknown): HubtelCsConfig {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, any>
  const services = {} as Record<HubtelCsServiceKey, boolean>
  for (const k of HUBTEL_CS_SERVICE_KEYS) {
    const v = s.services && typeof s.services === "object" ? s.services[k] : undefined
    services[k] = typeof v === "boolean" ? v : HUBTEL_CS_SERVICES[k].defaultEnabled
  }
  const t = s.lowBalanceThreshold
  return {
    enabled: s.enabled === true,
    mode: s.mode === "relay" ? "relay" : "direct",
    paused: s.paused === true,
    pausedReason: typeof s.pausedReason === "string" ? s.pausedReason : null,
    pausedAt: typeof s.pausedAt === "string" ? s.pausedAt : null,
    lowBalanceThreshold: typeof t === "number" && Number.isFinite(t) && t > 0 ? t : null,
    services,
  }
}

const PATCH_KEYS = new Set(["enabled", "mode", "lowBalanceThreshold", "services", "paused"])

export function validateConfigPatch(input: unknown): { ok: true; patch: ConfigPatch } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid JSON body" }
  const b = input as Record<string, unknown>
  for (const k of Object.keys(b)) if (!PATCH_KEYS.has(k)) return { ok: false, error: `Unknown field: ${k}` }
  const patch: ConfigPatch = {}
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }
    patch.enabled = b.enabled
  }
  if (b.mode !== undefined) {
    if (b.mode !== "direct" && b.mode !== "relay") return { ok: false, error: "mode must be 'direct' or 'relay'" }
    patch.mode = b.mode
  }
  if (b.lowBalanceThreshold !== undefined) {
    const t = b.lowBalanceThreshold
    if (t !== null && !(typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 10_000_000)) {
      return { ok: false, error: "lowBalanceThreshold must be a positive number or null" }
    }
    patch.lowBalanceThreshold = t as number | null
  }
  if (b.services !== undefined) {
    if (!b.services || typeof b.services !== "object" || Array.isArray(b.services)) return { ok: false, error: "services must be an object" }
    const out: Partial<Record<HubtelCsServiceKey, boolean>> = {}
    for (const [k, v] of Object.entries(b.services as Record<string, unknown>)) {
      if (!isServiceKey(k)) return { ok: false, error: `Unknown service: ${k}` }
      if (typeof v !== "boolean") return { ok: false, error: `services.${k} must be a boolean` }
      out[k] = v
    }
    patch.services = out
  }
  if (b.paused !== undefined) {
    if (b.paused !== false) return { ok: false, error: "paused can only be cleared (false)" }
    patch.paused = false
  }
  return { ok: true, patch }
}

/** Status checks always go through the relay, so relay env is required in both modes. */
export function hubtelCsEnvReady(
  mode: HubtelCsMode,
  env: Record<string, string | undefined> = process.env
): { ready: boolean; missing: string[] } {
  const required = ["HUBTEL_CS_CALLBACK_SECRET", "NEXT_PUBLIC_APP_URL", "HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"]
  if (mode === "direct") required.push("HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT")
  const missing = required.filter(k => !env[k])
  return { ready: missing.length === 0, missing }
}

export async function getHubtelCsConfig(db: SupabaseClient): Promise<HubtelCsConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", HUBTEL_CS_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveConfig(data?.value)
}

async function save(db: SupabaseClient, c: HubtelCsConfig): Promise<HubtelCsConfig> {
  const { error } = await db.from("admin_settings").upsert(
    {
      key: HUBTEL_CS_CONFIG_KEY,
      value: c,
      description: "Hubtel Commission Services: master switch, transport mode, per-service switches, pause state, low-balance threshold.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
  return c
}

export async function setHubtelCsConfig(db: SupabaseClient, patch: ConfigPatch): Promise<HubtelCsConfig> {
  const cur = await getHubtelCsConfig(db)
  const next: HubtelCsConfig = {
    ...cur,
    enabled: patch.enabled ?? cur.enabled,
    mode: patch.mode ?? cur.mode,
    lowBalanceThreshold: patch.lowBalanceThreshold !== undefined ? patch.lowBalanceThreshold : cur.lowBalanceThreshold,
    services: { ...cur.services, ...(patch.services ?? {}) },
    ...(patch.paused === false ? { paused: false, pausedReason: null, pausedAt: null } : {}),
  }
  return save(db, next)
}

/** reason=null resumes. Read-modify-write, same pattern (and same tiny race) as the USSD config. */
export async function setHubtelCsPaused(db: SupabaseClient, reason: string | null): Promise<HubtelCsConfig> {
  const cur = await getHubtelCsConfig(db)
  return save(db, reason === null
    ? { ...cur, paused: false, pausedReason: null, pausedAt: null }
    : { ...cur, paused: true, pausedReason: reason, pausedAt: new Date().toISOString() })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/config.ts lib/hubtel-cs/config.test.ts
git commit -m "feat(hubtel-cs): admin_settings config with validation and env readiness

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Callback authentication, parsing and processing

**Files:**
- Create: `lib/hubtel-cs/callback.ts`
- Test: `lib/hubtel-cs/callback.test.ts`

**Interfaces:**
- Consumes: Task 2 `applyCallback`; Task 4 `HubtelCsStore`, `applyAndCommit`; `ParsedCallback`.
- Produces:
```ts
export const HUBTEL_CALLBACK_IPS: string[]                       // ["18.202.122.131"]
export function signRef(ref: string, secret: string): string     // hex HMAC-SHA256
export function verifySig(ref: string | null, sig: string | null, secret: string): boolean
export function buildCallbackUrl(baseUrl: string, ref: string, secret: string): string
export function clientIpFromForwardedFor(header: string | null): string | null   // first entry, trimmed
export function isAllowedIp(ip: string | null, allowed?: string[]): boolean
export function parseCallbackBody(body: unknown): ParsedCallback | null
export interface CallbackDeps { store: HubtelCsStore; secret: string; enforceIp: boolean; onTransition: (tx: HubtelCsTx) => Promise<void>; now?: () => Date }
export function processCallback(deps: CallbackDeps, input: { ref: string | null; sig: string | null; ip: string | null; rawBody: string }): Promise<{ status: number; body: Record<string, unknown> }>
```

- [ ] **Step 1: Write the failing test** — `lib/hubtel-cs/callback.test.ts`

```ts
import { describe, it, expect, vi } from "vitest"
import {
  buildCallbackUrl, clientIpFromForwardedFor, isAllowedIp, parseCallbackBody, processCallback, signRef, verifySig,
} from "./callback"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, T0 } from "./testing/fixtures"

const SECRET = "s3cret"
const REF = "HCS-airtime_mtn-TESTREF1"

const body = (over: any = {}) => JSON.stringify({
  ResponseCode: "0000",
  Data: { AmountDebited: 0.5, TransactionId: "5b40e2e4", ClientReference: REF, Description: "GHC 0.50 sent", ExternalTransactionId: "2024012416592042208544402", Amount: 0.5, Charges: 0, Meta: { Commission: "0.0198" }, RecipientName: null, ...over.Data },
  ...(over.ResponseCode ? { ResponseCode: over.ResponseCode } : {}),
})

function setup(opts: { state?: any; enforceIp?: boolean; secret?: string } = {}) {
  const store = createMemoryStore()
  store.seed(makeTx({ state: opts.state ?? "pending", client_reference: REF }))
  const onTransition = vi.fn(async () => {})
  const deps = { store, secret: opts.secret ?? SECRET, enforceIp: opts.enforceIp ?? false, onTransition, now: () => T0 }
  const call = (over: Partial<{ ref: string | null; sig: string | null; ip: string | null; rawBody: string }> = {}) =>
    processCallback(deps, { ref: REF, sig: signRef(REF, SECRET), ip: "18.202.122.131", rawBody: body(), ...over })
  return { store, onTransition, call }
}

describe("signing", () => {
  it("round-trips and rejects tampering", () => {
    const sig = signRef(REF, SECRET)
    expect(verifySig(REF, sig, SECRET)).toBe(true)
    expect(verifySig(REF + "x", sig, SECRET)).toBe(false)
    expect(verifySig(REF, sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"), SECRET)).toBe(false)
    expect(verifySig(REF, "short", SECRET)).toBe(false)
    expect(verifySig(REF, null, SECRET)).toBe(false)
  })
  it("an empty secret never verifies (fail closed)", () => {
    expect(verifySig(REF, signRef(REF, ""), "")).toBe(false)
  })
  it("buildCallbackUrl embeds ref and a verifiable sig", () => {
    const u = new URL(buildCallbackUrl("https://app.example.com", REF, SECRET))
    expect(u.pathname).toBe("/api/hubtel-cs/callback")
    expect(u.searchParams.get("ref")).toBe(REF)
    expect(verifySig(REF, u.searchParams.get("sig"), SECRET)).toBe(true)
  })
})

describe("ip helpers", () => {
  it("takes the first x-forwarded-for entry", () => {
    expect(clientIpFromForwardedFor("18.202.122.131, 10.0.0.1")).toBe("18.202.122.131")
    expect(clientIpFromForwardedFor(" 1.2.3.4 ")).toBe("1.2.3.4")
    expect(clientIpFromForwardedFor(null)).toBeNull()
    expect(clientIpFromForwardedFor("")).toBeNull()
  })
  it("allows only Hubtel's callback IP", () => {
    expect(isAllowedIp("18.202.122.131")).toBe(true)
    expect(isAllowedIp("1.2.3.4")).toBe(false)
    expect(isAllowedIp(null)).toBe(false)
  })
})

describe("parseCallbackBody", () => {
  it("normalises the documented shape", () => {
    expect(parseCallbackBody(JSON.parse(body()))).toEqual({
      responseCode: "0000", clientReference: REF, transactionId: "5b40e2e4", externalTransactionId: "2024012416592042208544402",
      description: "GHC 0.50 sent", amountDebited: 0.5, charges: 0, commission: 0.0198,
    })
  })
  it("returns null without a ResponseCode or ClientReference", () => {
    expect(parseCallbackBody({})).toBeNull()
    expect(parseCallbackBody({ ResponseCode: "0000", Data: {} })).toBeNull()
    expect(parseCallbackBody("nope")).toBeNull()
  })
})

describe("processCallback", () => {
  it("401 on a bad signature and nothing changes", async () => {
    const { call, store, onTransition } = setup()
    const out = await call({ sig: "deadbeef" })
    expect(out.status).toBe(401)
    expect((await store.getByRef(REF))!.state).toBe("pending")
    expect(onTransition).not.toHaveBeenCalled()
  })
  it("401 when the server secret is empty", async () => {
    const { call } = setup({ secret: "" })
    expect((await call()).status).toBe(401)
  })
  it("ip enforcement: 403 for a foreign ip, missing ip, passes for Hubtel's", async () => {
    const { call } = setup({ enforceIp: true })
    expect((await call({ ip: "1.2.3.4" })).status).toBe(403)
    expect((await call({ ip: null })).status).toBe(403)
    expect((await call({ ip: "18.202.122.131" })).status).toBe(200)
  })
  it("ip is ignored when enforcement is off", async () => {
    const { call } = setup({ enforceIp: false })
    expect((await call({ ip: "1.2.3.4" })).status).toBe(200)
  })
  it("400 for invalid JSON and for a body/query reference mismatch", async () => {
    const { call } = setup()
    expect((await call({ rawBody: "{not json" })).status).toBe(400)
    expect((await call({ rawBody: body({ Data: { ClientReference: "OTHER" } }) })).status).toBe(400)
  })
  it("0000 settles the row once: fulfilled, commission stored, hook fired", async () => {
    const { call, store, onTransition } = setup()
    const out = await call()
    expect(out.status).toBe(200)
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("fulfilled")
    expect(tx.commission).toBe(0.0198)
    expect(tx.external_transaction_id).toBe("2024012416592042208544402")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a duplicate callback is acknowledged but ignored (hook not re-fired)", async () => {
    const { call, onTransition } = setup()
    await call()
    const again = await call()
    expect(again.status).toBe(200)
    expect(again.body.ignored).toMatch(/already fulfilled/)
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a failure callback marks failed with Hubtel's Description", async () => {
    const { call, store } = setup()
    await call({ rawBody: body({ ResponseCode: "2001", Data: { Description: "The receiving user is not registered in the system" } }) })
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("failed")
    expect(tx.failure_reason).toBe("The receiving user is not registered in the system")
  })
  it("a row resolved by an admin ignores later callbacks", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ state: "failed", client_reference: REF, resolved_at: T0.toISOString() }))
    const out = await processCallback(
      { store, secret: SECRET, enforceIp: false, onTransition: async () => {}, now: () => T0 },
      { ref: REF, sig: signRef(REF, SECRET), ip: null, rawBody: body() }
    )
    expect(out.body.ignored).toBeTruthy()
    expect((await store.getByRef(REF))!.state).toBe("failed")
  })
  it("an unknown reference with a valid signature answers 200 ok:false (stops Hubtel retries)", async () => {
    const store = createMemoryStore()
    const out = await processCallback(
      { store, secret: SECRET, enforceIp: false, onTransition: async () => {}, now: () => T0 },
      { ref: REF, sig: signRef(REF, SECRET), ip: null, rawBody: body() }
    )
    expect(out).toEqual({ status: 200, body: { ok: false, error: "unknown reference" } })
  })
  it("logs authenticated callbacks as events", async () => {
    const { call, store } = setup()
    await call()
    expect(store.events.some(e => e.direction === "callback" && e.client_reference === REF)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/callback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/hubtel-cs/callback.ts`

```ts
import crypto from "crypto"
import { applyAndCommit } from "./apply"
import { applyCallback, parseCommission } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx, ParsedCallback } from "./types"

/** Hubtel's documented callback source IP. */
export const HUBTEL_CALLBACK_IPS = ["18.202.122.131"]

export function signRef(ref: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(ref).digest("hex")
}

export function verifySig(ref: string | null, sig: string | null, secret: string): boolean {
  if (!ref || !sig || !secret) return false
  const a = Buffer.from(sig)
  const b = Buffer.from(signRef(ref, secret))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function buildCallbackUrl(baseUrl: string, ref: string, secret: string): string {
  const u = new URL("/api/hubtel-cs/callback", baseUrl)
  u.searchParams.set("ref", ref)
  u.searchParams.set("sig", signRef(ref, secret))
  return u.toString()
}

export function clientIpFromForwardedFor(header: string | null): string | null {
  const first = header?.split(",")[0]?.trim()
  return first ? first : null
}

export function isAllowedIp(ip: string | null, allowed: string[] = HUBTEL_CALLBACK_IPS): boolean {
  return !!ip && allowed.includes(ip)
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

export function parseCallbackBody(body: unknown): ParsedCallback | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, any>
  const d = (b.Data && typeof b.Data === "object" ? b.Data : {}) as Record<string, any>
  const code = b.ResponseCode !== undefined && b.ResponseCode !== null ? String(b.ResponseCode).trim() : ""
  const ref = str(d.ClientReference)
  if (!code || !ref) return null
  return {
    responseCode: code, clientReference: ref, transactionId: str(d.TransactionId), externalTransactionId: str(d.ExternalTransactionId),
    description: str(d.Description), amountDebited: num(d.AmountDebited), charges: num(d.Charges), commission: parseCommission(d.Meta?.Commission),
  }
}

export interface CallbackDeps {
  store: HubtelCsStore
  secret: string
  enforceIp: boolean
  onTransition: (tx: HubtelCsTx) => Promise<void>
  now?: () => Date
}

type Out = { status: number; body: Record<string, unknown> }

/**
 * Hubtel never signs callbacks, so the per-transaction HMAC in the callback URL is the
 * authentication. After auth we answer 200 for anything that cannot be retried into success
 * (unknown ref, duplicate) so Hubtel stops retrying; the status-check cron is the backstop.
 */
export async function processCallback(
  deps: CallbackDeps,
  input: { ref: string | null; sig: string | null; ip: string | null; rawBody: string }
): Promise<Out> {
  const now = deps.now ?? (() => new Date())
  if (!verifySig(input.ref, input.sig, deps.secret)) return { status: 401, body: { error: "unauthorized" } }
  if (deps.enforceIp && !isAllowedIp(input.ip)) return { status: 403, body: { error: "forbidden" } }
  const ref = input.ref as string

  let parsedJson: unknown
  try { parsedJson = JSON.parse(input.rawBody) } catch {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "invalid json", payload: { raw: input.rawBody.slice(0, 2000) }, source_ip: input.ip })
    return { status: 400, body: { error: "invalid json" } }
  }
  const cb = parseCallbackBody(parsedJson)
  if (!cb || cb.clientReference !== ref) {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "invalid or mismatched payload", payload: parsedJson, source_ip: input.ip })
    return { status: 400, body: { error: "invalid payload" } }
  }

  const tx = await deps.store.getByRef(ref)
  if (!tx) {
    await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: false, error: "unknown reference", payload: parsedJson, source_ip: input.ip })
    return { status: 200, body: { ok: false, error: "unknown reference" } }
  }

  const transition = applyCallback(tx, cb, now())
  const result = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  const ignored = "ignored" in transition ? transition.ignored : null
  await deps.store.logEvent({ client_reference: ref, direction: "callback", ok: true, payload: parsedJson, error: ignored, source_ip: input.ip })
  return { status: 200, body: ignored ? { ok: true, ignored } : { ok: true, state: result.tx.state } }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/callback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/callback.ts lib/hubtel-cs/callback.test.ts
git commit -m "feat(hubtel-cs): HMAC-authenticated callback processing

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Transport and client (persist-before-call, no resend)

**Files:**
- Create: `lib/hubtel-cs/transport.ts`
- Create: `lib/hubtel-cs/client.ts`
- Test: `lib/hubtel-cs/transport.test.ts`, `lib/hubtel-cs/client.test.ts`

**Interfaces:**
- Consumes: Task 1 (services, errors, types), Task 2 (`applyPostResponse`, `classifyCode`), Task 4 (`HubtelCsStore`, `applyAndCommit`), Task 5 (`HubtelCsConfig`, `HubtelCsMode`), Task 6 (`buildCallbackUrl`).
- Produces:
```ts
export type TransportResult = { httpStatus: number; body: unknown } | { error: string }
export interface HubtelCsTransport { call(req: { method: "GET" | "POST"; serviceId: string; query?: Record<string, string>; body?: unknown }): Promise<TransportResult> }
export function createDirectTransport(o: { disbursementAccount: string; basicAuth: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HubtelCsTransport
export function createRelayTransport(o: { relayUrl: string; relaySecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HubtelCsTransport
export function transportFromEnv(mode: HubtelCsMode, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): HubtelCsTransport   // throws HubtelNotConfiguredError

export interface PurchaseInput { serviceKey: HubtelCsServiceKey; destination: string; amount: number; bundle?: string; extra?: { email?: string; sessionId?: string }; orderTable?: string; orderId?: string }
export function validatePurchase(input: PurchaseInput): void                       // throws HubtelValidationError
export function buildPurchaseBody(input: PurchaseInput, callbackUrl: string, ref: string): Record<string, unknown>
export interface ClientDeps { store: HubtelCsStore; getConfig(): Promise<HubtelCsConfig>; getTransport(mode: HubtelCsMode): HubtelCsTransport; callbackBaseUrl: string; callbackSecret: string; onFloat(reason: string): Promise<void>; onTransition?: (tx: HubtelCsTx) => Promise<void>; now?: () => Date; newRef?: (k: HubtelCsServiceKey) => string }
export function createHubtelCsClient(deps: ClientDeps): {
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }):
    Promise<{ ok: true; data: HubtelQueryItem[]; label: string | null } | { ok: false; error: string; code?: string }>
}
```

- [ ] **Step 1: Write the failing transport test** — `lib/hubtel-cs/transport.test.ts`

```ts
import { describe, it, expect, vi } from "vitest"
import { createDirectTransport, createRelayTransport, transportFromEnv } from "./transport"
import { HubtelNotConfiguredError } from "./errors"

const jsonRes = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })

describe("direct transport", () => {
  const mk = (fetchImpl: any) => createDirectTransport({ disbursementAccount: "11691", basicAuth: "QUJD", fetchImpl })

  it("POSTs json to {base}/{account}/{serviceId} with Basic auth", async () => {
    const f = vi.fn(async () => jsonRes(200, { ResponseCode: "0001" }))
    const out = await mk(f).call({ method: "POST", serviceId: "fdd76c884e614b1c8f669a3207b09a98", body: { Amount: 1 } })
    expect(out).toEqual({ httpStatus: 200, body: { ResponseCode: "0001" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://cs.hubtel.com/commissionservices/11691/fdd76c884e614b1c8f669a3207b09a98")
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Basic QUJD")
    expect(JSON.parse(init.body)).toEqual({ Amount: 1 })
  })
  it("GET puts query params in the url and sends no body", async () => {
    const f = vi.fn(async () => jsonRes(200, { ResponseCode: "0000" }))
    await mk(f).call({ method: "GET", serviceId: "b230733cd56b4a0fad820e39f66bc27c", query: { destination: "233246912184" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://cs.hubtel.com/commissionservices/11691/b230733cd56b4a0fad820e39f66bc27c?destination=233246912184")
    expect(init.body).toBeUndefined()
  })
  it("a network error or timeout becomes { error }", async () => {
    const out = await mk(async () => { throw new Error("fetch failed") }).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ error: "fetch failed" })
  })
  it("non-json bodies come back as text (e.g. an html 502 page)", async () => {
    const out = await mk(async () => jsonRes(502, "<html>Bad gateway</html>")).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ httpStatus: 502, body: "<html>Bad gateway</html>" })
  })
})

describe("relay transport", () => {
  const mk = (fetchImpl: any) => createRelayTransport({ relayUrl: "https://relay.example.com/", relaySecret: "rs", fetchImpl })

  it("POSTs to {relay}/cs/{serviceId} with the bearer secret and unwraps the envelope", async () => {
    const f = vi.fn(async () => jsonRes(200, { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" } }))
    const out = await mk(f).call({ method: "POST", serviceId: "fdd76c884e614b1c8f669a3207b09a98", body: { Amount: 1 } })
    expect(out).toEqual({ httpStatus: 200, body: { ResponseCode: "0001" } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe("https://relay.example.com/cs/fdd76c884e614b1c8f669a3207b09a98")
    expect(init.headers.Authorization).toBe("Bearer rs")
  })
  it("upstreamStatus 0 (relay could not reach Hubtel) -> { error }", async () => {
    const out = await mk(async () => jsonRes(200, { ok: false, upstreamStatus: 0, body: "ECONNRESET" })).call({ method: "POST", serviceId: "x".repeat(32), body: {} })
    expect(out).toEqual({ error: "ECONNRESET" })
  })
  it("a relay refusal (401/501) -> { error }", async () => {
    const out = await mk(async () => jsonRes(501, { error: "cs not configured" })).call({ method: "GET", serviceId: "x".repeat(32), query: { destination: "1" } })
    expect("error" in out && out.error).toMatch(/relay 501/)
  })
})

describe("transportFromEnv", () => {
  it("throws HubtelNotConfiguredError listing what is missing", () => {
    expect(() => transportFromEnv("direct", {})).toThrow(HubtelNotConfiguredError)
    try { transportFromEnv("direct", { HUBTEL_CS_BASIC_AUTH: "a" }) } catch (e: any) { expect(e.missing).toEqual(["HUBTEL_DISBURSEMENT_ACCOUNT"]) }
    try { transportFromEnv("relay", {}) } catch (e: any) { expect(e.missing).toEqual(["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"]) }
  })
  it("builds a transport when configured", () => {
    expect(transportFromEnv("direct", { HUBTEL_CS_BASIC_AUTH: "a", HUBTEL_DISBURSEMENT_ACCOUNT: "1" }).call).toBeTypeOf("function")
    expect(transportFromEnv("relay", { HUBTEL_RELAY_URL: "https://r", HUBTEL_RELAY_SECRET: "s" }).call).toBeTypeOf("function")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/hubtel-cs/transport.ts`

```ts
import { HubtelNotConfiguredError } from "./errors"
import type { HubtelCsMode } from "./config"

export type TransportResult = { httpStatus: number; body: unknown } | { error: string }

export interface HubtelCsTransport {
  call(req: { method: "GET" | "POST"; serviceId: string; query?: Record<string, string>; body?: unknown }): Promise<TransportResult>
}

const TIMEOUT_MS = 10_000

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { return text }
}

const qs = (q?: Record<string, string>) => (q && Object.keys(q).length ? `?${new URLSearchParams(q).toString()}` : "")

export function createDirectTransport(o: {
  disbursementAccount: string; basicAuth: string; baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number
}): HubtelCsTransport {
  const doFetch = o.fetchImpl ?? fetch
  const base = (o.baseUrl ?? "https://cs.hubtel.com/commissionservices").replace(/\/$/, "")
  return {
    async call(req) {
      const url = `${base}/${encodeURIComponent(o.disbursementAccount)}/${req.serviceId}${qs(req.query)}`
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Basic ${o.basicAuth}`, Accept: "application/json", "Content-Type": "application/json" },
          ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
          signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
        })
        return { httpStatus: res.status, body: await readBody(res) }
      } catch (e: any) {
        return { error: String(e?.message ?? e) }
      }
    },
  }
}

export function createRelayTransport(o: { relayUrl: string; relaySecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HubtelCsTransport {
  const doFetch = o.fetchImpl ?? fetch
  const base = o.relayUrl.replace(/\/$/, "")
  return {
    async call(req) {
      const url = `${base}/cs/${req.serviceId}${qs(req.query)}`
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Bearer ${o.relaySecret}`, "Content-Type": "application/json" },
          ...(req.method === "POST" ? { body: JSON.stringify(req.body ?? {}) } : {}),
          signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
        })
        const json: any = await readBody(res)
        if (!res.ok || !json || typeof json !== "object" || !("upstreamStatus" in json)) return { error: `relay ${res.status}` }
        if (json.upstreamStatus === 0) return { error: String(json.body ?? "relay could not reach Hubtel") }
        return { httpStatus: json.upstreamStatus, body: json.body }
      } catch (e: any) {
        return { error: String(e?.message ?? e) }
      }
    },
  }
}

export function transportFromEnv(
  mode: HubtelCsMode,
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch
): HubtelCsTransport {
  if (mode === "relay") {
    const missing = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET"].filter(k => !env[k])
    if (missing.length) throw new HubtelNotConfiguredError(missing)
    return createRelayTransport({ relayUrl: env.HUBTEL_RELAY_URL!, relaySecret: env.HUBTEL_RELAY_SECRET!, fetchImpl })
  }
  const missing = ["HUBTEL_CS_BASIC_AUTH", "HUBTEL_DISBURSEMENT_ACCOUNT"].filter(k => !env[k])
  if (missing.length) throw new HubtelNotConfiguredError(missing)
  return createDirectTransport({ disbursementAccount: env.HUBTEL_DISBURSEMENT_ACCOUNT!, basicAuth: env.HUBTEL_CS_BASIC_AUTH!, fetchImpl })
}
```

- [ ] **Step 4: Run transport tests**

Run: `npx vitest run lib/hubtel-cs/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing client test** — `lib/hubtel-cs/client.test.ts`

```ts
import { describe, it, expect, vi } from "vitest"
import { buildPurchaseBody, createHubtelCsClient, validatePurchase } from "./client"
import { resolveConfig } from "./config"
import { verifySig } from "./callback"
import { createMemoryStore } from "./testing/memory-store"
import { T0 } from "./testing/fixtures"
import { HubtelDisabledError, HubtelNotConfiguredError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError } from "./errors"
import type { TransportResult } from "./transport"

const PENDING: TransportResult = { httpStatus: 200, body: { ResponseCode: "0001", Message: "Transaction pending.", Data: { ClientReference: "x", Amount: 5, TransactionId: " abc123 ", Meta: { Commission: "0.0198" } } } }

function setup(over: { cfg?: any; results?: TransportResult[]; callbackSecret?: string; callbackBaseUrl?: string; transportCall?: (req: any) => void } = {}) {
  const store = createMemoryStore()
  const calls: any[] = []
  const results = over.results ?? [PENDING]
  let i = 0
  const transport = { call: async (req: any) => { calls.push(req); over.transportCall?.(req); return results[Math.min(i++, results.length - 1)] } }
  const onFloat = vi.fn(async (_r: string) => {})
  const onTransition = vi.fn(async () => {})
  const cfg = resolveConfig({ enabled: true, ...over.cfg })
  const client = createHubtelCsClient({
    store, getConfig: async () => cfg, getTransport: () => transport,
    callbackBaseUrl: over.callbackBaseUrl ?? "https://app.example.com", callbackSecret: over.callbackSecret ?? "s3cret",
    onFloat, onTransition, now: () => T0, newRef: k => `HCS-${k}-TESTREF1`,
  })
  return { store, calls, client, onFloat, onTransition }
}

const AIRTIME = { serviceKey: "airtime_mtn" as const, destination: "233246912184", amount: 5 }

describe("validatePurchase / buildPurchaseBody", () => {
  it("accepts float-noise amounts and sends them rounded to 2dp", () => {
    const input = { ...AIRTIME, amount: 0.1 + 0.2 }
    expect(() => validatePurchase(input)).not.toThrow()
    expect(buildPurchaseBody(input, "https://cb", "REF").Amount).toBe(0.3)
  })
  it("rejects 3-decimal, zero, negative, NaN and over-cap airtime amounts", () => {
    for (const amount of [0.001, 1.234, 0, -1, NaN, Infinity, 100.01]) {
      expect(() => validatePurchase({ ...AIRTIME, amount })).toThrow(HubtelValidationError)
    }
    expect(() => validatePurchase({ ...AIRTIME, amount: 100 })).not.toThrow()
  })
  it("requires a destination", () => {
    expect(() => validatePurchase({ ...AIRTIME, destination: "  " })).toThrow(HubtelValidationError)
  })
  it("data needs a bundle and sends it EXACTLY as Hubtel returned it (leading spaces kept)", () => {
    const input = { serviceKey: "data_telecel" as const, destination: "233206439599", amount: 10, bundle: " 5.7 GB" }
    expect(buildPurchaseBody(input, "https://cb", "REF").Extradata).toEqual({ bundle: " 5.7 GB" })
    expect(() => validatePurchase({ ...input, bundle: undefined })).toThrow(HubtelValidationError)
  })
  it("ghana water needs bundle + email + sessionId and sends Email/SessionId", () => {
    const input = { serviceKey: "bill_ghana_water" as const, destination: "233548359582", amount: 10, bundle: "080706070056", extra: { email: "a@b.co", sessionId: "sess1" } }
    expect(buildPurchaseBody(input, "https://cb", "REF").Extradata).toEqual({ bundle: "080706070056", Email: "a@b.co", SessionId: "sess1" })
    expect(() => validatePurchase({ ...input, extra: { sessionId: "s" } })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...input, extra: { email: "not-an-email", sessionId: "s" } })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...input, extra: { email: "a@b.co" } })).toThrow(HubtelValidationError)
  })
  it("tv bills send no Extradata", () => {
    expect(buildPurchaseBody({ serviceKey: "bill_dstv", destination: "7029864396", amount: 50 }, "https://cb", "REF").Extradata).toBeUndefined()
  })
  it("the request body carries Destination, CallbackUrl and ClientReference", () => {
    expect(buildPurchaseBody({ ...AIRTIME, destination: " 233246912184 " }, "https://cb", "REF"))
      .toEqual({ Destination: "233246912184", Amount: 5, CallbackUrl: "https://cb", ClientReference: "REF" })
  })
})

describe("purchase", () => {
  it("persists the row BEFORE calling Hubtel", async () => {
    const seen: string[] = []
    const ctx = setup({ transportCall: () => seen.push("called") })
    // assert state at call time via a second transport spy
    const store = ctx.store
    const orig = store.insert
    store.insert = async row => { seen.push("inserted"); return orig(row) }
    await ctx.client.purchase(AIRTIME)
    expect(seen).toEqual(["inserted", "called"])
  })
  it("0001 -> pending with trimmed hubtel id and commission; one POST only", async () => {
    const { client, calls, store } = setup()
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("pending")
    expect(tx.hubtel_transaction_id).toBe("abc123")
    expect(tx.commission).toBe(0.0198)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("POST")
    expect(store.rows).toHaveLength(1)
  })
  it("sends a CallbackUrl whose signature verifies, and never logs the signature", async () => {
    const { client, calls, store } = setup()
    await client.purchase(AIRTIME)
    const u = new URL(calls[0].body.CallbackUrl)
    expect(u.searchParams.get("ref")).toBe("HCS-airtime_mtn-TESTREF1")
    expect(verifySig("HCS-airtime_mtn-TESTREF1", u.searchParams.get("sig"), "s3cret")).toBe(true)
    const reqEvent = store.events.find(e => e.direction === "request")!
    expect(JSON.stringify(reqEvent.payload)).not.toContain("sig=")
  })
  it("a transport error -> needs_review and the POST is NOT retried", async () => {
    const { client, calls } = setup({ results: [{ error: "timeout" }] })
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("needs_review")
    expect(calls).toHaveLength(1)
  })
  it("an html 5xx body -> needs_review, never failed", async () => {
    const { client } = setup({ results: [{ httpStatus: 502, body: "<html>Bad gateway</html>" }] })
    expect((await client.purchase(AIRTIME)).state).toBe("needs_review")
  })
  it("4075 -> failed and onFloat is called once", async () => {
    const { client, onFloat } = setup({ results: [{ httpStatus: 200, body: { ResponseCode: "4075", Message: "Insufficient prepaid balance." } }] })
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("failed")
    expect(onFloat).toHaveBeenCalledTimes(1)
    expect(onFloat.mock.calls[0][0]).toMatch(/4075/)
  })
  it("a definite failure fires the order hook (row entered a terminal state)", async () => {
    const { client, onTransition } = setup({ results: [{ httpStatus: 400, body: { ResponseCode: "4010", Message: "Validation errors" } }] })
    expect((await client.purchase(AIRTIME)).state).toBe("failed")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("stores the order link and extra on the row", async () => {
    const { client, store } = setup()
    await client.purchase({ ...AIRTIME, orderTable: "airtime_orders", orderId: "7d1f0c9e-1111-4222-8333-444455556666" })
    expect(store.rows[0].order_table).toBe("airtime_orders")
    expect(store.rows[0].order_id).toBe("7d1f0c9e-1111-4222-8333-444455556666")
  })
})

describe("purchase guards (no row is created)", () => {
  it("master switch off", async () => {
    const { client, store, calls } = setup({ cfg: { enabled: false } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelDisabledError)
    expect(store.rows).toHaveLength(0); expect(calls).toHaveLength(0)
  })
  it("service switch off", async () => {
    const { client, store } = setup({ cfg: { services: { airtime_mtn: false } } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelServiceDisabledError)
    expect(store.rows).toHaveLength(0)
  })
  it("paused after a 4075", async () => {
    const { client, store } = setup({ cfg: { paused: true, pausedReason: "4075" } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelPausedError)
    expect(store.rows).toHaveLength(0)
  })
  it("missing callback secret or base url", async () => {
    await expect(setup({ callbackSecret: "" }).client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelNotConfiguredError)
    await expect(setup({ callbackBaseUrl: "" }).client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelNotConfiguredError)
  })
  it("validation failures create nothing", async () => {
    const { client, store } = setup()
    await expect(client.purchase({ ...AIRTIME, amount: 100.01 })).rejects.toBeInstanceOf(HubtelValidationError)
    expect(store.rows).toHaveLength(0)
  })
})

describe("query", () => {
  const OK: TransportResult = { httpStatus: 200, body: { ResponseCode: "0000", Label: "Select bundle", Data: [{ Display: "80MB", Value: "DATA1", Amount: 1 }] } }
  it("returns the bundle list and sends destination in the query", async () => {
    const { client, calls } = setup({ results: [OK] })
    const out = await client.query("data_at", "233273833933")
    expect(out).toEqual({ ok: true, data: [{ Display: "80MB", Value: "DATA1", Amount: 1 }], label: "Select bundle" })
    expect(calls[0]).toMatchObject({ method: "GET", query: { destination: "233273833933" } })
  })
  it("ghana water requires the customer's mobile", async () => {
    const { client } = setup({ results: [OK] })
    await expect(client.query("bill_ghana_water", "091019010006")).rejects.toBeInstanceOf(HubtelValidationError)
    const out = await setup({ results: [OK] }).client.query("bill_ghana_water", "091019010006", { mobile: "233242825109" })
    expect(out.ok).toBe(true)
  })
  it("airtime has no query endpoint", async () => {
    await expect(setup().client.query("airtime_mtn", "233246912184")).rejects.toBeInstanceOf(HubtelValidationError)
  })
  it("a non-0000 code or transport error -> ok:false", async () => {
    expect(await setup({ results: [{ httpStatus: 200, body: { ResponseCode: "4000", Message: "bad" } }] }).client.query("data_at", "1")).toEqual({ ok: false, error: "bad", code: "4000" })
    expect(await setup({ results: [{ error: "timeout" }] }).client.query("data_at", "1")).toEqual({ ok: false, error: "timeout" })
  })
  it("respects the master switch and service switch but NOT the pause (read-only)", async () => {
    await expect(setup({ cfg: { enabled: false } }).client.query("data_at", "1")).rejects.toBeInstanceOf(HubtelDisabledError)
    const out = await setup({ cfg: { paused: true }, results: [OK] }).client.query("data_at", "1")
    expect(out.ok).toBe(true)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/client.test.ts`
Expected: FAIL — `./client` not found.

- [ ] **Step 7: Implement** — `lib/hubtel-cs/client.ts`

```ts
import crypto from "crypto"
import { applyAndCommit } from "./apply"
import { buildCallbackUrl } from "./callback"
import type { HubtelCsConfig, HubtelCsMode } from "./config"
import {
  HubtelDisabledError, HubtelNotConfiguredError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"
import { getService, type HubtelCsServiceKey } from "./services"
import { applyPostResponse, classifyCode, type PostResult } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTransport } from "./transport"
import type { HubtelCsTx, HubtelQueryItem } from "./types"

export interface PurchaseInput {
  serviceKey: HubtelCsServiceKey
  destination: string
  amount: number
  /** Bundle value / meter number / broadband account, exactly as Hubtel's query returned it. */
  bundle?: string
  extra?: { email?: string; sessionId?: string }
  orderTable?: string
  orderId?: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hasTwoDecimals = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6

export function validatePurchase(input: PurchaseInput): void {
  const svc = getService(input.serviceKey)
  if (!input.destination || !input.destination.trim()) throw new HubtelValidationError("destination is required")
  const a = input.amount
  if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) throw new HubtelValidationError("amount must be a positive number")
  if (!hasTwoDecimals(a)) throw new HubtelValidationError("amount may have at most 2 decimal places")
  if (svc.maxAmount !== undefined && Math.round(a * 100) > svc.maxAmount * 100) {
    throw new HubtelValidationError(`${svc.label} amount cannot exceed GHS ${svc.maxAmount}`)
  }
  if (svc.needsBundle && (!input.bundle || !input.bundle.length)) throw new HubtelValidationError(`${svc.label} requires a bundle / account value`)
  if (svc.key === "bill_ghana_water") {
    if (!input.extra?.email || !EMAIL.test(input.extra.email)) throw new HubtelValidationError("Ghana Water requires a valid customer email")
    if (!input.extra?.sessionId) throw new HubtelValidationError("Ghana Water requires the sessionId from the meter lookup")
  }
}

export function buildPurchaseBody(input: PurchaseInput, callbackUrl: string, ref: string): Record<string, unknown> {
  const svc = getService(input.serviceKey)
  const body: Record<string, unknown> = {
    Destination: input.destination.trim(),
    Amount: Number(input.amount.toFixed(2)),
    CallbackUrl: callbackUrl,
    ClientReference: ref,
  }
  if (svc.needsBundle) {
    const extra: Record<string, unknown> = { bundle: input.bundle }
    if (svc.key === "bill_ghana_water") { extra.Email = input.extra!.email; extra.SessionId = input.extra!.sessionId }
    body.Extradata = extra
  }
  return body
}

export interface ClientDeps {
  store: HubtelCsStore
  getConfig(): Promise<HubtelCsConfig>
  getTransport(mode: HubtelCsMode): HubtelCsTransport
  callbackBaseUrl: string
  callbackSecret: string
  onFloat(reason: string): Promise<void>
  onTransition?: (tx: HubtelCsTx) => Promise<void>
  now?: () => Date
  newRef?: (k: HubtelCsServiceKey) => string
}

type QueryOut = { ok: true; data: HubtelQueryItem[]; label: string | null } | { ok: false; error: string; code?: string }

export function createHubtelCsClient(deps: ClientDeps) {
  const now = deps.now ?? (() => new Date())
  const newRef = deps.newRef ?? ((k: HubtelCsServiceKey) => `HCS-${k}-${crypto.randomBytes(8).toString("hex")}`)
  const onTransition = deps.onTransition ?? (async () => {})

  async function gate(serviceKey: HubtelCsServiceKey, opts: { checkPause: boolean }): Promise<HubtelCsConfig> {
    const cfg = await deps.getConfig()
    if (!cfg.enabled) throw new HubtelDisabledError()
    if (!cfg.services[serviceKey]) throw new HubtelServiceDisabledError(serviceKey)
    if (opts.checkPause && cfg.paused) throw new HubtelPausedError(cfg.pausedReason)
    return cfg
  }

  return {
    /** Persist first, then call Hubtel exactly once. Unknown outcomes become needs_review and are never resent. */
    async purchase(input: PurchaseInput): Promise<HubtelCsTx> {
      const svc = getService(input.serviceKey)
      const cfg = await gate(input.serviceKey, { checkPause: true })
      validatePurchase(input)
      if (!deps.callbackSecret || !deps.callbackBaseUrl) {
        throw new HubtelNotConfiguredError([!deps.callbackSecret ? "HUBTEL_CS_CALLBACK_SECRET" : "", !deps.callbackBaseUrl ? "NEXT_PUBLIC_APP_URL" : ""].filter(Boolean))
      }
      const transport = deps.getTransport(cfg.mode) // may throw HubtelNotConfiguredError BEFORE any row exists

      const ref = newRef(input.serviceKey)
      const body = buildPurchaseBody(input, buildCallbackUrl(deps.callbackBaseUrl, ref, deps.callbackSecret), ref)
      const row = await deps.store.insert({
        client_reference: ref, service_key: input.serviceKey, kind: svc.kind, destination: input.destination.trim(),
        amount: Number(input.amount.toFixed(2)), bundle: input.bundle ?? null,
        extra: input.extra ? { email: input.extra.email ?? null, sessionId: input.extra.sessionId ?? null } : null,
        order_table: input.orderTable ?? null, order_id: input.orderId ?? null,
      })

      // The signature is never logged: it alone would let someone forge a callback for this reference.
      const loggedBody = { ...body, CallbackUrl: `${deps.callbackBaseUrl.replace(/\/$/, "")}/api/hubtel-cs/callback?ref=${ref}` }
      await deps.store.logEvent({ client_reference: ref, direction: "request", payload: { serviceKey: input.serviceKey, body: loggedBody } })

      let res: PostResult
      try {
        res = await transport.call({ method: "POST", serviceId: svc.serviceId, body })
      } catch (e: any) {
        res = { error: String(e?.message ?? e) }
      }
      await deps.store.logEvent({
        client_reference: ref, direction: "response",
        http_status: "httpStatus" in res ? res.httpStatus : null, ok: !("error" in res),
        payload: "body" in res ? res.body : null, error: "error" in res ? res.error : null,
      })

      const transition = applyPostResponse(row, res, now())
      const { tx } = await applyAndCommit(deps.store, row, transition, onTransition)
      if ("float" in transition && transition.float) {
        await deps.onFloat("Hubtel returned 4075: insufficient prepaid (Disbursement) balance").catch(e =>
          console.error("[hubtel-cs] onFloat failed:", e))
      }
      return tx
    },

    /** Read-only lookup (bundle list / account or meter details). Not recorded in the ledger. */
    async query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }): Promise<QueryOut> {
      const svc = getService(serviceKey)
      const cfg = await gate(serviceKey, { checkPause: false })
      if (!svc.hasQuery) throw new HubtelValidationError(`${svc.label} has no query endpoint`)
      if (svc.key === "bill_ghana_water" && !params?.mobile) throw new HubtelValidationError("Ghana Water lookup requires the customer's mobile")
      if (!destination || !destination.trim()) throw new HubtelValidationError("destination is required")
      const query: Record<string, string> = { destination: destination.trim() }
      if (params?.mobile) query.mobile = params.mobile.trim()
      const res = await deps.getTransport(cfg.mode).call({ method: "GET", serviceId: svc.serviceId, query })
      if ("error" in res) return { ok: false, error: res.error }
      const b = (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, any>
      if (classifyCode(b.ResponseCode) !== "success") {
        return { ok: false, error: typeof b.Message === "string" && b.Message ? b.Message : `Hubtel code ${b.ResponseCode ?? "none"}`, code: b.ResponseCode != null ? String(b.ResponseCode) : undefined }
      }
      return { ok: true, data: Array.isArray(b.Data) ? (b.Data as HubtelQueryItem[]) : [], label: typeof b.Label === "string" ? b.Label : null }
    },
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/client.test.ts lib/hubtel-cs/transport.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/hubtel-cs/transport.ts lib/hubtel-cs/transport.test.ts lib/hubtel-cs/client.ts lib/hubtel-cs/client.test.ts
git commit -m "feat(hubtel-cs): transport (direct/relay) and persist-before-call client

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Order adapters and admin actions

**Files:**
- Create: `lib/hubtel-cs/adapters.ts`
- Create: `lib/hubtel-cs/admin-actions.ts`
- Test: `lib/hubtel-cs/adapters.test.ts`, `lib/hubtel-cs/admin-actions.test.ts`

**Interfaces:**
- Consumes: Task 2 (`applyStatusCheck`, `applyResolve`), Task 4 (`HubtelCsStore`, `applyAndCommit`), `StatusCheckResult` from `lib/ussd-hubtel/relay.ts` (shape `{ ok: boolean; status?: string; data?: any; error?: string }`).
- Produces:
```ts
export interface OrderAdapter {
  table: string
  onFulfilled(tx: HubtelCsTx): Promise<void>          // must be idempotent
  onFailed(tx: HubtelCsTx): Promise<void>             // must be idempotent
  refundToWallet?(tx: HubtelCsTx, adminId: string): Promise<{ refunded: boolean; message: string }>
}
export function registerOrderAdapter(a: OrderAdapter): void
export function getOrderAdapter(table: string | null): OrderAdapter | undefined
export function clearOrderAdapters(): void                       // tests only
export function notifyAdapter(tx: HubtelCsTx): Promise<void>     // never throws

export interface AdminDeps { store: HubtelCsStore; checkStatus(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>; onTransition(tx: HubtelCsTx): Promise<void>; now?: () => Date }
export function adminCheckStatus(deps: AdminDeps, ref: string): Promise<{ ok: boolean; message: string; tx: HubtelCsTx | null }>
export function adminResolve(deps: AdminDeps, ref: string, outcome: "fulfilled" | "failed", note: string, adminId: string): Promise<{ ok: boolean; message: string; tx: HubtelCsTx | null }>
export function adminRefund(deps: AdminDeps, ref: string, adminId: string): Promise<{ ok: boolean; message: string; tx: HubtelCsTx | null }>
```

- [ ] **Step 1: Write the failing tests**

`lib/hubtel-cs/adapters.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearOrderAdapters, getOrderAdapter, notifyAdapter, registerOrderAdapter } from "./adapters"
import { makeTx } from "./testing/fixtures"

afterEach(() => clearOrderAdapters())

const adapter = () => ({ table: "airtime_orders", onFulfilled: vi.fn(async () => {}), onFailed: vi.fn(async () => {}) })

describe("order adapters", () => {
  it("routes fulfilled and failed rows to the adapter for their order_table", async () => {
    const a = adapter(); registerOrderAdapter(a)
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: "airtime_orders", order_id: "o1" }))
    await notifyAdapter(makeTx({ state: "failed", order_table: "airtime_orders", order_id: "o2" }))
    expect(a.onFulfilled).toHaveBeenCalledTimes(1)
    expect(a.onFailed).toHaveBeenCalledTimes(1)
  })
  it("does nothing for unlinked rows, unknown tables or non-terminal states", async () => {
    const a = adapter(); registerOrderAdapter(a)
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: null }))
    await notifyAdapter(makeTx({ state: "fulfilled", order_table: "other_orders", order_id: "o" }))
    await notifyAdapter(makeTx({ state: "pending", order_table: "airtime_orders", order_id: "o" }))
    expect(a.onFulfilled).not.toHaveBeenCalled()
  })
  it("never throws when an adapter hook throws", async () => {
    const a = { ...adapter(), onFulfilled: vi.fn(async () => { throw new Error("db down") }) }
    registerOrderAdapter(a)
    await expect(notifyAdapter(makeTx({ state: "fulfilled", order_table: "airtime_orders", order_id: "o" }))).resolves.toBeUndefined()
  })
  it("getOrderAdapter looks up by table", () => {
    const a = adapter(); registerOrderAdapter(a)
    expect(getOrderAdapter("airtime_orders")).toBe(a)
    expect(getOrderAdapter(null)).toBeUndefined()
    expect(getOrderAdapter("nope")).toBeUndefined()
  })
})
```

`lib/hubtel-cs/admin-actions.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { adminCheckStatus, adminRefund, adminResolve } from "./admin-actions"
import { clearOrderAdapters, registerOrderAdapter } from "./adapters"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"

afterEach(() => clearOrderAdapters())
const REF = "HCS-airtime_mtn-TESTREF1"

function setup(txOver = {}, check: any = async () => ({ ok: true, status: "Paid", data: { isFulfilled: true } })) {
  const store = createMemoryStore()
  store.seed(makeTx({ client_reference: REF, state: "pending", submitted_at: T0.toISOString(), ...txOver }))
  const onTransition = vi.fn(async () => {})
  return { store, onTransition, deps: { store, checkStatus: check, onTransition, now: () => minutesAfter(12) } }
}

describe("adminCheckStatus", () => {
  it("a Paid + fulfilled answer settles the row and fires the hook", async () => {
    const { deps, store, onTransition } = setup()
    const out = await adminCheckStatus(deps, REF)
    expect(out.ok).toBe(true)
    expect((await store.getByRef(REF))!.state).toBe("fulfilled")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("a relay failure is reported and the row is untouched except attempts", async () => {
    const { deps, store } = setup({}, async () => ({ ok: false, error: "relay not configured" }))
    const out = await adminCheckStatus(deps, REF)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/relay not configured/)
    expect((await store.getByRef(REF))!.state).toBe("pending")
  })
  it("unknown reference", async () => {
    const out = await adminCheckStatus(setup().deps, "NOPE")
    expect(out).toEqual({ ok: false, message: "Unknown reference", tx: null })
  })
})

describe("adminResolve", () => {
  it("resolves a needs_review row and fires the hook", async () => {
    const { deps, store, onTransition } = setup({ state: "needs_review" })
    const out = await adminResolve(deps, REF, "failed", "never delivered", "admin-1")
    expect(out.ok).toBe(true)
    const tx = (await store.getByRef(REF))!
    expect(tx.state).toBe("failed")
    expect(tx.resolved_by).toBe("admin-1")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("requires a note", async () => {
    const { deps } = setup({ state: "needs_review" })
    expect((await adminResolve(deps, REF, "failed", "  ", "admin-1")).ok).toBe(false)
  })
  it("resolving twice the same way is a no-op", async () => {
    const { deps, onTransition } = setup({ state: "needs_review" })
    await adminResolve(deps, REF, "fulfilled", "ok", "admin-1")
    const again = await adminResolve(deps, REF, "fulfilled", "ok", "admin-1")
    expect(again.ok).toBe(false)
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
})

describe("adminRefund", () => {
  it("is refused when no adapter is registered for the row's order table", async () => {
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/no refund handler/i)
  })
  it("only failed rows can be refunded", async () => {
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet: async () => ({ refunded: true, message: "ok" }) })
    const { deps } = setup({ state: "fulfilled", order_table: "airtime_orders", order_id: "o1" })
    expect((await adminRefund(deps, REF, "admin-1")).ok).toBe(false)
  })
  it("delegates to the adapter and returns its message", async () => {
    const refundToWallet = vi.fn(async () => ({ refunded: true, message: "Refunded GHS 5.00 to wallet" }))
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet })
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out).toMatchObject({ ok: true, message: "Refunded GHS 5.00 to wallet" })
    expect(refundToWallet).toHaveBeenCalledTimes(1)
  })
  it("an adapter error is reported, not thrown", async () => {
    registerOrderAdapter({ table: "airtime_orders", onFulfilled: async () => {}, onFailed: async () => {}, refundToWallet: async () => { throw new Error("wallet locked") } })
    const { deps } = setup({ state: "failed", order_table: "airtime_orders", order_id: "o1" })
    const out = await adminRefund(deps, REF, "admin-1")
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/wallet locked/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/hubtel-cs/adapters.test.ts lib/hubtel-cs/admin-actions.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`lib/hubtel-cs/adapters.ts`:
```ts
import type { HubtelCsTx } from "./types"

export interface OrderAdapter {
  /** The `order_table` value this adapter owns (e.g. "airtime_orders"). */
  table: string
  /** Called when a linked ledger row enters `fulfilled`. MUST be idempotent. */
  onFulfilled(tx: HubtelCsTx): Promise<void>
  /** Called when a linked ledger row enters `failed`. MUST be idempotent. Never auto-refunds. */
  onFailed(tx: HubtelCsTx): Promise<void>
  /** Manual refund, only invoked from the admin review queue. */
  refundToWallet?(tx: HubtelCsTx, adminId: string): Promise<{ refunded: boolean; message: string }>
}

const registry = new Map<string, OrderAdapter>()

export function registerOrderAdapter(a: OrderAdapter): void { registry.set(a.table, a) }
export function getOrderAdapter(table: string | null): OrderAdapter | undefined { return table ? registry.get(table) : undefined }
export function clearOrderAdapters(): void { registry.clear() }

/** Route a terminal ledger row to its product. A failing hook must never break a callback or cron. */
export async function notifyAdapter(tx: HubtelCsTx): Promise<void> {
  if (!tx.order_table || !tx.order_id) return
  const adapter = registry.get(tx.order_table)
  if (!adapter) return
  try {
    if (tx.state === "fulfilled") await adapter.onFulfilled(tx)
    else if (tx.state === "failed") await adapter.onFailed(tx)
  } catch (e: any) {
    console.error(`[hubtel-cs] order adapter ${tx.order_table} hook failed for ${tx.client_reference}:`, e?.message ?? e)
  }
}
```

`lib/hubtel-cs/admin-actions.ts`:
```ts
import { getOrderAdapter } from "./adapters"
import { applyAndCommit } from "./apply"
import { applyResolve, applyStatusCheck } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface AdminDeps {
  store: HubtelCsStore
  checkStatus(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
  onTransition(tx: HubtelCsTx): Promise<void>
  now?: () => Date
}
type Out = { ok: boolean; message: string; tx: HubtelCsTx | null }

export async function adminCheckStatus(deps: AdminDeps, ref: string): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  const res = await deps.checkStatus(ref)
  const data = res.data ?? {}
  await deps.store.logEvent({ client_reference: ref, direction: "status_check", ok: res.ok, payload: res.data ?? null, error: res.error ?? null })
  const transition = applyStatusCheck(tx, { ok: res.ok, status: res.status ?? data.status, isFulfilled: data.isFulfilled }, (deps.now ?? (() => new Date()))())
  const out = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  if (!res.ok) return { ok: false, message: `Status check failed: ${res.error ?? "unknown error"}`, tx: out.tx }
  return { ok: true, message: `Hubtel says: ${res.status ?? data.status ?? "unknown"} (fulfilled: ${String(data.isFulfilled ?? "unknown")}). Row is ${out.tx.state}.`, tx: out.tx }
}

export async function adminResolve(deps: AdminDeps, ref: string, outcome: "fulfilled" | "failed", note: string, adminId: string): Promise<Out> {
  if (!note || !note.trim()) return { ok: false, message: "A note is required", tx: null }
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  const transition = applyResolve(tx, outcome, note.trim(), adminId, (deps.now ?? (() => new Date()))())
  if ("ignored" in transition) return { ok: false, message: transition.ignored, tx }
  const out = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
  return out.changed ? { ok: true, message: `Marked ${outcome}`, tx: out.tx } : { ok: false, message: "The row changed while resolving; reload and retry", tx: out.tx }
}

export async function adminRefund(deps: AdminDeps, ref: string, adminId: string): Promise<Out> {
  const tx = await deps.store.getByRef(ref)
  if (!tx) return { ok: false, message: "Unknown reference", tx: null }
  if (tx.state !== "failed") return { ok: false, message: "Only failed transactions can be refunded", tx }
  const adapter = getOrderAdapter(tx.order_table)
  if (!adapter?.refundToWallet || !tx.order_id) return { ok: false, message: "No refund handler is registered for this order type", tx }
  try {
    const r = await adapter.refundToWallet(tx, adminId)
    return { ok: r.refunded, message: r.message, tx }
  } catch (e: any) {
    return { ok: false, message: `Refund failed: ${e?.message ?? e}`, tx }
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run lib/hubtel-cs/adapters.test.ts lib/hubtel-cs/admin-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/adapters.ts lib/hubtel-cs/adapters.test.ts lib/hubtel-cs/admin-actions.ts lib/hubtel-cs/admin-actions.test.ts
git commit -m "feat(hubtel-cs): order-adapter registry and manual admin actions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Float safety and the status-check runner

**Files:**
- Create: `lib/hubtel-cs/float.ts`
- Create: `lib/hubtel-cs/float-alert.ts`
- Create: `lib/hubtel-cs/status-runner.ts`
- Test: `lib/hubtel-cs/float.test.ts`, `lib/hubtel-cs/status-runner.test.ts`

**Interfaces:**
- Consumes: Task 2 (`applyStatusCheck`, `sweepStale`), Task 4 (store, `applyAndCommit`), `fetchDisbursementBalance` shape from `lib/ussd-hubtel/relay.ts`: `Promise<{ ok: true; amountGhs: number } | { ok: false; error: string }>`.
- Produces:
```ts
// float.ts
export interface FloatDeps { setPaused(reason: string): Promise<unknown>; alert(kind: "paused" | "low_balance", subject: string, message: string): Promise<void> }
export function pauseForFloat(deps: FloatDeps, reason: string): Promise<void>
export function checkLowBalance(deps: { threshold: number | null; fetchBalance(): Promise<{ ok: true; amountGhs: number } | { ok: false; error: string }>; alert: FloatDeps["alert"] }):
  Promise<{ checked: boolean; low?: boolean; balance?: number; error?: string }>
// float-alert.ts
export const FLOAT_ALERT_DEBOUNCE_MS: number
export function shouldSendAlert(lastIso: string | null | undefined, now: Date, windowMs?: number): boolean
export function sendFloatAlert(db: SupabaseClient, kind: "paused" | "low_balance", subject: string, message: string): Promise<void>
// status-runner.ts
export interface RunDeps { store: HubtelCsStore; check(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>; onTransition(tx: HubtelCsTx): Promise<void>; now?: () => Date; deadlineMs: number; batch?: number }
export function runHubtelCsStatusChecks(deps: RunDeps): Promise<{ swept: number; checked: number; fulfilled: number; failed: number; needsReview: number; errors: number }>
```

- [ ] **Step 1: Write the failing tests**

`lib/hubtel-cs/float.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest"
import { checkLowBalance, pauseForFloat } from "./float"
import { shouldSendAlert } from "./float-alert"

describe("pauseForFloat", () => {
  it("pauses the service and alerts admins, mentioning the shared SMS float", async () => {
    const setPaused = vi.fn(async () => {})
    const alert = vi.fn(async () => {})
    await pauseForFloat({ setPaused, alert }, "Hubtel returned 4075")
    expect(setPaused).toHaveBeenCalledWith("Hubtel returned 4075")
    expect(alert).toHaveBeenCalledTimes(1)
    const [kind, subject, message] = alert.mock.calls[0] as unknown as [string, string, string]
    expect(kind).toBe("paused")
    expect(subject).toMatch(/paused/i)
    expect(message).toMatch(/SMS/)
  })
  it("still alerts when setting the pause throws", async () => {
    const alert = vi.fn(async () => {})
    await pauseForFloat({ setPaused: async () => { throw new Error("db") }, alert }, "x")
    expect(alert).toHaveBeenCalledTimes(1)
  })
})

describe("checkLowBalance", () => {
  const mk = (balance: any, threshold: number | null = 100) => {
    const alert = vi.fn(async () => {})
    return { alert, run: () => checkLowBalance({ threshold, fetchBalance: async () => balance, alert }) }
  }
  it("does nothing when no threshold is configured", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 1 }, null)
    expect(await run()).toEqual({ checked: false })
    expect(alert).not.toHaveBeenCalled()
  })
  it("alerts when the balance is below the threshold", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 40.5 })
    expect(await run()).toEqual({ checked: true, low: true, balance: 40.5 })
    expect(alert).toHaveBeenCalledTimes(1)
    expect((alert.mock.calls[0] as unknown as string[])[0]).toBe("low_balance")
  })
  it("stays quiet at or above the threshold", async () => {
    const { run, alert } = mk({ ok: true, amountGhs: 100 })
    expect(await run()).toEqual({ checked: true, low: false, balance: 100 })
    expect(alert).not.toHaveBeenCalled()
  })
  it("a balance fetch error is reported without alerting", async () => {
    const { run, alert } = mk({ ok: false, error: "relay/hubtel 501" })
    expect(await run()).toEqual({ checked: false, error: "relay/hubtel 501" })
    expect(alert).not.toHaveBeenCalled()
  })
})

describe("shouldSendAlert (1h debounce)", () => {
  const now = new Date("2026-10-13T12:00:00.000Z")
  it("sends when never sent or invalid", () => {
    expect(shouldSendAlert(null, now)).toBe(true)
    expect(shouldSendAlert(undefined, now)).toBe(true)
    expect(shouldSendAlert("garbage", now)).toBe(true)
  })
  it("suppresses within an hour, sends after", () => {
    expect(shouldSendAlert("2026-10-13T11:30:00.000Z", now)).toBe(false)
    expect(shouldSendAlert("2026-10-13T10:59:59.000Z", now)).toBe(true)
  })
})
```

`lib/hubtel-cs/status-runner.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest"
import { runHubtelCsStatusChecks } from "./status-runner"
import { createMemoryStore } from "./testing/memory-store"
import { makeTx, minutesAfter, T0 } from "./testing/fixtures"

const PAID = async () => ({ ok: true, status: "Paid", data: { status: "Paid", isFulfilled: true } })
const UNPAID = async () => ({ ok: true, status: "Unpaid", data: { status: "Unpaid", isFulfilled: false } })

function run(store: any, check: any, minutes: number, extra: any = {}) {
  const onTransition = vi.fn(async () => {})
  return {
    onTransition,
    out: runHubtelCsStatusChecks({ store, check, onTransition, now: () => minutesAfter(minutes), deadlineMs: Date.now() + 60_000, ...extra }),
  }
}

describe("runHubtelCsStatusChecks", () => {
  it("sweeps created rows older than 2 minutes to needs_review", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "created" }))
    const { out } = run(store, PAID, 3)
    expect((await out).swept).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("needs_review")
  })
  it("settles an old pending row when Hubtel says Paid + fulfilled, and fires the hook", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const { out, onTransition } = run(store, PAID, 6)
    expect((await out).fulfilled).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("fulfilled")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("does not check pending rows younger than 5 minutes", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const check = vi.fn(PAID)
    const { out } = run(store, check, 4)
    expect((await out).checked).toBe(0)
    expect(check).not.toHaveBeenCalled()
  })
  it("fails a row only after two consecutive negatives across runs, once 10 minutes old", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    await run(store, UNPAID, 12).out
    expect((await store.getByRef("A"))!.state).toBe("pending")
    await run(store, UNPAID, 15).out
    expect((await store.getByRef("A"))!.state).toBe("failed")
  })
  it("skips rows checked in the last 90 seconds", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString(), last_status_check_at: minutesAfter(11).toISOString() }))
    const check = vi.fn(PAID)
    await run(store, check, 12).out
    expect(check).not.toHaveBeenCalled()
  })
  it("pending rows still reconcile while the service is paused (the runner never reads the pause)", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    expect((await run(store, PAID, 6).out).fulfilled).toBe(1)
  })
  it("counts check errors and leaves the row pending", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    const out = await run(store, async () => ({ ok: false, error: "relay down" }), 6).out
    expect(out.errors).toBe(1)
    expect((await store.getByRef("A"))!.state).toBe("pending")
    expect((await store.getByRef("A"))!.status_check_attempts).toBe(1)
  })
  it("stops starting new rows once the deadline passes", async () => {
    const store = createMemoryStore()
    for (const id of ["a", "b", "c"]) store.seed(makeTx({ id, client_reference: id.toUpperCase(), state: "pending", submitted_at: T0.toISOString() }))
    const check = vi.fn(PAID)
    const out = await run(store, check, 6, { deadlineMs: Date.now() - 1 }).out
    expect(out.checked).toBe(0)
    expect(check).not.toHaveBeenCalled()
  })
  it("logs each check as a status_check event", async () => {
    const store = createMemoryStore()
    store.seed(makeTx({ id: "a", client_reference: "A", state: "pending", submitted_at: T0.toISOString() }))
    await run(store, PAID, 6).out
    expect(store.events.some(e => e.direction === "status_check" && e.client_reference === "A")).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/hubtel-cs/float.test.ts lib/hubtel-cs/status-runner.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`lib/hubtel-cs/float.ts`:
```ts
export interface FloatDeps {
  setPaused(reason: string): Promise<unknown>
  alert(kind: "paused" | "low_balance", subject: string, message: string): Promise<void>
}

const SHARED = "The Hubtel Disbursement (prepaid) balance is shared with Hubtel SMS, so SMS credit sales can stall too. Top up the Disbursement account."

/** 4075 handler: stop taking new Hubtel orders and tell the admins. Pending rows keep reconciling. */
export async function pauseForFloat(deps: FloatDeps, reason: string): Promise<void> {
  try { await deps.setPaused(reason) } catch (e: any) { console.error("[hubtel-cs] could not set pause:", e?.message ?? e) }
  await deps.alert("paused", "Hubtel Commission Services paused - prepaid balance exhausted", `${reason}. New Hubtel orders are blocked until an admin resumes the service. ${SHARED}`)
    .catch(e => console.error("[hubtel-cs] pause alert failed:", e?.message ?? e))
}

export async function checkLowBalance(deps: {
  threshold: number | null
  fetchBalance(): Promise<{ ok: true; amountGhs: number } | { ok: false; error: string }>
  alert: FloatDeps["alert"]
}): Promise<{ checked: boolean; low?: boolean; balance?: number; error?: string }> {
  if (deps.threshold === null) return { checked: false }
  const bal = await deps.fetchBalance()
  if (!bal.ok) return { checked: false, error: bal.error }
  const low = bal.amountGhs < deps.threshold
  if (low) {
    await deps.alert("low_balance", "Hubtel prepaid balance is low",
      `Balance is GHS ${bal.amountGhs.toFixed(2)} (threshold GHS ${deps.threshold.toFixed(2)}). ${SHARED}`)
      .catch(e => console.error("[hubtel-cs] low-balance alert failed:", e?.message ?? e))
  }
  return { checked: true, low, balance: bal.amountGhs }
}
```

`lib/hubtel-cs/float-alert.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js"

export const FLOAT_ALERT_DEBOUNCE_MS = 3_600_000

export function shouldSendAlert(lastIso: string | null | undefined, now: Date, windowMs = FLOAT_ALERT_DEBOUNCE_MS): boolean {
  if (!lastIso) return true
  const last = Date.parse(lastIso)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= windowMs
}

/** SMS + email to admins via the same notifyAdmins() path as the MTN balance alert; debounced per kind. */
export async function sendFloatAlert(db: SupabaseClient, kind: "paused" | "low_balance", subject: string, message: string): Promise<void> {
  const key = `last_hubtel_cs_alert_${kind}`
  const { data } = await db.from("admin_settings").select("value").eq("key", key).maybeSingle()
  const now = new Date()
  if (!shouldSendAlert(data?.value?.timestamp, now)) return
  // Stamp first so two concurrent runs cannot both alert.
  await db.from("admin_settings").upsert({ key, value: { timestamp: now.toISOString() }, description: "Hubtel Commission Services alert debounce", updated_at: now.toISOString() }, { onConflict: "key" })

  const { notifyAdmins: sms } = await import("@/lib/sms-service")
  await sms(`HUBTEL ALERT\n\n${subject}\n${message}`, "balance_alert", "hubtel_cs_float", true).catch(e => console.error("[hubtel-cs] alert SMS error:", e))
  const { notifyAdmins: email } = await import("@/lib/email-service")
  const html = `<div><h2 style="color:#dc2626">${subject}</h2><p>${message}</p></div>`
  await email(subject, html).catch(e => console.error("[hubtel-cs] alert email error:", e))
}
```

`lib/hubtel-cs/status-runner.ts`:
```ts
import { applyAndCommit } from "./apply"
import { applyStatusCheck, sweepStale, CREATED_STALE_MS } from "./state-machine"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface RunDeps {
  store: HubtelCsStore
  check(ref: string): Promise<{ ok: boolean; status?: string; data?: any; error?: string }>
  onTransition(tx: HubtelCsTx): Promise<void>
  now?: () => Date
  deadlineMs: number
  batch?: number
}

/** Hubtel makes the status check mandatory for pending rows older than 5 minutes. */
const MIN_PENDING_AGE_MS = 5 * 60_000
/** Do not re-check a row more often than the 2-minute cron cadence allows. */
const RECHECK_GAP_MS = 90_000

export async function runHubtelCsStatusChecks(deps: RunDeps) {
  const now = deps.now ?? (() => new Date())
  const out = { swept: 0, checked: 0, fulfilled: 0, failed: 0, needsReview: 0, errors: 0 }

  // 1. rows whose request never completed (process died between insert and the Hubtel reply)
  const stale = await deps.store.listByStates(["created"], { olderThan: new Date(now().getTime() - CREATED_STALE_MS).toISOString(), limit: 100 })
  for (const tx of stale) {
    const r = await applyAndCommit(deps.store, tx, sweepStale(tx, now()), deps.onTransition)
    if (r.changed) out.swept++
  }

  // 2. pending rows older than 5 minutes, least-recently-checked first
  const pending = await deps.store.listByStates(["pending"], {
    olderThan: new Date(now().getTime() - MIN_PENDING_AGE_MS).toISOString(),
    limit: deps.batch ?? 50, orderBy: "last_status_check_at",
  })
  for (const tx of pending) {
    if (Date.now() >= deps.deadlineMs) break
    if (tx.last_status_check_at && now().getTime() - Date.parse(tx.last_status_check_at) < RECHECK_GAP_MS) continue
    const res = await deps.check(tx.client_reference)
    out.checked++
    if (!res.ok) out.errors++
    await deps.store.logEvent({ client_reference: tx.client_reference, direction: "status_check", ok: res.ok, payload: res.data ?? null, error: res.error ?? null })
    const data = res.data ?? {}
    const transition = applyStatusCheck(tx, { ok: res.ok, status: res.status ?? data.status, isFulfilled: data.isFulfilled }, now())
    const r = await applyAndCommit(deps.store, tx, transition, deps.onTransition)
    if (r.changed && r.tx.state !== tx.state) {
      if (r.tx.state === "fulfilled") out.fulfilled++
      else if (r.tx.state === "failed") out.failed++
      else if (r.tx.state === "needs_review") out.needsReview++
    }
  }
  return out
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run lib/hubtel-cs/float.test.ts lib/hubtel-cs/status-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/float.ts lib/hubtel-cs/float-alert.ts lib/hubtel-cs/float.test.ts lib/hubtel-cs/status-runner.ts lib/hubtel-cs/status-runner.test.ts
git commit -m "feat(hubtel-cs): float pause/alerts and status-check runner

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Runtime wiring, callback route, cron route

**Files:**
- Create: `lib/hubtel-cs/runtime.ts`
- Create: `app/api/hubtel-cs/callback/route.ts`
- Create: `app/api/cron/hubtel-cs-status-check/route.ts`
- Modify: `vercel.json` (add the cron)

**Interfaces:**
- Consumes: everything from Tasks 1–9; `supabaseAdmin` from `@/lib/supabase`; `checkTransactionStatus`, `fetchDisbursementBalance` from `@/lib/ussd-hubtel/relay`; `verifyCronAuth` from `@/lib/cron-auth`.
- Produces: `getHubtelCsRuntime(): { db; store; getConfig; client; onTransition; floatDeps; adminDeps; checkStatus; fetchBalance }` used by every route.

(Route files are thin and wired to real services, so they are verified by `tsc` + `next build` in Task 14 rather than unit tests; all their logic is already covered in Tasks 4–9.)

- [ ] **Step 1: Create `lib/hubtel-cs/runtime.ts`**

```ts
import { supabaseAdmin } from "@/lib/supabase"
import { checkTransactionStatus, fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"
import { notifyAdapter } from "./adapters"
import type { AdminDeps } from "./admin-actions"
import { createHubtelCsClient } from "./client"
import { getHubtelCsConfig, setHubtelCsPaused } from "./config"
import { pauseForFloat, type FloatDeps } from "./float"
import { sendFloatAlert } from "./float-alert"
import { createSupabaseHubtelCsStore } from "./store"
import { transportFromEnv } from "./transport"

/** Single place that wires the pure hubtel-cs modules to Supabase, env and the relay. */
export function getHubtelCsRuntime() {
  const db = supabaseAdmin
  const store = createSupabaseHubtelCsStore(db)
  const getConfig = () => getHubtelCsConfig(db)
  const floatDeps: FloatDeps = {
    setPaused: reason => setHubtelCsPaused(db, reason),
    alert: (kind, subject, message) => sendFloatAlert(db, kind, subject, message),
  }
  const client = createHubtelCsClient({
    store, getConfig,
    getTransport: mode => transportFromEnv(mode),
    callbackBaseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
    callbackSecret: process.env.HUBTEL_CS_CALLBACK_SECRET ?? "",
    onFloat: reason => pauseForFloat(floatDeps, reason),
    onTransition: notifyAdapter,
  })
  const adminDeps: AdminDeps = { store, checkStatus: checkTransactionStatus, onTransition: notifyAdapter }
  return {
    db, store, getConfig, client, floatDeps, adminDeps,
    onTransition: notifyAdapter,
    checkStatus: checkTransactionStatus,
    fetchBalance: fetchDisbursementBalance,
  }
}
```

- [ ] **Step 2: Create `app/api/hubtel-cs/callback/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server"
import { clientIpFromForwardedFor, processCallback } from "@/lib/hubtel-cs/callback"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const maxDuration = 30

/** Hubtel Commission Services final callback. Authenticated by the per-transaction HMAC in the URL. */
export async function POST(request: NextRequest) {
  const rt = getHubtelCsRuntime()
  const url = new URL(request.url)
  const out = await processCallback(
    {
      store: rt.store,
      secret: process.env.HUBTEL_CS_CALLBACK_SECRET ?? "",
      enforceIp: process.env.HUBTEL_CS_ENFORCE_CALLBACK_IP === "true",
      onTransition: rt.onTransition,
    },
    {
      ref: url.searchParams.get("ref"),
      sig: url.searchParams.get("sig"),
      ip: clientIpFromForwardedFor(request.headers.get("x-forwarded-for")),
      rawBody: await request.text(),
    }
  )
  return NextResponse.json(out.body, { status: out.status })
}
```

- [ ] **Step 3: Create `app/api/cron/hubtel-cs-status-check/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { checkLowBalance } from "@/lib/hubtel-cs/float"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { runHubtelCsStatusChecks } from "@/lib/hubtel-cs/status-runner"

export const maxDuration = 300

/** Stop starting new rows well before maxDuration; the next run picks up the rest. */
const TIME_BUDGET_MS = 240_000
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const rt = getHubtelCsRuntime()

  // Runs even while paused or disabled: rows already in flight must still settle.
  const result = await runHubtelCsStatusChecks({
    store: rt.store, check: rt.checkStatus, onTransition: rt.onTransition, deadlineMs: Date.now() + TIME_BUDGET_MS,
  })
  await rt.store.purgeEventsOlderThan(new Date(Date.now() - EVENT_RETENTION_MS).toISOString())

  let balance: Awaited<ReturnType<typeof checkLowBalance>> = { checked: false }
  try {
    const cfg = await rt.getConfig()
    if (cfg.enabled) balance = await checkLowBalance({ threshold: cfg.lowBalanceThreshold, fetchBalance: rt.fetchBalance, alert: rt.floatDeps.alert })
  } catch (e: any) {
    console.error("[hubtel-cs] low-balance check failed:", e?.message ?? e)
  }
  return NextResponse.json({ ...result, balance })
}
```

- [ ] **Step 4: Add the cron to `vercel.json`** — insert after the existing `hubtel-status-check` entry:

Old:
```json
    {
      "path": "/api/cron/hubtel-status-check",
      "schedule": "*/2 * * * *"
    },
```
New:
```json
    {
      "path": "/api/cron/hubtel-status-check",
      "schedule": "*/2 * * * *"
    },
    {
      "path": "/api/cron/hubtel-cs-status-check",
      "schedule": "*/2 * * * *"
    },
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (fix any type issues in the new files).

- [ ] **Step 6: Commit**

```bash
git add lib/hubtel-cs/runtime.ts app/api/hubtel-cs/callback/route.ts app/api/cron/hubtel-cs-status-check/route.ts vercel.json
git commit -m "feat(hubtel-cs): runtime wiring, callback route and status-check cron

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Relay `/cs` passthrough (optional fallback transport)

**Files:**
- Modify: `lib/ussd-hubtel/relay-handler.ts`
- Modify: `scripts/hubtel-relay/server.ts`
- Modify: `scripts/hubtel-relay/README.md`
- Test: `lib/ussd-hubtel/relay-handler.cs.test.ts`

**Interfaces:**
- Consumes: existing `RelayConfig` (`disbursementAccount?`), `createRelayHandler`.
- Produces: `RelayConfig.csBasicAuth?: string`, `RelayConfig.csBaseUrl?: string`; handler routes `GET|POST /cs/<32-hex serviceId>` → `https://cs.hubtel.com/commissionservices/<disbursementAccount>/<serviceId>`. GET forwards only `destination` and `mobile`; POST forwards the JSON body unchanged. Returns the standard envelope `{ ok, upstreamStatus, body }`. `501` when not configured.

- [ ] **Step 1: Write the failing test** — `lib/ussd-hubtel/relay-handler.cs.test.ts`

```ts
import { describe, expect, it, vi } from "vitest"
import { createRelayHandler } from "./relay-handler"

const SID = "fdd76c884e614b1c8f669a3207b09a98"
const mk = (over: any = {}, fetchImpl?: any) =>
  createRelayHandler({
    secret: "rs", collectionAccount: "11684", statusBasicAuth: "STATUS",
    disbursementAccount: "11691", csBasicAuth: "CSAUTH",
    fetchImpl: fetchImpl ?? vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 })),
    ...over,
  })
const req = (over: any = {}) => ({ method: "POST", path: `/cs/${SID}`, query: new URLSearchParams(), authorization: "Bearer rs", body: JSON.stringify({ Amount: 1 }), ...over })

describe("relay /cs passthrough", () => {
  it("401 without the bearer secret", async () => {
    expect((await mk()(req({ authorization: null }))).status).toBe(401)
  })
  it("501 when the CS credential or disbursement account is not configured", async () => {
    expect((await mk({ csBasicAuth: undefined })(req())).status).toBe(501)
    expect((await mk({ disbursementAccount: undefined })(req())).status).toBe(501)
  })
  it("POST forwards the body to cs.hubtel.com with the CS credential", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0001" }), { status: 200 }))
    const out = await mk({}, f)(req())
    expect(out).toEqual({ status: 200, body: { ok: true, upstreamStatus: 200, body: { ResponseCode: "0001" } } })
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://cs.hubtel.com/commissionservices/11691/${SID}`)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Basic CSAUTH")
    expect(JSON.parse(init.body)).toEqual({ Amount: 1 })
  })
  it("GET forwards only destination and mobile", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ResponseCode: "0000" }), { status: 200 }))
    await mk({}, f)(req({ method: "GET", body: "", query: new URLSearchParams("destination=233246912184&mobile=233242825109&evil=1&x=y") }))
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe(`https://cs.hubtel.com/commissionservices/11691/${SID}?destination=233246912184&mobile=233242825109`)
    expect(init.body).toBeUndefined()
  })
  it("rejects a service id that is not 32 hex chars (no open proxy)", async () => {
    expect((await mk()(req({ path: "/cs/../../etc" }))).status).toBe(404)
    expect((await mk()(req({ path: "/cs/ABC" }))).status).toBe(404)
    expect((await mk()(req({ path: `/cs/${SID}/extra` }))).status).toBe(404)
  })
  it("POST with a non-object / invalid json body -> 400", async () => {
    expect((await mk()(req({ body: "{nope" }))).status).toBe(400)
    expect((await mk()(req({ body: "[1,2]" }))).status).toBe(400)
  })
  it("an upstream network error is reported as upstreamStatus 0 (never throws)", async () => {
    const out = await mk({}, async () => { throw new Error("ECONNRESET") })(req())
    expect(out).toEqual({ status: 200, body: { ok: false, upstreamStatus: 0, body: "ECONNRESET" } })
  })
  it("only GET and POST are allowed", async () => {
    expect((await mk()(req({ method: "DELETE" }))).status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/relay-handler.cs.test.ts`
Expected: FAIL (the `/cs` route returns 404 for the valid cases).

- [ ] **Step 3: Implement** — edit `lib/ussd-hubtel/relay-handler.ts`

3a. In `interface RelayConfig`, after `balanceBaseUrl?: string`, add:
```ts
  /** Basic credential for Commission Services (cs.hubtel.com); required for the /cs passthrough. */
  csBasicAuth?: string
  csBaseUrl?: string
```
3b. Under `const SAFE_REF = ...` add:
```ts
const CS_PATH = /^\/cs\/([a-f0-9]{32})$/
const CS_QUERY_KEYS = ["destination", "mobile"] as const
const CS_QUERY_VALUE = /^[A-Za-z0-9+_-]{1,40}$/
```
3c. In `createRelayHandler`, after `const balanceBase = ...` add `const csBase = (cfg.csBaseUrl ?? "https://cs.hubtel.com/commissionservices").replace(/\/$/, "")`.
3d. Just before the final `return { status: 404, body: { error: "not found" } }`, insert:
```ts
    const cs = CS_PATH.exec(req.path)
    if (cs && (req.method === "GET" || req.method === "POST")) {
      if (!cfg.disbursementAccount || !cfg.csBasicAuth) return { status: 501, body: { error: "cs not configured" } }
      let url = `${csBase}/${encodeURIComponent(cfg.disbursementAccount)}/${cs[1]}`
      let body: string | undefined
      if (req.method === "GET") {
        const q = new URLSearchParams()
        for (const k of CS_QUERY_KEYS) {
          const v = req.query.get(k)
          if (v !== null) {
            if (!CS_QUERY_VALUE.test(v)) return { status: 400, body: { error: `invalid ${k}` } }
            q.set(k, v)
          }
        }
        if ([...q].length) url += `?${q.toString()}`
      } else {
        let parsed: unknown
        try { parsed = JSON.parse(req.body) } catch { return { status: 400, body: { error: "invalid json" } } }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, body: { error: "json object required" } }
        body = JSON.stringify(parsed)
      }
      try {
        const res = await doFetch(url, {
          method: req.method,
          headers: { Authorization: `Basic ${cfg.csBasicAuth}`, Accept: "application/json", "Content-Type": "application/json" },
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }
```
3e. In the header comment change "three outbound calls" to "four outbound calls".

3f. `scripts/hubtel-relay/server.ts`: in the `createRelayHandler({ ... })` call, after the `disbursementAccount` line add:
```ts
  csBasicAuth: process.env.HUBTEL_CS_BASIC_AUTH || undefined,
```
3g. `scripts/hubtel-relay/README.md`: after the line documenting `HUBTEL_DISBURSEMENT_ACCOUNT` (line ~42) add:
```
- `HUBTEL_CS_BASIC_AUTH` — base64 `clientId:secret` for Hubtel Commission Services. Optional; only needed for `mode: relay` (the `/cs/<serviceId>` passthrough to cs.hubtel.com, using `HUBTEL_DISBURSEMENT_ACCOUNT`). Without it `/cs` answers 501. In the default `direct` mode Vercel calls cs.hubtel.com itself.
```

- [ ] **Step 4: Run to verify it passes and nothing regressed**

Run: `npx vitest run lib/ussd-hubtel/`
Expected: PASS (existing relay-handler tests + new `/cs` tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/relay-handler.ts lib/ussd-hubtel/relay-handler.cs.test.ts scripts/hubtel-relay/server.ts scripts/hubtel-relay/README.md
git commit -m "feat(hubtel-relay): optional /cs passthrough to Commission Services

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Admin API routes

**Files:**
- Create: `lib/hubtel-cs/admin-route.ts`
- Create: `app/api/admin/hubtel-cs/config/route.ts`
- Create: `app/api/admin/hubtel-cs/transactions/route.ts`
- Create: `app/api/admin/hubtel-cs/check-status/route.ts`
- Create: `app/api/admin/hubtel-cs/resolve/route.ts`
- Create: `app/api/admin/hubtel-cs/refund/route.ts`
- Create: `app/api/admin/hubtel-cs/test-purchase/route.ts`
- Test: `lib/hubtel-cs/admin-route.test.ts`

**Interfaces:**
- Consumes: `verifyAdminAccess` (`@/lib/admin-auth`) — returns `{ isAdmin, userId?, errorResponse? }`; a rate-limited admin has `isAdmin: true` AND `errorResponse` (must be honoured). Runtime from Task 10. Config helpers from Task 5.
- Produces: `requireAdmin(request): Promise<{ ok: true; userId?: string } | { ok: false; response: NextResponse }>`; `clampPage(searchParams): { limit: number; offset: number }` (limit 1–100, default 25); `TEST_PURCHASE_MAX_GHS = 5`; `describeError(e): { status: number; error: string }` mapping Hubtel errors to HTTP codes.

- [ ] **Step 1: Write the failing test** — `lib/hubtel-cs/admin-route.test.ts`

```ts
import { describe, expect, it } from "vitest"
import { TEST_PURCHASE_MAX_GHS, clampPage, describeError } from "./admin-route"
import {
  HubtelDisabledError, HubtelNotConfiguredError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"

describe("clampPage", () => {
  it("defaults and clamps limit/offset", () => {
    expect(clampPage(new URLSearchParams())).toEqual({ limit: 25, offset: 0 })
    expect(clampPage(new URLSearchParams("limit=500&offset=-4"))).toEqual({ limit: 100, offset: 0 })
    expect(clampPage(new URLSearchParams("limit=0&offset=10"))).toEqual({ limit: 1, offset: 10 })
    expect(clampPage(new URLSearchParams("limit=abc&offset=xyz"))).toEqual({ limit: 25, offset: 0 })
  })
})

describe("describeError", () => {
  it("maps Hubtel errors to client-safe statuses", () => {
    expect(describeError(new HubtelValidationError("bad"))).toEqual({ status: 400, error: "bad" })
    expect(describeError(new HubtelDisabledError()).status).toBe(409)
    expect(describeError(new HubtelServiceDisabledError("airtime_mtn")).status).toBe(409)
    expect(describeError(new HubtelPausedError("4075")).status).toBe(409)
    expect(describeError(new HubtelNotConfiguredError(["X"])).status).toBe(503)
  })
  it("hides unexpected error details behind a generic 500", () => {
    expect(describeError(new Error("secret db password in message"))).toEqual({ status: 500, error: "Internal error" })
  })
})

it("test purchases are capped at GHS 5", () => {
  expect(TEST_PURCHASE_MAX_GHS).toBe(5)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run lib/hubtel-cs/admin-route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/hubtel-cs/admin-route.ts`

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  HubtelDisabledError, HubtelNotConfiguredError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError,
} from "./errors"

export const TEST_PURCHASE_MAX_GHS = 5

/** A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it. */
export async function requireAdmin(request: NextRequest): Promise<{ ok: true; userId?: string } | { ok: false; response: NextResponse }> {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) {
    return { ok: false, response: errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 }) }
  }
  return { ok: true, userId }
}

export function clampPage(sp: URLSearchParams): { limit: number; offset: number } {
  const n = (v: string | null, d: number) => { const x = Number.parseInt(v ?? "", 10); return Number.isFinite(x) ? x : d }
  return { limit: Math.min(100, Math.max(1, n(sp.get("limit"), 25))), offset: Math.max(0, n(sp.get("offset"), 0)) }
}

export function describeError(e: unknown): { status: number; error: string } {
  if (e instanceof HubtelValidationError) return { status: 400, error: e.message }
  if (e instanceof HubtelDisabledError || e instanceof HubtelServiceDisabledError || e instanceof HubtelPausedError) return { status: 409, error: (e as Error).message }
  if (e instanceof HubtelNotConfiguredError) return { status: 503, error: e.message }
  console.error("[hubtel-cs] admin route error:", e)
  return { status: 500, error: "Internal error" }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run lib/hubtel-cs/admin-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the six route files** (thin; verified by tsc/build and the manual checks in Task 14)

`app/api/admin/hubtel-cs/config/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { requireAdmin, describeError } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsConfig, hubtelCsEnvReady, setHubtelCsConfig, validateConfigPatch } from "@/lib/hubtel-cs/config"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS } from "@/lib/hubtel-cs/services"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  try {
    const { db } = getHubtelCsRuntime()
    const config = await getHubtelCsConfig(db)
    return NextResponse.json({
      config,
      env: hubtelCsEnvReady(config.mode),
      services: HUBTEL_CS_SERVICE_KEYS.map(k => ({ key: k, label: HUBTEL_CS_SERVICES[k].label, kind: HUBTEL_CS_SERVICES[k].kind })),
    })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const v = validateConfigPatch(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    const { db } = getHubtelCsRuntime()
    const before = await getHubtelCsConfig(db)
    const nextMode = v.patch.mode ?? before.mode
    if (v.patch.enabled === true) {
      const env = hubtelCsEnvReady(nextMode)
      if (!env.ready) return NextResponse.json({ error: `Cannot enable: missing ${env.missing.join(", ")}` }, { status: 400 })
    }
    const config = await setHubtelCsConfig(db, v.patch)
    db.from("admin_audit_log").insert([{
      admin_id: auth.userId, action: "hubtel_cs_config_update", target_user_id: null,
      old_value: before, new_value: config, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel cs config log failed:", error.message) })
    return NextResponse.json({ config })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

`app/api/admin/hubtel-cs/transactions/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { getOrderAdapter } from "@/lib/hubtel-cs/adapters"
import { clampPage, describeError, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import type { HubtelCsState } from "@/lib/hubtel-cs/types"

const STATES = new Set(["created", "pending", "fulfilled", "failed", "needs_review"])

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = new URL(request.url).searchParams
  const stateParam = sp.get("state")
  const state = stateParam === "attention" ? "attention" : stateParam && STATES.has(stateParam) ? (stateParam as HubtelCsState) : undefined
  try {
    const { store } = getHubtelCsRuntime()
    const [{ rows, total }, stats] = await Promise.all([
      store.listForAdmin({ state, q: sp.get("q") ?? undefined, ...clampPage(sp) }),
      store.stats(),
    ])
    return NextResponse.json({
      rows: rows.map(r => ({ ...r, refundable: r.state === "failed" && !!r.order_id && !!getOrderAdapter(r.order_table)?.refundToWallet })),
      total, stats,
    })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

`app/api/admin/hubtel-cs/check-status/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminCheckStatus } from "@/lib/hubtel-cs/admin-actions"
import { describeError, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.ref !== "string" || !body.ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  try {
    const out = await adminCheckStatus(getHubtelCsRuntime().adminDeps, body.ref)
    return NextResponse.json(out, { status: out.tx ? 200 : 404 })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

`app/api/admin/hubtel-cs/resolve/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminResolve } from "@/lib/hubtel-cs/admin-actions"
import { describeError, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to resolve" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.ref !== "string" || !body.ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  if (body.outcome !== "fulfilled" && body.outcome !== "failed") return NextResponse.json({ error: "outcome must be 'fulfilled' or 'failed'" }, { status: 400 })
  try {
    const rt = getHubtelCsRuntime()
    const out = await adminResolve(rt.adminDeps, body.ref, body.outcome, String(body.note ?? ""), auth.userId)
    if (out.ok) {
      rt.db.from("admin_audit_log").insert([{
        admin_id: auth.userId, action: "hubtel_cs_resolve", target_user_id: null,
        old_value: null, new_value: { ref: body.ref, outcome: body.outcome, note: body.note }, created_at: new Date().toISOString(),
      }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel cs resolve log failed:", error.message) })
    }
    return NextResponse.json(out, { status: out.ok ? 200 : 409 })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

`app/api/admin/hubtel-cs/refund/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminRefund } from "@/lib/hubtel-cs/admin-actions"
import { describeError, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to refund" }, { status: 403 })
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (typeof body?.ref !== "string" || !body.ref) return NextResponse.json({ error: "ref is required" }, { status: 400 })
  try {
    const rt = getHubtelCsRuntime()
    const out = await adminRefund(rt.adminDeps, body.ref, auth.userId)
    rt.db.from("admin_audit_log").insert([{
      admin_id: auth.userId, action: "hubtel_cs_refund", target_user_id: null,
      old_value: null, new_value: { ref: body.ref, ok: out.ok, message: out.message }, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel cs refund log failed:", error.message) })
    return NextResponse.json(out, { status: out.ok ? 200 : 409 })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

`app/api/admin/hubtel-cs/test-purchase/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { TEST_PURCHASE_MAX_GHS, describeError, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { isServiceKey } from "@/lib/hubtel-cs/services"

/** Admin-only live smoke test while the product surfaces do not exist yet. Capped at GHS 5. */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  if (!isServiceKey(body?.serviceKey)) return NextResponse.json({ error: "Unknown serviceKey" }, { status: 400 })
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > TEST_PURCHASE_MAX_GHS) {
    return NextResponse.json({ error: `Test amount must be between 0.01 and ${TEST_PURCHASE_MAX_GHS}` }, { status: 400 })
  }
  try {
    const tx = await getHubtelCsRuntime().client.purchase({
      serviceKey: body.serviceKey, destination: String(body.destination ?? ""), amount,
      bundle: typeof body.bundle === "string" && body.bundle.length ? body.bundle : undefined,
    })
    return NextResponse.json({ tx })
  } catch (e) {
    const d = describeError(e)
    return NextResponse.json({ error: d.error }, { status: d.status })
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/hubtel-cs/admin-route.ts lib/hubtel-cs/admin-route.test.ts app/api/admin/hubtel-cs
git commit -m "feat(hubtel-cs): admin API routes (config, transactions, review actions, test purchase)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Admin page and sidebar entry

**Files:**
- Create: `app/admin/hubtel-commission/page.tsx`
- Modify: `components/layout/sidebar.tsx` (add nav link after the Hubtel USSD link, ~line 1079)

**Interfaces:**
- Consumes: Task 12 routes (`/api/admin/hubtel-cs/{config,transactions,check-status,resolve,refund,test-purchase}`), `HUBTEL_CS_SERVICES` (client-safe, pure), types from Tasks 1 and 5.
- Produces: page at `/admin/hubtel-commission` with tabs **Settings | Transactions | Review Queue** (matches the admin Utility Bills reference: light cards, pill tabs, row-list, stat cards; `lg:` multi-column on desktop).

- [ ] **Step 1: Create the page** — `app/admin/hubtel-commission/page.tsx`

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { HUBTEL_CS_SERVICES, type HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelCsConfig } from "@/lib/hubtel-cs/config"
import type { HubtelCsTx } from "@/lib/hubtel-cs/types"

type Row = HubtelCsTx & { refundable: boolean }
type Stats = { total: number; in_flight: number; needs_review: number; failed: number; fulfilled: number; commission_earned: number }
type EnvStatus = { ready: boolean; missing: string[] }
type ServiceInfo = { key: HubtelCsServiceKey; label: string; kind: string }

async function authed(path: string, init?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("No authentication token available")
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || json.message || res.statusText || "Request failed")
  return json
}

const money = (n: number | null | undefined, dp = 2) => (n === null || n === undefined ? "-" : `₵${Number(n).toFixed(dp)}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GH", { dateStyle: "medium", timeStyle: "short" }) : "-")

const STATE_STYLE: Record<string, string> = {
  created: "bg-slate-100 text-slate-700",
  pending: "bg-blue-100 text-blue-700",
  fulfilled: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  needs_review: "bg-amber-100 text-amber-800",
}
const StateBadge = ({ state }: { state: string }) => (
  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_STYLE[state] ?? ""}`}>{state.replace("_", " ")}</span>
)

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

export default function HubtelCommissionPage() {
  const [config, setConfig] = useState<HubtelCsConfig | null>(null)
  const [env, setEnv] = useState<EnvStatus | null>(null)
  const [services, setServices] = useState<ServiceInfo[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [filter, setFilter] = useState("all")
  const [q, setQ] = useState("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [threshold, setThreshold] = useState("")
  const [test, setTest] = useState({ serviceKey: "airtime_mtn" as HubtelCsServiceKey, destination: "", amount: "0.50", bundle: "" })
  const [resolving, setResolving] = useState<{ ref: string; outcome: "fulfilled" | "failed" } | null>(null)
  const [note, setNote] = useState("")

  const loadConfig = useCallback(async () => {
    const j = await authed("/api/admin/hubtel-cs/config")
    setConfig(j.config); setEnv(j.env); setServices(j.services)
    setThreshold(j.config.lowBalanceThreshold === null ? "" : String(j.config.lowBalanceThreshold))
  }, [])
  const loadTx = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" })
    if (filter !== "all") params.set("state", filter)
    if (q.trim()) params.set("q", q.trim())
    const j = await authed(`/api/admin/hubtel-cs/transactions?${params}`)
    setRows(j.rows); setTotal(j.total); setStats(j.stats)
  }, [filter, q])
  const reload = useCallback(async () => {
    setLoading(true)
    try { await Promise.all([loadConfig(), loadTx()]) }
    catch (e: any) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [loadConfig, loadTx])
  useEffect(() => { reload() }, [reload])

  async function patchConfig(patch: object, okMsg = "Saved") {
    setBusy("config")
    try {
      const j = await authed("/api/admin/hubtel-cs/config", { method: "POST", body: JSON.stringify(patch) })
      setConfig(j.config); toast.success(okMsg)
    } catch (e: any) { toast.error(e.message) } finally { setBusy(null) }
  }
  async function action(path: string, body: object, label: string) {
    setBusy(label)
    try {
      const j = await authed(`/api/admin/hubtel-cs/${path}`, { method: "POST", body: JSON.stringify(body) })
      toast.success(j.message ?? "Done")
      await loadTx()
    } catch (e: any) { toast.error(e.message); await loadTx().catch(() => {}) } finally { setBusy(null) }
  }
  async function sendTest() {
    setBusy("test")
    try {
      const j = await authed("/api/admin/hubtel-cs/test-purchase", {
        method: "POST",
        body: JSON.stringify({ serviceKey: test.serviceKey, destination: test.destination, amount: Number(test.amount), bundle: test.bundle || undefined }),
      })
      toast.success(`Test sent: ${j.tx.client_reference} is ${j.tx.state}`)
      await loadTx()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(null) }
  }

  const attention = rows.filter(r => r.state === "needs_review" || r.state === "failed")

  function TxRow({ r, review }: { r: Row; review?: boolean }) {
    const svc = HUBTEL_CS_SERVICES[r.service_key as HubtelCsServiceKey]
    return (
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="min-w-[10rem] lg:w-48">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Service</div>
          <div className="font-medium">{svc?.label ?? r.service_key}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Destination</div>
          <div className="font-mono text-sm">{r.destination}</div>
          <button type="button" className="font-mono text-xs text-muted-foreground underline decoration-dotted"
            title="Click to copy" onClick={() => navigator.clipboard?.writeText(r.client_reference).then(() => toast.success("Reference copied"))}>
            {r.client_reference}
          </button>
        </div>
        <div className="lg:w-40">
          <StateBadge state={r.state} />
          {(r.failure_reason || r.review_reason) && <div className="mt-1 text-xs text-muted-foreground">{r.failure_reason ?? r.review_reason}</div>}
        </div>
        <div className="lg:w-40">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{when(r.created_at)}</div>
          <div className="font-semibold">{money(r.amount)}</div>
          {r.commission !== null && <div className="text-xs text-emerald-600">+{money(r.commission, 4)} comm.</div>}
        </div>
        <div className="flex flex-wrap gap-2 lg:w-72 lg:justify-end">
          {(r.state === "pending" || r.state === "needs_review") && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => action("check-status", { ref: r.client_reference }, `check-${r.id}`)}>Check status</Button>
          )}
          {review && (
            <>
              {r.state !== "fulfilled" && <Button size="sm" variant="outline" onClick={() => { setNote(""); setResolving({ ref: r.client_reference, outcome: "fulfilled" }) }}>Mark delivered</Button>}
              {r.state !== "failed" && <Button size="sm" variant="outline" onClick={() => { setNote(""); setResolving({ ref: r.client_reference, outcome: "failed" }) }}>Mark failed</Button>}
              <Button size="sm" disabled={!r.refundable || busy !== null} title={r.refundable ? "" : "Available once the order's product registers a refund handler"}
                onClick={() => { if (confirm(`Refund ${money(r.amount)} to the customer's wallet?`)) action("refund", { ref: r.client_reference }, `refund-${r.id}`) }}>Refund to wallet</Button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeaderBanner title="Hubtel Commission Services" subtitle="Airtime, data and utility bills through Hubtel, with commission earned on every transaction.">
          <Button variant="secondary" size="sm" onClick={reload} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
        </PageHeaderBanner>

        {config?.paused && (
          <Card className="border-amber-300 bg-amber-50">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-semibold text-amber-900">Paused: new Hubtel orders are blocked</div>
                <div className="text-sm text-amber-800">{config.pausedReason} · since {when(config.pausedAt)}. The Disbursement float is shared with Hubtel SMS.</div>
              </div>
              <Button disabled={busy !== null} onClick={() => patchConfig({ paused: false }, "Resumed")}>Resume</Button>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Transactions" value={String(stats?.total ?? 0)} hint={`${stats?.fulfilled ?? 0} fulfilled`} />
          <Stat label="In flight" value={String(stats?.in_flight ?? 0)} hint="created or pending" />
          <Stat label="Commission earned" value={money(stats?.commission_earned ?? 0, 4)} hint="fulfilled transactions" />
          <Stat label="Needs attention" value={String((stats?.needs_review ?? 0) + (stats?.failed ?? 0))} hint={`${stats?.needs_review ?? 0} review · ${stats?.failed ?? 0} failed`} />
        </div>

        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="transactions">Transactions</TabsTrigger>
            <TabsTrigger value="review">Review Queue{attention.length ? ` (${attention.length})` : ""}</TabsTrigger>
          </TabsList>

          <TabsContent value="settings" className="mt-4">
            {config && (
              <div className="grid gap-4 lg:grid-cols-3">
                <Card>
                  <CardHeader><CardTitle>Feature gates</CardTitle><CardDescription>The master switch ships OFF. Nothing customer-facing uses Hubtel until a product phase wires it in.</CardDescription></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between rounded-xl border p-3">
                      <div><div className="font-medium">Hubtel Commission Services enabled</div><div className="text-xs text-muted-foreground">Master switch</div></div>
                      <Switch checked={config.enabled} disabled={busy !== null} onCheckedChange={v => patchConfig({ enabled: v }, v ? "Enabled" : "Disabled")} />
                    </div>
                    <div className="text-sm font-medium">Services</div>
                    {services.map(s => (
                      <div key={s.key} className="flex items-center justify-between rounded-xl border p-3">
                        <div className="font-medium">{s.label}</div>
                        <Switch checked={config.services[s.key]} disabled={busy !== null} onCheckedChange={v => patchConfig({ services: { [s.key]: v } })} />
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <div className="space-y-4">
                  <Card>
                    <CardHeader><CardTitle>Transport</CardTitle><CardDescription>Direct calls cs.hubtel.com from Vercel. Relay sends it through the fixed-IP droplet.</CardDescription></CardHeader>
                    <CardContent className="space-y-3">
                      <Select value={config.mode} onValueChange={v => patchConfig({ mode: v }, "Transport updated")}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="direct">Direct (Vercel)</SelectItem><SelectItem value="relay">Via relay droplet</SelectItem></SelectContent>
                      </Select>
                      <div className="text-sm font-medium">Readiness</div>
                      {env?.ready
                        ? <Badge className="bg-emerald-100 text-emerald-700">All required environment variables are set</Badge>
                        : <div className="text-sm text-amber-700">Missing: {env?.missing.join(", ")}</div>}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><CardTitle>Float</CardTitle><CardDescription>The Disbursement balance is shared with Hubtel SMS. A 4075 pauses the service automatically.</CardDescription></CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-sm">Low-balance alert threshold (GHS)</div>
                      <div className="flex gap-2">
                        <Input inputMode="decimal" placeholder="e.g. 200 (blank = off)" value={threshold} onChange={e => setThreshold(e.target.value)} />
                        <Button disabled={busy !== null} onClick={() => patchConfig({ lowBalanceThreshold: threshold.trim() === "" ? null : Number(threshold) }, "Threshold saved")}>Save</Button>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader><CardTitle>Live test</CardTitle><CardDescription>Sends a real Hubtel request (max ₵5). Enable the master switch first.</CardDescription></CardHeader>
                  <CardContent className="space-y-3">
                    <Select value={test.serviceKey} onValueChange={v => setTest(t => ({ ...t, serviceKey: v as HubtelCsServiceKey }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{services.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input placeholder="Destination (e.g. 233246912184)" value={test.destination} onChange={e => setTest(t => ({ ...t, destination: e.target.value }))} />
                    <Input inputMode="decimal" placeholder="Amount" value={test.amount} onChange={e => setTest(t => ({ ...t, amount: e.target.value }))} />
                    {HUBTEL_CS_SERVICES[test.serviceKey].needsBundle && (
                      <Input placeholder="Bundle value / meter number (exactly as Hubtel returns it)" value={test.bundle} onChange={e => setTest(t => ({ ...t, bundle: e.target.value }))} />
                    )}
                    <Button className="w-full" disabled={busy !== null || !test.destination} onClick={sendTest}>Send test</Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="transactions" className="mt-4 space-y-4">
            <Card><CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
              <Input placeholder="Search reference, destination or Hubtel id" value={q} onChange={e => setQ(e.target.value)} />
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="sm:w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="fulfilled">Fulfilled</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem><SelectItem value="needs_review">Needs review</SelectItem><SelectItem value="created">Created</SelectItem>
                </SelectContent>
              </Select>
            </CardContent></Card>
            <div className="text-sm text-muted-foreground">{total} transaction{total === 1 ? "" : "s"}</div>
            {rows.length === 0 && !loading && <div className="rounded-xl border p-8 text-center text-muted-foreground">No Hubtel transactions yet.</div>}
            <div className="space-y-3">{rows.map(r => <TxRow key={r.id} r={r} />)}</div>
          </TabsContent>

          <TabsContent value="review" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">Failed and unknown transactions. Nothing here is refunded or resent automatically.</p>
            {attention.length === 0 && <div className="rounded-xl border p-8 text-center text-muted-foreground">Nothing needs attention.</div>}
            {attention.map(r => <TxRow key={r.id} r={r} review />)}
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={!!resolving} onOpenChange={o => { if (!o) setResolving(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as {resolving?.outcome === "fulfilled" ? "delivered" : "failed"}</DialogTitle>
            <DialogDescription>Record what you confirmed with Hubtel. This is audit-logged and cannot be changed by later callbacks.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Note (required)" value={note} onChange={e => setNote(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(null)}>Cancel</Button>
            <Button disabled={!note.trim() || busy !== null} onClick={async () => {
              if (!resolving) return
              await action("resolve", { ref: resolving.ref, outcome: resolving.outcome, note }, "resolve")
              setResolving(null)
            }}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  )
}
```

- [ ] **Step 2: Add the sidebar link** — in `components/layout/sidebar.tsx`, immediately after the closing `</Link>` of the Hubtel USSD block (the `</Link>` at ~line 1079, just before `</div>` / `)}`), insert:

```tsx
              <Link href="/admin/hubtel-commission" onClick={() => handleNavigation("/admin/hubtel-commission")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    pathname === "/admin/hubtel-commission" ? c.navLinkActive : c.navLinkInactive,
                    !isOpen && "justify-center",
                    loadingPath === "/admin/hubtel-commission" && "opacity-70"
                  )}
                  title={!isOpen ? "Hubtel Commission" : undefined}
                  disabled={loadingPath === "/admin/hubtel-commission"}
                >
                  {loadingPath === "/admin/hubtel-commission" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Zap className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Hubtel Commission"}
                </Button>
              </Link>
```
(`Zap` and `Loader2` are already imported in that file.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `PageHeaderBanner` children or `Dialog`/`Tabs` props differ, adjust to match `components/ui/*` exactly (the `ussd-hubtel` page uses the same components).

- [ ] **Step 4: Visual check** (per memory `reference-headless-screenshots`): run `npm run dev`, open `/admin/hubtel-commission` signed in as admin, screenshot at 500px and ≥1280px wide. Confirm: banner, 4 stat cards (2×2 on mobile, 4 across on desktop), Settings is 3 columns on `lg:`, rows stack on mobile and become a single line on `lg:`, empty states render, pause banner renders when `paused` (temporarily set via the config route).

- [ ] **Step 5: Commit**

```bash
git add app/admin/hubtel-commission/page.tsx components/layout/sidebar.tsx
git commit -m "feat(hubtel-cs): admin page (Settings, Transactions, Review Queue) and nav entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Verification, runbook, rollout gate

**Files:**
- Create: `docs/hubtel-commission-services/runbook.md`
- Modify: `docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase1-design.md` (apply the "Spec deltas" listed at the top of this plan)

- [ ] **Step 1: Full unit run**

Run: `npm run test:run`
Expected: all suites PASS (new `lib/hubtel-cs/**` suites + the existing `lib/ussd-hubtel/**` relay tests).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Real Next build (mandatory before any push to main — tsc/vitest miss route-export violations)**

Run (background, ~3–5 min):
```bash
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run build
```
Expected: reaches "Generating static pages (N/N)" with exit 0. If it fails on a route file, move any non-handler export into `lib/`.

- [ ] **Step 4: Write `docs/hubtel-commission-services/runbook.md`**

```markdown
# Hubtel Commission Services — Phase 1 rollout runbook

Phase 1 ships DARK: nothing customer-facing, master switch OFF. Order matters.

## Before enabling
1. Apply migrations `0113` and `0114` to production (Supabase Management API SQL, see memory `reference-supabase-access`). Verify: `select * from hubtel_cs_stats();` returns one row of zeros.
2. Set Vercel env (production): `HUBTEL_CS_CALLBACK_SECRET` (long random), `HUBTEL_CS_BASIC_AUTH` (base64 `clientId:secret` for Commission Services), `HUBTEL_DISBURSEMENT_ACCOUNT`. Confirm `NEXT_PUBLIC_APP_URL`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET` already exist. Optional: `HUBTEL_CS_ENFORCE_CALLBACK_IP=true` once a first callback has been seen from 18.202.122.131.
3. Deploy. Open `/admin/hubtel-commission`: the readiness card must say all variables are set.
4. Status checks use the relay `/status` (already deployed for USSD). If `mode: relay` is ever used, redeploy the droplet with `HUBTEL_CS_BASIC_AUTH` set (see `scripts/hubtel-relay/README.md`).

## Smoke test (live, ≤ ₵5)
1. Settings → master switch ON.
2. Live test: MTN Airtime, your own number, ₵0.50. Expect state `pending` immediately, then `fulfilled` via callback within ~1 min, and a commission value on the row.
3. Force the fallback: temporarily set `HUBTEL_CS_CALLBACK_SECRET` to a wrong value for one test, run another ₵0.50 test, and confirm the row settles via the status-check cron after ≥5 min (callback gets 401 and is not logged as a transition).
4. Data: use the query endpoint via a one-off script to read a real bundle `Value` + price, then send one live test with that exact bundle and amount.
5. Set a low-balance threshold above the current float and confirm one SMS/email arrives (then set it back).

## Safe operations
- A row in **Review Queue** is never resent automatically. Use **Check status** first; resolve manually with a note.
- A 4075 pauses the service and alerts admins (the float is shared with Hubtel SMS). Top up the Disbursement account, then **Resume** on the page.
- Turning the master switch OFF stops new orders; in-flight rows still reconcile (the cron runs regardless).

## Known limits (Phase 1)
- No product wiring yet: no order adapters are registered, so **Refund to wallet** is disabled until Phases 2/3 add them.
- Hubtel de-duplication of a repeated `ClientReference` is unknown, so unknown POSTs are never resent.
```

- [ ] **Step 5: Apply the spec deltas** — edit the spec so it matches this plan:
  - §4 heading: `0111_hubtel_cs_transactions.sql`/`0112_hubtel_cs_events.sql` → `0113_…`/`0114_…`; add `negative_checks int default 0` to the table list and mention the `hubtel_cs_stats()` RPC.
  - §6 relay bullet: path `^/cs/\d+/[a-f0-9]{32}$` → `^/cs/[a-f0-9]{32}$` (relay env supplies the Disbursement account), and note the relay change is an optional fallback.
  - §6 `float.ts` bullet and §9 item 3: replace "blocked on balance docs" with "uses the existing `fetchDisbursementBalance()` (relay `/balance`); the float is shared with Hubtel SMS".

- [ ] **Step 6: Update memory** — in `project-hubtel-commission-services.md` add: migrations 0113/0114 + `lib/hubtel-cs/` built (date), the relay `/balance` discovery, the float-shared-with-SMS fact, and the corrected worktree base (the worktree must track `origin/main`; local `main` was 279 commits stale — run `git fetch` and compare to `origin/main`, never local `main`).

- [ ] **Step 7: Commit**

```bash
git add docs/hubtel-commission-services/runbook.md docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase1-design.md
git commit -m "docs(hubtel-cs): phase 1 runbook and spec alignment

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: STOP — ask the user before anything outward-facing.** Do not apply migrations to production, set production env, push, or merge without an explicit go-ahead; report the verification results (tests, tsc, build exit codes) first.

---

## Self-review (against the spec)

- **Spec §3 decisions:** persist-before-call (Task 7 test "persists the row BEFORE calling Hubtel"); never resend (Task 7 "transport error -> needs_review ... NOT retried"); no auto-refund (adapters only act on admin action; Task 8); HMAC callbacks (Task 6); forward-only/idempotent (Tasks 2, 4, 6); conservative status-check rule (Tasks 2, 9); transport is a setting (Tasks 5, 7, 11); config in `admin_settings` (Task 5).
- **Spec §4 data model:** Task 3 (+ `negative_checks` and stats RPC, deltas noted).
- **Spec §5 state machine:** Task 2, including created-sweep (2 min) and 24 h rules; Task 9 runner applies them.
- **Spec §6 components:** services/types/errors (1), state-machine (2), store/ledger (4), config (5), callback (6), transport/client (7), adapters (8), float (9), routes + cron (10), relay (11), admin API (12), admin page + nav (13). `float.ts` low-balance threshold implemented with the *existing* balance fetcher (spec §9 blocker resolved).
- **Spec §7 env:** `HUBTEL_CS_CALLBACK_SECRET`, `HUBTEL_CS_ENFORCE_CALLBACK_IP`, `HUBTEL_CS_BASIC_AUTH`, `HUBTEL_DISBURSEMENT_ACCOUNT` — checked by `hubtelCsEnvReady` (Task 5) and documented (Task 14).
- **Spec §8 tests:** every listed test class has a task; live tests are in the runbook smoke test.
- **Type consistency:** `Transition`, `PostResult`, `StatusObservation` (Task 2) are consumed unchanged by Tasks 4, 7, 8, 9; `HubtelCsStore` (Task 4) is consumed by Tasks 6–10 with the same method names; `OrderAdapter`/`notifyAdapter` (Task 8) match their use in Task 10 (`runtime.ts`) and Task 12 (`getOrderAdapter(...)?.refundToWallet`); `FloatDeps["alert"]` signature `(kind, subject, message)` is identical in Tasks 9 and 10.
- **Placeholders:** none; every code step contains the code. The only external dependency is Hubtel itself (live smoke test), which is gated in Task 14.
