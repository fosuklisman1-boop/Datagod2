# Shop WhatsApp "Check My Results" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Check My Results" (Datagod performs the WASSCE/BECE/NOVDEC check on the customer's behalf — combo or own-voucher) as a 4th product on the shop WhatsApp bot, alongside its existing Data/Airtime/Results-Checker-voucher products.

**Architecture:** New shop-prefixed session steps (`RCCHECK_*`) in `lib/whatsapp-bot/shop-router.ts`, mirroring the exact step order and validation of the main bot's `RC_CHECK_*` flow but rendered as shop-styled WhatsApp menus and billed through the shop's existing token/MoMo mechanism. Writes to the existing `results_check_requests` table (no migration) via a new `createShopCheckResultsRequest()` helper, reusing the already shop-aware `calculateResultsCheckPrice()`. Two small, targeted fixes ride along: the Paystack webhook's existing `results_check_requests` completion branch is missing shop-profit crediting and token deduction (a real gap this feature would otherwise silently walk into), and the admin-notify channel label needs a new case for the `whatsapp_shop` channel this feature introduces.

**Tech Stack:** Next.js/TypeScript, Supabase (Postgres), Vitest, WhatsApp Cloud API, Paystack (mobile money direct charge).

**Spec:** `docs/superpowers/specs/2026-07-31-shop-whatsapp-check-my-results-design.md`

---

### Task 1: Session types

**Files:**
- Modify: `lib/whatsapp-bot/shop-types.ts`
- Modify: `lib/whatsapp-bot/shop-router.ts`

**Note:** this task touches two files, not one, because `WaShopSession.pendingOrderTable`'s type and `shop-router.ts`'s own `ShopOrderTable` type are structurally coupled — the `SUBMIT_OTP` case does `const table: ShopOrderTable = session.pendingOrderTable ?? 'ussd_shop_orders'`. Widening one without the other breaks `tsc --noEmit` immediately (confirmed by running it: `error TS2322: Type '"results_check_requests"' is not assignable to type 'ShopOrderTable'` at that exact line). They must land in the same commit.

- [ ] **Step 1: Add the new steps, session fields, and `pendingOrderTable` value**

In `lib/whatsapp-bot/shop-types.ts`, add to the `WaShopStep` union (after the existing `RC_CONFIRM` line):

```ts
  // Check My Results (Datagod checks on the customer's behalf — distinct
  // from the RC_* voucher-purchase flow above)
  | 'RCCHECK_SELECT_BOARD'
  | 'RCCHECK_CANDIDATE_TYPE'
  | 'RCCHECK_MODE'
  | 'RCCHECK_ENTER_VOUCHER'
  | 'RCCHECK_ENTER_INDEX'
  | 'RCCHECK_ENTER_YEAR'
  | 'RCCHECK_ENTER_DOB'
  | 'RCCHECK_ENTER_PAYMENT_PHONE'
  | 'RCCHECK_CONFIRM'
```

Change the `pendingOrderTable` field's type from:

```ts
  pendingOrderTable?: 'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders'
```

to:

```ts
  pendingOrderTable?: 'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders' | 'results_check_requests'
```

Add new fields after the existing `// Results Checker flow` block:

```ts
  // Check My Results flow
  rcCheckBoard?: string
  rcCheckCandidateType?: 'school' | 'private'
  rcCheckMode?: 'combo' | 'own_voucher'
  rcCheckFee?: number          // own_voucher total (shop-marked-up)
  rcCheckComboTotal?: number   // combo total (shop-marked-up); undefined when the board has 0 stock
  rcCheckAmount?: number       // the amount actually shown/charged, set once mode is chosen
  rcCheckVoucherPin?: string
  rcCheckVoucherSerial?: string
  rcCheckIndex?: string
  rcCheckYear?: number
  rcCheckDob?: string
```

- [ ] **Step 2: Widen the coupled type in `shop-router.ts`**

In `lib/whatsapp-bot/shop-router.ts`, extend the `ShopOrderTable` type and `BROAD_STATUS_COL` map:

```ts
export type ShopOrderTable = 'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders' | 'results_check_requests'

const BROAD_STATUS_COL: Record<ShopOrderTable, 'order_status' | 'status'> = {
  ussd_shop_orders: 'order_status',
  airtime_orders: 'status',
  results_checker_orders: 'status',
  results_check_requests: 'status',
}
```

