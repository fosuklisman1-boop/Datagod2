# Developer / API Page + v1 API Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every logged-in user a dedicated `/dashboard/developer` page for self-service API key management and integration docs, backed by 5 new `X-API-Key`-authenticated v1 endpoints (products, airtime, AFA, results-checker, SMS send) alongside the existing balance/orders endpoints.

**Architecture:** Backend: thin `app/api/v1/*` route handlers (auth → rate-limit → call existing/extracted service logic → audit-log), matching the pattern already established by `app/api/v1/orders/route.ts`. Two existing dashboard routes (`airtime/purchase`, `afa/submit`) get their inline purchase logic extracted into reusable `lib/*.ts` functions first, so the v1 routes and the dashboard routes share one implementation. Frontend: a data-driven docs registry (`lib/api-docs-registry.ts`) rendered by one `<EndpointDoc>` component, plus a rebuilt key-management card replacing the existing `components/developer/ApiKeysManager.tsx` (currently buried in the Profile page).

**Tech Stack:** Next.js 15 App Router route handlers, Supabase (service-role client), Upstash-backed `applyRateLimit`, Vitest (fake-Supabase-client unit tests for extracted `lib/` functions, matching the `lib/sms/*.test.ts` convention), shadcn/ui + `DashboardLayout` for the page.

**Spec:** `docs/superpowers/specs/2026-09-15-developer-api-page-design.md`

---

## Important constraints discovered during planning (read before starting)

1. **`lib/airtime-pricing.ts` is NOT a drop-in for the extraction.** It uses network type `"MTN" | "Telecel" | "AT"` and builds admin-settings keys via `network.toLowerCase()`. The existing purchase route (`app/api/airtime/purchase/route.ts`) instead accepts `"MTN" | "AirtelTigo" | "Telecel"` and builds keys via `network.toLowerCase().replace(/\s/g, "_")`. For `"AirtelTigo"` both happen to produce the same key suffix (`airteltigo`), but `lib/airtime-pricing.ts`'s own prefix-detector (`detectAirtimeNetwork`) returns `"AT"` for the exact same network, which would read a **different** admin-settings key (`airtime_fee_at_dealer` vs `airtime_fee_airteltigo_dealer`). **Do not swap the route's inline pricing logic for `lib/airtime-pricing.ts`'s helpers as part of this extraction** — that would silently change which admin-configured fee applies. Task 3 extracts the existing inline logic verbatim (same `getAdminSetting` calls, same `"AirtelTigo"` network string), not a rewrite.
2. **`components/developer/ApiKeysManager.tsx` already exists** and is embedded in `app/dashboard/profile/page.tsx` behind `{(isDealer || profile.role === 'admin') && ...}`. This plan deletes that component and its call site (Task 17) — the new page replaces it, not supplements it.
3. **SMS send has no GET-by-reference.** `enqueueSend`/`enqueueSendBatched` is fully synchronous (dispatch happens inside the call) and returns everything the caller needs in the POST response — there's no pending state to poll for and no client-supplied reference to key a lookup by. Only Airtime, AFA, and Data Orders get a GET handler (their fulfillment can stay `pending`/`processing` after the response). Results-checker is also fully synchronous (voucher assignment happens inline or the call throws), but gets a GET anyway for "look up an order I made earlier" parity with the other purchase endpoints — low cost, and matches the docs page's per-resource tab structure.
4. **Insufficient-balance status codes are inconsistent in the existing dashboard routes** (airtime → 402, AFA → 400). The new v1 routes standardize on **402** for every insufficient-balance case — this is new surface with no backward-compatibility constraint, so it doesn't need to inherit that inconsistency. The dashboard routes' own status codes are left untouched (out of scope, not part of the extraction's visible behavior).

---

## Phase 1: Products endpoint

### Task 1: Products catalog aggregation

**Files:**
- Create: `lib/products-catalog.ts`
- Test: `lib/products-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/products-catalog.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [
      { network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
      { network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
      { network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
    ],
    afaPriceRow: { price: "50.00" } as { price: string } | null,
  }
  const fake = {
    from: (table: string) => {
      if (table === "packages") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: state.packagesRows, error: null }),
          }),
        }
      }
      if (table === "afa_registration_prices") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: state.afaPriceRow, error: null }),
              }),
            }),
          }),
        }
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

vi.mock("@/lib/airtime-pricing", () => ({
  isAirtimeEnabled: vi.fn(async (network: string) => network !== "Telecel"),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: vi.fn(async (_network: string, isDealer: boolean) => (isDealer ? 3 : 5)),
}))

vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(async (board: string) => board !== "NOVDEC"),
  calculateRCPrice: vi.fn(async () => ({
    basePrice: 15, markupPerVoucher: 0, unitPrice: 15, totalPaid: 15,
    merchantCommission: 0, bulkApplied: false,
  })),
}))

import { buildProductsCatalog } from "./products-catalog"

beforeEach(() => {
  h.state.packagesRows = [
    { network: "MTN", size: "1", price: 6.5, dealer_price: 5.8, is_available: true },
    { network: "MTN", size: "5", price: 27, dealer_price: 24.5, is_available: true },
    { network: "AT - iShare", size: "2", price: 12, dealer_price: 10.5, is_available: true },
  ]
  h.state.afaPriceRow = { price: "50.00" }
})

describe("buildProductsCatalog", () => {
  it("prices data bundles at customer price for a non-dealer role", async () => {
    const catalog = await buildProductsCatalog("user")
    const mtn1gb = catalog.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")
    expect(mtn1gb?.price).toBe(6.5)
  })

  it("prices data bundles at dealer price for a dealer role", async () => {
    const catalog = await buildProductsCatalog("dealer")
    const mtn1gb = catalog.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")
    expect(mtn1gb?.price).toBe(5.8)
  })

  it("excludes a disabled airtime network", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.airtime.find((a) => a.network === "Telecel")).toBeUndefined()
    expect(catalog.airtime.find((a) => a.network === "MTN")).toBeDefined()
  })

  it("excludes a disabled results-checker board", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.results_checker.find((b) => b.exam_board === "NOVDEC")).toBeUndefined()
    expect(catalog.results_checker.find((b) => b.exam_board === "WASSCE")).toBeDefined()
  })

  it("reports afa as enabled with the active price", async () => {
    const catalog = await buildProductsCatalog("user")
    expect(catalog.afa).toEqual({ enabled: true, price: 50 })
  })

  it("reports afa as disabled when no active price row exists", async () => {
    h.state.afaPriceRow = null
    const catalog = await buildProductsCatalog("user")
    expect(catalog.afa).toEqual({ enabled: false, price: null })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/products-catalog.test.ts --run`
Expected: FAIL with "Cannot find module './products-catalog'" (file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

```typescript
// lib/products-catalog.ts
import { createClient } from "@supabase/supabase-js"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"
import { isExamBoardEnabled, calculateRCPrice, type ExamBoard } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const AIRTIME_NETWORKS = ["MTN", "Telecel", "AT"] as const
const EXAM_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

export interface ProductsCatalogResponse {
  data_bundles: { network: string; size_gb: string; price: number }[]
  airtime: { network: string; min_amount: number; max_amount: number; fee_rate_percent: number }[]
  results_checker: { exam_board: string; unit_price: number }[]
  afa: { enabled: boolean; price: number | null }
}

/**
 * Read-only product/pricing catalog for GET /api/v1/products. Role-aware
 * (dealer price vs customer price) for data bundles; airtime/results-checker/AFA
 * pricing all live in admin_settings (or afa_registration_prices), not the
 * `packages` table, so each section reads its own source.
 */
export async function buildProductsCatalog(role: string): Promise<ProductsCatalogResponse> {
  const isDealer = role === "dealer"

  const [dataBundles, airtime, resultsChecker, afa] = await Promise.all([
    buildDataBundles(isDealer),
    buildAirtime(isDealer),
    buildResultsChecker(),
    buildAfa(),
  ])

  return { data_bundles: dataBundles, airtime, results_checker: resultsChecker, afa }
}

async function buildDataBundles(isDealer: boolean): Promise<ProductsCatalogResponse["data_bundles"]> {
  const { data, error } = await supabase
    .from("packages")
    .select("network, size, price, dealer_price")
    .eq("is_available", true)

  if (error || !data) return []

  return data.map((row: any) => ({
    network: row.network,
    size_gb: row.size,
    price: isDealer && Number(row.dealer_price) > 0 ? Number(row.dealer_price) : Number(row.price),
  }))
}

async function buildAirtime(isDealer: boolean): Promise<ProductsCatalogResponse["airtime"]> {
  const results: ProductsCatalogResponse["airtime"] = []
  for (const network of AIRTIME_NETWORKS) {
    const enabled = await isAirtimeEnabled(network)
    if (!enabled) continue
    const [{ min, max }, feeRate] = await Promise.all([
      getAirtimeLimits(),
      airtimeBaseFeeRate(network, isDealer),
    ])
    results.push({ network, min_amount: min, max_amount: max, fee_rate_percent: feeRate })
  }
  return results
}

async function buildResultsChecker(): Promise<ProductsCatalogResponse["results_checker"]> {
  const results: ProductsCatalogResponse["results_checker"] = []
  for (const board of EXAM_BOARDS) {
    const enabled = await isExamBoardEnabled(board)
    if (!enabled) continue
    const pricing = await calculateRCPrice({ examBoard: board, quantity: 1, applyBulk: false })
    results.push({ exam_board: board, unit_price: pricing.unitPrice })
  }
  return results
}

async function buildAfa(): Promise<ProductsCatalogResponse["afa"]> {
  const { data } = await supabase
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()

  if (!data) return { enabled: false, price: null }
  return { enabled: true, price: parseFloat(data.price) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/products-catalog.test.ts --run`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/products-catalog.ts lib/products-catalog.test.ts
git commit -m "feat(v1-api): add products catalog aggregation"
```

### Task 2: `GET /api/v1/products` route

**Files:**
- Create: `app/api/v1/products/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/v1/products/route.ts
import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { buildProductsCatalog } from "@/lib/products-catalog"

/**
 * GET /api/v1/products
 * Read-only catalog of purchasable products and current prices.
 */
export async function GET(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_products_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: `Rate limit exceeded. Max ${rateLimitCount} requests/minute.` },
      { status: 429 }
    )
  }

  const catalog = await buildProductsCatalog(user.role)
  const durationMs = Date.now() - start

  logApiRequest({
    userId: user.id,
    apiKeyId: user.api_key_id,
    method: "GET",
    endpoint: "/api/v1/products",
    statusCode: 200,
    request,
    durationMs,
    responsePayload: { data_bundles_count: catalog.data_bundles.length },
  }).catch(() => {})

  return NextResponse.json({ success: true, ...catalog })
}
```

- [ ] **Step 2: Manual verification against the dev server**

Run: `npm run dev` (if not already running), then in another terminal, using a real `dg_live_` key from `user_api_keys` (generate one via `POST /api/user/keys` with a valid session first if none exists):

```bash
curl -s http://localhost:3000/api/v1/products -H "X-API-Key: dg_live_..." | head -c 500
```

Expected: `{"success":true,"data_bundles":[...],"airtime":[...],"results_checker":[...],"afa":{...}}`. A request with no/invalid key returns `{"success":false,"error":"Invalid or missing API key"}` with HTTP 401.

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/products/route.ts
git commit -m "feat(v1-api): add GET /api/v1/products"
```

