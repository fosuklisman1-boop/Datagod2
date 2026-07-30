# WhatsApp Shop Bot Conversational AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI conversation layer to the WhatsApp shop bot (sub-agent storefront number) so freetext feels human, while every money-moving step stays on the existing deterministic menu state machine.

**Architecture:** `shopWaRouter` keeps handling digits/menu-valid input unchanged. A new `shopNaturalToDigit` mapper converts obvious phrases ("mtn", "2gb", "cancel") to menu digits with zero AI cost. Genuine freetext escapes (`shopWaRouter` returns `''`) to a new `handleShopWithAI` handler (`lib/whatsapp-bot/shop-ai.ts`) that mirrors the main bot's `runAgenticLoop` pattern with three shop-scoped tools. The riskiest tool, `place_shop_order`, never charges money — it re-validates and stages a `WaShopSession` at the exact `*_CONFIRM` step, and the existing (untouched) CONFIRM handlers do the real charge. A new `wa_shop_customer_prefs` table remembers each phone's last shop so returning customers skip the code prompt.

**Tech Stack:** Next.js 15 API routes, Supabase (Postgres + service-role client), Upstash Redis (shop session store, already in use), Anthropic SDK via the existing `runAgenticLoop`/`AIProvider` abstraction, Vitest.

## Global Constraints

- Currency is always GHS — never invent a price; all shop prices come from `fetchShopBundles`/board pricing helpers, never from AI memory.
- Money-moving steps (`CONFIRM`, `AIRTIME_CONFIRM`, `RC_CONFIRM`, `*_ENTER_PAYMENT_PHONE`, `SUBMIT_OTP`) never escape to AI — unrecognized input there re-prompts the same deterministic screen.
- `place_shop_order` never creates an order row or calls Paystack — it only writes a `WaShopSession` via the existing `setSession`; the untouched CONFIRM handlers do the actual charge and re-verify price/availability server-side regardless of what was staged.
- No new tools are exposed on the shop AI beyond `resolve_shop_code`, `get_shop_packages`, `place_shop_order` — wallet/complaints/AFA/account-verification stay out of scope per the spec.
- AI provider/model resolution reuses `resolveProviderForContext("whatsapp", aiConfig)` — no new admin config surface.
- RLS on `wa_shop_customer_prefs` is service-role only, matching this codebase's locked-down convention (`0060`/RLS grant model).

---

## File Structure

- **Create:** `migrations/20260730_wa_shop_customer_prefs.sql` — new table.
- **Create:** `lib/whatsapp-bot/shop-prefs.ts` — get/set/clear the phone→shop mapping. Test: `lib/whatsapp-bot/shop-prefs.test.ts`.
- **Modify:** `lib/ai-tools.ts` — add `"whatsapp_shop"` to `AIChatContext`, three new tool defs, an `aiTools()` branch, and `executeToolCall` cases.
- **Create:** `lib/whatsapp-bot/shop-ai.ts` — `handleShopWithAI()`, system-prompt builder, shop-context resolver. Test: `lib/whatsapp-bot/shop-ai.test.ts`.
- **Modify:** `lib/whatsapp-bot/shop-router.ts` — add `shopNaturalToDigit`, AI-escape sentinel, returning-customer greeting at `ENTER_CODE`. Existing tests: `lib/whatsapp-bot/shop-router.test.ts` (extend).
- **Modify:** `app/api/whatsapp/webhook/route.ts` — shop branch gets the rate cap + AI escape call.

---

### Task 1: `wa_shop_customer_prefs` table + shop-prefs module

**Files:**
- Create: `migrations/20260730_wa_shop_customer_prefs.sql`
- Create: `lib/whatsapp-bot/shop-prefs.ts`
- Test: `lib/whatsapp-bot/shop-prefs.test.ts`

