# Hubtel Commission Services — Phase 3a (Utility Bills + Telecel Broadband) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in customers verify and pay ECG, Ghana Water, DSTV, GOtv, StarTimes and Telecel Broadband bills from their wallet through Hubtel Commission Services, with an admin Utility Bills page (Orders / Settings / Refund Queue).

**Architecture:** A pure `lib/bills/` engine (biller definitions + lookup parsers, config, signed verify token, verify/pay/dispatch orchestration with injected deps) on top of the live Phase 1 Hubtel client; one `hubtel_bill_orders` table + an order adapter registered in the hubtel-cs runtime; thin API routes; customer pages `/dashboard/bills` and `/dashboard/broadband`; admin page `/admin/utility-bills`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service role), Vitest, existing `lib/hubtel-cs/*`, shadcn UI, sonner.

**Spec:** `docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase3a-design.md` (read first). API: `docs/hubtel-commission-services/hubtel-docs-full-2026-10-12.md`. UI references: `docs/hubtel-commission-services/ref/customer-utility-bills-home.png`, `customer-utility-bills-verify-sheet.png`, `admin-utility-bills-orders.png`, `admin-utility-bills-settings.png`.

## Global Constraints

- Zero markup: the customer is debited exactly `amount`. Never add fees.
- Ships dark: `utility_bills_config` defaults `enabled: false` and every biller `enabled: false`; sidebar links hidden until enabled.
- Config key `utility_bills_config` in `admin_settings` (never `app_settings`); written only via the `utility_bills_config_patch(jsonb)` RPC.
- Pay order is fixed: validate (token, switches, Hubtel enabled & not paused, limits) → insert order → `deduct_wallet` → at most ONE `hubtelCs.purchase`. Nothing is charged if any pre-debit check fails. Never resend. Never auto-refund.
- Refunds only via the admin Refund Queue → Phase 1 `adminRefund` (refund claim) → adapter `refundToWallet` → `credit_wallet_safely` with `p_reference_id = "bill-refund-<order id>"`.
- Verify token: HMAC-SHA256 with `HUBTEL_CS_CALLBACK_SECRET` and domain prefix `"bills-verify:"`; 10-minute validity; bound to the user id; empty secret ⇒ throw (fail closed).
- Phones sent to Hubtel for bills are normalised to `233XXXXXXXXX` here (the Phase 1 client only normalises airtime/data).
- Limits: per biller, `1 ≤ min ≤ max ≤ 10000`, defaults `min 5`, `max 10000`; amounts 2 decimals.
- Route files export only HTTP handlers / route config; shared code in `lib/`. New migration additive, `IF NOT EXISTS`, service-role only (RLS on, `REVOKE ALL … FROM PUBLIC, anon, authenticated`; functions `SET search_path = public`, `GRANT EXECUTE … TO service_role`). Use the next free migration number on `origin/main` (expected `0117`).
- UI: navy brand via existing tokens, light cards, follows the reference images, usable at 500px and multi-column at `lg:`; new sidebar items get NEW tags (`lib/nav-new.ts`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the plan's worktree; tests `../../../node_modules/.bin/vitest run <files>`, typecheck `../../../node_modules/.bin/tsc --noEmit -p .`.

## Review Focus

1. **Tampered or stale verify token** (changed account/amount fields, other user's token, >10 min, Ghana Water session from another lookup) ⇒ nothing charged (Task 4 tests).
2. **Hubtel paused (4075) or bills/biller switched off between verify and pay** ⇒ rejected before the wallet debit (Task 5 "pre-debit checks").
3. **Wallet debit succeeds but Hubtel errors before the POST** ⇒ order stays `pending` + `paid`, admin alerted, no resend, refundable later (Task 5).
4. **Late/duplicate Hubtel callback after an admin refund** ⇒ adapter never moves a `refunded`/`completed` order; refund cannot run twice (Task 6).
5. **Lookup responses with odd shapes** (StarTimes `Name`/`Account Number`, leading spaces, negative `amountDue`, empty `Data`) ⇒ parsed safely, suggested amount ≥ 0 (Task 3).

---

### Task 1: Migration — bill orders table and config patch RPC

**Files:** Create `migrations/0117_hubtel_bill_orders.sql`.

- [ ] **Step 1:** Write the migration:

```sql
-- 0117_hubtel_bill_orders.sql
-- Utility bill payments via Hubtel Commission Services (Phase 3a). ADDITIVE; service-role only.

CREATE TABLE IF NOT EXISTS hubtel_bill_orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code          text NOT NULL UNIQUE,
  user_id                 uuid NOT NULL,
  channel                 text NOT NULL DEFAULT 'dashboard' CHECK (channel IN ('dashboard')),
  biller                  text NOT NULL CHECK (biller IN ('ecg','ghana_water','dstv','gotv','startimes','telecel_broadband')),
  account_number          text NOT NULL,
  phone                   text,
  email                   text,
  broadband_account       text,
  session_id              text,
  customer_name           text,
  verified                boolean NOT NULL DEFAULT true,
  amount                  numeric(12,2) NOT NULL CHECK (amount > 0),
  status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','processing','completed','failed','refunded')),
  payment_status          text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  hubtel_client_reference text UNIQUE,
  commission              numeric(12,6),
  failure_reason          text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hubtel_bill_orders_user_idx   ON hubtel_bill_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hubtel_bill_orders_status_idx ON hubtel_bill_orders (status, created_at);
CREATE INDEX IF NOT EXISTS hubtel_bill_orders_biller_idx ON hubtel_bill_orders (biller, created_at);

ALTER TABLE hubtel_bill_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hubtel_bill_orders FROM anon, authenticated;

-- Atomic merge into admin_settings['utility_bills_config']; top-level keys replace, "billers" merges per biller key.
CREATE OR REPLACE FUNCTION utility_bills_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('utility_bills_config', '{}'::jsonb, 'Utility bills (Hubtel): master switch, auto-fulfil, per-biller switches and limits.', now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'billers'))
                 || CASE WHEN jsonb_typeof(p_patch -> 'billers') = 'object'
                         THEN jsonb_build_object('billers', COALESCE(value -> 'billers', '{}'::jsonb) || (p_patch -> 'billers'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'utility_bills_config'
  RETURNING value INTO v;
  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION utility_bills_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION utility_bills_config_patch(jsonb) TO service_role;
```

- [ ] **Step 2: Commit** — `git add migrations/0117_hubtel_bill_orders.sql && git commit -m "feat(bills): hubtel_bill_orders table and utility_bills_config_patch RPC (migration 0117, not applied)"` (+ trailer).

---

### Task 2: Bills config

**Files:** Create `lib/bills/config.ts`, `lib/bills/config.test.ts`.

**Interfaces — Produces:** `BILLS_CONFIG_KEY = "utility_bills_config"`; `BillerSetting { enabled: boolean; min: number; max: number }`; `BillsConfig { enabled: boolean; autoFulfil: boolean; billers: Record<BillerKey, BillerSetting> }`; `BILL_LIMIT_FLOOR = 1`, `BILL_LIMIT_CEIL = 10000`, `BILL_DEFAULT_MIN = 5`, `BILL_DEFAULT_MAX = 10000`; `resolveBillsConfig(raw: unknown): BillsConfig`; `validateBillsPatch(body: unknown): { ok: true; patch: BillsPatch } | { ok: false; error: string }` where `BillsPatch = { enabled?: boolean; autoFulfil?: boolean; billers?: Partial<Record<BillerKey, BillerSetting>> }`; `checkBillAmount(s: BillerSetting, amount: number): string | null`; `getBillsConfig(db)`, `setBillsConfig(db, patch)` (RPC). **Consumes:** `BillerKey`, `BILLER_KEYS` from Task 3 — so implement Task 3's `billers.ts` type exports first if needed (Task 3 owns the file; here only import).

> Ordering note: Task 2 imports `BILLER_KEYS`/`BillerKey` from `lib/bills/billers.ts`. If Task 3 is not done yet, create `lib/bills/billers.ts` with just these two exports (Task 3 extends the same file).

- [ ] **Step 1: Failing tests** `lib/bills/config.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { BILLS_CONFIG_KEY, checkBillAmount, resolveBillsConfig, setBillsConfig, validateBillsPatch } from "./config"

describe("bills config", () => {
  it("key", () => expect(BILLS_CONFIG_KEY).toBe("utility_bills_config"))
  it("ships dark: everything off with default limits", () => {
    const c = resolveBillsConfig(null)
    expect(c.enabled).toBe(false)
    expect(c.autoFulfil).toBe(true)
    for (const k of ["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"] as const) {
      expect(c.billers[k]).toEqual({ enabled: false, min: 5, max: 10000 })
    }
  })
  it("only literal true enables; bad limits fall back to defaults", () => {
    const c = resolveBillsConfig({ enabled: "true", billers: { dstv: { enabled: true, min: 0, max: 99999 }, gotv: { enabled: true, min: 20, max: 500 } } })
    expect(c.enabled).toBe(false)
    expect(c.billers.dstv).toEqual({ enabled: true, min: 5, max: 10000 })
    expect(c.billers.gotv).toEqual({ enabled: true, min: 20, max: 500 })
  })
  it("validates patches strictly", () => {
    expect(validateBillsPatch({ enabled: true, autoFulfil: false })).toEqual({ ok: true, patch: { enabled: true, autoFulfil: false } })
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 10, max: 2000 } } }).ok).toBe(true)
    expect(validateBillsPatch({ nope: 1 }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 50, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 0, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true, min: 5, max: 10001 } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { ecg: { enabled: true } } }).ok).toBe(false)
    expect(validateBillsPatch({ billers: { water: { enabled: true, min: 5, max: 10 } } }).ok).toBe(false)
    expect(validateBillsPatch([]).ok).toBe(false)
  })
  it("amount limits", () => {
    const s = { enabled: true, min: 5, max: 100 }
    expect(checkBillAmount(s, 5)).toBeNull()
    expect(checkBillAmount(s, 100)).toBeNull()
    expect(checkBillAmount(s, 4.99)).toMatch(/at least/)
    expect(checkBillAmount(s, 100.01)).toMatch(/at most/)
    expect(checkBillAmount(s, 10.005)).toMatch(/decimal/)
    expect(checkBillAmount(s, NaN)).toMatch(/valid/)
  })
  it("setBillsConfig calls the RPC with the validated patch", async () => {
    const calls: any[] = []
    const db = { rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: { enabled: true }, error: null } } } as any
    const c = await setBillsConfig(db, { enabled: true })
    expect(calls).toEqual([{ fn: "utility_bills_config_patch", args: { p_patch: { enabled: true } } }])
    expect(c.enabled).toBe(true)
  })
})
```

- [ ] **Step 2:** Run → fails.
- [ ] **Step 3: Implement** `lib/bills/config.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { BILLER_KEYS, type BillerKey } from "./billers"

export const BILLS_CONFIG_KEY = "utility_bills_config"
export const BILL_LIMIT_FLOOR = 1
export const BILL_LIMIT_CEIL = 10000
export const BILL_DEFAULT_MIN = 5
export const BILL_DEFAULT_MAX = 10000

export interface BillerSetting { enabled: boolean; min: number; max: number }
export interface BillsConfig { enabled: boolean; autoFulfil: boolean; billers: Record<BillerKey, BillerSetting> }
export interface BillsPatch { enabled?: boolean; autoFulfil?: boolean; billers?: Partial<Record<BillerKey, BillerSetting>> }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const validLimits = (min: unknown, max: unknown): min is number =>
  typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) &&
  min >= BILL_LIMIT_FLOOR && max <= BILL_LIMIT_CEIL && min <= max

export function resolveBillsConfig(raw: unknown): BillsConfig {
  const r = isObj(raw) ? raw : {}
  const billers = {} as Record<BillerKey, BillerSetting>
  for (const k of BILLER_KEYS) {
    const b = isObj(r.billers) && isObj(r.billers[k]) ? r.billers[k] : {}
    const ok = validLimits(b.min, b.max)
    billers[k] = { enabled: b.enabled === true, min: ok ? b.min : BILL_DEFAULT_MIN, max: ok ? (b.max as number) : BILL_DEFAULT_MAX }
  }
  return { enabled: r.enabled === true, autoFulfil: r.autoFulfil !== false, billers }
}

export function validateBillsPatch(body: unknown): { ok: true; patch: BillsPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "Body must be an object" }
  const allowed = new Set(["enabled", "autoFulfil", "billers"])
  for (const k of Object.keys(body)) if (!allowed.has(k)) return { ok: false, error: `Unknown field ${k}` }
  const patch: BillsPatch = {}
  for (const k of ["enabled", "autoFulfil"] as const) {
    if (k in body) {
      if (typeof body[k] !== "boolean") return { ok: false, error: `${k} must be true or false` }
      patch[k] = body[k]
    }
  }
  if ("billers" in body) {
    if (!isObj(body.billers)) return { ok: false, error: "billers must be an object" }
    const out: Partial<Record<BillerKey, BillerSetting>> = {}
    for (const [k, v] of Object.entries(body.billers)) {
      if (!(BILLER_KEYS as readonly string[]).includes(k)) return { ok: false, error: `Unknown biller ${k}` }
      if (!isObj(v) || typeof v.enabled !== "boolean" || !validLimits(v.min, v.max)) {
        return { ok: false, error: `${k}: send enabled, min and max with ${BILL_LIMIT_FLOOR} ≤ min ≤ max ≤ ${BILL_LIMIT_CEIL}` }
      }
      out[k as BillerKey] = { enabled: v.enabled, min: v.min, max: v.max }
    }
    patch.billers = out
  }
  return { ok: true, patch }
}

export function checkBillAmount(s: BillerSetting, amount: number): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return "Enter a valid amount"
  if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) return "Amount can have at most 2 decimal places"
  if (amount < s.min) return `Amount must be at least GHS ${s.min.toFixed(2)}`
  if (amount > s.max) return `Amount must be at most GHS ${s.max.toFixed(2)}`
  return null
}

export async function getBillsConfig(db: SupabaseClient): Promise<BillsConfig> {
  const { data, error } = await db.from("admin_settings").select("value").eq("key", BILLS_CONFIG_KEY).maybeSingle()
  if (error) throw error
  return resolveBillsConfig(data?.value)
}

export async function setBillsConfig(db: SupabaseClient, patch: BillsPatch): Promise<BillsConfig> {
  const { data, error } = await db.rpc("utility_bills_config_patch", { p_patch: patch })
  if (error) throw error
  return resolveBillsConfig(data)
}
```

- [ ] **Step 4:** Run → pass. **Step 5: Commit** `feat(bills): config with per-biller limits, strict patch validation, atomic RPC write`.

---

### Task 3: Biller definitions, inputs and lookup parsers

**Files:** Create/extend `lib/bills/billers.ts`, `lib/bills/billers.test.ts`.

**Interfaces — Produces:**
- `type BillerKey = "ecg" | "ghana_water" | "dstv" | "gotv" | "startimes" | "telecel_broadband"`; `BILLER_KEYS`; `isBillerKey(v): v is BillerKey`.
- `BillerDef { key; label; serviceKey: HubtelCsServiceKey; logo: string /* /billers/<key>.png */; inputHint: string; page: "bills" | "broadband" }`; `BILLERS: Record<BillerKey, BillerDef>`.
- `BillInputs { phone?: string; account?: string; email?: string; broadbandAccount?: string }`.
- `NormalisedInputs { account: string; phone: string | null /* 233… */; email: string | null; broadbandAccount: string | null }`; `normaliseInputs(biller, inputs): { ok: true; value: NormalisedInputs } | { ok: false; error: string }` (ECG: `account` optional at lookup time — the meter is chosen after).
- `lookupRequest(biller, n: NormalisedInputs): { destination: string; mobile?: string }`.
- `ParsedLookup { customerName: string | null; amountDue: number | null; sessionId: string | null; meters: { meter: string; name: string | null; outstanding: number | null }[] }`; `parseLookup(biller, items: HubtelQueryItem[]): ParsedLookup`; `suggestedAmount(amountDue: number | null): number` (≥0, 2dp).
- `purchaseFields(biller, v: { account: string; phone: string | null; email: string | null; broadbandAccount: string | null; sessionId: string | null }): { destination: string; bundle?: string; extra?: { email?: string; sessionId?: string } }`.

- [ ] **Step 1: Failing tests** `lib/bills/billers.test.ts` (use the documented responses):

```ts
import { describe, expect, it } from "vitest"
import { BILLERS, BILLER_KEYS, isBillerKey, lookupRequest, normaliseInputs, parseLookup, purchaseFields, suggestedAmount } from "./billers"

const it_ = (Display: string, Value: string, Amount: number) => ({ Display, Value, Amount })

describe("billers", () => {
  it("six billers mapped to the Hubtel services", () => {
    expect(BILLER_KEYS).toEqual(["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"])
    expect(BILLERS.ecg.serviceKey).toBe("bill_ecg")
    expect(BILLERS.telecel_broadband.page).toBe("broadband")
    expect(BILLERS.dstv.logo).toBe("/billers/dstv.png")
    expect(isBillerKey("ecg")).toBe(true)
    expect(isBillerKey("constructor")).toBe(false)
  })
  it("normalises and validates inputs", () => {
    expect(normaliseInputs("ecg", { phone: "024 123 4567" })).toEqual({ ok: true, value: { account: "", phone: "233241234567", email: null, broadbandAccount: null } })
    expect(normaliseInputs("ecg", { phone: "12" }).ok).toBe(false)
    expect(normaliseInputs("ghana_water", { account: "091019010006", phone: "0242825109", email: "bad" }).ok).toBe(false)
    expect(normaliseInputs("ghana_water", { account: "091019010006", phone: "0242825109", email: "a@b.co" }))
      .toEqual({ ok: true, value: { account: "091019010006", phone: "233242825109", email: "a@b.co", broadbandAccount: null } })
    expect(normaliseInputs("dstv", { account: " 7029864396 " })).toEqual({ ok: true, value: { account: "7029864396", phone: null, email: null, broadbandAccount: null } })
    expect(normaliseInputs("dstv", { account: "<script>" }).ok).toBe(false)
    expect(normaliseInputs("telecel_broadband", { account: "0302450262" }).ok).toBe(false)
    expect(normaliseInputs("telecel_broadband", { account: "0302450262", broadbandAccount: "P0444101" }).ok).toBe(true)
  })
  it("lookup requests", () => {
    expect(lookupRequest("ecg", { account: "", phone: "233541312238", email: null, broadbandAccount: null })).toEqual({ destination: "233541312238" })
    expect(lookupRequest("ghana_water", { account: "091019010006", phone: "233242825109", email: "a@b.co", broadbandAccount: null }))
      .toEqual({ destination: "091019010006", mobile: "233242825109" })
    expect(lookupRequest("startimes", { account: "02190617357", phone: null, email: null, broadbandAccount: null })).toEqual({ destination: "02190617357" })
  })
  it("parses DSTV/GOtv (negative due => suggested 0)", () => {
    const p = parseLookup("gotv", [it_("name", "Senya Duku", 0), it_("amountDue", "-201.00", 0), it_("account", "7032371505", 0)])
    expect(p.customerName).toBe("Senya Duku")
    expect(p.amountDue).toBe(-201)
    expect(suggestedAmount(p.amountDue)).toBe(0)
    expect(suggestedAmount(371.889)).toBe(371.89)
  })
  it("parses StarTimes' different key casing", () => {
    const p = parseLookup("startimes", [it_("Name", "Joe Nti", 0), it_("Account Number", "02190617357", 0), it_("Bouquet", "DTH_Super ", 0)])
    expect(p.customerName).toBe("Joe Nti")
    expect(p.amountDue).toBeNull()
  })
  it("parses Ghana Water incl. sessionId", () => {
    const p = parseLookup("ghana_water", [it_("name", "AMAKYE FREMPONG", 0), it_("amountDue", "371.89", 371.89), it_("sessionId", "3792660ccf", 0)])
    expect(p).toMatchObject({ customerName: "AMAKYE FREMPONG", amountDue: 371.89, sessionId: "3792660ccf" })
  })
  it("parses ECG meter lists with leading spaces", () => {
    const p = parseLookup("ecg", [it_(" THOMAS ANANE (G131099826)", " G131099826", -1.1432), it_(" ADEMAU LYDIA (24911947992)", " 24911947992", 0)])
    expect(p.meters).toEqual([
      { meter: "G131099826", name: "THOMAS ANANE", outstanding: -1.1432 },
      { meter: "24911947992", name: "ADEMAU LYDIA", outstanding: 0 },
    ])
  })
  it("empty data is safe", () => {
    expect(parseLookup("dstv", [])).toEqual({ customerName: null, amountDue: null, sessionId: null, meters: [] })
  })
  it("purchase fields per biller", () => {
    expect(purchaseFields("ecg", { account: "P09137104", phone: "233541312238", email: null, broadbandAccount: null, sessionId: null }))
      .toEqual({ destination: "233541312238", bundle: "P09137104" })
    expect(purchaseFields("ghana_water", { account: "080706070056", phone: "233548359582", email: "u@x.com", broadbandAccount: null, sessionId: "e7a1" }))
      .toEqual({ destination: "233548359582", bundle: "080706070056", extra: { email: "u@x.com", sessionId: "e7a1" } })
    expect(purchaseFields("dstv", { account: "7029864396", phone: null, email: null, broadbandAccount: null, sessionId: null })).toEqual({ destination: "7029864396" })
    expect(purchaseFields("telecel_broadband", { account: "0302450262", phone: null, email: null, broadbandAccount: "P0444101", sessionId: null }))
      .toEqual({ destination: "0302450262", bundle: "P0444101" })
  })
})
```

- [ ] **Step 2:** Run → fails. **Step 3: Implement** `lib/bills/billers.ts`:

```ts
import type { HubtelCsServiceKey } from "@/lib/hubtel-cs/services"
import type { HubtelQueryItem } from "@/lib/hubtel-cs/types"
import { ghanaSignificant, isValidGhanaMobile } from "@/lib/phone-format"

export type BillerKey = "ecg" | "ghana_water" | "dstv" | "gotv" | "startimes" | "telecel_broadband"
export const BILLER_KEYS: readonly BillerKey[] = ["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"]
export const isBillerKey = (v: unknown): v is BillerKey => typeof v === "string" && (BILLER_KEYS as readonly string[]).includes(v)

export interface BillerDef { key: BillerKey; label: string; serviceKey: HubtelCsServiceKey; logo: string; inputHint: string; page: "bills" | "broadband" }
const def = (key: BillerKey, label: string, serviceKey: HubtelCsServiceKey, inputHint: string, page: "bills" | "broadband" = "bills"): BillerDef =>
  ({ key, label, serviceKey, logo: `/billers/${key}.png`, inputHint, page })
export const BILLERS: Record<BillerKey, BillerDef> = {
  ecg: def("ecg", "ECG Prepaid & Postpaid", "bill_ecg", "Meter number"),
  ghana_water: def("ghana_water", "Ghana Water", "bill_ghana_water", "Meter number"),
  dstv: def("dstv", "DSTV", "bill_dstv", "Smartcard number"),
  gotv: def("gotv", "GOtv", "bill_gotv", "Smartcard number"),
  startimes: def("startimes", "StarTimes TV", "bill_startimes", "Account number"),
  telecel_broadband: def("telecel_broadband", "Telecel Broadband", "bill_telecel_broadband", "Landline + broadband account", "broadband"),
}

export interface BillInputs { phone?: string; account?: string; email?: string; broadbandAccount?: string }
export interface NormalisedInputs { account: string; phone: string | null; email: string | null; broadbandAccount: string | null }

const ACCOUNT = /^[A-Za-z0-9-]{4,30}$/
const LANDLINE = /^0\d{9}$/
const BROADBAND = /^[A-Za-z0-9]{3,20}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phone233 = (p: string) => "233" + ghanaSignificant(p)!

export function normaliseInputs(biller: BillerKey, i: BillInputs): { ok: true; value: NormalisedInputs } | { ok: false; error: string } {
  const account = (i.account ?? "").trim()
  const phoneRaw = (i.phone ?? "").trim()
  const needPhone = biller === "ecg" || biller === "ghana_water"
  if (needPhone && !isValidGhanaMobile(phoneRaw)) return { ok: false, error: "Enter a valid Ghana mobile number" }
  const phone = needPhone ? phone233(phoneRaw) : null
  if (biller === "ecg") {
    if (account && !ACCOUNT.test(account)) return { ok: false, error: "Enter a valid meter or account number" }
    return { ok: true, value: { account, phone, email: null, broadbandAccount: null } }
  }
  if (biller === "telecel_broadband") {
    const bb = (i.broadbandAccount ?? "").trim()
    if (!LANDLINE.test(account)) return { ok: false, error: "Enter the 10-digit landline (e.g. 0302450262)" }
    if (!BROADBAND.test(bb)) return { ok: false, error: "Enter the broadband account number (e.g. P0444101)" }
    return { ok: true, value: { account, phone: null, email: null, broadbandAccount: bb } }
  }
  if (!ACCOUNT.test(account)) return { ok: false, error: `Enter a valid ${BILLERS[biller].inputHint.toLowerCase()}` }
  if (biller === "ghana_water") {
    const email = (i.email ?? "").trim()
    if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email (Ghana Water requires it)" }
    return { ok: true, value: { account, phone, email, broadbandAccount: null } }
  }
  return { ok: true, value: { account, phone: null, email: null, broadbandAccount: null } }
}

export function lookupRequest(biller: BillerKey, n: NormalisedInputs): { destination: string; mobile?: string } {
  if (biller === "ecg") return { destination: n.phone! }
  if (biller === "ghana_water") return { destination: n.account, mobile: n.phone! }
  return { destination: n.account }
}

export interface ParsedLookup {
  customerName: string | null
  amountDue: number | null
  sessionId: string | null
  meters: { meter: string; name: string | null; outstanding: number | null }[]
}
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null
}
const keyOf = (d: string) => d.trim().toLowerCase().replace(/[\s_-]/g, "")

export function parseLookup(biller: BillerKey, items: HubtelQueryItem[]): ParsedLookup {
  const out: ParsedLookup = { customerName: null, amountDue: null, sessionId: null, meters: [] }
  for (const it of Array.isArray(items) ? items : []) {
    const display = String(it?.Display ?? "")
    const value = String(it?.Value ?? "").trim()
    if (biller === "ecg") {
      if (!value) continue
      const name = display.trim().replace(/\s*\([^)]*\)\s*$/, "").trim()
      out.meters.push({ meter: value, name: name || null, outstanding: num(it?.Amount) })
      continue
    }
    const k = keyOf(display)
    if (k === "name") out.customerName = value || null
    else if (k === "amountdue") out.amountDue = num(value) ?? num(it?.Amount)
    else if (k === "sessionid") out.sessionId = value || null
  }
  return out
}

export function suggestedAmount(amountDue: number | null): number {
  if (amountDue === null || !Number.isFinite(amountDue) || amountDue <= 0) return 0
  return Math.round(amountDue * 100) / 100
}

export function purchaseFields(
  biller: BillerKey,
  v: { account: string; phone: string | null; email: string | null; broadbandAccount: string | null; sessionId: string | null },
): { destination: string; bundle?: string; extra?: { email?: string; sessionId?: string } } {
  if (biller === "ecg") return { destination: v.phone!, bundle: v.account }
  if (biller === "ghana_water") return { destination: v.phone!, bundle: v.account, extra: { email: v.email!, sessionId: v.sessionId! } }
  if (biller === "telecel_broadband") return { destination: v.account, bundle: v.broadbandAccount! }
  return { destination: v.account }
}
```

- [ ] **Step 4:** Run → pass. **Step 5: Commit** `feat(bills): biller definitions, input normalisation and tolerant lookup parsers`.

---

### Task 4: Signed verify token

**Files:** Create `lib/bills/token.ts`, `lib/bills/token.test.ts`.

**Interfaces — Produces:** `BILL_TOKEN_TTL_MS = 600_000`; `VerifiedBill { userId: string; biller: BillerKey; account: string; phone: string | null; email: string | null; broadbandAccount: string | null; sessionId: string | null; customerName: string | null; verified: boolean; issuedAt: number }`; `signBillToken(v: VerifiedBill, secret: string): string`; `verifyBillToken(token: string, secret: string, userId: string, now: number): VerifiedBill | null`.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest"
import { BILL_TOKEN_TTL_MS, signBillToken, verifyBillToken, type VerifiedBill } from "./token"

const S = "x".repeat(40)
const v: VerifiedBill = { userId: "u1", biller: "dstv", account: "7029864396", phone: null, email: null, broadbandAccount: null, sessionId: null, customerName: "John", verified: true, issuedAt: 1_000_000 }

describe("bill verify token", () => {
  it("round-trips for the same user within 10 minutes", () => {
    expect(verifyBillToken(signBillToken(v, S), S, "u1", 1_000_000 + BILL_TOKEN_TTL_MS)).toEqual(v)
  })
  it("rejects expiry, other user, wrong secret, tampering, garbage", () => {
    const t = signBillToken(v, S)
    expect(verifyBillToken(t, S, "u1", 1_000_000 + BILL_TOKEN_TTL_MS + 1)).toBeNull()
    expect(verifyBillToken(t, S, "u2", 1_000_001)).toBeNull()
    expect(verifyBillToken(t, "y".repeat(40), "u1", 1_000_001)).toBeNull()
    const [body, sig] = t.split(".")
    const forged = Buffer.from(JSON.stringify({ ...v, account: "9999999999" })).toString("base64url") + "." + sig
    expect(verifyBillToken(forged, S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken(body, S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken("", S, "u1", 1_000_001)).toBeNull()
    expect(verifyBillToken("a.b.c", S, "u1", 1_000_001)).toBeNull()
  })
  it("fails closed on an empty secret", () => {
    expect(() => signBillToken(v, "")).toThrow()
    expect(verifyBillToken(signBillToken(v, S), "", "u1", 1_000_001)).toBeNull()
  })
})
```

- [ ] **Step 2:** Run → fails. **Step 3: Implement:**

```ts
import { createHmac, timingSafeEqual } from "crypto"
import { isBillerKey, type BillerKey } from "./billers"

export const BILL_TOKEN_TTL_MS = 10 * 60_000
const DOMAIN = "bills-verify:"

export interface VerifiedBill {
  userId: string; biller: BillerKey; account: string; phone: string | null; email: string | null
  broadbandAccount: string | null; sessionId: string | null; customerName: string | null; verified: boolean; issuedAt: number
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(DOMAIN + body).digest("hex")

export function signBillToken(v: VerifiedBill, secret: string): string {
  if (!secret) throw new Error("bills: token secret not configured")
  const body = Buffer.from(JSON.stringify(v)).toString("base64url")
  return `${body}.${mac(body, secret)}`
}

export function verifyBillToken(token: string, secret: string, userId: string, now: number): VerifiedBill | null {
  if (!secret || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const want = Buffer.from(mac(body, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  let v: any
  try { v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) } catch { return null }
  if (!v || v.userId !== userId || !isBillerKey(v.biller) || typeof v.issuedAt !== "number") return null
  if (now - v.issuedAt > BILL_TOKEN_TTL_MS || now < v.issuedAt - 60_000) return null
  return v as VerifiedBill
}
```

- [ ] **Step 4:** Run → pass. **Step 5: Commit** `feat(bills): HMAC-signed 10-minute verify token bound to the user`.

---

### Task 5: Verify / pay / dispatch orchestration

**Files:** Create `lib/bills/service.ts`, `lib/bills/service.test.ts`.

**Interfaces — Consumes:** Tasks 2–4; Phase 1 `PurchaseInput`, `HubtelCsTx`, errors (`HubtelOutcomeUnknownError`, `HubtelDuplicateOrderError`), `HubtelCsConfig`.
**Produces:**

```ts
export interface BillOrderRow {
  id: string; reference_code: string; user_id: string; biller: BillerKey; account_number: string; phone: string | null
  email: string | null; broadband_account: string | null; session_id: string | null; customer_name: string | null
  verified: boolean; amount: number; status: "pending" | "processing" | "completed" | "failed" | "refunded"
  payment_status: "unpaid" | "paid" | "refunded"; hubtel_client_reference: string | null; commission: number | null
  failure_reason: string | null; notes: string | null; created_at: string; updated_at: string
}
export interface BillsDeps {
  getBillsConfig(): Promise<BillsConfig>
  getHubtelConfig(): Promise<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }>
  query(serviceKey: HubtelCsServiceKey, destination: string, params?: { mobile?: string }):
    Promise<{ ok: true; data: HubtelQueryItem[] } | { ok: false; error: string; code?: string }>
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  insertOrder(row: Omit<BillOrderRow, "id" | "created_at" | "updated_at" | "hubtel_client_reference" | "commission" | "failure_reason" | "notes">): Promise<BillOrderRow>
  updateOrder(id: string, patch: Partial<BillOrderRow>, onlyFromStatuses?: BillOrderRow["status"][]): Promise<number>
  debitWallet(userId: string, amount: number): Promise<"ok" | "insufficient">   // throws on RPC error
  alert(message: string): Promise<void>
  newReference(): string                       // e.g. "BILL-" + 12 hex
  secret: string
  now(): number
}
export type VerifyResult =
  | { ok: true; customerName: string | null; amountDue: number | null; suggestedAmount: number; token?: string;
      meters?: { meter: string; name: string | null; outstanding: number | null; token: string }[] }
  | { ok: false; status: number; error: string }
export function verifyBill(d: BillsDeps, userId: string, biller: string, inputs: BillInputs & { addMeter?: boolean; consent?: boolean }): Promise<VerifyResult>
export type PayResult = { ok: true; order: BillOrderRow } | { ok: false; status: number; error: string; order?: BillOrderRow }
export function payBill(d: BillsDeps, userId: string, token: string, amount: number): Promise<PayResult>
export function dispatchBillOrder(d: BillsDeps, order: BillOrderRow): Promise<BillOrderRow["status"]>
```

Rules:
- `verifyBill`: unknown biller ⇒ 400; bills or biller disabled ⇒ 403 "This biller is not available"; Hubtel disabled ⇒ 503; `normaliseInputs` error ⇒ 400; `query` not ok ⇒ 422 "Couldn't verify this account: <msg>" (no token). ECG without `addMeter`: return `meters` each with its own token (`verified: true`, `account` = meter, `customerName` = name); no meters ⇒ `ok: true, meters: []`. ECG with `addMeter`: requires `account` and `consent === true` (else 400 "Tick to confirm linking …"); if the typed meter is in the lookup list ⇒ `verified: true` + its name, else `verified: false`, name null. Other billers: one token; Ghana Water requires a parsed `sessionId` (else 422).
- `payBill` order: `verifyBillToken` (null ⇒ 400 "Please verify the account again"); bills + biller enabled (403); `checkBillAmount` (400); Hubtel config enabled, service enabled, not paused (503 "Temporarily unavailable") — ALL before any write; then `insertOrder` (status pending, payment_status unpaid); `debitWallet` — `"insufficient"` ⇒ `updateOrder(failed, failure_reason "Insufficient wallet balance")` and 402, nothing sent; RPC throw ⇒ order failed "Payment error", 500; then `updateOrder({ payment_status: "paid" })`; if `autoFulfil` ⇒ `dispatchBillOrder`; return the fresh order.
- `dispatchBillOrder` (only for `pending` + `paid`): build `PurchaseInput` from the order via `purchaseFields` (`serviceKey` from `BILLERS`, `orderTable: "hubtel_bill_orders"`, `orderId: order.id`); on a tx in `pending|created` ⇒ `updateOrder({ status: "processing", hubtel_client_reference }, ["pending"])`; `needs_review` ⇒ processing + `alert` "outcome unknown, do not resend"; `fulfilled`/`failed` returned synchronously were already applied by the adapter; `HubtelDuplicateOrderError` ⇒ no-op; `HubtelOutcomeUnknownError` ⇒ processing + note with the ref + alert; any other error (raised before the POST) ⇒ stays `pending` (paid) with note "Not sent: <reason>" + alert. Never throws; never retries.

- [ ] **Step 1: Failing tests** `lib/bills/service.test.ts` — build a fake `BillsDeps` (in-memory orders array; `debitWallet` returns `"ok"`/`"insufficient"`; counters for `purchase`; `secret = "s".repeat(40)`; `now = () => 1_000_000`). Required cases:
  1. verify DSTV returns name, suggested amount and a token that `payBill` accepts.
  2. verify with bills disabled ⇒ 403, `query` not called.
  3. verify ECG phone-only ⇒ `meters` with tokens; addMeter without consent ⇒ 400; addMeter with consent and unknown meter ⇒ token with `verified:false`.
  4. Ghana Water lookup without sessionId ⇒ 422.
  5. pay with tampered/expired/other-user token ⇒ 400 and no `insertOrder`, no `debitWallet`, no `purchase`.
  6. pay when Hubtel paused, or biller switched off after verify ⇒ 503/403 with NO order inserted and NO debit (Review Focus 2).
  7. pay amount out of limits / 3 decimals ⇒ 400, nothing charged.
  8. insufficient wallet ⇒ 402, order `failed`, `purchase` never called.
  9. happy path (autoFulfil on) ⇒ order inserted → debited → `purchase` called exactly once with the right fields (Ghana Water includes `extra.email` + `extra.sessionId` from the token) → order `processing` + `hubtel_client_reference`.
  10. autoFulfil off ⇒ order `pending` + `paid`, `purchase` not called.
  11. purchase throws `HubtelPausedError` after debit ⇒ order stays `pending` + `paid`, note "Not sent", alert sent, `purchase` called once (Review Focus 3).
  12. purchase throws `HubtelOutcomeUnknownError` ⇒ `processing` + alert; second `dispatchBillOrder` on a non-pending order does nothing.
- [ ] **Step 2:** Run → fails. **Step 3:** Implement exactly per the rules above. **Step 4:** Run → pass. **Step 5: Commit** `feat(bills): verify, pay and dispatch orchestration (charge only after all checks, one POST max)`.

---

### Task 6: `hubtel_bill_orders` order adapter + customer notifications

**Files:** Create `lib/hubtel-cs/adapters/bill-orders.ts`, `lib/hubtel-cs/adapters/bill-orders.test.ts`; modify `lib/hubtel-cs/runtime.ts` (register), `lib/hubtel-cs/runtime.test.ts` (assert registration).

**Interfaces — Produces:** `BILL_ORDERS_TABLE = "hubtel_bill_orders"`; `createBillOrdersAdapter(deps: { get(orderId): Promise<{ status; payment_status; user_id; biller; amount; account_number } | null>; update(orderId, patch, onlyFromStatuses: string[]): Promise<number>; creditWallet(userId, amount, referenceId, description): Promise<void>; notify(userId, title, message, orderId): Promise<void> }): OrderAdapter`; `billOrdersAdapterFor(db): OrderAdapter`.

Rules:
- `onFulfilled(tx)`: `update(order_id, { status: "completed", commission: tx.commission, notes: "Delivered via Hubtel [hcsRef:…]" }, ["pending","processing"])`; if rows > 0 ⇒ `notify` "Bill paid" (`"<Biller> GHS x.xx to <account> was delivered."`).
- `onFailed(tx)`: `update(order_id, { status: "failed", failure_reason }, ["pending","processing"])`; if rows > 0 ⇒ `notify` "Bill payment failed" ("…is under review; a refund follows if it was not delivered."). Never touches `completed`/`refunded`.
- `refundToWallet(tx, adminId)`: `get` the order; only if `status === "failed"` and `payment_status === "paid"`; `creditWallet(user_id, amount, "bill-refund-<order id>", "Refund: <biller> bill <reference>")`; then `update(order_id, { status: "refunded", payment_status: "refunded" }, ["failed"])`; `notify` "Bill refunded". Else return `{ refunded: false, message: "Order is not a paid failed order" }`. Throws on DB/RPC errors (the refund claim then stays, per Phase 1).
- Real deps: `get`/`update` via the service-role db (`update` uses `.in("status", onlyFromStatuses).select("id")` and returns `data.length`, throws on error); `creditWallet` via `db.rpc("credit_wallet_safely", { p_user_id, p_amount, p_reference_id, p_description, p_source: "bill_refund" })` (throw on error; check the RPC's real parameter list in `lib/payment-cleanup-service.ts` and match it); `notify` inserts into `notifications` (`user_id, title, message, type: "order_update", reference_id, action_url: "/dashboard/bills", read: false`) and calls `sendPushToUser(userId, { title, body: message, data: { url: "/dashboard/bills" } })` from `lib/push-service.ts`, both best-effort (catch + log).
- Register in `getHubtelCsRuntime()` next to the airtime adapter.

- [ ] Steps: failing tests (completed from processing ⇒ notify once; onFulfilled on `refunded` ⇒ 0 rows, no notify; onFailed from pending ⇒ failed + notify; refund only on failed+paid, credit reference `bill-refund-<id>`, then refunded; refund on completed ⇒ `refunded:false`, no credit; update error propagates; runtime registers `hubtel_bill_orders`) → implement → pass → commit `feat(bills): hubtel_bill_orders adapter with notifications and idempotent wallet refund`.

---

### Task 7: Customer API routes

**Files:** Create `lib/bills/runtime.ts` (real `BillsDeps` + order queries), `app/api/bills/availability/route.ts`, `app/api/bills/verify/route.ts`, `app/api/bills/pay/route.ts`, `app/api/bills/orders/route.ts`.

- `lib/bills/runtime.ts` — `getBillsRuntime()` builds `BillsDeps` from `getHubtelCsRuntime()` (db, `getConfig` for Hubtel, `client.query`, `client.purchase`) plus: `insertOrder`/`updateOrder` on `hubtel_bill_orders` (update guarded with `.in("status", …)` when given, returns rows), `debitWallet` via `deduct_wallet` (`{ p_user_id, p_amount }`; empty result ⇒ `"insufficient"`, error ⇒ throw — same handling as `lib/airtime-service.ts`), `alert` via `notifyAdmins(message, "bills_review", undefined, true)`, `newReference` = `"BILL-" + randomBytes(6).toString("hex").toUpperCase()`, `secret = process.env.HUBTEL_CS_CALLBACK_SECRET ?? ""`, `now = Date.now`. Also `listUserBillOrders(userId, filters)` (biller/status/date range, limit 50, newest first) and `getBillsAvailability()` → `{ enabled, billers: [{ key, label, logo, inputHint, page, min, max }] }` (only enabled billers; `enabled` false when master off).
- Routes (auth via the `Authorization: Bearer` + `supabase.auth.getUser(token)` pattern from `app/api/airtime/purchase/route.ts`; rate-limit verify and pay with the repo's `applyRateLimit` like `app/api/v1/airtime/route.ts`):
  - `GET /api/bills/availability` — public-ish (auth not required), returns availability; never throws (500 JSON on error).
  - `POST /api/bills/verify` — `{ biller, phone?, account?, email?, broadbandAccount?, addMeter?, consent? }` → `verifyBill`; returns `{ status, json }` mapped to HTTP.
  - `POST /api/bills/pay` — `{ token, amount }` (amount number or numeric string) → `payBill`.
  - `GET /api/bills/orders?biller=&status=&from=&to=` → the user's orders.
- Tests: `lib/bills/runtime.test.ts` for `getBillsAvailability` shaping (fake db) and the `deduct_wallet` mapping. Commit `feat(bills): customer API routes (availability, verify, pay, orders)`.

---

### Task 8: Biller logos, customer pages and sidebar links

**Files:** Create `public/billers/{ecg,ghana_water,dstv,gotv,startimes,telecel_broadband}.png`, `components/bills/BillPayFlow.tsx`, `app/dashboard/bills/page.tsx`, `app/dashboard/broadband/page.tsx`; modify `lib/dashboard-nav-items.ts`, `lib/nav-new.ts`, `components/layout/sidebar.tsx` (or wherever `menuItems` render).

- **Logos:** download each biller's official logo (official website or Wikimedia Commons) with `curl` into `public/billers/<key>.png`, resized/compressed to ≤ 30 KB, square-ish 128×128 with transparent/white background (use `sharp` via a one-off node script if available in node_modules; otherwise keep the original if ≤ 60 KB). Record each source URL in `public/billers/SOURCES.md`. If a download fails, create a simple generated placeholder (initials on a tinted square, PNG) and note it in SOURCES.md.
- **`BillPayFlow`** (shared by both pages): props `{ billers: AvailabilityBiller[] }`; biller card grid (logo, name, hint) → bottom sheet/dialog per the verify-sheet reference: title, "Pay with your wallet · GHS min–max", the biller's fields (ECG: phone → linked meters list as tappable cards with name/meter/outstanding + "Add another meter" with meter input and the consent checkbox "This links meter {meter} to phone {phone} with ECG"; Ghana Water: meter, phone (prefilled from profile if available), email; TV: account; Broadband: landline + broadband account), **Verify account →** → confirm step (customer name or "Unverified — entered manually", account, amount due, amount input prefilled with the suggested amount, limits, wallet balance) → **Pay GHS x.xx** (disabled while in flight; double-submit guard with a ref) → success state ("Processing — we'll notify you") and refresh of Recent payments. Errors shown inline with the API message; 400 "verify again" returns to the input step.
- **`/dashboard/bills`** matches `customer-utility-bills-home.png`: header "Utility bills" + subtitle, wallet balance card, "PAY A BILL" grid (billers with `page === "bills"`), "RECENT PAYMENTS" with filters (biller, status, source, date range) + refresh, empty state ("No bills paid yet…"), rows (logo, biller, account/name, amount, status pill, time). If availability `enabled` is false or no billers ⇒ a friendly "Utility bills are not available yet" card.
- **`/dashboard/broadband`**: same layout with only `telecel_broadband`.
- **Sidebar:** add `{ href: "/dashboard/bills", label: "Utility Bills", icon: Lightbulb, roles: ["user","admin","dealer","sub_agent"], feature: "bills" }` and `{ href: "/dashboard/broadband", label: "Telecel Broadband", icon: Wifi, roles: [same], feature: "broadband" }` to `menuItems`; add optional `feature?: "bills" | "broadband"` to `NavItem`; the sidebar fetches `/api/bills/availability` once (client-side, cached in state) and hides `feature` items unless available (bills: any enabled biller with page "bills"; broadband: telecel_broadband enabled). Add both hrefs to `NEW_NAV_ITEMS` (`since: "2026-10-13"`) and render the NEW tag the same way existing NEW items do. Update `lib/dashboard-nav-items.test.ts` if it asserts the list.
- Verify by tsc + lint; screenshot at 500px and desktop with the headless-Chrome method if a dev server can run (else note it). Commit `feat(bills): customer Utility Bills and Telecel Broadband pages, biller logos, sidebar links`.

---

### Task 9: Admin API and `/admin/utility-bills` page

**Files:** Create `app/api/admin/utility-bills/config/route.ts` (GET/POST), `app/api/admin/utility-bills/orders/route.ts` (GET), `app/api/admin/utility-bills/dispatch/route.ts` (POST), `app/api/admin/utility-bills/refund/route.ts` (POST), `lib/bills/admin.ts` (query + stats helpers), `app/admin/utility-bills/page.tsx`; modify the admin sidebar section (add "Utility Bills" link after Hubtel Commission) and `NEW_NAV_ITEMS`.

- All admin routes: `requireAdmin` from `lib/hubtel-cs/admin-route.ts` (honours rate-limit errorResponse), mutating routes also reject a missing `userId` (403) and write `auditLog`.
- `config` GET → `{ config: BillsConfig, billers: BILLERS }`; POST → `validateBillsPatch` → `setBillsConfig`.
- `orders` GET `?q=&status=&biller=&paidOnly=&from=&to=&limit=&offset=` → `{ rows, total, stats: { totalSales, orders, completed, inFlight, commission, failed, refunded } }` (stats over the filtered window, computed in SQL or by an aggregate query — never by summing a 1000-row page). Each row includes the purchaser's display name/email (join `users` or the repo's profile table — check how `app/api/admin/airtime` lists purchasers and copy it).
- `dispatch` POST `{ orderId }` → only `pending` + `paid` orders → `dispatchBillOrder`.
- `refund` POST `{ orderId, note }` → finds the order's ledger row by `hubtel_client_reference` and calls Phase 1 `adminRefund(deps, ref, adminId, { force })` (so the refund claim applies); if the order never reached Hubtel (no ledger row, still `pending`+`paid` after a "Not sent" error) → mark it `failed` first via a guarded update, then refund through the adapter's `refundToWallet` directly with an idempotent reference (`bill-refund-<id>`); note required.
- Page per the two admin references: header "Utility Bills" + subtitle + Refresh; tabs **Orders | Settings | Refund Queue** (+ disabled "Commission Wallets · coming soon").
  - Orders: the five stat cards (Total sales, Orders: completed · in flight, Hubtel commission earned, Partner share paid → show "—" with "3b", Failed / Refunded); filters (search, status, biller, source = Dashboard, Paid only, From/To); rows exactly like the reference (biller logo + name, ACCOUNT name or "Unverified — entered manually" + number, PURCHASER + source tag, STATUS pills Paid/Completed|Processing|Pending|Failed|Refunded, TIME, AMOUNT + "+x comm."), eye → details drawer (all fields, Hubtel ref, notes), **Sync** on processing rows (Phase 1 `/api/admin/hubtel-cs/check-status` with the ref), **Dispatch** on pending+paid rows when auto-fulfil is off.
  - Settings: Feature gates card (Utility bills enabled, Auto-fulfilment), Enabled billers with logos + per-biller min/max inputs (validated 1 ≤ min ≤ max ≤ 10,000) and Save; Surfaces / payment rail / partner split shown disabled "Coming in Phase 3b".
  - Refund Queue: failed+paid orders with **Refund to wallet** (confirm dialog, note required, in-flight guard); refunded list below.
- Commit `feat(bills): admin Utility Bills page (orders, settings, refund queue) and API`.

---

### Task 10: Verification, runbook, rollout gate

- [ ] Full suite (only the 9 known `lib/order-health-service.test.ts` failures allowed), `tsc` 0, real `next build` with placeholder env → exit 0.
- [ ] Append "Phase 3a — Utility Bills" to `docs/hubtel-commission-services/runbook.md`: apply 0117 before merge (verify table + RPC grants; smoke `select utility_bills_config_patch('{}'::jsonb)`); enable in order (master → one biller → one live payment of the minimum to a known account → others); Hubtel service switches `bill_*` must be on in `/admin/hubtel-commission`; refunds only via the Utility Bills Refund Queue; ECG link side effect; Ghana Water needs a fresh verification within 10 minutes; logos source file.
- [ ] Commit; STOP — no migration apply / push without the user's go-ahead.

## Self-review

- Spec §3 billers/parsing → Task 3; §4 data/config → Tasks 1–2; §5 flow/token/pay order → Tasks 4–5, 7–8; §6 broadband → Tasks 3, 8; §7 adapter/notifications/refund → Task 6; §8 admin → Task 9; §9 sidebar/NEW → Tasks 8–9; §10 errors → Task 5 tests; §11 tests → each task; §12 rollout → Task 10.
- Names: `BillerKey`, `BILLER_KEYS`, `BILLERS`, `normaliseInputs`, `lookupRequest`, `parseLookup`, `suggestedAmount`, `purchaseFields`, `VerifiedBill`, `signBillToken`, `verifyBillToken`, `BillsConfig`, `resolveBillsConfig`, `validateBillsPatch`, `checkBillAmount`, `getBillsConfig`, `setBillsConfig`, `BillsDeps`, `verifyBill`, `payBill`, `dispatchBillOrder`, `BillOrderRow`, `createBillOrdersAdapter`, `billOrdersAdapterFor`, `getBillsRuntime` are defined once and reused with the same names.