(This table has two independent state columns — `payment_status` and `status` — same split `airtime_orders`/`results_checker_orders` already have. `markOrderOtpRequired` always writes only `payment_status` regardless of table, unchanged; `markOrderFailed` writes both `payment_status` and whatever `BROAD_STATUS_COL[table]` resolves to.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add lib/whatsapp-bot/shop-types.ts lib/whatsapp-bot/shop-router.ts
git commit -m "feat(whatsapp-shop): add session types for Check My Results flow"
```

---

### Task 2: Menu renderers

**Files:**
- Modify: `lib/whatsapp-bot/shop-menus.ts`
- Test: `lib/whatsapp-bot/shop-menus.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/whatsapp-bot/shop-menus.test.ts`. First, add the new names to the existing import block at the top of the file (extend the destructured import list with `shopRcCheckBoardMenu, shopRcCheckCandidateTypeMenu, shopRcCheckModeMenu, shopRcCheckVoucherPrompt, shopRcCheckIndexPrompt, shopRcCheckYearPrompt, shopRcCheckDobPrompt, shopRcCheckConfirmMenu`). Then add this describe block, and extend the existing `shopProductMenu` tests:

```ts
  describe("entry / product menus", () => {
    it("shopEnterCodeMenu prompts for a code and offers exit", () => {
      const text = shopEnterCodeMenu()
      expect(text).toContain("Enter shop code")
      expect(text).toContain("0. Exit")
    })

    it("shopInvalidCodeMenu surfaces the reason before re-prompting", () => {
      const text = shopInvalidCodeMenu("Shop code not found.")
      expect(text).toContain("Shop code not found.")
      expect(text).toContain("Enter shop code")
    })

    it("shopProductMenu shows the shop name and all four products by default", () => {
      const text = shopProductMenu("Kofi's Data Shop")
      expect(text).toContain("Kofi's Data Shop")
      expect(text).toContain("1. Data Bundle")
      expect(text).toContain("2. Airtime")
      expect(text).toContain("3. Results Checker")
      expect(text).toContain("4. Check My Results")
    })

    it("shopProductMenu omits Data Bundle when showData is false, renumbering Check My Results to 3", () => {
      const text = shopProductMenu("Kofi's Data Shop", false)
      expect(text).not.toContain("Data Bundle")
      expect(text).toContain("1. Airtime")
      expect(text).toContain("2. Results Checker")
      expect(text).toContain("3. Check My Results")
    })
  })
```

(This replaces the existing two `shopProductMenu` tests in that describe block — same block, updated expectations.)

```ts
  describe("shop check-my-results menus", () => {
    it("shopRcCheckBoardMenu lists the shop name and each board with a number", () => {
      const text = shopRcCheckBoardMenu("Shop A", ["WASSCE", "BECE"])
      expect(text).toContain("Shop A")
      expect(text).toContain("1. WASSCE")
      expect(text).toContain("2. BECE")
      expect(text).toContain("0. Back")
    })

    it("shopRcCheckCandidateTypeMenu offers school/private", () => {
      const text = shopRcCheckCandidateTypeMenu()
      expect(text).toContain("1. School")
      expect(text).toContain("2. Private")
      expect(text).toContain("0. Back")
    })

    it("shopRcCheckModeMenu shows both the combo and own-voucher prices", () => {
      const text = shopRcCheckModeMenu(12, 2)
      expect(text).toContain("GHS 12.00")
      expect(text).toContain("GHS 2.00")
      expect(text).toContain("0. Back")
    })

    it("shopRcCheckVoucherPrompt asks for PIN/Serial", () => {
      const text = shopRcCheckVoucherPrompt()
      expect(text).toContain("PIN")
      expect(text).toContain("Serial")
      expect(text).toContain("0. Back")
    })

    it("shopRcCheckIndexPrompt asks for the index number", () => {
      expect(shopRcCheckIndexPrompt()).toContain("index number")
    })

    it("shopRcCheckYearPrompt asks for the exam year", () => {
      expect(shopRcCheckYearPrompt()).toContain("exam year")
    })

    it("shopRcCheckDobPrompt asks for DD/MM/YYYY", () => {
      expect(shopRcCheckDobPrompt()).toContain("DD/MM/YYYY")
    })

    it("shopRcCheckConfirmMenu shows board, candidate type, index, year, dob, mode, amount, and payment number", () => {
      const text = shopRcCheckConfirmMenu(
        "Shop A", "WASSCE", "school", "0070202043", 2024, "15/06/2008", "combo", 12, "233245555555"
      )
      expect(text).toContain("Shop A")
      expect(text).toContain("WASSCE (School)")
      expect(text).toContain("Index: 0070202043")
      expect(text).toContain("Year: 2024")
      expect(text).toContain("DOB: 15/06/2008")
      expect(text).toContain("Voucher + check")
      expect(text).toContain("GHS 12.00 from")
      expect(text).toContain("0245555555")
      expect(text).toContain("1. Pay now")
      expect(text).toContain("2. Cancel")
    })

    it("shopRcCheckConfirmMenu labels own_voucher mode as 'Check only'", () => {
      const text = shopRcCheckConfirmMenu(
        "Shop A", "WASSCE", "private", "0070202043", 2024, "15/06/2008", "own_voucher", 2, "233245555555"
      )
      expect(text).toContain("WASSCE (Private)")
      expect(text).toContain("Check only")
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/whatsapp-bot/shop-menus.test.ts`
Expected: FAIL — `shopRcCheckBoardMenu` (and siblings) is not exported from `./shop-menus`, and the updated `shopProductMenu` assertions fail against the current 3-item menu.

- [ ] **Step 3: Implement**

In `lib/whatsapp-bot/shop-menus.ts`, replace `shopProductMenu`:

```ts
export function shopProductMenu(shopName: string, showData = true): string {
  if (showData) {
    return `${shopName}\nWhat to buy?\n1. Data Bundle\n2. Airtime\n3. Results Checker\n4. Check My Results\n0. Exit`
  }
  return `${shopName}\nWhat to buy?\n1. Airtime\n2. Results Checker\n3. Check My Results\n0. Exit`
}
```

Add after the existing `shopRcConfirmMenu` function (before `formatLocal`):

```ts
// ── Shop Check My Results (Datagod checks on the customer's behalf) ──────────
export function shopRcCheckBoardMenu(shopName: string, boards: string[]): string {
  const lines = boards.map((b, i) => `${i + 1}. ${b}`)
  lines.push('0. Back')
  return `${shopName}\nCheck My Results\nSelect exam board:\n` + lines.join('\n')
}

export function shopRcCheckCandidateTypeMenu(): string {
  return 'Candidate Type:\n1. School\n2. Private\n\n0. Back'
}

export function shopRcCheckModeMenu(comboTotal: number, ownFee: number): string {
  return (
    `How to pay?\n` +
    `1. Buy voucher + check\n   GHS ${comboTotal.toFixed(2)}\n` +
    `2. I have a voucher\n   GHS ${ownFee.toFixed(2)}\n\n` +
    `0. Back`
  )
}

export function shopRcCheckVoucherPrompt(): string {
  return 'Enter voucher PIN\nand serial number:\n(PIN/Serial)\ne.g. 1234/567890\n\n0. Back'
}

export function shopRcCheckIndexPrompt(): string {
  return 'Enter your index number:\n(10 digits e.g. 0070202043)\n\n0. Back'
}

export function shopRcCheckYearPrompt(): string {
  return 'Enter exam year:\n(e.g. 2024)\n\n0. Back'
}

export function shopRcCheckDobPrompt(): string {
  return 'Enter date of birth:\n(DD/MM/YYYY)\ne.g. 15/06/2008\n\n0. Back'
}

export function shopRcCheckConfirmMenu(
  shopName: string,
  board: string,
  candidateType: 'school' | 'private',
  indexNo: string,
  year: number,
  dob: string,
  mode: 'combo' | 'own_voucher',
  amount: number,
  paymentPhone: string
): string {
  const boardLine = `${board} (${candidateType === 'school' ? 'School' : 'Private'})`
  const detail = mode === 'combo' ? 'Voucher + check' : 'Check only'
  return (
    `${shopName}\n` +
    `${boardLine}\n` +
    `Index: ${indexNo}\nYear: ${year}\nDOB: ${dob}\n` +
    `${detail}\n` +
    `GHS ${amount.toFixed(2)} from\n${formatLocal(paymentPhone)}\n\n` +
    `1. Pay now\n2. Cancel`
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/whatsapp-bot/shop-menus.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp-bot/shop-menus.ts lib/whatsapp-bot/shop-menus.test.ts
git commit -m "feat(whatsapp-shop): add Check My Results menu renderers"
```

---

### Task 3: Order-creation helper

**Files:**
- Modify: `lib/shop-commerce/orders.ts`
- Test: `lib/shop-commerce/orders.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/shop-commerce/orders.test.ts` (add `createShopCheckResultsRequest` to the existing top import from `./orders`):

```ts
describe("createShopCheckResultsRequest", () => {
  const baseInput = {
    examBoard: "WASSCE",
    candidateType: "school" as const,
    indexNumber: "0070202043",
    examYear: 2024,
    dob: "15/06/2008",
    mode: "combo" as const,
    phoneNumber: "0241234567",
    whatsappNumber: "0241234567",
    fee: 12,
    paymentReference: "RCK123AB",
    shopId: "s1",
    merchantCommission: 3,
  }

  it("tags the insert payload with channel: 'whatsapp_shop' and returns the new request id", async () => {
    const { client, captured } = fakeInsertClient("results_check_requests", { data: { id: "req1" }, error: null })

    const result = await createShopCheckResultsRequest({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ orderId: "req1" })
    expect(captured.payload).toMatchObject({
      exam_board: "WASSCE",
      candidate_type: "school",
      index_number: "0070202043",
      exam_year: 2024,
      dob: "15/06/2008",
      mode: "combo",
      voucher_pin: null,
      voucher_serial: null,
      phone_number: "0241234567",
      whatsapp_number: "0241234567",
      fee: 12,
      payment_reference: "RCK123AB",
      shop_id: "s1",
      merchant_commission: 3,
      user_id: null,
      payment_status: "pending_payment",
      status: "pending",
      channel: "whatsapp_shop",
    })
  })

  it("stores voucher_pin/voucher_serial only in own_voucher mode", async () => {
    const { client, captured } = fakeInsertClient("results_check_requests", { data: { id: "req2" }, error: null })

    await createShopCheckResultsRequest({
      ...baseInput, channel: "whatsapp_shop", mode: "own_voucher",
      voucherPin: "123456789012", voucherSerial: "WGR1900112581",
    }, client)

    expect(captured.payload.voucher_pin).toBe("123456789012")
    expect(captured.payload.voucher_serial).toBe("WGR1900112581")
  })

  it("nulls voucher_pin/voucher_serial in combo mode even if passed", async () => {
    const { client, captured } = fakeInsertClient("results_check_requests", { data: { id: "req3" }, error: null })

    await createShopCheckResultsRequest({
      ...baseInput, channel: "whatsapp_shop", mode: "combo",
      voucherPin: "should-be-ignored", voucherSerial: "should-be-ignored",
    }, client)

    expect(captured.payload.voucher_pin).toBeNull()
    expect(captured.payload.voucher_serial).toBeNull()
  })

  it("returns { error } instead of throwing when the insert fails", async () => {
    const { client } = fakeInsertClient("results_check_requests", { data: null, error: { message: "insert failed" } })

    const result = await createShopCheckResultsRequest({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ error: "insert failed" })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/shop-commerce/orders.test.ts`
Expected: FAIL — `createShopCheckResultsRequest` is not exported from `./orders`.

- [ ] **Step 3: Implement**

Add to `lib/shop-commerce/orders.ts`, after `createShopRcOrder`:

```ts
// ── Check My Results (Datagod checks the customer's result, distinct from
// the voucher-purchase RcOrderInput above) ──────────────────────────────────

export interface CheckResultsRequestInput {
  examBoard: string
  candidateType: 'school' | 'private'
  indexNumber: string
  examYear: number
  dob: string
  mode: 'combo' | 'own_voucher'
  voucherPin?: string | null
  voucherSerial?: string | null
  phoneNumber: string       // customer's own number, local format — this table's identity column
  whatsappNumber: string    // same number; the shop bot always knows it, no separate ask
  fee: number
  paymentReference: string
  shopId: string
  merchantCommission: number
  channel: ShopOrderChannel
}

export async function createShopCheckResultsRequest(
  input: CheckResultsRequestInput,
  client: SupabaseClientLike = supabase
): Promise<{ orderId: string } | { error: string }> {
  const { data, error } = await client
    .from("results_check_requests")
    .insert([{
      exam_board: input.examBoard,
      candidate_type: input.candidateType,
      index_number: input.indexNumber,
      exam_year: input.examYear,
      dob: input.dob,
      mode: input.mode,
      voucher_pin: input.mode === 'own_voucher' ? (input.voucherPin ?? null) : null,
      voucher_serial: input.mode === 'own_voucher' ? (input.voucherSerial ?? null) : null,
      phone_number: input.phoneNumber,
      whatsapp_number: input.whatsappNumber,
      fee: input.fee,
      payment_reference: input.paymentReference,
      shop_id: input.shopId,
      merchant_commission: input.merchantCommission,
      user_id: null,
      payment_status: "pending_payment",
      status: "pending",
      channel: input.channel,
    }])
    .select("id")
    .single()

  if (error || !data) {
    return { error: error?.message ?? "Failed to create results check request" }
  }
  return { orderId: data.id }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/shop-commerce/orders.test.ts`
Expected: PASS (all tests in the file, including the pre-existing bundle/airtime/RC-voucher describe blocks).

- [ ] **Step 5: Commit**

```bash
git add lib/shop-commerce/orders.ts lib/shop-commerce/orders.test.ts
git commit -m "feat(whatsapp-shop): add createShopCheckResultsRequest order helper"
```

---

### Task 4: Admin-notify channel label + shop attribution

**Files:**
- Modify: `lib/results-checker-service.ts:135-164` (`notifyAdminsNewResultsCheckRequest`)

No test file exists for `lib/results-checker-service.ts` today (it's a heavy Supabase-integration module with no fake-client convention, unlike the `lib/shop-commerce/` modules) — verify this change by reading the diff carefully and running the full suite afterward to confirm nothing else regresses.

- [ ] **Step 1: Implement**

In `lib/results-checker-service.ts`, replace the body of `notifyAdminsNewResultsCheckRequest`:

```ts
export async function notifyAdminsNewResultsCheckRequest(requestId: string): Promise<void> {
  const phones = await getResultsCheckAdminPhones()
  if (phones.length === 0) return

  const { data: req } = await supabase
    .from("results_check_requests")
    .select("*")
    .eq("id", requestId)
    .single()
  if (!req) return

  const channelLabel = req.channel === "whatsapp" ? "WhatsApp"
    : req.channel === "whatsapp_shop" ? "WhatsApp Shop"
    : req.channel === "web" ? "Web" : "USSD"

  let shopSuffix = ""
  if (req.shop_id) {
    const { data: shop } = await supabase
      .from("user_shops")
      .select("shop_name")
      .eq("id", req.shop_id)
      .maybeSingle()
    if (shop?.shop_name) shopSuffix = ` via ${shop.shop_name}`
  }

  const modeLabel = req.mode === "combo" ? "Combo (voucher assigned)" : "Own voucher"
  const message =
    `🔔 New Results Check Request\n\n` +
    `${req.exam_board} · ${modeLabel}\n` +
    `Index: ${req.index_number} (${req.exam_year})\n` +
    `Channel: ${channelLabel}${shopSuffix} · ${req.phone_number}\n` +
    `Ref: ${req.payment_reference}` +
    voucherInfoBlock(req) +
    `\n\nReply "pending" to view and pick up requests.`

  const { sendWhatsAppText } = await import("@/lib/whatsapp-bot/send")
  for (const phone of phones) {
    const waPhone = phone.startsWith("0") ? `233${phone.slice(1)}` : phone.replace(/^\+/, "")
    await sendWhatsAppText(waPhone, message).catch(e =>
      console.warn(`[RC-CHECK] Admin notify to ${phone} failed:`, e)
    )
  }
}
```

The only changes from the original: the `channelLabel` ternary gains the `"whatsapp_shop"` branch, and the new `shopSuffix` block (a no-op — empty string — for every existing caller, since none of them set `shop_id` on a `results_check_requests` row today).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All existing tests still pass (this file has no dedicated test suite, so this step confirms no other test transitively depends on the exact old message string).

- [ ] **Step 3: Commit**

```bash
git add lib/results-checker-service.ts
git commit -m "fix(results-check): label whatsapp_shop channel and attribute shop in admin notify"
```

---

### Task 5: Router — menu entry, board, candidate type, mode

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts`
- Modify: `lib/whatsapp-bot/shop-router.test.ts`

- [ ] **Step 1: Extend test-file mocks and fake client (test infrastructure, not yet a new behavior test)**

In `lib/whatsapp-bot/shop-router.test.ts`:

Add `calculateResultsCheckPrice` to the existing `vi.mock("@/lib/results-checker-service", ...)` block (alongside `isExamBoardEnabled`, `getAvailableCount`, etc.):

```ts
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(),
  getAvailableCount: vi.fn(),
  getMaxQuantity: vi.fn(),
  calculateRCPrice: vi.fn(),
  getRCBulkHint: vi.fn(),
  calculateResultsCheckPrice: vi.fn(),
}))
```

Add `createShopCheckResultsRequest` to the existing `vi.mock("@/lib/shop-commerce/orders", ...)` block:

```ts
vi.mock("@/lib/shop-commerce/orders", () => ({
  createShopBundleOrder: vi.fn(),
  createShopAirtimeOrder: vi.fn(),
  createShopRcOrder: vi.fn(),
  createShopCheckResultsRequest: vi.fn(),
}))
```

Add `"results_check_requests"` to the fake Supabase client's table-recognition condition (around line 143):

```ts
      if (table === "ussd_shop_orders" || table === "airtime_orders" || table === "results_checker_orders" || table === "results_check_requests") {
```

Make the fake client's existing `admin_settings` branch key-aware, so it can serve both the pre-existing data-whitelist setting and the new results-check-service kill switch with independent values. Currently (around line 136-144):

```ts
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { value: { enabled: fakeDb.whitelistEnabled } } }),
            }),
          }),
        }
      }
```

Change to:

```ts
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: () => {
                if (key === "results_check_settings") {
                  return Promise.resolve({ data: { value: { enabled: fakeDb.resultsCheckEnabled } } })
                }
                return Promise.resolve({ data: { value: { enabled: fakeDb.whitelistEnabled } } })
              },
            }),
          }),
        }
      }
```

Add `resultsCheckEnabled: true` to the `fakeDb` object's initial shape (near `whitelistEnabled: false`) — defaults to enabled, matching the real admin default (`enabled !== false`).

Add the new menu functions and `chargeMobileMoney`/`createShopCheckResultsRequest` are already imported for mocking above; also add the import line for the new menu renderers is not needed in the test file (the router imports them, not the test) — no further import changes needed here since the test file imports `shopWaRouter` itself, not individual menu functions.

- [ ] **Step 2: Write the failing test**

Add to `lib/whatsapp-bot/shop-router.test.ts`, after the existing `// ── Results Checker (Task 3.4) ──` describe block's tests (before `// ── Inbox visibility ──`):

```ts
  // ── Check My Results ────────────────────────────────────────────────────────
  it("walks code -> product(4) -> board -> candidate type -> mode menu (combo available)", async () => {
    const phone = "233241000100"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc90", shopId: "s90", shopName: "Check Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockImplementation(async ({ mode }) =>
      mode === "combo"
        ? { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, voucherPrice: 10, totalPaid: 12, merchantCommission: 1 }
        : { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0 }
    )

    await shopWaRouter(phone, "CODE1", "ck1") // ENTER_CODE -> SELECT_PRODUCT
    await shopWaRouter(phone, "4", "ck2") // SELECT_PRODUCT -> RCCHECK_SELECT_BOARD
    expect(lastReplyTo(phone)).toContain("Select exam board")

    await shopWaRouter(phone, "1", "ck3") // WASSCE -> RCCHECK_CANDIDATE_TYPE
    expect(lastReplyTo(phone)).toContain("Candidate Type")

    await shopWaRouter(phone, "1", "ck4") // School -> RCCHECK_MODE (combo available)
    expect(lastReplyTo(phone)).toContain("GHS 12.00")
    expect(lastReplyTo(phone)).toContain("GHS 2.00")
  })

  it("skips the mode menu and forces own_voucher when the board has 0 voucher stock", async () => {
    const phone = "233241000101"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc91", shopId: "s91", shopName: "No Stock Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(0)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })

    await shopWaRouter(phone, "CODE1", "ck5")
    await shopWaRouter(phone, "4", "ck6")
    await shopWaRouter(phone, "1", "ck7") // WASSCE -> RCCHECK_CANDIDATE_TYPE

    await shopWaRouter(phone, "2", "ck8") // Private -> forced RCCHECK_ENTER_VOUCHER
    expect(lastReplyTo(phone)).toContain("No vouchers in stock")
    expect(lastReplyTo(phone)).toContain("PIN")
  })

  it("renumbers Check My Results to option 3 when Data is blocked", async () => {
    const phone = "233241000102"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc92", shopId: "s92", shopName: "Blocked Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    fakeDb.whitelistEnabled = true
    fakeDb.hasCompletedPurchase = false
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })

    await shopWaRouter(phone, "CODE1", "ck9")
    expect(lastReplyTo(phone)).toContain("3. Check My Results")

    await shopWaRouter(phone, "3", "ck10") // renumbered Check My Results
    expect(lastReplyTo(phone)).toContain("Select exam board")

    fakeDb.whitelistEnabled = false
    fakeDb.hasCompletedPurchase = true
  })
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: FAIL — `shopProductMenu` doesn't yet show "4. Check My Results" (Task 2 already made this pass at the menu-string level, but the router doesn't yet handle input `'4'`, so `SELECT_PRODUCT` falls through to the generic re-prompt and the flow never reaches `RCCHECK_SELECT_BOARD`).

- [ ] **Step 4: Implement**

In `lib/whatsapp-bot/shop-router.ts`:

Extend the `./shop-menus` import (around line 5-11) to add the new renderers:

```ts
import {
  shopProductMenu, shopNetworkMenu, shopBundleMenu, shopRecipientPrompt,
  shopPaymentPhonePrompt, shopInvalidPaymentPhoneMenu, shopConfirmMenu,
  shopPaymentSentMenu, shopOtpMenu, shopInvalidCodeMenu, sortNetworks, PAGE_SIZE,
  shopAirtimeRecipientPrompt, shopAirtimeNetworkMenu, shopAirtimeAmountPrompt, shopAirtimeConfirmMenu,
  shopRcBoardMenu, shopRcQtyPrompt, shopRcConfirmMenu,
  shopRcCheckBoardMenu, shopRcCheckCandidateTypeMenu, shopRcCheckModeMenu,
  shopRcCheckVoucherPrompt, shopRcCheckIndexPrompt, shopRcCheckYearPrompt,
  shopRcCheckDobPrompt, shopRcCheckConfirmMenu,
} from "./shop-menus"
```

Extend the `@/lib/results-checker-service` import (around line 26-29) to add `calculateResultsCheckPrice`:

```ts
import {
  isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice, getRCBulkHint,
  calculateResultsCheckPrice,
  type ExamBoard,
} from "@/lib/results-checker-service"
```

Add a new import for the pure validators, after the `secureReference` import (line 31):

```ts
import { isValidVoucherPin, isValidVoucherSerial, isValidIndexNumber, isValidDob, isValidExamYear } from "@/lib/results-check-validation"
```

Extend the `@/lib/shop-commerce/orders` import (line 16) to add `createShopCheckResultsRequest`:

```ts
import { createShopBundleOrder, createShopAirtimeOrder, createShopRcOrder, createShopCheckResultsRequest } from "@/lib/shop-commerce/orders"
```

(`ShopOrderTable` and `BROAD_STATUS_COL` were already widened in Task 1, together with the coupled `pendingOrderTable` type in `shop-types.ts` — no further change needed here.)

**Add a new local helper, near the file's other small helpers (e.g. right after `shopNoProviderMessage`):**

```ts
// Check My Results has no voucher-inventory dependency in own_voucher mode (the
// customer supplies their own PIN/serial) — unlike buildRcBoardOptions() (the
// voucher-PURCHASE flow's board list), which filters out any board with 0
// stock. Gating Check My Results entry on stock would make the whole feature
// unavailable whenever inventory empties out (has happened in this codebase
// before — results_checker_inventory has been observed completely empty),
// even though own_voucher mode never touches inventory at all. This only
// respects the admin's per-board enable toggle (results_checker_enabled_<board>) —
// unlike USSD/the main WhatsApp bot's Check-flow board menu (lib/ussd/menus.ts's
// rcCheckBoardMenu, always all 3 boards, no per-board filtering at all), this is
// a deliberately stricter, per-board gate for the shop channel. Combo-mode stock
// is still checked separately, per board, once one is selected — purely for
// pricing, not for whether the board can be checked at all.
async function buildRcCheckBoardOptions(): Promise<string[]> {
  const boards: ExamBoard[] = ['WASSCE', 'BECE', 'NOVDEC']
  const results = await Promise.all(boards.map(async (b) => (await isExamBoardEnabled(b)) ? b : null))
  return results.filter((b): b is ExamBoard => b !== null)
}

// The master service-wide kill switch (admin_settings.results_check_settings.enabled)
// that USSD and the main WhatsApp bot both check at their equivalent menu entry
// (lib/ussd/handlers/results-checker.ts's RC_MENU case '3': `if (!enabled) return
// cont('Service not available...')`). That helper (getRcCheckSettings) is private
// to that file, so — same reasoning as fetchPaystackFeePercent above — this is
// resolved inline here with the module's own Supabase client, mirroring the exact
// admin_settings row shape.
async function isResultsCheckServiceEnabled(): Promise<boolean> {
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", "results_check_settings")
    .maybeSingle()
  return (data as any)?.value?.enabled !== false
}
```

This needs no new test mock for `buildRcCheckBoardOptions` — `isExamBoardEnabled` is already in the test file's `@/lib/results-checker-service` mock block, so tests control it directly (see the `vi.mocked(isExamBoardEnabled).mockResolvedValue(true)` lines already added to Step 2's tests above). `isResultsCheckServiceEnabled` reads through the same fake Supabase client the test file already provides for `admin_settings` (used for the data-whitelist setting) — extend that fake client's `admin_settings` branch to also serve a `results_check_settings` row (default `{ enabled: true }` via a new `fakeDb.resultsCheckEnabled = true` field), added in this task's Step 1 alongside the other fake-client extensions.

In the `SELECT_PRODUCT` case's data-blocked branch (currently `input === '1'` -> Airtime, `input === '2'` -> RC-voucher, `input === '0'` -> exit), insert a new `input === '3'` branch before the `input === '0'` branch:

```ts
        if (dataBlocked) {
          // Renumbered menu (no Data option at all): 1=Airtime, 2=Results Checker, 3=Check My Results.
          if (input === '1') {
            session.step = 'AIRTIME_ENTER_RECIPIENT'
            reply = shopAirtimeRecipientPrompt(shopName)
          } else if (input === '2') {
            const boards = await buildRcBoardOptions()
            if (boards.length === 0) {
              reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName, false)}`
            } else {
              session.step = 'RC_SELECT_BOARD'
              session.rcBoardOptions = boards
              reply = shopRcBoardMenu(shopName, boards)
            }
          } else if (input === '3') {
            const serviceEnabled = await isResultsCheckServiceEnabled()
            const boards = serviceEnabled ? await buildRcCheckBoardOptions() : []
            if (boards.length === 0) {
              reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName, false)}`
            } else {
              session.step = 'RCCHECK_SELECT_BOARD'
              session.rcBoardOptions = boards
              reply = shopRcCheckBoardMenu(shopName, boards)
            }
          } else if (input === '0') {
            deleteAfter = true
            reply = 'Goodbye.'
          } else {
            reply = shopProductMenu(shopName, false)
          }
          break
        }
```

In the same case's unblocked branch, insert a new `input === '4'` branch before the existing `input === '0'` branch:

```ts
        } else if (input === '3') {
          const boards = await buildRcBoardOptions()
          if (boards.length === 0) {
            reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName)}`
          } else {
            session.step = 'RC_SELECT_BOARD'
            session.rcBoardOptions = boards
            reply = shopRcBoardMenu(shopName, boards)
          }
        } else if (input === '4') {
          const serviceEnabled = await isResultsCheckServiceEnabled()
          const boards = serviceEnabled ? await buildRcCheckBoardOptions() : []
          if (boards.length === 0) {
            reply = `Results Checker unavailable.\n\n${shopProductMenu(shopName)}`
          } else {
            session.step = 'RCCHECK_SELECT_BOARD'
            session.rcBoardOptions = boards
            reply = shopRcCheckBoardMenu(shopName, boards)
          }
        } else if (input === '0') {
          deleteAfter = true
          reply = 'Goodbye.'
        } else {
          reply = shopProductMenu(shopName)
        }
        break
      }
```

(The `input === '3'` branch already exists; only the new `input === '4'` branch and this restated context are shown for placement clarity — the existing `1`/`2`/`3`/`0` branches are unchanged.)

Add three new cases after the existing `RC_CONFIRM` case (before `SUBMIT_OTP`):

```ts
      // ── RCCHECK_SELECT_BOARD ─────────────────────────────────────────────────
      case 'RCCHECK_SELECT_BOARD': {
        const options = session.rcBoardOptions ?? []
        if (input === '0') {
          session.step = 'SELECT_PRODUCT'
          reply = shopProductMenu(shopName, !(session.dataBlocked === true))
          break
        }

        const idx = parseInt(input, 10) - 1
        const board = Number.isNaN(idx) ? undefined : options[idx]
        if (!board) {
          reply = shopRcCheckBoardMenu(shopName, options)
          break
        }

        session.step = 'RCCHECK_CANDIDATE_TYPE'
        session.rcCheckBoard = board
        reply = shopRcCheckCandidateTypeMenu()
        break
      }

      // ── RCCHECK_CANDIDATE_TYPE ───────────────────────────────────────────────
      case 'RCCHECK_CANDIDATE_TYPE': {
        if (input === '0') {
          session.step = 'RCCHECK_SELECT_BOARD'
          reply = shopRcCheckBoardMenu(shopName, session.rcBoardOptions ?? [])
          break
        }
        if (input !== '1' && input !== '2') {
          reply = shopRcCheckCandidateTypeMenu()
          break
        }
        const candidateType = input === '1' ? 'school' : 'private'
        const board = session.rcCheckBoard! as ExamBoard

        const avail = await getAvailableCount(board)
        const ownPricing = await calculateResultsCheckPrice({ examBoard: board, mode: 'own_voucher', shopId: session.shopId })
        session.rcCheckCandidateType = candidateType
        session.rcCheckFee = ownPricing.totalPaid

        if (avail > 0) {
          const comboPricing = await calculateResultsCheckPrice({ examBoard: board, mode: 'combo', shopId: session.shopId })
          session.step = 'RCCHECK_MODE'
          session.rcCheckComboTotal = comboPricing.totalPaid
          reply = shopRcCheckModeMenu(comboPricing.totalPaid, ownPricing.totalPaid)
        } else {
          session.step = 'RCCHECK_ENTER_VOUCHER'
          session.rcCheckMode = 'own_voucher'
          session.rcCheckAmount = ownPricing.totalPaid
          reply = `No vouchers in stock.\nProvide your own PIN.\n\n${shopRcCheckVoucherPrompt()}`
        }
        break
      }

      // ── RCCHECK_MODE ─────────────────────────────────────────────────────────
      case 'RCCHECK_MODE': {
        if (input === '0') {
          session.step = 'RCCHECK_CANDIDATE_TYPE'
          reply = shopRcCheckCandidateTypeMenu()
          break
        }
        if (input === '1') {
          session.step = 'RCCHECK_ENTER_INDEX'
          session.rcCheckMode = 'combo'
          session.rcCheckAmount = session.rcCheckComboTotal
          reply = shopRcCheckIndexPrompt()
          break
        }
        if (input === '2') {
          session.step = 'RCCHECK_ENTER_VOUCHER'
          session.rcCheckMode = 'own_voucher'
          session.rcCheckAmount = session.rcCheckFee
          reply = shopRcCheckVoucherPrompt()
          break
        }
        reply = shopRcCheckModeMenu(session.rcCheckComboTotal ?? 0, session.rcCheckFee ?? 0)
        break
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: The three new tests pass. The `RCCHECK_ENTER_INDEX`/`RCCHECK_ENTER_VOUCHER` cases don't exist yet, but none of Task 5's tests advance past receiving the reply that transitions into them (they assert on the reply text produced by the *current* case, not the next one) — the router's `default:` case would only be hit by a *subsequent* message, which these tests don't send. Full suite: `npm test` should also still pass (no other test touches these new steps yet).

- [ ] **Step 6: Commit**

```bash
git add lib/whatsapp-bot/shop-router.ts lib/whatsapp-bot/shop-router.test.ts
git commit -m "feat(whatsapp-shop): wire Check My Results menu entry, board, candidate type, mode"
```

---

### Task 6: Router — voucher/index/year/DOB entry

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts`
- Modify: `lib/whatsapp-bot/shop-router.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/whatsapp-bot/shop-router.test.ts`, after Task 5's tests:

```ts
  it("combo mode: index -> year -> dob -> payment-phone prompt", async () => {
    const phone = "233241000110"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc93", shopId: "s93", shopName: "Combo Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockImplementation(async ({ mode }) =>
      mode === "combo"
        ? { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, voucherPrice: 10, totalPaid: 12, merchantCommission: 1 }
        : { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0 }
    )

    await shopWaRouter(phone, "CODE1", "cd1")
    await shopWaRouter(phone, "4", "cd2")
    await shopWaRouter(phone, "1", "cd3") // WASSCE
    await shopWaRouter(phone, "1", "cd4") // School -> RCCHECK_MODE
    await shopWaRouter(phone, "1", "cd5") // combo -> RCCHECK_ENTER_INDEX
    expect(lastReplyTo(phone)).toContain("index number")

    await shopWaRouter(phone, "0070202043", "cd6") // -> RCCHECK_ENTER_YEAR
    expect(lastReplyTo(phone)).toContain("exam year")

    await shopWaRouter(phone, "abcd", "cd7") // invalid year -> re-prompt
    expect(lastReplyTo(phone)).toContain("Invalid year")

    await shopWaRouter(phone, "2024", "cd8") // -> RCCHECK_ENTER_DOB
    expect(lastReplyTo(phone)).toContain("DD/MM/YYYY")

    await shopWaRouter(phone, "31/02/2008", "cd9") // invalid calendar date -> re-prompt
    expect(lastReplyTo(phone)).toContain("Invalid date")

    await shopWaRouter(phone, "15/06/2008", "cd10") // -> RCCHECK_ENTER_PAYMENT_PHONE
    expect(lastReplyTo(phone)).toContain("MoMo number")
  })

  it("own_voucher mode: voucher PIN/serial -> index, with board-aware validation", async () => {
    const phone = "233241000111"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc94", shopId: "s94", shopName: "Own Voucher Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })

    await shopWaRouter(phone, "CODE1", "ov1")
    await shopWaRouter(phone, "4", "ov2")
    await shopWaRouter(phone, "1", "ov3") // WASSCE
    await shopWaRouter(phone, "1", "ov4") // School -> RCCHECK_MODE
    await shopWaRouter(phone, "2", "ov5") // own_voucher -> RCCHECK_ENTER_VOUCHER

    await shopWaRouter(phone, "12345/WGR1900112581", "ov6") // bad PIN (not 12 digits) -> re-prompt
    expect(lastReplyTo(phone)).toContain("Invalid PIN or serial")

    await shopWaRouter(phone, "123456789012/WGR1900112581", "ov7") // valid -> RCCHECK_ENTER_INDEX
    expect(lastReplyTo(phone)).toContain("index number")
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: FAIL — `RCCHECK_ENTER_INDEX`/`RCCHECK_ENTER_YEAR`/`RCCHECK_ENTER_DOB`/`RCCHECK_ENTER_VOUCHER` don't exist, so the router hits `default:` ("Session error...") instead of the expected prompts.

- [ ] **Step 3: Implement**

Add these four cases in `lib/whatsapp-bot/shop-router.ts`, right after the `RCCHECK_MODE` case added in Task 5:

```ts
      // ── RCCHECK_ENTER_VOUCHER ────────────────────────────────────────────────
      case 'RCCHECK_ENTER_VOUCHER': {
        if (input === '0') {
          if (session.rcCheckComboTotal !== undefined) {
            session.step = 'RCCHECK_MODE'
            reply = shopRcCheckModeMenu(session.rcCheckComboTotal, session.rcCheckFee ?? 0)
          } else {
            session.step = 'RCCHECK_CANDIDATE_TYPE'
            reply = shopRcCheckCandidateTypeMenu()
          }
          break
        }

        const board = session.rcCheckBoard! as ExamBoard
        const raw = input.trim().toUpperCase()
        const parts = raw.split(/[/,\s]+/)
        const pin = parts[0] ?? ''
        const serial = parts[1] ?? ''
        if (!pin || !serial || !isValidVoucherPin(board, pin) || !isValidVoucherSerial(board, serial)) {
          reply = board === 'BECE'
            ? 'Invalid PIN or serial.\nPIN: 10-12 letters/digits\nSerial: digits e.g. 252100270719\n\nFormat: PIN/Serial\n\n0. Back'
            : 'Invalid PIN or serial.\nPIN: 12 digits\nSerial: e.g. WGR1900112581\n\nFormat: PIN/Serial\ne.g. 012345678912/WGR1900112581\n\n0. Back'
          break
        }

        session.step = 'RCCHECK_ENTER_INDEX'
        session.rcCheckVoucherPin = pin
        session.rcCheckVoucherSerial = serial
        reply = shopRcCheckIndexPrompt()
        break
      }

      // ── RCCHECK_ENTER_INDEX ──────────────────────────────────────────────────
      case 'RCCHECK_ENTER_INDEX': {
        if (input === '0') {
          if (session.rcCheckMode === 'own_voucher') {
            session.step = 'RCCHECK_ENTER_VOUCHER'
            reply = shopRcCheckVoucherPrompt()
          } else {
            session.step = 'RCCHECK_MODE'
            reply = shopRcCheckModeMenu(session.rcCheckComboTotal ?? 0, session.rcCheckFee ?? 0)
          }
          break
        }

        const board = session.rcCheckBoard! as ExamBoard
        const index = input.trim().replace(/\s/g, '')
        if (!isValidIndexNumber(board, index)) {
          const hint = board === 'BECE' ? '10 or 12 digits' : 'exactly 10 digits'
          reply = `Invalid index number.\nMust be ${hint},\nnumbers only.\ne.g. 0070202043\n\n0. Back`
          break
        }

        session.step = 'RCCHECK_ENTER_YEAR'
        session.rcCheckIndex = index
        reply = shopRcCheckYearPrompt()
        break
      }

      // ── RCCHECK_ENTER_YEAR ───────────────────────────────────────────────────
      case 'RCCHECK_ENTER_YEAR': {
        if (input === '0') {
          session.step = 'RCCHECK_ENTER_INDEX'
          reply = shopRcCheckIndexPrompt()
          break
        }

        const year = parseInt(input, 10)
        if (Number.isNaN(year) || !isValidExamYear(year)) {
          reply = `Invalid year.\nEnter a year between\n1980 and ${new Date().getFullYear()}.\n\n0. Back`
          break
        }

        session.step = 'RCCHECK_ENTER_DOB'
        session.rcCheckYear = year
        reply = shopRcCheckDobPrompt()
        break
      }

      // ── RCCHECK_ENTER_DOB ────────────────────────────────────────────────────
      case 'RCCHECK_ENTER_DOB': {
        if (input === '0') {
          session.step = 'RCCHECK_ENTER_YEAR'
          reply = shopRcCheckYearPrompt()
          break
        }

        const normalised = input.trim().replace(/-/g, '/')
        if (!isValidDob(normalised)) {
          reply = 'Invalid date.\nUse DD/MM/YYYY\ne.g. 15/06/2008\n\n0. Back'
          break
        }

        session.step = 'RCCHECK_ENTER_PAYMENT_PHONE'
        session.rcCheckDob = normalised
        reply = shopPaymentPhonePrompt()
        break
      }
```

Add `'RCCHECK_ENTER_VOUCHER'` and `'RCCHECK_ENTER_DOB'` to the `FREE_TEXT_ENTRY_STEPS` array (their valid input contains `/`, so it fails the `isDigitOrZero` test and would otherwise escape to the AI before ever reaching these cases):

```ts
    const FREE_TEXT_ENTRY_STEPS: WaShopSession['step'][] = [
      'ENTER_RECIPIENT', 'AIRTIME_ENTER_RECIPIENT', 'AIRTIME_ENTER_AMOUNT',
      'RCCHECK_ENTER_VOUCHER', 'RCCHECK_ENTER_DOB',
    ]
```

(`RCCHECK_ENTER_INDEX` and `RCCHECK_ENTER_YEAR` take pure digits, so they already pass `isDigitOrZero` unaided — no listing needed, same as `RC_ENTER_QTY` today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: PASS (both new tests, plus everything from Task 5).

- [ ] **Step 5: Commit**

```bash
git add lib/whatsapp-bot/shop-router.ts lib/whatsapp-bot/shop-router.test.ts
git commit -m "feat(whatsapp-shop): wire Check My Results voucher/index/year/dob entry"
```

---

### Task 7: Router — payment phone, confirm, charge, and full end-to-end tests

**Files:**
- Modify: `lib/whatsapp-bot/shop-router.ts`
- Modify: `lib/whatsapp-bot/shop-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/whatsapp-bot/shop-router.test.ts`, after Task 6's tests:

```ts
  it("combo mode: full flow through payment-phone, confirm, charge, and OTP", async () => {
    const phone = "233241000120"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc95", shopId: "s95", shopName: "Full Combo Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockImplementation(async ({ mode }) =>
      mode === "combo"
        ? { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, voucherPrice: 10, totalPaid: 12, merchantCommission: 1 }
        : { checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0 }
    )

    await shopWaRouter(phone, "CODE1", "fc1")
    await shopWaRouter(phone, "4", "fc2")
    await shopWaRouter(phone, "1", "fc3") // WASSCE
    await shopWaRouter(phone, "1", "fc4") // School
    await shopWaRouter(phone, "1", "fc5") // combo -> RCCHECK_ENTER_INDEX
    await shopWaRouter(phone, "0070202043", "fc6")
    await shopWaRouter(phone, "2024", "fc7")
    await shopWaRouter(phone, "15/06/2008", "fc8") // -> RCCHECK_ENTER_PAYMENT_PHONE

    await shopWaRouter(phone, "0244000333", "fc9") // -> RCCHECK_CONFIRM
    expect(lastReplyTo(phone)).toContain("Pay now")
    expect(lastReplyTo(phone)).toContain("GHS 12.00")

    vi.mocked(createShopCheckResultsRequest).mockResolvedValue({ orderId: "req1" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "req1" })

    await shopWaRouter(phone, "1", "fc10") // CONFIRM -> pay -> send_otp

    expect(createShopCheckResultsRequest).toHaveBeenCalledWith(expect.objectContaining({
      examBoard: "WASSCE",
      candidateType: "school",
      indexNumber: "0070202043",
      examYear: 2024,
      dob: "15/06/2008",
      mode: "combo",
      voucherPin: null,
      voucherSerial: null,
      phoneNumber: "0241000120",
      whatsappNumber: "0241000120",
      fee: 12,
      shopId: "s95",
      merchantCommission: 1,
      channel: "whatsapp_shop",
    }))
    expect(chargeMobileMoney).toHaveBeenCalledWith(expect.objectContaining({
      amount: 12,
      phone: "0244000333",
      provider: "mtn",
      reference: "req1",
    }))
    expect(lastReplyTo(phone)).toContain("OTP")

    vi.mocked(submitOtp).mockResolvedValue({ status: "pending", reference: "req1" })
    await shopWaRouter(phone, "123456", "fc11")
    expect(submitOtp).toHaveBeenCalledWith("req1", "123456")
  })

  it("RCCHECK_CONFIRM: a token balance that hit zero rejects and does not create a request or charge", async () => {
    const phone = "233241000121"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc96", shopId: "s96", shopName: "Broke Check Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })

    await shopWaRouter(phone, "CODE1", "tz1")
    await shopWaRouter(phone, "4", "tz2")
    await shopWaRouter(phone, "1", "tz3") // WASSCE -> RCCHECK_CANDIDATE_TYPE
    await shopWaRouter(phone, "1", "tz3b") // School -> RCCHECK_MODE (stock is 3, so the mode menu shows)
    await shopWaRouter(phone, "2", "tz4") // own_voucher -> RCCHECK_ENTER_VOUCHER
    await shopWaRouter(phone, "123456789012/WGR1900112581", "tz5")
    await shopWaRouter(phone, "0070202043", "tz6")
    await shopWaRouter(phone, "2024", "tz7")
    await shopWaRouter(phone, "15/06/2008", "tz8")
    await shopWaRouter(phone, "0244000333", "tz9")

    fakeDb.tokenBalance = 0
    await shopWaRouter(phone, "1", "tz10")

    expect(createShopCheckResultsRequest).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no sessions left")

    fakeDb.tokenBalance = 5
  })

  it("RCCHECK_CONFIRM: chargeMobileMoney throwing marks the results check request failed", async () => {
    const phone = "233241000122"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc97", shopId: "s97", shopName: "Throw Check Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })
    vi.mocked(createShopCheckResultsRequest).mockResolvedValue({ orderId: "req2" })
    vi.mocked(chargeMobileMoney).mockRejectedValue(new Error("Paystack charge failed (HTTP 400)"))

    await shopWaRouter(phone, "CODE1", "th1")
    await shopWaRouter(phone, "4", "th2") // -> RCCHECK_SELECT_BOARD
    await shopWaRouter(phone, "1", "th3") // WASSCE -> RCCHECK_CANDIDATE_TYPE
    await shopWaRouter(phone, "1", "th3b") // School -> RCCHECK_MODE (stock is 3)
    await shopWaRouter(phone, "2", "th4") // own_voucher -> RCCHECK_ENTER_VOUCHER
    await shopWaRouter(phone, "123456789012/WGR1900112581", "th5")
    await shopWaRouter(phone, "0070202043", "th6")
    await shopWaRouter(phone, "2024", "th7")
    await shopWaRouter(phone, "15/06/2008", "th8")
    await shopWaRouter(phone, "0244000333", "th9")

    await shopWaRouter(phone, "1", "th10")

    expect(lastReplyTo(phone)).toContain("could not start the payment")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "results_check_requests",
      payload: expect.objectContaining({ status: "failed", payment_status: "failed" }),
      id: "req2",
    })
  })

  it("RCCHECK_CONFIRM: the board going disabled between mode selection and confirm is rejected", async () => {
    const phone = "233241000123"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc98", shopId: "s98", shopName: "Disabled Mid Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(calculateResultsCheckPrice).mockResolvedValue({
      checkFee: 2, checkFeeMarkup: 0, effectiveCheckFee: 2, totalPaid: 2, merchantCommission: 0,
    })

    await shopWaRouter(phone, "CODE1", "db1")
    await shopWaRouter(phone, "4", "db2") // -> RCCHECK_SELECT_BOARD
    await shopWaRouter(phone, "1", "db3") // WASSCE -> RCCHECK_CANDIDATE_TYPE
    await shopWaRouter(phone, "1", "db3b") // School -> RCCHECK_MODE (stock is 3)
    await shopWaRouter(phone, "2", "db4") // own_voucher -> RCCHECK_ENTER_VOUCHER
    await shopWaRouter(phone, "123456789012/WGR1900112581", "db5")
    await shopWaRouter(phone, "0070202043", "db6")
    await shopWaRouter(phone, "2024", "db7")
    await shopWaRouter(phone, "15/06/2008", "db8")
    await shopWaRouter(phone, "0244000333", "db9")

    vi.mocked(isExamBoardEnabled).mockResolvedValue(false)
    await shopWaRouter(phone, "1", "db10")

    expect(createShopCheckResultsRequest).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no longer available")
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: FAIL — `RCCHECK_ENTER_PAYMENT_PHONE`/`RCCHECK_CONFIRM` don't exist yet, so these flows hit `default:` partway through.

- [ ] **Step 3: Implement**

Add these two cases in `lib/whatsapp-bot/shop-router.ts`, right after the `RCCHECK_ENTER_DOB` case added in Task 6:

```ts
      // ── RCCHECK_ENTER_PAYMENT_PHONE ──────────────────────────────────────────
      case 'RCCHECK_ENTER_PAYMENT_PHONE': {
        if (input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }

        const local = normalizeGhanaLocal(input)
        if (!isValidLocalGhana(local)) {
          reply = shopInvalidPaymentPhoneMenu()
          break
        }

        const paystackProvider = paystackProviderFromPhone(local)
        if (!paystackProvider) {
          reply = shopNoProviderMessage()
          break
        }

        session.step = 'RCCHECK_CONFIRM'
        session.paymentPhone = local
        session.paystackProvider = paystackProvider
        reply = shopRcCheckConfirmMenu(
          shopName, session.rcCheckBoard!, session.rcCheckCandidateType ?? 'school',
          session.rcCheckIndex!, session.rcCheckYear!, session.rcCheckDob!,
          session.rcCheckMode ?? 'own_voucher', session.rcCheckAmount ?? 0, local
        )
        break
      }

      // ── RCCHECK_CONFIRM ──────────────────────────────────────────────────────
      case 'RCCHECK_CONFIRM': {
        if (input === '2' || input === '0') {
          deleteAfter = true
          reply = 'Order cancelled.'
          break
        }
        if (input !== '1') {
          reply = shopRcCheckConfirmMenu(
            shopName, session.rcCheckBoard!, session.rcCheckCandidateType ?? 'school',
            session.rcCheckIndex!, session.rcCheckYear!, session.rcCheckDob!,
            session.rcCheckMode ?? 'own_voucher', session.rcCheckAmount ?? 0, session.paymentPhone!
          )
          break
        }

        // Same anti-race token recheck as every other CONFIRM step.
        const tokenBalance = await fetchShopCodeTokenBalance(session.shopCodeId!)
        if (tokenBalance === null || tokenBalance <= 0) {
          deleteAfter = true
          reply = 'This shop has no sessions left. Please contact the seller.'
          break
        }

        const board = session.rcCheckBoard! as ExamBoard
        const mode = session.rcCheckMode ?? 'own_voucher'

        // Re-verify server-side (stale-session guard) — mirrors every other
        // shop CONFIRM step; do NOT trust session.rcCheckAmount for the charge.
        // Checks both the service-wide kill switch (an admin could disable the
        // whole service mid-session — up to 30 min per shop-session.ts's TTL)
        // and the per-board enable toggle re-verified at entry.
        const [serviceEnabled, enabled] = await Promise.all([
          isResultsCheckServiceEnabled(),
          isExamBoardEnabled(board),
        ])
        if (!serviceEnabled || !enabled) {
          deleteAfter = true
          reply = 'Results Checker is no longer available. Please send your shop code to start again.'
          break
        }
        if (mode === 'combo') {
          const avail = await getAvailableCount(board)
          if (avail < 1) {
            deleteAfter = true
            reply = 'No vouchers left for that board. Please send your shop code to start again.'
            break
          }
        }

        const pricing = await calculateResultsCheckPrice({ examBoard: board, mode, shopId: session.shopId })

        const referenceCode = secureReference("RCK", 2, 3)
        const localCustomerPhone = normalizeGhanaLocal(from)
        const customerEmail = await resolveEmail(from).catch(() => null)

        const orderResult = await createShopCheckResultsRequest({
          examBoard: board,
          candidateType: session.rcCheckCandidateType ?? 'school',
          indexNumber: session.rcCheckIndex!,
          examYear: session.rcCheckYear!,
          dob: session.rcCheckDob!,
          mode,
          voucherPin: session.rcCheckVoucherPin ?? null,
          voucherSerial: session.rcCheckVoucherSerial ?? null,
          phoneNumber: localCustomerPhone,
          whatsappNumber: localCustomerPhone,
          fee: pricing.totalPaid,
          paymentReference: referenceCode,
          shopId: session.shopId!,
          merchantCommission: pricing.merchantCommission,
          channel: 'whatsapp_shop',
        })

        if ('error' in orderResult) {
          console.error("[WA-SHOP-RCCHECK-CONFIRM] Failed to create request:", orderResult.error)
          deleteAfter = true
          reply = 'Sorry, there was an error creating your request. Please try again.'
          break
        }

        const orderId = orderResult.orderId
        const email = customerEmail ?? await resolveEmail(from).catch(() => `${from.replace(/\D/g, '')}@ussd.datagod.com`)

        try {
          const { status } = await chargeMobileMoney({
            email,
            amount: pricing.totalPaid,
            phone: session.paymentPhone!,
            provider: session.paystackProvider as 'mtn' | 'vod' | 'tgo',
            reference: orderId,
            metadata: {
              source: 'whatsapp_shop_results_check',
              results_check_request_id: orderId,
              exam_board: board,
              mode,
              shop_id: session.shopId,
            },
          })

          if (status === 'send_otp') {
            await markOrderOtpRequired('results_check_requests', orderId)
            session.step = 'SUBMIT_OTP'
            session.pendingOrderId = orderId
            session.pendingOrderTable = 'results_check_requests'
            reply = shopOtpMenu()
          } else {
            deleteAfter = true
            reply = shopPaymentSentMenu(session.paymentPhone!)
          }
        } catch (err) {
          console.error("[WA-SHOP-RCCHECK-CONFIRM] Charge failed:", err)
          await markOrderFailed('results_check_requests', orderId)
          deleteAfter = true
          reply = 'Sorry, we could not start the payment. Please try again.'
        }
        break
      }
```

Add `'RCCHECK_ENTER_PAYMENT_PHONE'` and `'RCCHECK_CONFIRM'` to the `MONEY_STEPS` array:

```ts
    const MONEY_STEPS: WaShopSession['step'][] = [
      'CONFIRM', 'AIRTIME_CONFIRM', 'RC_CONFIRM', 'RCCHECK_CONFIRM',
      'ENTER_PAYMENT_PHONE', 'AIRTIME_ENTER_PAYMENT_PHONE', 'RC_ENTER_PAYMENT_PHONE', 'RCCHECK_ENTER_PAYMENT_PHONE',
      'SUBMIT_OTP',
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/whatsapp-bot/shop-router.test.ts`
Expected: PASS — every test added across Tasks 5, 6, and 7.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: All test files pass (520+ existing tests plus the new ones added in this plan).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add lib/whatsapp-bot/shop-router.ts lib/whatsapp-bot/shop-router.test.ts
git commit -m "feat(whatsapp-shop): wire Check My Results payment, confirm, and charge"
```

---

### Task 8: Webhook fix — shop profit crediting and token deduction

**Files:**
- Modify: `app/api/webhooks/paystack/route.ts:753-824`

No test file exists for this route (per the established precedent in `lib/shop-commerce/token-deduction.ts`'s own header comment: "the codebase has no route-handler test convention under app/api/" — that's exactly why `deductTokenIfWhatsappShopOrder` was extracted into a unit-tested lib module in the first place). Verification here is a careful manual trace plus the full suite run, matching how this file has always been changed.

- [ ] **Step 1: Implement**

In `app/api/webhooks/paystack/route.ts`, locate the `results_check_requests` direct-reference branch (currently ~line 753-824, right after the `results_checker_orders` branch and before the `wallet_payments` fallback lookup). Change the `.select(...)` call to add three columns:

```ts
      // Handle WhatsApp results-check requests (reference IS the UUID)
      const { data: checkReq } = await supabase
        .from("results_check_requests")
        .select("id, fee, payment_status, phone_number, exam_board, index_number, exam_year, payment_reference, mode, voucher_pin, shop_id, merchant_commission, channel")
        .eq("id", reference)
        .maybeSingle()
```

Immediately after the existing update block:

```ts
        await supabase
          .from("results_check_requests")
          .update(updatePayload)
          .eq("id", checkReq.id)
```

insert this new block (before the existing `await notifyAdminsNewResultsCheckRequest(checkReq.id)...` line):

```ts
        // Shop attribution (added for the shop WhatsApp bot's Check My Results
        // flow — the main bot's direct-charge callers never set shop_id, so this
        // is a no-op for them). Mirrors the identical insert shape
        // fulfillPaidResultsCheckRequest() uses (lib/results-checker-service.ts).
        if (checkReq.shop_id && Number(checkReq.merchant_commission) > 0) {
          const { error: profitError } = await supabase.from("shop_profits").insert([{
            shop_id: checkReq.shop_id,
            results_check_request_id: checkReq.id,
            profit_amount: checkReq.merchant_commission,
            status: "credited",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }])
          if (profitError && profitError.code !== "23505") {
            console.error("[WEBHOOK] Failed to credit shop profit for results check request:", profitError.message)
          } else if (!profitError) {
            console.log(`[WEBHOOK] ✓ Shop profit credited: GHS ${checkReq.merchant_commission} for results check request ${checkReq.id}`)
          }
        }

        // WhatsApp shop bot bills 1 session token per completed order, same as
        // the airtime_orders/results_checker_orders branches above.
        if (checkReq.channel === "whatsapp_shop") {
          const { deductTokenIfWhatsappShopOrder } = await import("@/lib/shop-commerce/token-deduction")
          const deductResult = await deductTokenIfWhatsappShopOrder(checkReq)
          if (deductResult.deducted) {
            console.log("[WEBHOOK] ✓ WhatsApp shop token deducted for results check request:", checkReq.id)
          } else if (deductResult.reason !== "not_whatsapp_shop") {
            console.error("[WEBHOOK] Failed to deduct WhatsApp shop token:", deductResult)
          }
        }

```

Nothing else in this branch changes — the combo voucher-assignment logic, the `notifyAdminsNewResultsCheckRequest` call, and the WhatsApp confirmation send all stay exactly as they are today.

- [ ] **Step 2: Manually trace the change**

Re-read the full modified branch (`app/api/webhooks/paystack/route.ts`, the `results_check_requests` section) top to bottom and confirm:
1. For a non-shop row (`shop_id` is `null`, as every existing caller produces): both new blocks no-op (`checkReq.shop_id` is falsy; `checkReq.channel` is `"whatsapp"`/`"ussd"`/`"web"`, never `"whatsapp_shop"`) — behavior is byte-identical to before this change for the main bot/USSD-momo/storefront.
2. For a shop row (this feature's rows): `shop_id`/`merchant_commission`/`channel` are now selected, so both new blocks fire — profit credited, token deducted — using the exact same insert shape and `deductTokenIfWhatsappShopOrder` call already proven correct by `airtime_orders`/`results_checker_orders` a few dozen lines above and by `token-deduction.test.ts`.
3. `deductTokenIfWhatsappShopOrder` needs `shop_id` (present) — it resolves `shop_code_id` via `shop_id` when absent, which `results_check_requests` rows never carry, exactly like `airtime_orders`/`results_checker_orders` today (per that function's own doc comment).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: All tests pass, including `lib/shop-commerce/token-deduction.test.ts` (unchanged, still covers the function this new call reuses).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/webhooks/paystack/route.ts
git commit -m "fix(webhook): credit shop profit and deduct session token for shop results-check requests"
```

---

## Post-implementation notes for the final reviewer

- No database migration is needed anywhere in this plan — `results_check_requests`, `user_shops.results_check_markup`, and the admin-notify/delivery infrastructure all pre-date this feature.
- The main WhatsApp bot, USSD, and web storefront are untouched. The only shared file modified outside `lib/whatsapp-bot/`/`lib/shop-commerce/` is `lib/results-checker-service.ts` (Task 4, additive-only) and `app/api/webhooks/paystack/route.ts` (Task 8, additive-only, gated on fields that are only ever populated by this new flow).
- Manually verify in a staging/real WhatsApp session after merge: the full combo flow through to a live MoMo OTP prompt, and the full own-voucher flow — Paystack's actual `charge.success` webhook delivery for `results_check_requests` with a `shop_id` set has no automated coverage (per Task 8's note), so this is the one path worth a real end-to-end smoke test before considering the feature fully verified in production.