**Interfaces:**
- Produces: `getShopPref(phone: string): Promise<{ shopCodeId: string } | null>`, `setShopPref(phone: string, shopCodeId: string): Promise<void>`, `clearShopPref(phone: string): Promise<void>` — used by Task 4 (router) and Task 3 (AI handler).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/20260730_wa_shop_customer_prefs.sql
-- Remembers each WhatsApp customer's last-used shop code so returning
-- customers on the shop bot skip re-entering their shop code.
CREATE TABLE IF NOT EXISTS public.wa_shop_customer_prefs (
  phone TEXT PRIMARY KEY,
  shop_code_id UUID NOT NULL REFERENCES public.ussd_shop_codes(id) ON DELETE CASCADE,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wa_shop_customer_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role only" ON public.wa_shop_customer_prefs;
CREATE POLICY "Service role only" ON public.wa_shop_customer_prefs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

- [ ] **Step 2: Write the failing test**

```typescript
// lib/whatsapp-bot/shop-prefs.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { getShopPref, setShopPref, clearShopPref } from "@/lib/whatsapp-bot/shop-prefs"

const fakeDb = vi.hoisted(() => ({
  rows: new Map<string, { shop_code_id: string; last_used_at: string }>(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== "wa_shop_customer_prefs") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, phone: string) => ({
            maybeSingle: () => Promise.resolve({
              data: fakeDb.rows.has(phone) ? { shop_code_id: fakeDb.rows.get(phone)!.shop_code_id } : null,
            }),
          }),
        }),
        upsert: (row: { phone: string; shop_code_id: string; last_used_at: string }) => {
          fakeDb.rows.set(row.phone, { shop_code_id: row.shop_code_id, last_used_at: row.last_used_at })
          return Promise.resolve({ error: null })
        },
        delete: () => ({
          eq: (_col: string, phone: string) => {
            fakeDb.rows.delete(phone)
            return Promise.resolve({ error: null })
          },
        }),
      }
    },
  }),
}))

describe("shop-prefs", () => {
  beforeEach(() => { fakeDb.rows.clear() })

  it("returns null when no pref exists", async () => {
    expect(await getShopPref("233559919037")).toBeNull()
  })

  it("round-trips a set pref", async () => {
    await setShopPref("233559919037", "shop-code-1")
    expect(await getShopPref("233559919037")).toEqual({ shopCodeId: "shop-code-1" })
  })

  it("overwrites an existing pref on re-set", async () => {
    await setShopPref("233559919037", "shop-code-1")
    await setShopPref("233559919037", "shop-code-2")
    expect(await getShopPref("233559919037")).toEqual({ shopCodeId: "shop-code-2" })
  })

  it("clears a pref", async () => {
    await setShopPref("233559919037", "shop-code-1")
    await clearShopPref("233559919037")
    expect(await getShopPref("233559919037")).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/whatsapp-bot/shop-prefs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/whatsapp-bot/shop-prefs'`

- [ ] **Step 4: Write the implementation**

```typescript
// lib/whatsapp-bot/shop-prefs.ts
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function getShopPref(phone: string): Promise<{ shopCodeId: string } | null> {
  const { data } = await supabase
    .from("wa_shop_customer_prefs")
    .select("shop_code_id")
    .eq("phone", phone)
    .maybeSingle()
  return data ? { shopCodeId: data.shop_code_id } : null
}

export async function setShopPref(phone: string, shopCodeId: string): Promise<void> {
  await supabase
    .from("wa_shop_customer_prefs")
    .upsert({ phone, shop_code_id: shopCodeId, last_used_at: new Date().toISOString() })
}

export async function clearShopPref(phone: string): Promise<void> {
  await supabase
    .from("wa_shop_customer_prefs")
    .delete()
    .eq("phone", phone)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/whatsapp-bot/shop-prefs.test.ts`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add migrations/20260730_wa_shop_customer_prefs.sql lib/whatsapp-bot/shop-prefs.ts lib/whatsapp-bot/shop-prefs.test.ts
git commit -m "feat(whatsapp-shop): add wa_shop_customer_prefs table + shop-prefs module"
```

---

### Task 2: Shop-scoped AI tools (`resolve_shop_code`, `get_shop_packages`, `place_shop_order`)

**Files:**
- Modify: `lib/ai-tools.ts`
- Test: `lib/ai-tools.test.ts` (create if it doesn't exist, else extend)

**Interfaces:**
- Consumes: `resolveShopCode(code, client?)` and `fetchShopNetworks(shopId, parentShopId?, client?)` from `lib/shop-commerce/shop-code.ts`; `fetchShopBundles(shopId, network, parentShopId?, client?)` from `lib/shop-commerce/pricing.ts`; `detectAirtimeNetwork`, `isAirtimeEnabled`, `getAirtimeLimits`, `airtimeBaseFeeRate`, `splitInclusive`, `airtimeNetworkKey` from `lib/airtime-pricing.ts`; `isExamBoardEnabled`, `getAvailableCount`, `getMaxQuantity`, `calculateRCPrice` from `lib/results-checker-service.ts`; `validateNetworkPrefix` from `lib/phone-format.ts`; `getPrefixValidationConfig` from `lib/network-prefix-config.ts`; `paystackProviderFromPhone` from `lib/ussd/paystack-provider.ts`; `setSession` (as `setShopSession`) from `lib/whatsapp-bot/shop-session.ts`; `WaShopSession` from `lib/whatsapp-bot/shop-types.ts`; `setShopPref` from Task 1.
- Produces: `AIChatContext` gains `"whatsapp_shop"`. `aiTools("whatsapp_shop")` returns `[resolveShopCodeTool, getShopPackagesTool, placeShopOrderTool]`. `executeToolCall("resolve_shop_code" | "get_shop_packages" | "place_shop_order", input, ctx)` — `ctx.phone` is required for all three (the tool re-derives shop identity from `wa_shop_customer_prefs` + `resolveShopCode`, it is never passed shop state via `ctx`). Consumed by Task 3 (`shop-ai.ts`).

Read `lib/ai-tools.ts` around line 10 (`AIChatContext`), line 976 (`aiTools`), line 1108 (`ToolContext`), and line 1141 (`executeToolCall`) before starting — these are the exact insertion points.

- [ ] **Step 1: Add `"whatsapp_shop"` to `AIChatContext`**

In `lib/ai-tools.ts`, change:

```typescript
export type AIChatContext = "storefront" | "dashboard" | "admin" | "home" | "whatsapp"
```

to:

```typescript
export type AIChatContext = "storefront" | "dashboard" | "admin" | "home" | "whatsapp" | "whatsapp_shop"
```

- [ ] **Step 2: Write the failing test for tool definitions**

```typescript
// lib/ai-tools.test.ts (add this describe block; create the file with this
// content if it doesn't already exist)
import { describe, it, expect } from "vitest"
import { aiTools } from "@/lib/ai-tools"

describe("aiTools whatsapp_shop context", () => {
  it("returns exactly the three shop-scoped tools", () => {
    const tools = aiTools("whatsapp_shop").map(t => t.name)
    expect(tools).toEqual(["resolve_shop_code", "get_shop_packages", "place_shop_order"])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/ai-tools.test.ts`
Expected: FAIL — `aiTools("whatsapp_shop")` returns the admin tool list (falls through to the `else` branch) since no `whatsapp_shop` branch exists yet, so the array won't match.

- [ ] **Step 4: Add the three tool definitions**

Add these three `Anthropic.Tool` consts near `placeWhatsappOrderTool` (around line 851 in `lib/ai-tools.ts`):

```typescript
const resolveShopCodeTool: Anthropic.Tool = {
  name: "resolve_shop_code",
  description: "Look up a shop code the customer sent (e.g. 'AB12CD') to identify which storefront they're shopping at. Call this whenever the customer provides something that looks like a shop code, OR when you don't yet know which shop this conversation belongs to and the customer's message might contain one. On success you can then greet them by shop name and use get_shop_packages/place_shop_order. On failure, relay the reason and ask them to double-check the code.",
  input_schema: {
    type: "object" as const,
    properties: {
      code: { type: "string", description: "The shop code as the customer typed it." },
    },
    required: ["code"],
  },
}

const getShopPackagesTool: Anthropic.Tool = {
  name: "get_shop_packages",
  description: "Get this shop's REAL data bundle prices (optionally filtered by network), and its airtime/results-checker availability. Always call this before quoting a data bundle price or listing what a shop sells — never quote from memory or from an earlier message. Requires a shop to already be known (resolve_shop_code succeeded, or the customer is a returning customer).",
  input_schema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "Optional: 'MTN', 'Telecel', 'AirtelTigo', or 'AT-iShare' to filter data bundles to one network." },
    },
    required: [],
  },
}

const placeShopOrderTool: Anthropic.Tool = {
  name: "place_shop_order",
  description: "Place an order at the customer's current shop — DATA bundles, AIRTIME top-ups, or RESULTS-CHECKER voucher PINs. Call this ONLY after you've quoted the real price (via get_shop_packages) and the customer has clearly confirmed what they want, including the MoMo number to charge. It stages a final confirmation screen where THEY pick 'Pay now' or 'Cancel' — no money moves until they approve there. Never invent a price. Set `service`: 'data' needs network + size + recipient_phone + payment_phone; 'airtime' needs recipient_phone + amount + payment_phone (network auto-detected from recipient if omitted); 'rc' needs board + quantity + payment_phone. After calling, do NOT say the order is paid — only that it's ready for them to confirm.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: { type: "string", enum: ["data", "airtime", "rc"], description: "What to buy." },
      network: { type: "string", description: "DATA: exact network name from get_shop_packages. AIRTIME: 'MTN', 'Telecel', or 'AT' (optional, auto-detected). Not used for 'rc'." },
      size: { type: "string", description: "DATA only: bundle size exactly as get_shop_packages listed it." },
      recipient_phone: { type: "string", description: "DATA & AIRTIME: the Ghana number that receives the data/airtime, e.g. '0244123456'." },
      amount: { type: "string", description: "AIRTIME only: how much the customer pays in GHS." },
      board: { type: "string", description: "RC only: 'WASSCE', 'BECE', or 'NOVDEC'." },
      quantity: { type: "string", description: "RC only: how many voucher PINs." },
      payment_phone: { type: "string", description: "The Ghana MoMo number to charge, e.g. '0244123456'." },
    },
    required: ["service", "payment_phone"],
  },
}
```

- [ ] **Step 5: Wire the `aiTools()` branch**

In `lib/ai-tools.ts`, add this branch right before the final admin `return [` (i.e. right after the existing `if (context === "whatsapp") return [...]` block, around line 1030):

```typescript
  // WhatsApp shop bot: sub-agent storefront number — narrow tool set, no wallet/complaint tools.
  if (context === "whatsapp_shop") return [
    resolveShopCodeTool,
    getShopPackagesTool,
    placeShopOrderTool,
  ]
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run lib/ai-tools.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing test for `resolve_shop_code` execution**

Add to `lib/ai-tools.test.ts`:

```typescript
import { executeToolCall } from "@/lib/ai-tools"

vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: vi.fn(),
  fetchShopNetworks: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({
  setShopPref: vi.fn(),
  getShopPref: vi.fn(),
}))

import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { setShopPref } from "@/lib/whatsapp-bot/shop-prefs"

describe("executeToolCall resolve_shop_code", () => {
  const baseCtx = { baseUrl: "http://localhost:3000", phone: "233559919037" }

  it("resolves a valid active code and remembers it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN", "Telecel"])

    const result = await executeToolCall("resolve_shop_code", { code: "AB12CD" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(true)
    expect(result.shopName).toBe("Kofi's Data Hub")
    expect(setShopPref).toHaveBeenCalledWith("233559919037", "code-1")
  })

  it("returns a reason without remembering an invalid code", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    const result = await executeToolCall("resolve_shop_code", { code: "ZZZZZZ" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })

  it("rejects an inactive shop without remembering it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-2", shopId: "shop-2", shopName: "Ama's Shop",
      parentShopId: null, status: "suspended", tokenBalance: 5, whatsappActivated: true,
    })

    const result = await executeToolCall("resolve_shop_code", { code: "CD34EF" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npx vitest run lib/ai-tools.test.ts`
Expected: FAIL — `executeToolCall` has no `"resolve_shop_code"` case, so `result` is the default `{ error: "Unknown tool" }` (or similar) shape and `resolved` is `undefined`.

- [ ] **Step 9: Implement `resolve_shop_code`, `get_shop_packages`, `place_shop_order` in `executeToolCall`**

Add these three cases to the `switch (name)` block in `executeToolCall` (`lib/ai-tools.ts`, near the other WhatsApp cases around line 1425). Also add a small shared helper above `executeToolCall` for re-deriving the current shop from `ctx.phone`:

```typescript
// Re-derives which shop a WhatsApp-shop-bot conversation belongs to, purely from
// ctx.phone — the shop AI tools never trust a shop identity passed through ctx,
// since ToolContext/AgenticToolCtx are shared across every AI context and widening
// them with shop-only fields isn't worth it for three tools. Returns null if the
// phone has no remembered shop (customer hasn't given a code yet this session).
async function currentShopForPhone(phone: string) {
  const { getShopPref } = await import("@/lib/whatsapp-bot/shop-prefs")
  const { resolveShopCode } = await import("@/lib/shop-commerce/shop-code")
  const pref = await getShopPref(phone)
  if (!pref) return null
  // Re-resolve by code id isn't available (resolveShopCode takes a code, not an
  // id) — instead read the code string off ussd_shop_codes directly.
  const { createClient } = await import("@supabase/supabase-js")
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: codeRow } = await supabase.from("ussd_shop_codes").select("code").eq("id", pref.shopCodeId).maybeSingle()
  if (!codeRow?.code) return null
  return resolveShopCode(codeRow.code)
}
```

```typescript
      case "resolve_shop_code": {
        const phone = String(ctx.phone || "").trim()
        if (!phone) return { error: "phone is required" }
        const code = String(input.code ?? "").trim()
        if (!code) return { resolved: false, message: "Ask the customer for their shop code." }

        const { resolveShopCode, fetchShopNetworks } = await import("@/lib/shop-commerce/shop-code")
        const resolved = await resolveShopCode(code)
        if (!resolved) {
          return { resolved: false, message: "That shop code wasn't found — ask the customer to double-check it." }
        }
        if (resolved.status !== "active") {
          return { resolved: false, message: "That shop is currently unavailable — let the customer know and ask if they have another code." }
        }
        if (resolved.tokenBalance <= 0) {
          return { resolved: false, message: "That shop has no sessions left — tell the customer to contact the seller." }
        }
        if (!resolved.whatsappActivated) {
          return { resolved: false, message: "That shop isn't set up for WhatsApp ordering yet — let the customer know." }
        }

        const { setShopPref } = await import("@/lib/whatsapp-bot/shop-prefs")
        await setShopPref(phone, resolved.shopCodeId)

        const networks = await fetchShopNetworks(resolved.shopId, resolved.parentShopId ?? undefined)
        return {
          resolved: true,
          shopName: resolved.shopName,
          networks,
          message: `Shop resolved: ${resolved.shopName}. Greet the customer by shop name and ask what they'd like — data, airtime, or a results checker.`,
        }
      }

      case "get_shop_packages": {
        const phone = String(ctx.phone || "").trim()
        if (!phone) return { error: "phone is required" }
        const shop = await currentShopForPhone(phone)
        if (!shop) return { error: "no_shop", message: "No shop is known yet for this customer — ask for their shop code and call resolve_shop_code first." }

        const { fetchShopBundles } = await import("@/lib/shop-commerce/pricing")
        const { isAirtimeEnabled, getAirtimeLimits } = await import("@/lib/airtime-pricing")
        const { isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice } = await import("@/lib/results-checker-service")
        const { fetchShopNetworks } = await import("@/lib/shop-commerce/shop-code")

        const requestedNetwork = input.network ? String(input.network) : undefined
        const allNetworks = await fetchShopNetworks(shop.shopId, shop.parentShopId ?? undefined)
        const networksToQuote = requestedNetwork
          ? allNetworks.filter(n => n.toLowerCase() === requestedNetwork.toLowerCase())
          : allNetworks

        const bundlesByNetwork: Record<string, Array<{ size: string; price: number }>> = {}
        for (const network of networksToQuote) {
          const bundles = await fetchShopBundles(shop.shopId, network, shop.parentShopId ?? undefined)
          bundlesByNetwork[network] = bundles.map(b => ({ size: b.size, price: b.price }))
        }

        const { min: airtimeMin, max: airtimeMax } = await getAirtimeLimits()
        const airtimeAvailable: Record<string, boolean> = {}
        for (const network of ["MTN", "Telecel", "AT"]) {
          airtimeAvailable[network] = await isAirtimeEnabled(network)
        }

        const boards: Record<string, { available: number; maxPerOrder: number; unitPrice: number }> = {}
        for (const board of ["WASSCE", "BECE", "NOVDEC"] as const) {
          if (!(await isExamBoardEnabled(board))) continue
          const [avail, max, pricing] = await Promise.all([
            getAvailableCount(board),
            getMaxQuantity(),
            calculateRCPrice({ examBoard: board, quantity: 1, shopId: shop.shopId, applyBulk: false }),
          ])
          boards[board] = { available: avail, maxPerOrder: max, unitPrice: pricing.unitPrice }
        }

        return {
          shopName: shop.shopName,
          dataBundles: bundlesByNetwork,
          airtime: { available: airtimeAvailable, minGHS: airtimeMin, maxGHS: airtimeMax },
          resultsChecker: boards,
        }
      }

      case "place_shop_order": {
        // SAFETY MODEL (mirrors place_whatsapp_order): this tool writes no charge
        // code. It re-validates inputs against the DB, then stages the exact
        // WaShopSession fields the corresponding *_ENTER_PAYMENT_PHONE step would
        // have set, landing on the existing, untested-by-this-tool CONFIRM step —
        // which independently re-verifies price/availability before charging.
        const phone = String(ctx.phone || "").trim()
        if (!phone) return { error: "phone is required" }
        const shop = await currentShopForPhone(phone)
        if (!shop) return { error: "no_shop", message: "No shop is known yet — ask for their shop code and call resolve_shop_code first." }

        const { getSession: getShopSession, setSession: setShopSession } = await import("@/lib/whatsapp-bot/shop-session")
        const existing = await getShopSession(phone)
        if (existing && ["CONFIRM", "AIRTIME_CONFIRM", "RC_CONFIRM", "SUBMIT_OTP"].includes(existing.step)) {
          return { duplicate: true, message: "The customer already has an order awaiting confirmation (reply 1 to pay or 2 to cancel). Ask them to finish or cancel that one first." }
        }

        const toLocal = (raw: string): string => {
          const r = String(raw || "").replace(/\s+/g, "")
          return r.startsWith("+233") ? "0" + r.slice(4) : r.startsWith("233") ? "0" + r.slice(3) : r
        }
        const { paystackProviderFromPhone } = await import("@/lib/ussd/paystack-provider")
        const paymentPhone = toLocal(String(input.payment_phone ?? ""))
        if (!/^0[0-9]{9}$/.test(paymentPhone)) {
          return { error: "invalid_payment_phone", message: "Ask for a valid Ghana MoMo number to charge, e.g. 0244123456." }
        }
        const paystackProvider = paystackProviderFromPhone(paymentPhone)
        if (!paystackProvider) {
          return { error: "invalid_payment_phone", message: "That MoMo number's provider isn't supported. Ask for a different Ghana MoMo number." }
        }

        const service = String(input.service ?? "data").toLowerCase()
        const baseSession: Partial<WaShopSession> = {
          shopCodeId: shop.shopCodeId, shopId: shop.shopId,
          parentShopId: shop.parentShopId ?? undefined, shopName: shop.shopName,
          paymentPhone, paystackProvider,
        }

        if (service === "data") {
          const network = String(input.network ?? "")
          const size = String(input.size ?? "")
          const recipient = toLocal(String(input.recipient_phone ?? ""))
          if (!/^0[0-9]{9}$/.test(recipient)) {
            return { error: "invalid_recipient", message: "Ask for a valid Ghana number to receive the data, e.g. 0244123456." }
          }
          const { getPrefixValidationConfig } = await import("@/lib/network-prefix-config")
          const { validateNetworkPrefix } = await import("@/lib/phone-format")
          const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
          if (prefixCheckEnabled) {
            const check = validateNetworkPrefix(network, recipient, prefixMap)
            if (!check.ok) return { error: "prefix_mismatch", message: check.message }
          }
          const { fetchShopBundles } = await import("@/lib/shop-commerce/pricing")
          const bundles = await fetchShopBundles(shop.shopId, network, shop.parentShopId ?? undefined)
          const match = bundles.find(b => b.size.toLowerCase() === size.toLowerCase())
          if (!match) {
            return { error: "unknown_bundle", message: `That bundle size isn't available for ${network} at this shop — call get_shop_packages to see current options.` }
          }

          const { setSession: setShop } = await import("@/lib/whatsapp-bot/shop-session")
          await setShop(phone, {
            ...baseSession,
            step: "CONFIRM",
            network, bundleId: match.id, bundleSize: match.size, bundlePrice: match.price,
            recipientPhone: recipient,
          } as WaShopSession)
          return { staged: true, service: "data", network, size: match.size, price: match.price, recipient, message: "Order staged — the customer has been shown a confirm screen to pay or cancel. Do NOT say it is paid yet." }
        }

        if (service === "airtime") {
          const recipient = toLocal(String(input.recipient_phone ?? ""))
          if (!/^0[0-9]{9}$/.test(recipient)) {
            return { error: "invalid_recipient", message: "Ask for a valid Ghana number to top up, e.g. 0244123456." }
          }
          const amount = parseFloat(String(input.amount ?? "").replace(/[^\d.]/g, ""))
          if (isNaN(amount) || amount <= 0) {
            return { error: "invalid_amount", message: "Ask how much airtime (in GHS) the customer wants." }
          }
          const { detectAirtimeNetwork, isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate, splitInclusive, airtimeNetworkKey } = await import("@/lib/airtime-pricing")
          const netIn = String(input.network ?? "").toLowerCase().replace(/[\s_-]/g, "")
          let network: string | null =
            netIn.startsWith("mtn") ? "MTN"
            : /telecel|vodafone/.test(netIn) ? "Telecel"
            : /airteltigo|airtel|tigo|^at$/.test(netIn) ? "AT"
            : null
          if (!network) network = detectAirtimeNetwork(recipient)
          if (!network) return { error: "unknown_network", message: "Ask which network the airtime is for: MTN, Telecel, or AT (AirtelTigo)." }
          if (!(await isAirtimeEnabled(network))) return { error: "unavailable", message: `${network} airtime is currently unavailable.` }
          const { min, max } = await getAirtimeLimits()
          if (amount < min || amount > max) return { error: "out_of_range", message: `Airtime must be between GHS ${min} and GHS ${max}.` }

          const { shopOwnerIsDealer } = await import("@/lib/shop-commerce/pricing")
          const { createClient } = await import("@supabase/supabase-js")
          const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
          const isDealer = await shopOwnerIsDealer(shop.shopId)
          const baseRate = await airtimeBaseFeeRate(network, isDealer)
          const { data: shopRow } = await supabase.from("user_shops").select(`airtime_markup_${airtimeNetworkKey(network)}`).eq("id", shop.shopId).single()
          const rawMarkup = parseFloat((shopRow as Record<string, unknown> | null)?.[`airtime_markup_${airtimeNetworkKey(network)}`] as string ?? "0") || 0
          const cappedMarkup = Math.max(0, Math.min(rawMarkup, 10 - baseRate))
          const { fee, toDeliver } = splitInclusive(amount, baseRate + cappedMarkup)

          const { setSession: setShop } = await import("@/lib/whatsapp-bot/shop-session")
          await setShop(phone, {
            ...baseSession,
            step: "AIRTIME_CONFIRM",
            airtimeNetwork: network, airtimeRecipient: recipient, airtimeAmount: amount,
            airtimeFee: fee, airtimeToDeliver: toDeliver,
          } as WaShopSession)
          return { staged: true, service: "airtime", network, recipient, amount, recipient_gets: toDeliver, message: "Order staged — the customer has been shown a confirm screen to pay or cancel. Do NOT say it is paid yet." }
        }

        if (service === "rc") {
          const { isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice } = await import("@/lib/results-checker-service")
          const boardIn = String(input.board ?? "").toUpperCase()
          const board = /WASSCE|WAEC|WASCE/.test(boardIn) ? "WASSCE" : /BECE/.test(boardIn) ? "BECE" : /NOVDEC|NOV/.test(boardIn) ? "NOVDEC" : null
          if (!board) return { error: "unknown_board", message: "Ask which exam: WASSCE, BECE, or NOVDEC." }
          if (!(await isExamBoardEnabled(board))) return { error: "unavailable", message: `${board} vouchers are currently unavailable.` }
          const qty = parseInt(String(input.quantity ?? "").replace(/[^\d]/g, ""), 10)
          if (isNaN(qty) || qty < 1) return { error: "invalid_quantity", message: "Ask how many voucher PINs the customer wants." }
          const [avail, max] = await Promise.all([getAvailableCount(board), getMaxQuantity()])
          const cap = Math.min(avail, max)
          if (qty > cap) return { error: "too_many", message: `Only ${cap} ${board} voucher(s) available right now.` }
          const pricing = await calculateRCPrice({ examBoard: board, quantity: qty, shopId: shop.shopId, applyBulk: true })

          const { setSession: setShop } = await import("@/lib/whatsapp-bot/shop-session")
          await setShop(phone, {
            ...baseSession,
            step: "RC_CONFIRM",
            rcBoard: board, rcQty: qty, rcUnitPrice: pricing.unitPrice,
            rcTotal: pricing.totalPaid, rcMerchantCommission: pricing.merchantCommission,
          } as WaShopSession)
          return { staged: true, service: "rc", board, qty, total: pricing.totalPaid, message: "Order staged — the customer has been shown a confirm screen to pay or cancel. Do NOT say it is paid yet." }
        }

        return { error: "unknown_service", message: "service must be data, airtime, or rc." }
      }