---

## Phase 2: Airtime v1 endpoint

### Task 3: Extract `purchaseAirtime()` into `lib/airtime-service.ts`

**Files:**
- Modify: `lib/airtime-service.ts`
- Test: `lib/airtime-service.test.ts`

This step extracts the inline logic currently in `app/api/airtime/purchase/route.ts` (steps 3–13 of that file — network-enable check, fee calc, min/max limits, idempotency guard, atomic wallet deduction, order creation, transaction ledger, notification, Digiwapy trigger) **verbatim**, preserving the exact `getAdminSetting`/network-key behavior described in the constraints section above. Auth and body-parsing stay in the caller (the route or the new v1 route); this function starts from "network is known and validated."

- [ ] **Step 1: Write the failing test**

```typescript
// lib/airtime-service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {
      airtime_enabled_mtn: { enabled: true },
      airtime_fee_mtn_customer: { rate: 5 },
      airtime_fee_mtn_dealer: { rate: 3 },
      airtime_min_amount: { amount: 1 },
      airtime_max_amount: { amount: 500 },
    } as Record<string, any>,
    userRole: "user",
    recentOrder: null as any,
    deductError: null as null | string,
    deductResult: [{ new_balance: 88, old_balance: 100, new_total_spent: 12 }] as any,
    insertedOrder: { id: "order-1" } as any,
    insertError: null as any,
  }

  const fake = {
    from: (table: string) => {
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              single: () => Promise.resolve({ data: { value: state.settings[key] ?? null }, error: null }),
            }),
          }),
        }
      }
      if (table === "users") {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { role: state.userRole }, error: null }) }) }),
        }
      }
      if (table === "airtime_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  neq: () => ({
                    gte: () => ({ maybeSingle: () => Promise.resolve({ data: state.recentOrder, error: null }) }),
                  }),
                }),
              }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve(
                state.insertError
                  ? { data: null, error: state.insertError }
                  : { data: state.insertedOrder, error: null }
              ),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        }
      }
      if (table === "transactions" || table === "notifications" || table === "wallets" || table === "user_shops") {
        return {
          insert: () => Promise.resolve({ data: null, error: null }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: (fn: string) => {
      if (fn === "deduct_wallet") {
        return Promise.resolve(
          state.deductError
            ? { data: null, error: { message: state.deductError } }
            : { data: state.deductResult, error: null }
        )
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

// purchaseAirtime calls triggerDigiwapyFulfillment as a same-module function
// reference, not through the module's export binding — self-mocking
// "@/lib/airtime-service" would NOT intercept that internal call. Mock its
// real dependencies (a genuine module boundary) instead.
vi.mock("@/lib/digiwapy-provider", () => ({
  isDigiWapyEnabledForNetwork: vi.fn(async () => true),
  sendAirtimeViaDigiwapy: vi.fn(async () => ({ success: true, digiwapyRef: "dgw-1" })),
}))
vi.mock("@/lib/sms-service", () => ({
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: {
    adminAirtimeManualRequired: () => "msg",
    adminAirtimeDigiwapyFailed: () => "msg",
  },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { airtimeAdminAlert: () => ({ subject: "s", html: "h" }) },
}))

import { purchaseAirtime } from "./airtime-service"

beforeEach(() => {
  h.state.settings = {
    airtime_enabled_mtn: { enabled: true },
    airtime_fee_mtn_customer: { rate: 5 },
    airtime_fee_mtn_dealer: { rate: 3 },
    airtime_min_amount: { amount: 1 },
    airtime_max_amount: { amount: 500 },
  }
  h.state.userRole = "user"
  h.state.recentOrder = null
  h.state.deductError = null
  h.state.deductResult = [{ new_balance: 88, old_balance: 100, new_total_spent: 12 }]
  h.state.insertedOrder = { id: "order-1" }
  h.state.insertError = null
})

describe("purchaseAirtime", () => {
  it("creates an order and returns the reference + new balance", async () => {
    const result = await purchaseAirtime({
      userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10,
    })
    expect(result.order.id).toBe("order-1")
    expect(result.newBalance).toBe(88)
  })

  it("throws NETWORK_DISABLED when the network is disabled", async () => {
    h.state.settings.airtime_enabled_mtn = { enabled: false }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "NETWORK_DISABLED" })
  })

  it("throws INSUFFICIENT_BALANCE when deduct_wallet returns no rows", async () => {
    h.state.deductResult = []
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" })
  })

  it("throws DUPLICATE_REQUEST when an identical order was placed in the last 30s", async () => {
    h.state.recentOrder = { id: "prev", reference_code: "AT-XXX-YYY" }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/airtime-service.test.ts --run`
Expected: FAIL — `purchaseAirtime` is not exported yet

- [ ] **Step 3: Add `purchaseAirtime()` to `lib/airtime-service.ts`**

Add these exports to the existing file (keep `triggerDigiwapyFulfillment` and `markAirtimeOrderPaid` as they are):