```

Add `import type { WaShopSession } from "@/lib/whatsapp-bot/shop-types"` near the top of `lib/ai-tools.ts` alongside the other imports.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run lib/ai-tools.test.ts`
Expected: PASS (all cases)

- [ ] **Step 11: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 12: Commit**

```bash
git add lib/ai-tools.ts lib/ai-tools.test.ts
git commit -m "feat(whatsapp-shop): add shop-scoped AI tools (resolve_shop_code, get_shop_packages, place_shop_order)"
```

---

### Task 3: `shop-ai.ts` — the shop AI handler

**Files:**
- Create: `lib/whatsapp-bot/shop-ai.ts`
- Test: `lib/whatsapp-bot/shop-ai.test.ts`

**Interfaces:**
- Consumes: `runAgenticLoop` from `lib/ai-agentic-loop.ts`; `resolveProviderForContext`, `DEFAULT_CONFIG`, `AIProviderConfig` from `lib/ai-providers.ts`; `getShopPref` from Task 1; `resolveShopCode` from `lib/shop-commerce/shop-code.ts`; `getSession as getShopSession` from `lib/whatsapp-bot/shop-session.ts`; `shopConfirmMenu`, `shopAirtimeConfirmMenu`, `shopRcConfirmMenu` from `lib/whatsapp-bot/shop-menus.ts`; `logMessage` from `lib/whatsapp-bot/log-message.ts`.
- Produces: `handleShopWithAI(phone: string, text: string, messageId: string | null): Promise<string>` — consumed by Task 4 (router) and Task 5 (webhook).

- [ ] **Step 1: Write the failing test**

```typescript
// lib/whatsapp-bot/shop-ai.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: vi.fn() }))
vi.mock("@/lib/ai-providers", () => ({
  resolveProviderForContext: () => ({ provider: {}, model: "claude-haiku-4-5-20251001", providerName: "anthropic" }),
  DEFAULT_CONFIG: {},
}))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({ getShopPref: vi.fn() }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({ resolveShopCode: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/shop-session", () => ({ getSession: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/log-message", () => ({ logMessage: vi.fn() }))

const fakeMessages: Array<{ direction: string; message: string }> = []
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "whatsapp_messages") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: fakeMessages }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === "admin_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { handleShopWithAI } from "@/lib/whatsapp-bot/shop-ai"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import { resolveShopCode } from "@/lib/shop-commerce/shop-code"
import { getSession as getShopSession } from "@/lib/whatsapp-bot/shop-session"

describe("handleShopWithAI", () => {
  beforeEach(() => {
    vi.mocked(getShopPref).mockReset()
    vi.mocked(resolveShopCode).mockReset()
    vi.mocked(getShopSession).mockReset()
    vi.mocked(runAgenticLoop).mockReset()
    fakeMessages.length = 0
  })

  it("greets with an enter-code prompt when no shop is known", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Hi! What's your shop code?", toolsUsed: [] })

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.1")

    expect(reply).toBe("Hi! What's your shop code?")
    const call = vi.mocked(runAgenticLoop).mock.calls[0][0]
    expect(call.system).not.toContain("Kofi's Data Hub")
  })

  it("includes the shop name in the system prompt for a known shop", async () => {
    vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Welcome back!", toolsUsed: [] })

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.2")

    expect(reply).toBe("Welcome back!")
    const call = vi.mocked(runAgenticLoop).mock.calls[0][0]
    expect(call.system).toContain("Kofi's Data Hub")
    expect(call.context).toBe("whatsapp_shop")
  })

  it("returns the staged confirm screen verbatim when place_shop_order just staged one", async () => {
    vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Sure, staging that.", toolsUsed: ["place_shop_order"] })
    vi.mocked(getShopSession).mockResolvedValue({
      step: "CONFIRM", shopName: "Kofi's Data Hub", network: "MTN", bundleSize: "5GB",
      bundlePrice: 25, recipientPhone: "0244123456", paymentPhone: "0244123456",
    } as never)

    const reply = await handleShopWithAI("233559919037", "yes 5gb mtn to 0244123456 pay from same number", "wamid.3")

    expect(reply).toContain("5GB MTN")
    expect(reply).toContain("1. Pay now")
  })

  it("falls back to a safe message when runAgenticLoop throws", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)
    vi.mocked(runAgenticLoop).mockRejectedValue(new Error("provider down"))

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.4")

    expect(reply).toContain("trouble")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/whatsapp-bot/shop-ai.test.ts`