```typescript
import { secureReference } from "@/lib/secure-random"

// ... (existing imports/code above stay unchanged) ...

async function getAdminSetting(key: string): Promise<any> {
  const { data } = await supabase.from("admin_settings").select("value").eq("key", key).single()
  return data?.value ?? null
}

export interface PurchaseAirtimeParams {
  userId: string
  network: "MTN" | "AirtelTigo" | "Telecel"
  beneficiaryPhone: string
  airtimeAmount: number
  paySeparately?: boolean
  shopId?: string | null
}

export interface PurchaseAirtimeResult {
  order: {
    id: string
    reference_code: string
    network: string
    beneficiary_phone: string
    airtime_amount: number
    fee_amount: number
    total_paid: number
    status: string
  }
  newBalance: number
}

/**
 * Buy airtime for a beneficiary phone, deducting the buyer's wallet.
 * Extracted from app/api/airtime/purchase/route.ts so the dashboard route and
 * the v1 API route share one implementation. Preserves that route's exact
 * network-key convention ("AirtelTigo" → admin_settings key suffix
 * "airteltigo") — do NOT swap in lib/airtime-pricing.ts's helpers here, they
 * use a different network vocabulary ("AT") that reads a different key.
 */
export async function purchaseAirtime(params: PurchaseAirtimeParams): Promise<PurchaseAirtimeResult> {
  const { userId, network, beneficiaryPhone, paySeparately = false, shopId } = params
  const cleanPhone = beneficiaryPhone.replace(/\s/g, "")
  const networkKey = network.toLowerCase().replace(/\s/g, "_")

  const enableSetting = await getAdminSetting(`airtime_enabled_${networkKey}`)
  if (enableSetting?.enabled === false) {
    const err: any = new Error(`Airtime for ${network} is currently unavailable`)
    err.code = "NETWORK_DISABLED"
    throw err
  }

  let merchantRoleFeeRate = 5
  let customMarkupRate = 0

  if (shopId) {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("user_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at")
      .eq("id", shopId)
      .single()

    if (shop) {
      const merchantUserId = shop.user_id
      if (merchantUserId !== userId) {
        customMarkupRate = parseFloat(shop[`airtime_markup_${networkKey}` as keyof typeof shop] as string) || 0
      }
      const { data: merchantProfile } = await supabase.from("users").select("role").eq("id", merchantUserId).single()
      const isMerchantDealer = merchantProfile?.role === "dealer"
      const merchantFeeKey = isMerchantDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
      const merchantFeeSetting = await getAdminSetting(merchantFeeKey)
      merchantRoleFeeRate = merchantFeeSetting?.rate ?? 5
    }
  } else {
    const { data: userProfile } = await supabase.from("users").select("role").eq("id", userId).single()
    const isUserDealer = userProfile?.role === "dealer" || userProfile?.role === "sub_agent"
    const feeKey = isUserDealer ? `airtime_fee_${networkKey}_dealer` : `airtime_fee_${networkKey}_customer`
    const feeSetting = await getAdminSetting(feeKey)
    merchantRoleFeeRate = feeSetting?.rate ?? 5
  }

  const totalFeeRate = merchantRoleFeeRate + customMarkupRate

  const minSetting = await getAdminSetting("airtime_min_amount")
  const maxSetting = await getAdminSetting("airtime_max_amount")
  const minAmount = minSetting?.amount ?? 1
  const maxAmount = maxSetting?.amount ?? 500
  if (params.airtimeAmount < minAmount) {
    const err: any = new Error(`Minimum airtime amount is GHS ${minAmount}`)
    err.code = "INVALID_AMOUNT"
    throw err
  }
  if (params.airtimeAmount > maxAmount) {
    const err: any = new Error(`Maximum airtime amount is GHS ${maxAmount}`)
    err.code = "INVALID_AMOUNT"
    throw err
  }

  let airtimeToRecipient: number
  let totalPaid: number
  const merchantCommissionValue = 0

  if (paySeparately) {
    airtimeToRecipient = params.airtimeAmount
    const totalFeeAmount = parseFloat((params.airtimeAmount * totalFeeRate / 100).toFixed(2))
    totalPaid = parseFloat((params.airtimeAmount + totalFeeAmount).toFixed(2))
  } else {
    totalPaid = params.airtimeAmount
    const totalFeeAmount = parseFloat((params.airtimeAmount * totalFeeRate / (100 + totalFeeRate)).toFixed(2))
    airtimeToRecipient = parseFloat((totalPaid - totalFeeAmount).toFixed(2))
  }
  const feeAmount = parseFloat((totalPaid - airtimeToRecipient).toFixed(2))

  const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
  const { data: recentOrder } = await supabase
    .from("airtime_orders")
    .select("id, reference_code")
    .eq("user_id", userId)
    .eq("beneficiary_phone", cleanPhone)
    .eq("airtime_amount", airtimeToRecipient)
    .neq("status", "failed")
    .gte("created_at", thirtySecondsAgo)
    .maybeSingle()

  if (recentOrder) {
    const err: any = new Error("Duplicate request detected. Please wait before trying again.")
    err.code = "DUPLICATE_REQUEST"
    err.reference = recentOrder.reference_code
    throw err
  }

  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: totalPaid,
  })
  if (deductError) {
    const err: any = new Error("Failed to process payment")
    err.code = "PAYMENT_FAILED"
    throw err
  }
  if (!deductResult || deductResult.length === 0) {
    const err: any = new Error("Insufficient wallet balance")
    err.code = "INSUFFICIENT_BALANCE"
    err.required = totalPaid
    throw err
  }
  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  const referenceCode = secureReference("AT", 2, 3)
  const { data: order, error: orderError } = await supabase
    .from("airtime_orders")
    .insert([{
      user_id: userId,
      reference_code: referenceCode,
      network,
      beneficiary_phone: cleanPhone,
      airtime_amount: airtimeToRecipient,
      fee_amount: feeAmount,
      total_paid: totalPaid,
      pay_separately: paySeparately,
      status: "pending",
      payment_status: "completed",
      shop_id: shopId || null,
      merchant_commission: merchantCommissionValue,
    }])
    .select()
    .single()

  if (orderError || !order) {
    await supabase
      .from("wallets")
      .update({ balance: balanceBefore, total_spent: deductResult[0].new_total_spent - totalPaid, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
    const err: any = new Error("Failed to create order. Wallet refunded.")
    err.code = "ORDER_CREATE_FAILED"
    throw err
  }

  await supabase.from("transactions").insert([{
    user_id: userId,
    type: "debit",
    source: "airtime_purchase",
    amount: totalPaid,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: `Airtime: ${network} GHS ${airtimeToRecipient} to ${cleanPhone}`,
    reference_id: order.id,
    status: "completed",
    created_at: new Date().toISOString(),
  }])

  await supabase.from("notifications").insert([{
    user_id: userId,
    title: "Airtime Order Placed",
    message: `Your GHS ${airtimeToRecipient} ${network} airtime order for ${cleanPhone} is pending. Ref: ${referenceCode}`,
    type: "order_update",
    reference_id: order.id,
    action_url: `/dashboard/airtime`,
    read: false,
  }])

  await triggerDigiwapyFulfillment({
    id: order.id,
    reference_code: referenceCode,
    network,
    beneficiary_phone: cleanPhone,
    airtime_amount: airtimeToRecipient,
  })

  try {
    const { data: shopData } = order.shop_id
      ? await supabase.from("user_shops").select("shop_name").eq("id", order.shop_id).single()
      : { data: null }
    const shopName = shopData?.shop_name || "Direct"
    Promise.allSettled([
      import("@/lib/email-service").then(({ sendEmail, EmailTemplates }) => {
        const payload = EmailTemplates.airtimeAdminAlert(referenceCode, network, cleanPhone, airtimeToRecipient.toFixed(2), totalPaid.toFixed(2))
        return sendEmail({ to: [], subject: payload.subject, htmlContent: payload.html, referenceId: order.id, type: "airtime_admin_alert" })
      }).catch((e) => console.warn("[AIRTIME-SVC] Admin email error:", e)),
    ]).catch((e) => console.warn("[AIRTIME-SVC] Non-blocking notification error:", e))
  } catch (notifErr) {
    console.warn("[AIRTIME-SVC] Notification preparation error:", notifErr)
  }

  return {
    order: {
      id: order.id,
      reference_code: referenceCode,
      network,
      beneficiary_phone: cleanPhone,
      airtime_amount: airtimeToRecipient,
      fee_amount: feeAmount,
      total_paid: totalPaid,
      status: "pending",
    },
    newBalance,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/airtime-service.test.ts --run`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/airtime-service.ts lib/airtime-service.test.ts
git commit -m "feat(v1-api): extract purchaseAirtime() for reuse by the v1 route"
```

### Task 4: Refactor the dashboard airtime route to call `purchaseAirtime()`

**Files:**
- Modify: `app/api/airtime/purchase/route.ts`

- [ ] **Step 1: Replace the inline logic with a call to `purchaseAirtime()`**

Replace the entire body of `app/api/airtime/purchase/route.ts` (steps 2–14, i.e. everything after the phone-gate check) with:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseAirtime } from "@/lib/airtime-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    const phoneGuard = await checkPhoneVerified(supabase, user.id)
    if (!phoneGuard.allowed) {
      return NextResponse.json({ error: phoneGuard.error }, { status: 403 })
    }

    const { network, beneficiaryPhone, airtimeAmount, paySeparately = false, shopId } = await request.json()

    if (!network || !beneficiaryPhone || !airtimeAmount) {
      return NextResponse.json({ error: "network, beneficiaryPhone, and airtimeAmount are required" }, { status: 400 })
    }
    const ALLOWED_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]
    if (!ALLOWED_NETWORKS.includes(network)) {
      return NextResponse.json({ error: "Invalid network. Must be MTN, AirtelTigo, or Telecel" }, { status: 400 })
    }
    const cleanPhone = String(beneficiaryPhone).replace(/\s/g, "")
    if (!/^\d{10}$/.test(cleanPhone)) {
      return NextResponse.json({ error: "Phone number must be exactly 10 digits" }, { status: 400 })
    }
    const amount = parseFloat(airtimeAmount)
    if (isNaN(amount) || amount <= 0 || amount > 1000) {
      return NextResponse.json({ error: "Airtime amount must be between GHS 0.01 and GHS 1000" }, { status: 400 })
    }

    const result = await purchaseAirtime({
      userId: user.id, network, beneficiaryPhone: cleanPhone, airtimeAmount: amount, paySeparately, shopId,
    })

    console.log(`[AIRTIME] ✓ Order created: ${result.order.reference_code} | ${network} GHS ${result.order.airtime_amount} → ${cleanPhone}`)

    return NextResponse.json({
      success: true,
      message: "Airtime order placed successfully",
      order: result.order,
      newBalance: result.newBalance,
    })
  } catch (error: any) {
    const knownCodes = ["NETWORK_DISABLED", "INVALID_AMOUNT", "DUPLICATE_REQUEST", "INSUFFICIENT_BALANCE", "PAYMENT_FAILED", "ORDER_CREATE_FAILED"]
    const status =
      error?.code === "NETWORK_DISABLED" ? 503 :
      error?.code === "INVALID_AMOUNT" ? 400 :
      error?.code === "DUPLICATE_REQUEST" ? 409 :
      error?.code === "INSUFFICIENT_BALANCE" ? 402 :
      error?.code === "PAYMENT_FAILED" || error?.code === "ORDER_CREATE_FAILED" ? 500 :
      500

    if (knownCodes.includes(error?.code)) {
      console.error("[AIRTIME]", error.code, error.message)
      const body: Record<string, unknown> = { error: error.message }
      if (error.reference) body.reference = error.reference
      if (error.required) body.required = error.required
      return NextResponse.json(body, { status })
    }
    console.error("[AIRTIME] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Manual regression check**

Run: `npm run dev`, then place a real airtime order through the dashboard UI at `/dashboard/airtime` with a wallet-funded test account. Confirm the order appears in `airtime_orders` with the same shape as before (reference_code, status transitions to "processing" if Digiwapy accepts it), and that an insufficient-balance attempt still returns HTTP 402 with the same error message text as before the refactor.

- [ ] **Step 3: Commit**

```bash
git add app/api/airtime/purchase/route.ts
git commit -m "refactor(airtime): route now calls the shared purchaseAirtime() service"
```

### Task 5: `POST`/`GET /api/v1/airtime`

**Files:**
- Create: `app/api/v1/airtime/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/v1/airtime/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseAirtime } from "@/lib/airtime-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const ALLOWED_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]