Expected: FAIL — `Cannot find module '@/lib/whatsapp-bot/shop-ai'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/whatsapp-bot/shop-ai.ts
import { createClient } from "@supabase/supabase-js"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { resolveProviderForContext, DEFAULT_CONFIG, AIProviderConfig } from "@/lib/ai-providers"
import { getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import { resolveShopCode } from "@/lib/shop-commerce/shop-code"
import { getSession as getShopSession } from "@/lib/whatsapp-bot/shop-session"
import { shopConfirmMenu, shopAirtimeConfirmMenu, shopRcConfirmMenu } from "@/lib/whatsapp-bot/shop-menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function loadAiConfig(): Promise<AIProviderConfig> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "ai_provider_config")
      .maybeSingle()
    if (data?.value) return data.value as AIProviderConfig
  } catch { /* fall through to default */ }
  return DEFAULT_CONFIG
}

// handleShopWithAI mirrors app/api/whatsapp/webhook/route.ts's handleWithAI for
// the main bot, but scoped to a single shop: same runAgenticLoop pattern, same
// provider resolution (reuses the "whatsapp" provider/model config — no separate
// admin toggle for the shop bot), different (narrower) tool set and system prompt.
export async function handleShopWithAI(phone: string, text: string, _messageId: string | null): Promise<string> {
  const aiConfig = await loadAiConfig()
  const { provider, model } = resolveProviderForContext("whatsapp", aiConfig)

  const pref = await getShopPref(phone)
  let shopName: string | null = null
  let shopSystemBlock = ""

  if (pref) {
    const { data: codeRow } = await supabase
      .from("ussd_shop_codes")
      .select("code")
      .eq("id", pref.shopCodeId)
      .maybeSingle()
    if (codeRow?.code) {
      const shop = await resolveShopCode(codeRow.code)
      if (shop && shop.status === "active" && shop.whatsappActivated) {
        shopName = shop.shopName
        shopSystemBlock = `\nThe customer's shop is *${shop.shopName}* — you are speaking AS this shop's assistant. Greet returning customers by name (e.g. "Welcome back to ${shop.shopName} 👋"). Always call get_shop_packages before quoting any price — never invent one.\n`
      }
    }
  }

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
  messages.push({ role: "user", content: text })

  const system = `You are a friendly WhatsApp ordering assistant for a Datagod shop storefront. This is a dedicated shop number — every customer here is shopping at ONE specific shop.
${shopSystemBlock}
IF NO SHOP IS KNOWN YET: warmly explain this is a shop ordering line and ask for their shop code. The moment they send something that looks like a code, call resolve_shop_code with it.

ORDERING: use get_shop_packages to see real prices/availability (data bundles by network, airtime limits, results-checker boards) — NEVER invent a price. Once you have everything needed (service, network/board, size/qty, recipient number where relevant, and the MoMo number to charge), and the customer has confirmed, call place_shop_order. It stages a confirm screen where THEY tap to pay or cancel — never say an order is paid before that.

STYLE: short, warm, WhatsApp-appropriate replies. Currency is always GHS. One idea per line, *bold* sparingly for prices. Never mention tools or internal details. Don't ask for details the customer already gave.`

  let result: { text: string; toolsUsed: string[] }
  try {
    result = await runAgenticLoop({
      provider,
      model,
      system,
      context: "whatsapp_shop",
      messages,
      toolCtx: { baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", phone, userRole: "guest" },
      maxIterations: 5,
      maxTokens: 600,
    })
  } catch (e) {
    console.error("[WA-SHOP-AI] runAgenticLoop error:", e)
    return "Sorry, I'm having trouble right now — please try again in a moment, or send your shop code to start over."
  }

  if (result.toolsUsed.includes("place_shop_order")) {
    const staged = await getShopSession(phone)
    if (staged?.step === "CONFIRM") {
      return shopConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.network!, staged.bundleSize!, staged.bundlePrice!, staged.recipientPhone!, staged.paymentPhone!)
    }
    if (staged?.step === "AIRTIME_CONFIRM") {
      return shopAirtimeConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.airtimeNetwork!, staged.airtimeRecipient!, staged.airtimeAmount!, staged.airtimeToDeliver!, staged.paymentPhone!)
    }
    if (staged?.step === "RC_CONFIRM") {
      return shopRcConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.rcBoard!, staged.rcQty!, staged.rcTotal!, staged.paymentPhone!)
    }
  }

  return result.text || "How can I help — data, airtime, or a results checker?"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/whatsapp-bot/shop-ai.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add lib/whatsapp-bot/shop-ai.ts lib/whatsapp-bot/shop-ai.test.ts
git commit -m "feat(whatsapp-shop): add handleShopWithAI conversational handler"
```

---

### Task 4: Router changes — natural-language mapper, AI escape, returning-customer greeting

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts`
- Modify: `lib/whatsapp-bot/shop-router.test.ts`

**Interfaces:**
- Consumes: `getShopPref`, `setShopPref` from Task 1.
- Produces: `shopWaRouter` now returns `Promise<string>` instead of `Promise<void>` — callers (Task 5's webhook) get back `''` as the AI-escape sentinel, or the reply string otherwise (`shopWaRouter` still sends+logs the reply itself for the non-escape case, exactly as today).

Read the current `shopWaRouter` signature and its `!session` branch (`lib/whatsapp-bot/shop-router.ts:184-225`) plus the default case (`:1044-1049`) before editing — these are the two places that need returning-customer/AI-escape logic.

- [ ] **Step 1: Write the failing test for the AI-escape sentinel**

First, add a module-level mock for the new `shop-prefs` module near the file's other `vi.mock` calls (e.g. right after the `vi.mock("@/lib/whatsapp-bot/shop-session"...)`-adjacent mocks, if present, or alongside the `resolveShopCode`/`fetchShopNetworks` mock), and import `getShopPref` alongside the file's other named imports so tests can call `vi.mocked(getShopPref)`. Without the mock, `shop-router.ts` importing `getShopPref`/`setShopPref`/`clearShopPref` (added in Step 3/5 below) would make every existing test in this file hit the real Supabase client:

```typescript
import { getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
```

```typescript
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({
  getShopPref: vi.fn().mockResolvedValue(null),
  setShopPref: vi.fn(),
  clearShopPref: vi.fn(),
}))
```

Note: this file's `beforeEach` calls `vi.resetAllMocks()`, which clears the `.mockResolvedValue(null)` set above along with every other mock — so by the time any test runs, `getShopPref` resolves `undefined`, not `null`, unless a test explicitly sets it (exactly how `resolveShopCode`/`fetchShopNetworks` already work in this file). That's harmless here: `if (pref && looksLikeGreeting)` in Step 3's returning-customer check treats `undefined` and `null` identically (both falsy), so every pre-existing test still takes the normal code-entry path with no changes needed. Only the new returning-customer test below explicitly sets `getShopPref`'s return value.

Second, extend the existing `ussd_shop_codes` branch of the file's `@supabase/supabase-js` mock (currently around line 99, reproduced below) so it can also serve `resolveShopCodeById`'s `.select("code").eq("id", ...).maybeSingle()` query — today it only serves `fetchShopCodeTokenBalance`'s `.select("token_balance").eq("id", ...).maybeSingle()`, always returning `{ token_balance }` regardless of what was selected. Add a `rememberedShopCode` field to the hoisted `fakeDb` object, and branch on the `select()` argument (both call sites use `.eq("id", ...)`, so the column name can't distinguish them — the select columns can). Replace:

```typescript
const fakeDb = vi.hoisted(() => ({
  feePercent: 3,
  ownerEmail: "owner@example.com" as string | null,
  tokenBalance: 5 as number | null,
  whitelistEnabled: false,
  hasCompletedPurchase: true,
  orderUpdates: [] as Array<{ table: string; payload: Record<string, unknown>; id: unknown }>,
}))
```

with:

```typescript
const fakeDb = vi.hoisted(() => ({
  feePercent: 3,
  ownerEmail: "owner@example.com" as string | null,
  tokenBalance: 5 as number | null,
  whitelistEnabled: false,
  hasCompletedPurchase: true,
  orderUpdates: [] as Array<{ table: string; payload: Record<string, unknown>; id: unknown }>,
  // Backs resolveShopCodeById's lookup for the returning-customer path — the
  // shop code string that "belongs to" whatever shopCodeId a test's mocked
  // getShopPref returns. null means "no such shop code row found".
  rememberedShopCode: null as string | null,
}))
```

And replace:

```typescript
      if (table === "ussd_shop_codes") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: fakeDb.tokenBalance === null ? null : { token_balance: fakeDb.tokenBalance },
              }),
            }),
          }),
        }
      }
```

with:

```typescript
      if (table === "ussd_shop_codes") {
        return {
          select: (cols: string) => ({
            eq: () => ({
              maybeSingle: () => {
                if (cols === "code") {
                  return Promise.resolve({
                    data: fakeDb.rememberedShopCode ? { code: fakeDb.rememberedShopCode } : null,
                  })
                }
                return Promise.resolve({
                  data: fakeDb.tokenBalance === null ? null : { token_balance: fakeDb.tokenBalance },
                })
              },
            }),
          }),
        }
      }
```

Then add to `lib/whatsapp-bot/shop-router.test.ts` (it already mocks `resolveShopCode`, `fetchShopNetworks`, etc. — reuse those mocks):

```typescript
describe("shopWaRouter — AI escape", () => {
  it("returns '' and clears the session when the customer sends off-script freetext mid-flow", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    // First message resolves the shop code and lands on SELECT_PRODUCT.
    const first = await shopWaRouter("233559919037", "AB12CD", "wamid.1")
    expect(first).not.toBe("")

    // Second message is off-script freetext at SELECT_PRODUCT (not "1"/"2"/"3"/"0",
    // and not an ordering keyword shopNaturalToDigit recognises).
    const second = await shopWaRouter("233559919037", "do you sell mtn data here?", "wamid.2")
    expect(second).toBe("")
  })

  it("does NOT escape to AI from a money step — CONFIRM re-prompts instead", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "pkg-1", size: "5GB", price: 25 }])
    vi.mocked(getPrefixValidationConfig).mockResolvedValue({ enabled: false, map: DEFAULT_NETWORK_PREFIXES })

    await shopWaRouter("233559919037", "AB12CD", "wamid.1")   // ENTER_CODE -> SELECT_PRODUCT
    await shopWaRouter("233559919037", "1", "wamid.2")         // -> SELECT_NETWORK
    await shopWaRouter("233559919037", "1", "wamid.3")         // -> SELECT_BUNDLE
    await shopWaRouter("233559919037", "1", "wamid.4")         // -> ENTER_RECIPIENT
    await shopWaRouter("233559919037", "0244123456", "wamid.5") // -> ENTER_PAYMENT_PHONE
    await shopWaRouter("233559919037", "0244123456", "wamid.6") // -> CONFIRM

    const reply = await shopWaRouter("233559919037", "what does confirm mean", "wamid.7")

    expect(reply).not.toBe("")
    expect(reply).toContain("1. Pay now")
  })

  it("greets a returning customer by shop name and skips the code prompt", async () => {
    fakeDb.rememberedShopCode = "AB12CD"
    vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    const reply = await shopWaRouter("233559919037", "hi", "wamid.1")

    expect(reply).toContain("Welcome back")
    expect(reply).toContain("Kofi's Data Hub")
    // resolveShopCodeById resolves the remembered code string ("AB12CD") via
    // resolveShopCode internally — so resolveShopCode IS called, but with the
    // remembered code, never with the literal "hi" the customer typed. That's
    // what distinguishes the returning-customer path from treating "hi" as an
    // attempted (and invalid) shop code entry.
    expect(resolveShopCode).toHaveBeenCalledWith("AB12CD")
    expect(resolveShopCode).not.toHaveBeenCalledWith("hi")
  })
})
```