/**
 * GET /api/v1/airtime?reference=<ref>
 */
export async function GET(request: NextRequest) {
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_airtime_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("airtime_orders")
    .select("reference_code, network, beneficiary_phone, airtime_amount, total_paid, status, created_at")
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .single()

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.reference_code,
      network: order.network,
      recipient: order.beneficiary_phone,
      airtime_amount: order.airtime_amount,
      total_paid: order.total_paid,
      status: order.status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/airtime
 * Body: { network: "MTN"|"AirtelTigo"|"Telecel", recipient: string, amount: number, pay_separately?: boolean }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_airtime_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const phoneGuard = await checkPhoneVerified(supabase, user.id)
  if (!phoneGuard.allowed) {
    return NextResponse.json({ success: false, error: phoneGuard.error }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { network, recipient, amount, pay_separately = false } = body
  if (!network || !recipient || !amount) {
    return NextResponse.json({ success: false, error: "Missing required fields: network, recipient, amount" }, { status: 400 })
  }
  if (!ALLOWED_NETWORKS.includes(network)) {
    return NextResponse.json({ success: false, error: "Invalid network. Must be MTN, AirtelTigo, or Telecel" }, { status: 400 })
  }
  const cleanPhone = String(recipient).replace(/\s/g, "")
  if (!/^\d{10}$/.test(cleanPhone)) {
    return NextResponse.json({ success: false, error: "recipient must be a 10-digit phone number" }, { status: 400 })
  }
  const numericAmount = Number(amount)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > 1000) {
    return NextResponse.json({ success: false, error: "amount must be between GHS 0.01 and GHS 1000" }, { status: 400 })
  }

  try {
    const result = await purchaseAirtime({
      userId: user.id, network, beneficiaryPhone: cleanPhone, airtimeAmount: numericAmount, paySeparately: pay_separately,
    })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/airtime",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { network, recipient: cleanPhone, amount: numericAmount },
      responsePayload: { reference: result.order.reference_code, status: result.order.status },
    }).catch(() => {})

    return NextResponse.json({ success: true, order: result.order, new_balance: result.newBalance }, { status: 201 })
  } catch (error: any) {
    const status =
      error?.code === "NETWORK_DISABLED" ? 503 :
      error?.code === "INVALID_AMOUNT" ? 400 :
      error?.code === "DUPLICATE_REQUEST" ? 409 :
      error?.code === "INSUFFICIENT_BALANCE" ? 402 :
      500

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/airtime",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { network, recipient: cleanPhone, amount: numericAmount },
      responsePayload: { error: error.message },
    }).catch(() => {})

    return NextResponse.json(
      { success: false, error: error.message ?? "Failed to purchase airtime", required: error?.required },
      { status }
    )
  }
}
```

- [ ] **Step 2: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/v1/airtime \
  -H "X-API-Key: dg_live_..." -H "Content-Type: application/json" \
  -d '{"network":"MTN","recipient":"0541234567","amount":5}'
```

Expected: `201` with `{"success":true,"order":{...,"status":"pending"},"new_balance":...}` for a funded, phone-verified test account; `402` with `INSUFFICIENT_BALANCE`-style message for an unfunded one; `403` for an account that hasn't completed phone verification.

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/airtime/route.ts
git commit -m "feat(v1-api): add POST/GET /api/v1/airtime"
```

---

## Phase 3: AFA v1 endpoint

### Task 6: Extract `submitAfaOrder()` into `lib/afa-fulfillment.ts`

**Files:**
- Modify: `lib/afa-fulfillment.ts`
- Test: `lib/afa-fulfillment.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// lib/afa-fulfillment.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    priceRow: { price: "50.00" } as { price: string } | null,
    deductResult: [{ new_balance: 40, old_balance: 90, new_total_spent: 50 }] as any,
    insertedOrder: { id: "afa-1", order_code: "AFA-1234567" } as any,
    insertError: null as any,
    autoFulfillEnabled: false,
  }
  const fake = {
    from: (table: string) => {
      if (table === "afa_registration_prices") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.priceRow, error: null }) }) }) }) }
      }
      if (table === "afa_orders") {
        return {
          insert: () => ({ select: () => ({ single: () => Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: state.insertedOrder, error: null }) }) }),
        }
      }
      if (table === "transactions" || table === "wallets") {
        return { insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }
      }
      if (table === "admin_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { value: { enabled: state.autoFulfillEnabled } }, error: null }) }) }) }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: () => Promise.resolve(
      state.deductResult.length === 0
        ? { data: [], error: null }
        : { data: state.deductResult, error: null }
    ),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { afaRegistration: () => "msg" } }))

import { submitAfaOrder } from "./afa-fulfillment"

beforeEach(() => {
  h.state.priceRow = { price: "50.00" }
  h.state.deductResult = [{ new_balance: 40, old_balance: 90, new_total_spent: 50 }]
  h.state.insertedOrder = { id: "afa-1", order_code: "AFA-1234567" }
  h.state.insertError = null
  h.state.autoFulfillEnabled = false
})