Finally, add `fakeDb.rememberedShopCode = null` to the `beforeEach`'s existing fake-DB reset block (`fakeDb.feePercent = 3`, `fakeDb.ownerEmail = ...`, etc., around line 181) — otherwise the returning-customer test's `fakeDb.rememberedShopCode = "AB12CD"` leaks into every test that runs after it in the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: FAIL — `shopWaRouter` currently returns `void`; `first`/`second`/`reply` are `undefined`, not `''` or a string, and TypeScript will also flag `await shopWaRouter(...)` assigned to a typed variable once the signature changes are half-done. The returning-customer test also fails: `getShopPref` isn't imported/called by the current code at all. Confirm the tests fail against the *current* code first.

- [ ] **Step 3: Add `shopNaturalToDigit` and the AI-escape sentinel**

In `lib/whatsapp-bot/shop-router.ts`, add this function near the top (after `isValidLocalGhana`, before `shopWaRouter`):

```typescript
// Converts obvious natural-language phrases to a menu digit, at zero AI cost —
// mirrors lib/whatsapp-bot/router.ts's naturalToDigit for the main bot. Returns
// null when the input doesn't map to anything recognisable, signalling the
// caller should escape to AI instead. Deliberately narrow: only steps where a
// customer might reasonably type a network/size/yes-no word instead of a digit.
function shopNaturalToDigit(step: WaShopSession['step'], input: string): string | null {
  const lc = input.trim().toLowerCase()

  if (step === 'SELECT_NETWORK' || step === 'AIRTIME_SELECT_NETWORK') {
    if (/^mtn$/.test(lc)) return '1'
    if (/telecel|vodafone/.test(lc)) return '2'
    if (/airteltigo|airtel|tigo|^at$/.test(lc)) return '3'
  }

  if (step === 'CONFIRM' || step === 'AIRTIME_CONFIRM' || step === 'RC_CONFIRM') {
    if (/^(yes|pay|confirm|ok|okay)$/.test(lc)) return '1'
    if (/^(no|cancel|stop)$/.test(lc)) return '2'
  }

  return null
}
```

Then change the `shopWaRouter` signature and the two spots that need it: the `!session` branch's shop-code resolution failure paths, and the `default` case. Full diff described below (apply exactly):

1. Change the function signature line:

```typescript
export async function shopWaRouter(from: string, text: string, inboundMsgId: string | null): Promise<string> {
```

2. Replace the ENTIRE `if (!session) { ... }` block (from `if (!session) {` through its matching closing `}` — the one immediately followed by `} else {` that starts the `switch (session.step)` branch) with this complete version, which adds a returning-customer check up front and a `setShopPref` call on first-ever successful resolution. It sets `session`/`reply` and always falls through to the function's existing shared bottom block (send, log, persist) — no early return, no duplicated send logic:

```typescript
  if (!session) {
    // Returning-customer memory: a bare greeting/empty-ish first message with a
    // remembered shop skips straight to the product menu instead of re-asking
    // for the code. Any OTHER input (e.g. actually typing a new code) still goes
    // through resolveShopCode below, so typing a different valid code always
    // switches shops. matchedReturning gates the resolveShopCode chain below so
    // a successful match doesn't also run it.
    let matchedReturning = false
    const pref = await getShopPref(from)
    const looksLikeGreeting = /^(hi|hello|hey|start|menu)?$/i.test(input)
    if (pref && looksLikeGreeting) {
      const remembered = await resolveShopCodeById(pref.shopCodeId)
      if (remembered && remembered.status === 'active' && remembered.whatsappActivated) {
        const [networks, dataBlocked] = await Promise.all([
          fetchShopNetworks(remembered.shopId, remembered.parentShopId),
          isDataWhitelistBlocked(from),
        ])
        session = {
          step: 'SELECT_PRODUCT',
          shopCodeId: remembered.shopCodeId,
          shopId: remembered.shopId,
          parentShopId: remembered.parentShopId ?? undefined,
          shopName: remembered.shopName,
          networks,
          dataBlocked,
        }
        reply = `Welcome back to *${remembered.shopName}* 👋\n\n${shopProductMenu(remembered.shopName, !dataBlocked)}`
        matchedReturning = true
      } else {
        await clearShopPref(from)
      }
    }

    if (!matchedReturning) {
      const resolved = await resolveShopCode(input)

      if (!resolved) {
        reply = shopInvalidCodeMenu('Invalid shop code. Please check and try again.')
        skipPersist = true
      } else if (resolved.status !== 'active') {
        reply = shopInvalidCodeMenu('This shop is currently unavailable.')
        skipPersist = true
      } else if (resolved.tokenBalance <= 0) {
        reply = shopInvalidCodeMenu('This shop has no sessions left. Please contact the seller.')
        skipPersist = true
      } else if (!resolved.whatsappActivated) {
        reply = shopInvalidCodeMenu("This shop isn't set up for WhatsApp yet.")
        skipPersist = true
      } else {
        const [networks, dataBlocked] = await Promise.all([
          fetchShopNetworks(resolved.shopId, resolved.parentShopId),
          isDataWhitelistBlocked(from),
        ])
        session = {
          step: 'SELECT_PRODUCT',
          shopCodeId: resolved.shopCodeId,
          shopId: resolved.shopId,
          parentShopId: resolved.parentShopId ?? undefined,
          shopName: resolved.shopName,
          networks,
          dataBlocked,
        }
        reply = shopProductMenu(resolved.shopName, !dataBlocked)
        await setShopPref(from, resolved.shopCodeId)
      }
    }
  } else {
```

This is a byte-for-byte drop-in replacement of the original block (everything between the original `if (!session) {` and its `} else {`) — the only changes are the new returning-customer preamble, wrapping the pre-existing `resolveShopCode` chain in `if (!matchedReturning) { ... }`, and the added `await setShopPref(...)` line in the success branch.

3. Add the AI-escape check right before the `switch (session.step)` in the `else` branch (i.e. right after `const shopName = session.shopName ?? 'Shop'`). The existing `switch` body reads the `input` variable throughout, so `shopNaturalToDigit`'s mapped digit must actually replace `input` for the switch to use it — that requires `input` to be reassignable, so also change the top of the function from `const input = text.trim()` to `let input = text.trim()`:

```typescript
  let input = text.trim()
```

```typescript
    const shopName = session.shopName ?? 'Shop'

    // AI escape: money-moving steps never leave the deterministic flow (a
    // gentle re-prompt happens inside their own case below via the existing
    // "else fall through to menu" pattern — we only escape from steps that
    // don't move money). Everywhere else, digits pass straight through; obvious
    // phrases resolve via shopNaturalToDigit; anything else escapes to AI.
    const MONEY_STEPS: WaShopSession['step'][] = [
      'CONFIRM', 'AIRTIME_CONFIRM', 'RC_CONFIRM',
      'ENTER_PAYMENT_PHONE', 'AIRTIME_ENTER_PAYMENT_PHONE', 'RC_ENTER_PAYMENT_PHONE',
      'SUBMIT_OTP',
    ]
    const isDigitOrZero = /^[0-9]+$/.test(input)
    if (!isDigitOrZero && !MONEY_STEPS.includes(session.step)) {
      const mapped = shopNaturalToDigit(session.step, input)
      if (mapped !== null) {
        input = mapped
      } else {
        await deleteSession(from)
        return ''
      }
    }
```

4. Change the two `return` sites at the bottom of the function. Replace:

```typescript
  const wamid = await sendWhatsAppText(from, reply, process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
  await logMessage(from, "outbound", reply, wamid)

  if (skipPersist) return
  if (deleteAfter) {
    await deleteSession(from)
  } else if (session) {
    await setSession(from, session)
  }
}
```