describe("submitAfaOrder", () => {
  const baseParams = {
    userId: "user-1", fullName: "Jane Doe", phoneNumber: "0541234567",
    ghCardNumber: "GHA-123456789-0", location: "Accra", region: "Greater Accra",
  }

  it("creates the order using the server-side price, not a client-supplied amount", async () => {
    const result = await submitAfaOrder(baseParams)
    expect(result.order.id).toBe("afa-1")
  })

  it("throws PRICE_UNAVAILABLE when no active price row exists", async () => {
    h.state.priceRow = null
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "PRICE_UNAVAILABLE" })
  })

  it("throws INSUFFICIENT_BALANCE when deduct_wallet returns no rows", async () => {
    h.state.deductResult = []
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/afa-fulfillment.test.ts --run`
Expected: FAIL — `submitAfaOrder` is not exported yet

- [ ] **Step 3: Add `submitAfaOrder()` to `lib/afa-fulfillment.ts`**

Add near the top of the file (after the existing imports) and export alongside the existing functions:

```typescript
import { sendSMS, SMSTemplates } from "@/lib/sms-service"
import { secureString } from "@/lib/secure-random"

export interface SubmitAfaOrderParams {
  userId: string
  fullName: string
  phoneNumber: string
  ghCardNumber: string
  location: string
  region: string
  occupation?: string
}

export interface SubmitAfaOrderResult {
  order: Record<string, any>
}

/**
 * Create and pay for an AFA registration order, then fire-and-forget the
 * Sykes registration if auto-fulfillment is on. Extracted from
 * app/api/afa/submit/route.ts so the dashboard route and the v1 API route
 * share one implementation. Always charges the server-side price from
 * afa_registration_prices — never a client-supplied amount.
 */
export async function submitAfaOrder(params: SubmitAfaOrderParams): Promise<SubmitAfaOrderResult> {
  const supabase = getSupabase()
  const { userId, fullName, phoneNumber, ghCardNumber, location, region, occupation } = params

  let afaPrice = 50.0
  {
    const { data: priceRow } = await supabase
      .from("afa_registration_prices")
      .select("price")
      .eq("is_active", true)
      .eq("name", "default")
      .maybeSingle()
    if (priceRow?.price != null) afaPrice = parseFloat(priceRow.price)
  }
  if (!Number.isFinite(afaPrice) || afaPrice <= 0) {
    const err: any = new Error("AFA price unavailable, try again later")
    err.code = "PRICE_UNAVAILABLE"
    throw err
  }

  const { data: deductResult, error: deductError } = await supabase.rpc("deduct_wallet", {
    p_user_id: userId,
    p_amount: afaPrice,
  })
  if (deductError) {
    const err: any = new Error("Failed to process payment")
    err.code = "PAYMENT_FAILED"
    throw err
  }
  if (!deductResult || deductResult.length === 0) {
    const err: any = new Error("Insufficient balance")
    err.code = "INSUFFICIENT_BALANCE"
    err.required = afaPrice
    throw err
  }
  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]

  const orderCode = `AFA-${Date.now().toString().slice(-7)}`
  const transactionCode = secureString(10)

  const { data: afaOrder, error: afaError } = await supabase
    .from("afa_orders")
    .insert({
      user_id: userId,
      order_code: orderCode,
      transaction_code: transactionCode,
      full_name: fullName,
      phone_number: phoneNumber,
      gh_card_number: ghCardNumber,
      location,
      region,
      occupation,
      amount: afaPrice,
      status: "pending",
      created_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (afaError) {
    await supabase
      .from("wallets")
      .update({ balance: balanceBefore, total_spent: deductResult[0].new_total_spent - afaPrice, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
    const err: any = new Error("Failed to create AFA order")
    err.code = "ORDER_CREATE_FAILED"
    throw err
  }

  try {
    await sendSMS({ phone: phoneNumber, message: SMSTemplates.afaRegistration(fullName, orderCode, afaPrice.toString()), type: "afa_registration" })
  } catch (smsError) {
    console.warn("[AFA-FULFILL] Failed to send confirmation SMS:", smsError)
  }

  await supabase.from("transactions").insert({
    user_id: userId,
    type: "debit",
    amount: afaPrice,
    description: `AFA Registration - ${fullName}`,
    reference_id: transactionCode,
    source: "afa_registration",
    status: "completed",
    balance_before: balanceBefore,
    balance_after: newBalance,
    created_at: new Date().toISOString(),
  })

  try {
    const autoFulfill = await isAfaAutoFulfillmentEnabled()
    if (autoFulfill) {
      fulfillAfaOrder(afaOrder.id).catch((err) => {
        console.error("[AFA-FULFILL] Auto-fulfillment error for order", afaOrder.id, err)
      })
    }
  } catch (autoFulfillCheckError) {
    console.error("[AFA-FULFILL] Error checking auto-fulfillment setting:", autoFulfillCheckError)
  }

  return { order: afaOrder }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/afa-fulfillment.test.ts --run`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/afa-fulfillment.ts lib/afa-fulfillment.test.ts
git commit -m "feat(v1-api): extract submitAfaOrder() for reuse by the v1 route"
```

### Task 7: Refactor the dashboard AFA submit route to call `submitAfaOrder()`

**Files:**
- Modify: `app/api/afa/submit/route.ts`

- [ ] **Step 1: Replace the inline logic with a call to `submitAfaOrder()`**

Replace the body of `app/api/afa/submit/route.ts` with:

```typescript
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { submitAfaOrder } from "@/lib/afa-fulfillment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.substring(7)
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const phoneGuard = await checkPhoneVerified(supabase, user.id)
    if (!phoneGuard.allowed) {
      return NextResponse.json({ error: phoneGuard.error }, { status: 403 })
    }

    const body = await request.json()
    const { fullName, phoneNumber, ghCardNumber, location, region, occupation, userId } = body

    if (!fullName || !phoneNumber || !ghCardNumber || !location || !region || !userId) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
    }
    if (userId !== user.id) {
      return NextResponse.json({ error: "User ID mismatch" }, { status: 401 })
    }

    const result = await submitAfaOrder({ userId: user.id, fullName, phoneNumber, ghCardNumber, location, region, occupation })

    return NextResponse.json({ success: true, order: result.order, message: "AFA registration submitted successfully" }, { status: 200 })
  } catch (error: any) {
    if (error?.code === "PRICE_UNAVAILABLE") {
      return NextResponse.json({ error: error.message }, { status: 503 })
    }
    if (error?.code === "INSUFFICIENT_BALANCE") {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error?.code === "PAYMENT_FAILED" || error?.code === "ORDER_CREATE_FAILED") {
      console.error("[AFA-SUBMIT] Order/payment error:", error)
      return NextResponse.json({ error: error.message, details: error.message }, { status: 500 })
    }
    console.error("[AFA-SUBMIT] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error", details: "Failed to submit order. Please try again." }, { status: 500 })
  }
}
```

- [ ] **Step 2: Manual regression check**

Submit a real AFA registration through `/dashboard` (or wherever the AFA submit form lives) with a wallet-funded, phone-verified test account. Confirm the order lands in `afa_orders` with an `order_code`, the confirmation SMS still fires, and an unfunded account still gets HTTP 400 "Insufficient balance" (same as before the refactor).

- [ ] **Step 3: Commit**

```bash
git add app/api/afa/submit/route.ts
git commit -m "refactor(afa): route now calls the shared submitAfaOrder() service"
```

### Task 8: `POST`/`GET /api/v1/afa`

**Files:**
- Create: `app/api/v1/afa/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/v1/afa/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { submitAfaOrder } from "@/lib/afa-fulfillment"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/afa?reference=<order_code>
 */
export async function GET(request: NextRequest) {
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_afa_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("afa_orders")
    .select("order_code, full_name, phone_number, amount, status, fulfillment_status, created_at")
    .eq("order_code", reference)
    .eq("user_id", user.id)
    .single()

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.order_code,
      full_name: order.full_name,
      phone_number: order.phone_number,
      amount: order.amount,
      status: order.status,
      fulfillment_status: order.fulfillment_status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/afa
 * Body: { full_name, phone_number, gh_card_number, location, region, occupation? }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_afa_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const phoneGuard = await checkPhoneVerified(supabase, user.id)
  if (!phoneGuard.allowed) {
    return NextResponse.json({ success: false, error: phoneGuard.error }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { full_name, phone_number, gh_card_number, location, region, occupation } = body
  if (!full_name || !phone_number || !gh_card_number || !location || !region) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: full_name, phone_number, gh_card_number, location, region" },
      { status: 400 }
    )
  }

  try {
    const result = await submitAfaOrder({
      userId: user.id, fullName: full_name, phoneNumber: phone_number, ghCardNumber: gh_card_number, location, region, occupation,
    })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/afa",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { full_name, phone_number, region },
      responsePayload: { reference: result.order.order_code, status: result.order.status },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      order: {
        reference: result.order.order_code,
        full_name: result.order.full_name,
        phone_number: result.order.phone_number,
        amount: result.order.amount,
        status: result.order.status,
        created_at: result.order.created_at,
      },
    }, { status: 201 })
  } catch (error: any) {
    const status =
      error?.code === "PRICE_UNAVAILABLE" ? 503 :
      error?.code === "INSUFFICIENT_BALANCE" ? 402 :
      500

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/afa",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { full_name, phone_number, region },
      responsePayload: { error: error.message },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: error.message ?? "Failed to submit AFA order", required: error?.required }, { status })
  }
}
```

- [ ] **Step 2: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/v1/afa \
  -H "X-API-Key: dg_live_..." -H "Content-Type: application/json" \
  -d '{"full_name":"Jane Doe","phone_number":"0541234567","gh_card_number":"GHA-123456789-0","location":"Accra","region":"Greater Accra"}'
```

Expected: `201` with `{"success":true,"order":{"reference":"AFA-...","status":"pending",...}}`; then `curl "http://localhost:3000/api/v1/afa?reference=AFA-..." -H "X-API-Key: ..."` returns the same order.

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/afa/route.ts
git commit -m "feat(v1-api): add POST/GET /api/v1/afa"
```

---

## Phase 4: Results-checker v1 endpoint

### Task 9: `POST`/`GET /api/v1/results-checker`

No extraction needed — `purchaseResultsCheckerVouchers()` in `lib/results-checker-service.ts` is already a clean, directly-reusable function.

**Files:**
- Create: `app/api/v1/results-checker/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/v1/results-checker/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { checkPhoneVerified } from "@/lib/phone-verify-guard"
import { purchaseResultsCheckerVouchers, isValidExamBoard } from "@/lib/results-checker-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * GET /api/v1/results-checker?reference=<reference_code>
 */
export async function GET(request: NextRequest) {
  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const rateLimit = await applyRateLimit(request, "v1_results_checker_get", rateLimitCount, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Rate limit exceeded." }, { status: 429 })
  }

  const { searchParams } = new URL(request.url)
  const reference = searchParams.get("reference")
  if (!reference) {
    return NextResponse.json({ success: false, error: "Reference is required" }, { status: 400 })
  }

  const { data: order } = await supabase
    .from("results_checker_orders")
    .select("reference_code, exam_board, quantity, unit_price, total_paid, status, created_at")
    .eq("reference_code", reference)
    .eq("user_id", user.id)
    .single()

  if (!order) {
    return NextResponse.json({ success: false, error: "Order not found" }, { status: 404 })
  }

  return NextResponse.json({
    success: true,
    order: {
      reference: order.reference_code,
      exam_board: order.exam_board,
      quantity: order.quantity,
      unit_price: order.unit_price,
      total_paid: order.total_paid,
      status: order.status,
      created_at: order.created_at,
    },
  })
}

/**
 * POST /api/v1/results-checker
 * Body: { exam_board: "WASSCE"|"BECE"|"NOVDEC", quantity: number }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_results_checker_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const phoneGuard = await checkPhoneVerified(supabase, user.id)
  if (!phoneGuard.allowed) {
    return NextResponse.json({ success: false, error: phoneGuard.error }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { exam_board, quantity } = body
  if (!exam_board || !isValidExamBoard(exam_board)) {
    return NextResponse.json({ success: false, error: "exam_board must be one of WASSCE, BECE, NOVDEC" }, { status: 400 })
  }
  const qty = Number(quantity)
  if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
    return NextResponse.json({ success: false, error: "quantity must be a positive integer up to 50" }, { status: 400 })
  }

  try {
    const result = await purchaseResultsCheckerVouchers({ userId: user.id, examBoard: exam_board, quantity: qty })

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/results-checker",
      statusCode: 201, request, durationMs: Date.now() - start,
      requestPayload: { exam_board, quantity: qty },
      responsePayload: { reference: result.order.reference_code, voucher_count: result.vouchers.length },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      order: {
        reference: result.order.reference_code,
        exam_board,
        quantity: qty,
        total_paid: result.order.total_paid,
        status: "completed",
      },
      vouchers: result.vouchers.map((v) => ({ pin: v.pin, serial_number: v.serial_number })),
      new_balance: result.newBalance,
    }, { status: 201 })
  } catch (error: any) {
    const status =
      error?.code === "INSUFFICIENT_BALANCE" ? 402 :
      error?.code === "INSUFFICIENT_INVENTORY" ? 503 :
      500

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/results-checker",
      statusCode: status, request, durationMs: Date.now() - start,
      requestPayload: { exam_board, quantity: qty },
      responsePayload: { error: error.message },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: error.message ?? "Failed to purchase vouchers", required: error?.required }, { status })
  }
}
```

- [ ] **Step 2: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/v1/results-checker \
  -H "X-API-Key: dg_live_..." -H "Content-Type: application/json" \
  -d '{"exam_board":"WASSCE","quantity":1}'
```

Expected: `201` with `{"success":true,"order":{...},"vouchers":[{"pin":"...","serial_number":...}],"new_balance":...}` for a funded account; `402` for an unfunded one; `503` if the board's inventory is exhausted.

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/results-checker/route.ts
git commit -m "feat(v1-api): add POST/GET /api/v1/results-checker"
```

---

## Phase 5: SMS v1 endpoint

### Task 10: `POST /api/v1/sms/send`

No extraction needed — mirrors `app/api/shop/sms/send/route.ts`, swapping session-Bearer auth for `X-API-Key`. No GET handler (see constraint #3 above).

**Files:**
- Create: `app/api/v1/sms/send/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/v1/sms/send/route.ts
import { NextRequest, NextResponse } from "next/server"
import { authenticateApiKey, logApiRequest } from "@/lib/api-auth"
import { applyRateLimit } from "@/lib/rate-limiter"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { enqueueSendBatched, SMS_MAX_TOTAL } from "@/lib/sms/send-service"
import { getShopTokens } from "@/lib/sms/shop-context-service"

/**
 * POST /api/v1/sms/send
 * Body: { message: string, recipients: string[], sender_id?: string }
 */
export async function POST(request: NextRequest) {
  const start = Date.now()

  const user = await authenticateApiKey(request)
  if (!user) {
    return NextResponse.json({ success: false, error: "Invalid or missing API key" }, { status: 401 })
  }

  const rateLimitCount = user.rate_limit_per_min || 60
  const postLimit = Math.max(5, Math.floor(rateLimitCount / 3))
  const rateLimit = await applyRateLimit(request, "v1_sms_send_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ success: false, error: "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { message, recipients, sender_id } = body
  if (typeof message !== "string" || message.length < 3 || message.length > 1000) {
    return NextResponse.json({ success: false, error: "message must be a string between 3 and 1000 characters" }, { status: 400 })
  }
  if (!Array.isArray(recipients) || recipients.length === 0 || !recipients.every((r) => typeof r === "string")) {
    return NextResponse.json({ success: false, error: "recipients must be a non-empty string array" }, { status: 400 })
  }
  if (recipients.length > SMS_MAX_TOTAL) {
    return NextResponse.json({ success: false, error: `Maximum ${SMS_MAX_TOTAL} recipients per send` }, { status: 400 })
  }
  if (sender_id !== undefined && typeof sender_id !== "string") {
    return NextResponse.json({ success: false, error: "sender_id must be a string" }, { status: 400 })
  }

  const tokens = await getShopTokens(account)
  const uniqueRecipients = Array.from(new Set(recipients as string[]))

  let result: Awaited<ReturnType<typeof enqueueSendBatched>>
  try {
    result = await enqueueSendBatched(user.id, account.id, message, uniqueRecipients, tokens, sender_id)
  } catch (e) {
    console.error("[V1-SMS-SEND] batched send threw:", e)
    return NextResponse.json({ success: false, error: "SEND_ERROR" }, { status: 500 })
  }

  const durationMs = Date.now() - start

  if (!result.ok) {
    const status =
      result.error === "INSUFFICIENT_CREDITS" ? 402 :
      result.error === "NOT_ACTIVATED" || result.error === "SUSPENDED" ? 403 :
      400

    logApiRequest({
      userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/sms/send",
      statusCode: status, request, durationMs,
      requestPayload: { recipients_count: uniqueRecipients.length },
      responsePayload: { error: result.error },
    }).catch(() => {})

    return NextResponse.json({ success: false, error: result.error }, { status })
  }

  logApiRequest({
    userId: user.id, apiKeyId: user.api_key_id, method: "POST", endpoint: "/api/v1/sms/send",
    statusCode: 200, request, durationMs,
    requestPayload: { recipients_count: uniqueRecipients.length },
    responsePayload: { total: result.totalQueued, batches: result.batches },
  }).catch(() => {})

  return NextResponse.json({
    success: true,
    total: result.totalQueued,
    batches: result.batches,
    segments: result.segments,
    credits_reserved: result.creditsReserved,
    partial: result.partial,
  })
}
```

- [ ] **Step 2: Manual verification**

```bash
curl -s -X POST http://localhost:3000/api/v1/sms/send \
  -H "X-API-Key: dg_live_..." -H "Content-Type: application/json" \
  -d '{"message":"Test from the v1 API","recipients":["0541234567"]}'
```

Expected: `200` with `{"success":true,"total":1,"batches":1,...}` for an API-key owner who has an SMS account with credits; `403` "No SMS account..." for a plain user with no shop; `402` `INSUFFICIENT_CREDITS` for a shop account with 0 credits.

- [ ] **Step 3: Commit**

```bash
git add app/api/v1/sms/send/route.ts
git commit -m "feat(v1-api): add POST /api/v1/sms/send"
```

---

## Phase 6: Open key generation to all roles

### Task 11: Remove the dealer/admin-only restriction on `POST /api/user/keys`

**Files:**
- Modify: `app/api/user/keys/route.ts:68-80`

- [ ] **Step 1: Delete the role check**

In `app/api/user/keys/route.ts`, remove this block from the `POST` handler (currently right after the per-IP rate limit and before the active-key-count check):

```typescript
  // Check user role (only dealers and admins can generate keys)
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", sessionUser.id)
    .single()

  if (!profile || !["dealer", "admin"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only dealers and admins can generate API keys" },
      { status: 403 }
    )
  }
```

Everything else in the file (the 5-active-keys cap, key generation, GET, DELETE) stays unchanged.

- [ ] **Step 2: Manual verification**

With a test account whose `users.role = 'user'`, call `POST /api/user/keys` with a valid session Bearer token and `{"name":"test"}`. Expected: `201` with the generated key (previously would have been `403`). Confirm `GET /api/user/keys` and `DELETE /api/user/keys?id=...` still work for that same account.

- [ ] **Step 3: Commit**

```bash
git add app/api/user/keys/route.ts
git commit -m "feat(api-keys): open API key generation to all authenticated roles"
```

---

## Phase 7: `/dashboard/developer` page

### Task 12: Docs registry data

**Files:**
- Create: `lib/api-docs-registry.ts`

- [ ] **Step 1: Write the registry**

```typescript
// lib/api-docs-registry.ts

export interface ApiParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface ApiOperation {
  method: "GET" | "POST"
  path: string
  description: string
  params?: ApiParam[]
  curl: string
  successExample: string
  errorExamples: { status: number; body: string }[]
}

export interface ApiDocSection {
  id: string
  label: string
  operations: ApiOperation[]
}

const BASE_URL = "https://datagod.store"

export const apiDocsRegistry: ApiDocSection[] = [
  {
    id: "balance",
    label: "Balance",
    operations: [{
      method: "GET",
      path: "/api/v1/balance",
      description: "Returns the authenticated key owner's wallet balance.",
      curl: `curl -X GET ${BASE_URL}/api/v1/balance \\\n  -H "X-API-Key: dg_live_your_key_here"`,
      successExample: `{\n  "success": true,\n  "balance": 45.00,\n  "total_credited": 165.50,\n  "total_spent": 120.50,\n  "currency": "GHS",\n  "user": { "name": "John", "role": "dealer" }\n}`,
      errorExamples: [{ status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` }],
    }],
  },
  {
    id: "products",
    label: "Products",
    operations: [{
      method: "GET",
      path: "/api/v1/products",
      description: "Read-only catalog of data bundles, airtime, results-checker vouchers, and AFA registration, with your role's current pricing.",
      curl: `curl -X GET ${BASE_URL}/api/v1/products \\\n  -H "X-API-Key: dg_live_your_key_here"`,
      successExample: `{\n  "success": true,\n  "data_bundles": [{ "network": "MTN", "size_gb": "1", "price": 6.5 }],\n  "airtime": [{ "network": "MTN", "min_amount": 1, "max_amount": 500, "fee_rate_percent": 5 }],\n  "results_checker": [{ "exam_board": "WASSCE", "unit_price": 15 }],\n  "afa": { "enabled": true, "price": 50 }\n}`,
      errorExamples: [{ status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` }],
    }],
  },
  {
    id: "orders",
    label: "Data Orders",
    operations: [
      {
        method: "POST",
        path: "/api/v1/orders",
        description: "Place a data bundle order for a recipient number.",
        params: [
          { name: "network", type: "string", required: true, description: "e.g. MTN, Telecel, AT - iShare" },
          { name: "volume_gb", type: "integer", required: true, description: "Bundle size in GB" },
          { name: "recipient", type: "string", required: true, description: "Recipient phone number" },
          { name: "reference", type: "string", required: true, description: "Your own unique idempotency reference (3-100 chars)" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/orders \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "network": "MTN",\n    "volume_gb": 5,\n    "recipient": "0541234567",\n    "reference": "your_unique_txn_id"\n  }'`,
        successExample: `{\n  "success": true,\n  "order": { "id": "...", "reference": "your_unique_txn_id", "network": "MTN", "volume_gb": 5, "status": "pending" }\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient balance", "required": 12.5 }` },
          { status: 409, body: `{ "success": false, "error": "Duplicate reference" }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/orders?reference=<ref>",
        description: "Check the status of a previously placed data order by your own reference.",
        curl: `curl -X GET "${BASE_URL}/api/v1/orders?reference=your_unique_txn_id" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "your_unique_txn_id", "status": "completed" }\n}`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "airtime",
    label: "Airtime",
    operations: [
      {
        method: "POST",
        path: "/api/v1/airtime",
        description: "Top up airtime for a recipient number.",
        params: [
          { name: "network", type: "string", required: true, description: "MTN, AirtelTigo, or Telecel" },
          { name: "recipient", type: "string", required: true, description: "10-digit recipient phone number" },
          { name: "amount", type: "number", required: true, description: "GHS amount, up to 1000" },
          { name: "pay_separately", type: "boolean", required: false, description: "If true, the fee is added on top instead of deducted from amount" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/airtime \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "network": "MTN", "recipient": "0541234567", "amount": 5 }'`,
        successExample: `{\n  "success": true,\n  "order": { "reference_code": "AT-XXX-YYY", "status": "pending" },\n  "new_balance": 32.5\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance", "required": 5.25 }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue." }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/airtime?reference=<ref>",
        description: "Check the status of an airtime order by its reference_code.",
        curl: `curl -X GET "${BASE_URL}/api/v1/airtime?reference=AT-XXX-YYY" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "AT-XXX-YYY", "status": "processing" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "afa",
    label: "AFA",
    operations: [
      {
        method: "POST",
        path: "/api/v1/afa",
        description: "Submit an AFA (government scheme) registration order.",
        params: [
          { name: "full_name", type: "string", required: true, description: "Registrant's full name" },
          { name: "phone_number", type: "string", required: true, description: "Registrant's phone number" },
          { name: "gh_card_number", type: "string", required: true, description: "Ghana Card number" },
          { name: "location", type: "string", required: true, description: "Registrant's location" },
          { name: "region", type: "string", required: true, description: "Registrant's region" },
          { name: "occupation", type: "string", required: false, description: "Defaults to Farmer if omitted" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/afa \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "full_name": "Jane Doe",\n    "phone_number": "0541234567",\n    "gh_card_number": "GHA-123456789-0",\n    "location": "Accra",\n    "region": "Greater Accra"\n  }'`,
        successExample: `{ "success": true, "order": { "reference": "AFA-1234567", "status": "pending" } }`,
        errorExamples: [{ status: 402, body: `{ "success": false, "error": "Insufficient balance", "required": 50 }` }],
      },
      {
        method: "GET",
        path: "/api/v1/afa?reference=<ref>",
        description: "Check the status of an AFA order by its reference (order_code).",
        curl: `curl -X GET "${BASE_URL}/api/v1/afa?reference=AFA-1234567" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "AFA-1234567", "status": "completed", "fulfillment_status": "fulfilled" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "results-checker",
    label: "Results Checker",
    operations: [
      {
        method: "POST",
        path: "/api/v1/results-checker",
        description: "Buy one or more WASSCE/BECE/NOVDEC results-checker voucher PINs.",
        params: [
          { name: "exam_board", type: "string", required: true, description: "WASSCE, BECE, or NOVDEC" },
          { name: "quantity", type: "integer", required: true, description: "1-50" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/results-checker \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "exam_board": "WASSCE", "quantity": 1 }'`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "RC-XXX-YYY", "status": "completed" },\n  "vouchers": [{ "pin": "1234-5678-90", "serial_number": "WA0001234" }],\n  "new_balance": 30\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance", "required": 15 }` },
          { status: 503, body: `{ "success": false, "error": "Insufficient voucher inventory" }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/results-checker?reference=<ref>",
        description: "Look up a previously purchased voucher order (does not re-return the PIN).",
        curl: `curl -X GET "${BASE_URL}/api/v1/results-checker?reference=RC-XXX-YYY" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "RC-XXX-YYY", "exam_board": "WASSCE", "quantity": 1, "status": "completed" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "sms",
    label: "SMS",
    operations: [{
      method: "POST",
      path: "/api/v1/sms/send",
      description: "Send an SMS to one or more recipients using your own SMS account credits. Requires a shop, sub-agent, or admin account.",
      params: [
        { name: "message", type: "string", required: true, description: "3-1000 characters" },
        { name: "recipients", type: "string[]", required: true, description: "Up to 5000 phone numbers" },
        { name: "sender_id", type: "string", required: false, description: "One of your account's active sender IDs; defaults to your first active one" },
      ],
      curl: `curl -X POST ${BASE_URL}/api/v1/sms/send \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "message": "Hello from the API", "recipients": ["0541234567"] }'`,
      successExample: `{ "success": true, "total": 1, "batches": 1, "segments": 1, "credits_reserved": 1, "partial": false }`,
      errorExamples: [
        { status: 402, body: `{ "success": false, "error": "INSUFFICIENT_CREDITS" }` },
        { status: 403, body: `{ "success": false, "error": "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }` },
      ],
    }],
  },
]
```

- [ ] **Step 2: Commit**

```bash
git add lib/api-docs-registry.ts
git commit -m "feat(developer-page): add the v1 API docs registry"
```

### Task 13: `EndpointDoc` renderer component

**Files:**
- Create: `components/developer/EndpointDoc.tsx`

- [ ] **Step 1: Write the component**

```typescript
// components/developer/EndpointDoc.tsx
"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Copy, Check } from "lucide-react"
import type { ApiDocSection } from "@/lib/api-docs-registry"

function CopyableBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative">
      <pre className="bg-muted/50 border rounded-lg p-4 text-xs overflow-x-auto font-mono">{text}</pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2 h-7 w-7"
        onClick={() => {
          navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
      </Button>
    </div>
  )
}

export function EndpointDoc({ section }: { section: ApiDocSection }) {
  return (
    <div className="space-y-8">
      {section.operations.map((op) => (
        <div key={`${op.method}-${op.path}`} className="space-y-3">
          <div className="flex items-center gap-2 font-mono text-sm">
            <Badge className={op.method === "GET" ? "bg-sky-600 hover:bg-sky-600" : "bg-emerald-600 hover:bg-emerald-600"}>
              {op.method}
            </Badge>
            <span>{op.path}</span>
          </div>
          <p className="text-sm text-muted-foreground">{op.description}</p>

          {op.params && op.params.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border rounded-lg overflow-hidden">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2">Param</th>
                    <th className="p-2">Type</th>
                    <th className="p-2">Required</th>
                    <th className="p-2">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {op.params.map((p) => (
                    <tr key={p.name}>
                      <td className="p-2 font-mono">{p.name}</td>
                      <td className="p-2 text-muted-foreground">{p.type}</td>
                      <td className="p-2">{p.required ? "Yes" : "No"}</td>
                      <td className="p-2 text-muted-foreground">{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Request</p>
            <CopyableBlock text={op.curl} />
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Success response</p>
            <CopyableBlock text={op.successExample} />
          </div>
          {op.errorExamples.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Example errors</p>
              <div className="space-y-2">
                {op.errorExamples.map((e, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <Badge variant="outline" className="font-mono mt-0.5">{e.status}</Badge>
                    <pre className="bg-muted/50 border rounded-lg p-3 text-xs overflow-x-auto font-mono flex-1">{e.body}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/developer/EndpointDoc.tsx
git commit -m "feat(developer-page): add the EndpointDoc renderer"
```

### Task 14: `DeveloperKeysCard` key-management component

**Files:**
- Create: `components/developer/DeveloperKeysCard.tsx`

This replaces `components/developer/ApiKeysManager.tsx`'s functionality, rebuilt with shadcn instead of raw CSS-in-JS (matching the rest of the app, per the bulk-SMS UI-overhaul precedent). Same backend contract (`/api/user/keys`), same one-time-reveal UX.

- [ ] **Step 1: Write the component**

```typescript
// components/developer/DeveloperKeysCard.tsx
"use client"

import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Plus, Trash2, Copy, Check, RefreshCw, KeyRound } from "lucide-react"
import { toast } from "sonner"

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

const MAX_ACTIVE_KEYS = 5

export function DeveloperKeysCard() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState("")
  const [generating, setGenerating] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  const fetchKeys = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/user/keys", { headers: await authHeader() })
      const data = await res.json()
      if (res.ok) setKeys(data.keys || [])
      else toast.error(data.error || "Failed to load API keys")
    } catch {
      toast.error("Failed to load API keys")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchKeys() }, [])

  const activeCount = keys.filter((k) => k.is_active).length

  const generateKey = async () => {
    if (!newKeyName.trim()) return
    setGenerating(true)
    try {
      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({ name: newKeyName.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setGeneratedKey(data.key)
        setNewKeyName("")
        fetchKeys()
      } else {
        toast.error(data.error || "Failed to generate key")
      }
    } catch {
      toast.error("Failed to generate key")
    } finally {
      setGenerating(false)
    }
  }

  const revokeKey = async (keyId: string) => {
    try {
      const res = await fetch(`/api/user/keys?id=${keyId}`, { method: "DELETE", headers: await authHeader() })
      if (res.ok) {
        toast.success("API key revoked")
        fetchKeys()
      } else {
        const data = await res.json()
        toast.error(data.error || "Failed to revoke key")
      }
    } catch {
      toast.error("Failed to revoke key")
    }
  }

  const copyKey = () => {
    if (!generatedKey) return
    navigator.clipboard.writeText(generatedKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><KeyRound className="w-4 h-4" /> Your API Keys</CardTitle>
            <CardDescription>Generate keys to authenticate requests to the Datagod API ({activeCount}/{MAX_ACTIVE_KEYS} active).</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchKeys}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {generatedKey && (
          <div className="rounded-lg border border-success/30 bg-success/5 p-4 space-y-2">
            <p className="text-sm font-semibold text-success">Copy your new key now — it won't be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background rounded px-3 py-2 border font-mono break-all">{generatedKey}</code>
              <Button size="sm" variant="outline" onClick={copyKey}>
                {copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setGeneratedKey(null)}>Dismiss</Button>
          </div>
        )}

        <div className="flex gap-2">
          <Input
            placeholder="Key name (e.g. My App)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generateKey()}
            disabled={activeCount >= MAX_ACTIVE_KEYS}
          />
          <Button onClick={generateKey} disabled={generating || !newKeyName.trim() || activeCount >= MAX_ACTIVE_KEYS}>
            <Plus className="w-4 h-4 mr-1.5" />
            {generating ? "Generating..." : "Generate"}
          </Button>
        </div>
        {activeCount >= MAX_ACTIVE_KEYS && (
          <p className="text-xs text-muted-foreground">You've reached the {MAX_ACTIVE_KEYS}-key limit — revoke one to generate another.</p>
        )}

        <div className="divide-y rounded-lg border">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
          ) : keys.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No API keys yet. Generate your first key above.</div>
          ) : keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between p-3">
              <div>
                <div className="text-sm font-medium">{key.name}</div>
                <div className="text-xs text-muted-foreground font-mono">{key.key_prefix}••••••••••••••••</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Created {new Date(key.created_at).toLocaleDateString()} ·{" "}
                  {key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}` : "Never used"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={key.is_active ? "secondary" : "outline"} className={key.is_active ? "bg-success/15 text-success border-border" : ""}>
                  {key.is_active ? "Active" : "Revoked"}
                </Badge>
                {key.is_active && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive hover:bg-destructive/10">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke this API key?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Any application using "{key.name}" will immediately stop being able to authenticate. This cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revokeKey(key.id)} className="bg-destructive hover:bg-destructive/90">
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/developer/DeveloperKeysCard.tsx
git commit -m "feat(developer-page): add the shadcn-based key management card"
```

### Task 15: The `/dashboard/developer` page

**Files:**
- Create: `app/dashboard/developer/page.tsx`

- [ ] **Step 1: Write the page**

```typescript
// app/dashboard/developer/page.tsx
"use client"

import { useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code2 } from "lucide-react"
import { DeveloperKeysCard } from "@/components/developer/DeveloperKeysCard"
import { EndpointDoc } from "@/components/developer/EndpointDoc"
import { apiDocsRegistry } from "@/lib/api-docs-registry"

export default function DeveloperPage() {
  const [activeTab, setActiveTab] = useState(apiDocsRegistry[0].id)

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6 max-w-5xl mx-auto">
        <header className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
            <Code2 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Developer / API</h1>
            <p className="text-sm text-muted-foreground">Integrate and automate with the Datagod API.</p>
          </div>
        </header>

        <DeveloperKeysCard />

        <Card>
          <CardHeader>
            <CardTitle>API Configuration</CardTitle>
            <CardDescription>Every request needs a valid key.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Base URL:</span> <code className="bg-muted/50 px-1.5 py-0.5 rounded">https://datagod.store/api/v1</code></p>
            <p><span className="text-muted-foreground">Auth:</span> send your key as the <code className="bg-muted/50 px-1.5 py-0.5 rounded">X-API-Key</code> header on every request.</p>
          </CardContent>
        </Card>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap h-auto">
            {apiDocsRegistry.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>{section.label}</TabsTrigger>
            ))}
          </TabsList>
          {apiDocsRegistry.map((section) => (
            <TabsContent key={section.id} value={section.id} className="mt-6">
              <EndpointDoc section={section} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 2: Manual browser verification**

Run: `npm run dev`, sign in as a test account (any role, not just dealer), navigate to `http://localhost:3000/dashboard/developer`. Confirm: the page renders inside the normal dashboard chrome (sidebar visible); the key card loads/generates/reveals-once/revokes correctly; all 7 tabs render without console errors; copy buttons work; the page looks consistent with the rest of the dark/emerald dashboard (not the raw-CSS look of the old widget).

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/developer/page.tsx
git commit -m "feat(developer-page): add the /dashboard/developer page"
```

### Task 16: Sidebar navigation entry

**Files:**
- Modify: `components/layout/sidebar.tsx:12-79`

- [ ] **Step 1: Add the `Code2` icon import**

In the `lucide-react` import block at the top of `components/layout/sidebar.tsx`, add `Code2` to the list (alongside `Globe` at the end):

```typescript
  Globe,
  Code2,
} from "lucide-react"
```

- [ ] **Step 2: Add the menu entry**

In the `menuItems` array, add a new entry right after the Profile entry:

```typescript
  { href: "/dashboard/profile", label: "Profile", icon: User, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/developer", label: "Developer / API", icon: Code2, roles: ["user", "admin", "sub_agent", "dealer"] },
```

- [ ] **Step 3: Manual verification**

With the dev server running, confirm "Developer / API" appears in the sidebar for a plain `user`-role test account (not just dealer/admin), and that clicking it navigates to `/dashboard/developer` with the row highlighted as active.

- [ ] **Step 4: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat(developer-page): add sidebar entry for the developer page"
```

### Task 17: Remove the old embedded widget from Profile

**Files:**
- Modify: `app/dashboard/profile/page.tsx`
- Delete: `components/developer/ApiKeysManager.tsx`

- [ ] **Step 1: Remove the import and the embedded card**

In `app/dashboard/profile/page.tsx`, delete this import line:

```typescript
import ApiKeysManager from "@/components/developer/ApiKeysManager"
```

And delete this block:

```typescript
        {/* API Keys */}
        {(isDealer || profile.role === 'admin') && (
          <Card>
            <CardContent className="pt-6">
              <ApiKeysManager />
            </CardContent>
          </Card>
        )}
```

- [ ] **Step 2: Delete the old component file**

```bash
git rm components/developer/ApiKeysManager.tsx
```

- [ ] **Step 3: Manual verification**

Confirm `npm run build` (or `npx tsc --noEmit`) has no dangling-import errors, and that `/dashboard/profile` renders normally without the old API Keys card (replaced by a mention in the sidebar's new "Developer / API" entry).

Run: `npx tsc --noEmit`
Expected: no new errors referencing `ApiKeysManager` or `app/dashboard/profile/page.tsx`

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/profile/page.tsx
git commit -m "refactor(profile): remove the API Keys card, superseded by /dashboard/developer"
```

---

## Self-Review Notes

- **Spec coverage:** Every endpoint in the spec's table (products, airtime, AFA, results-checker, sms/send) has a task (2, 5, 8, 9, 10). Phone-gate parity is in Tasks 5/8/9 (airtime/AFA/results-checker), explicitly not in Task 10 (sms) per the spec. The role-gate removal is Task 11. The page (key management + docs + sidebar + Profile cleanup) is Tasks 12–17.
- **Type consistency checked:** `purchaseAirtime`'s `PurchaseAirtimeResult.order.reference_code` matches what Task 5's route reads off it; `submitAfaOrder`'s returned `order` (the raw `afa_orders` row, includes `order_code`, `full_name`, `phone_number`, `amount`, `status`, `created_at`) matches what Task 8's route destructures from `result.order`.
- **No placeholders:** every step above has complete, runnable code — nothing marked TBD or "add validation here."