with:

```typescript
  const wamid = await sendWhatsAppText(from, reply, process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
  await logMessage(from, "outbound", reply, wamid)

  if (skipPersist) return reply
  if (deleteAfter) {
    await deleteSession(from)
  } else if (session) {
    await setSession(from, session)
  }
  return reply
}
```

5. Add the imports and the `resolveShopCodeById` helper. At the top of the file, extend the existing shop-code import, add the shop-prefs import, and add an explicit `WaShopSession` type import (needed because `shopNaturalToDigit` and `MONEY_STEPS` above reference `WaShopSession['step']` by name — today the file only relies on that type being inferred through `getSession`/`setSession`'s signatures, never naming it directly):

```typescript
import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { getShopPref, setShopPref, clearShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import type { WaShopSession } from "./shop-types"
```

Add this helper near `fetchShopCodeTokenBalance` (it needs the module's own `supabase` client, already declared at the top of the file):

```typescript
// resolveShopCode takes a code string, not an id — the returning-customer path
// only has the remembered shopCodeId, so look up the code string first.
async function resolveShopCodeById(shopCodeId: string) {
  const { data } = await supabase.from("ussd_shop_codes").select("code").eq("id", shopCodeId).maybeSingle()
  if (!data?.code) return null
  return resolveShopCode(data.code)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: PASS, including the two new tests and all pre-existing ones (this step also validates the `let input` change and `return reply` changes didn't break any existing assertion — pre-existing tests currently call `shopWaRouter` and assert on `sendWhatsAppText`'s mock calls, not on the return value, so they should be unaffected).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors — pay special attention to any other caller of `shopWaRouter` expecting `void` (Task 5 updates the one real caller, the webhook route).

- [ ] **Step 6: Commit**

```bash
git add lib/whatsapp-bot/shop-router.ts lib/whatsapp-bot/shop-router.test.ts
git commit -m "feat(whatsapp-shop): add natural-language mapper, AI escape, and returning-customer greeting to shopWaRouter"
```

---

### Task 5: Webhook wiring — rate cap + AI escape

**Files:**
- Modify: `app/api/whatsapp/webhook/route.ts`

**Interfaces:**
- Consumes: `shopWaRouter` (now `Promise<string>`, Task 4), `handleShopWithAI` (Task 3), `allowInbound` from `lib/whatsapp-bot/rate-limit.ts`.

Read `app/api/whatsapp/webhook/route.ts:300-310` (the current shop branch) before editing.

- [ ] **Step 1: Write the failing test**

There isn't an existing webhook route-level test harness for this file (it's covered indirectly via `shop-router.test.ts` and manual/integration testing per the project's established pattern for this route — confirm by checking for `app/api/whatsapp/webhook/route.test.ts`; if absent, this step is a manual verification instead of an automated one). Skip to Step 3 if no such test file exists; otherwise add a case asserting the shop branch calls `allowInbound` and, when `shopWaRouter` returns `''`, calls `handleShopWithAI`.

- [ ] **Step 2: Run test to verify it fails (if a test file exists)**

Run: `npx vitest run app/api/whatsapp/webhook/route.test.ts`
Expected: FAIL against current code (shop branch returns unconditionally with no rate cap or AI fallback).

- [ ] **Step 3: Update the shop branch**

Replace:

```typescript
  const receivingPhoneNumberId: string | undefined = change?.metadata?.phone_number_id
  if (isShopWhatsAppNumber(receivingPhoneNumberId)) {
    await shopWaRouter(from, text, msg.id ?? null)
    return
  }

  // Per-sender inbound cap: a spammer flooding the bot would otherwise burn AI
  // tokens on every message. Inbound is already logged (visible in the inbox);
  // we just stop the expensive bot/AI processing for over-the-limit senders.
  const { allowInbound } = await import("@/lib/whatsapp-bot/rate-limit")
  if (!(await allowInbound(from))) {
    console.warn("[WA-WEBHOOK] Inbound rate limit hit, dropping:", from)
    return
  }
```

with:

```typescript
  // Per-sender inbound cap: a spammer flooding the bot would otherwise burn AI
  // tokens on every message. Inbound is already logged (visible in the inbox);
  // we just stop the expensive bot/AI processing for over-the-limit senders.
  // Applies to BOTH the shop number and the main number now that the shop bot
  // also has an AI escape hatch (Task 3/4) that can burn tokens per message.
  const { allowInbound } = await import("@/lib/whatsapp-bot/rate-limit")
  if (!(await allowInbound(from))) {
    console.warn("[WA-WEBHOOK] Inbound rate limit hit, dropping:", from)
    return
  }

  const receivingPhoneNumberId: string | undefined = change?.metadata?.phone_number_id
  if (isShopWhatsAppNumber(receivingPhoneNumberId)) {
    if (msg.id) void sendWaTyping(msg.id)
    const reply = await shopWaRouter(from, text, msg.id ?? null)
    if (reply === '') {
      const { handleShopWithAI } = await import("@/lib/whatsapp-bot/shop-ai")
      const aiReply = await handleShopWithAI(from, text, msg.id ?? null)
      if (aiReply) {
        const out = formatForWhatsApp(aiReply)
        const wamid = await sendWhatsAppText(from, out, process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
        await logMessage(from, "outbound", out, wamid)
      }
    }
    return
  }
```

- [ ] **Step 4: Run test to verify it passes (if applicable) / type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (in particular, `shopWaRouter`'s new `Promise<string>` return type must satisfy this call site; `formatForWhatsApp`, `sendWhatsAppText`, `logMessage`, `sendWaTyping` are already imported in this file per the earlier reads).

- [ ] **Step 5: Commit**

```bash
git add app/api/whatsapp/webhook/route.ts
git commit -m "feat(whatsapp-shop): wire AI escape + rate cap into the shop webhook branch"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, no regressions in `shop-router.test.ts`, `shop-menus.test.ts`, `shop-session.test.ts`, `send.test.ts`, or any other suite.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke check reminder**

This plan cannot verify live WhatsApp behavior (needs Meta webhook delivery + a real/sandboxed shop code). Note for the user: after merging, send a real WhatsApp message to the shop number that is NOT a menu digit (e.g. "hi, do you sell mtn data?") and confirm the AI responds instead of the bot showing "Invalid shop code" — this is the one thing automated tests can't cover end-to-end.

- [ ] **Step 4: Commit (if anything was fixed during verification)**

```bash
git add -A
git commit -m "test(whatsapp-shop): fix regressions found during full-suite verification"
```

(Skip if Steps 1-2 were clean.)

---

## Plan Self-Review Notes

- **Spec coverage:** traffic split (digits/natural-language/AI-escape/money-fence) → Task 4; shop AI handler + provider/config reuse → Task 3; shop-scoped tools (`resolve_shop_code`, `get_shop_packages`, `place_shop_order`) → Task 2; returning-customer memory table + module → Task 1, wired into router in Task 4; webhook rate cap + escape wiring → Task 5; error handling (AI failure → menu fallback, `place_shop_order` validation failures, deactivated remembered shop → `clearShopPref` fallback) → covered inline in Tasks 2-4.
- **Out of scope items** (complaints/handoff/wallet tools, menu copy rewrite, image/vision, native buttons) are deliberately NOT implemented anywhere in this plan, matching the spec.
- **Type consistency check:** `WaShopSession['step']` used consistently in Task 4's `MONEY_STEPS`/`shopNaturalToDigit`; `shopWaRouter`'s new `Promise<string>` return type is consumed correctly in Task 5; `handleShopWithAI(phone, text, messageId)` signature matches its Task 5 call site; tool names (`resolve_shop_code`, `get_shop_packages`, `place_shop_order`) match between Task 2's definitions and Task 2's `executeToolCall` cases and Task 3's system-prompt references.
