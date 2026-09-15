# Withdrawal Fee Minimum & Minimum Withdrawal Amount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the withdrawal fee minimum (a GHS floor under the percentage-based fee) and the minimum withdrawal amount (currently hardcoded to GHS 5.00) admin-configurable.

**Architecture:** Two new `numeric NOT NULL DEFAULT` columns on `app_settings` (the singleton `key IS NULL` config row). `lib/shop-service.ts`'s `createWithdrawalRequest` is the single enforcement point — it already reads `withdrawal_fee_percentage` from this row in a fail-closed query; both new columns are added to that same query. The public `/api/settings/fees` endpoint (already consumed by both the web shop dashboard and the mobile app) gains both fields so every consumer picks them up from one place.

**Tech Stack:** Next.js App Router API routes, Supabase Postgres, TypeScript, React.

Design doc: `docs/superpowers/specs/2026-09-15-withdrawal-minimums-design.md`

**Correction from the design doc, found while writing this plan:** `app/api/admin/settings/route.ts`'s GET handler uses `.select("*")` — it already returns every column on the row, including the two new ones once the migration lands, with no code change needed there. Only the PUT handler's allowed-fields list, body destructuring, and validation need updating. The design doc's Section 4 overstated this ("Add both to the GET response and both default-fallback objects") — that step is dropped; the DB column defaults alone are sufficient for the create-default-row path too, so those insert payloads are also left untouched (adding the two fields there would be redundant, not incorrect — the column default fires identically either way).

**Deliberately out of scope:** `mobile/src/app/withdraw.tsx`'s hardcoded "min 5.00" label (separate Expo app, separate release cycle) — not touched by this plan.

---

### Task 1: Migration

**Files:**
- Create: `migrations/add_withdrawal_minimums.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/add_withdrawal_minimums.sql`:

```sql
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS withdrawal_fee_minimum numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minimum_withdrawal_amount numeric NOT NULL DEFAULT 5;
```

- [ ] **Step 2: Apply it to the live database**

Run via the Supabase Management API SQL endpoint (`POST https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query`, `Authorization: Bearer <PAT from .mcp.json>`, body `{"query": "<contents of the migration file>"}`) — this project applies migrations this way rather than via a CLI (no `supabase` CLI configured in this environment).

- [ ] **Step 3: Verify**

Run this query through the same endpoint and confirm both columns appear with the right defaults:
```sql
SELECT withdrawal_fee_minimum, minimum_withdrawal_amount FROM app_settings WHERE key IS NULL;
```
Expected: one row, `withdrawal_fee_minimum = 0`, `minimum_withdrawal_amount = 5`.

- [ ] **Step 4: Commit**

```bash
git add migrations/add_withdrawal_minimums.sql
git commit -m "feat(withdrawals): add withdrawal_fee_minimum and minimum_withdrawal_amount columns"
```

---

### Task 2: Enforcement — `lib/shop-service.ts`

**Files:**
- Modify: `lib/shop-service.ts`

- [ ] **Step 1: Remove the hardcoded minimum-amount check from its current location**

Find:

```ts
    // Validate minimum withdrawal amount
    if (withdrawalData.amount < 5) {
      throw new Error("Minimum withdrawal amount is GHS 5.00")
    }

    // Cooling-off period: 7 days after first payment for first withdrawal,
```

Replace with:

```ts
    // Cooling-off period: 7 days after first payment for first withdrawal,
```

(The minimum-amount check moves below, after the settings read in Step 2, since it now needs `minimumWithdrawalAmount` from that same query.)

- [ ] **Step 2: Read the two new columns and re-add the minimum-amount check after them**

Find:

```ts
    let withdrawalFeePercentage = 0
    const { data: settings, error: settingsError } = await db
      .from("app_settings")
      .select("withdrawal_fee_percentage")
      .is("key", null)
      .maybeSingle()
    if (settingsError) {
      console.error(`[WITHDRAWAL-CREATE] Fee settings read failed (${settingsError.code}): ${settingsError.message}`)
      throw new Error("Could not determine the withdrawal fee right now. Please try again in a moment.")
    }
    if (settings?.withdrawal_fee_percentage) {
      withdrawalFeePercentage = settings.withdrawal_fee_percentage / 100
    }

    // Calculate fee and net amount
    const feeAmount = Math.round(withdrawalData.amount * withdrawalFeePercentage * 100) / 100
    const netAmount = withdrawalData.amount - feeAmount
```

Replace with:

```ts
    let withdrawalFeePercentage = 0
    const { data: settings, error: settingsError } = await db
      .from("app_settings")
      .select("withdrawal_fee_percentage, withdrawal_fee_minimum, minimum_withdrawal_amount")
      .is("key", null)
      .maybeSingle()
    if (settingsError) {
      console.error(`[WITHDRAWAL-CREATE] Fee settings read failed (${settingsError.code}): ${settingsError.message}`)
      throw new Error("Could not determine the withdrawal fee right now. Please try again in a moment.")
    }
    if (settings?.withdrawal_fee_percentage) {
      withdrawalFeePercentage = settings.withdrawal_fee_percentage / 100
    }
    const withdrawalFeeMinimum = settings?.withdrawal_fee_minimum ?? 0
    const minimumWithdrawalAmount = settings?.minimum_withdrawal_amount ?? 5

    // Validate minimum withdrawal amount — moved here (was a hardcoded `< 5`
    // check earlier in this function) so a settings-read failure above blocks
    // the whole request instead of silently falling back to a stale minimum,
    // matching the fee percentage's existing fail-closed guarantee.
    if (withdrawalData.amount < minimumWithdrawalAmount) {
      throw new Error(`Minimum withdrawal amount is GHS ${minimumWithdrawalAmount.toFixed(2)}`)
    }

    // Calculate fee and net amount
    const percentageFee = Math.round(withdrawalData.amount * withdrawalFeePercentage * 100) / 100
    const feeAmount = Math.max(percentageFee, withdrawalFeeMinimum)
    const netAmount = withdrawalData.amount - feeAmount
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/shop-service.ts
git commit -m "feat(withdrawals): enforce configurable fee minimum and withdrawal minimum"
```

---

### Task 3: Public fees API — `app/api/settings/fees/route.ts`

**Files:**
- Modify: `app/api/settings/fees/route.ts`

- [ ] **Step 1: Rewrite the route**

Replace the entire file content with:

```ts
import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    const { data: settings, error } = await supabase
      .from("app_settings")
      .select("paystack_fee_percentage, wallet_topup_fee_percentage, withdrawal_fee_percentage, withdrawal_fee_minimum, minimum_withdrawal_amount")
      .is("key", null)
      .single()

    if (error && error.code !== "PGRST116") {
      console.error("[FEES-API] Error fetching settings:", error)
      // Return default fees if error
      return NextResponse.json({
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      })
    }

    // If no settings exist, return defaults
    if (!settings) {
      return NextResponse.json({
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      })
    }

    return NextResponse.json({
      paystack_fee_percentage: settings.paystack_fee_percentage || 3.0,
      wallet_topup_fee_percentage: settings.wallet_topup_fee_percentage || 0,
      withdrawal_fee_percentage: settings.withdrawal_fee_percentage || 0,
      withdrawal_fee_minimum: settings.withdrawal_fee_minimum ?? 0,
      minimum_withdrawal_amount: settings.minimum_withdrawal_amount ?? 5,
    })
  } catch (error) {
    console.error("[FEES-API] Error:", error)
    return NextResponse.json(
      {
        paystack_fee_percentage: 3.0,
        wallet_topup_fee_percentage: 0,
        withdrawal_fee_percentage: 0,
        withdrawal_fee_minimum: 0,
        minimum_withdrawal_amount: 5,
      },
      { status: 500 }
    )
  }
}
```

(The catch-all error response previously omitted `withdrawal_fee_percentage` entirely — now includes it alongside the two new fields for consistency across all three response branches.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/settings/fees/route.ts
git commit -m "feat(withdrawals): expose fee minimum and withdrawal minimum via /api/settings/fees"
```

---

### Task 4: Admin settings API — `app/api/admin/settings/route.ts`

**Files:**
- Modify: `app/api/admin/settings/route.ts`

- [ ] **Step 1: Add both fields to the PUT allowed-fields list**

Find:

```ts
    const fields = [
      'join_community_link',
      'ordering_enabled',
      'announcement_enabled',
      'announcement_title',
      'announcement_message',
      'paystack_fee_percentage',
      'wallet_topup_fee_percentage',
      'withdrawal_fee_percentage',
      'price_adjustment_mtn',
```

Replace with:

```ts
    const fields = [
      'join_community_link',
      'ordering_enabled',
      'announcement_enabled',
      'announcement_title',
      'announcement_message',
      'paystack_fee_percentage',
      'wallet_topup_fee_percentage',
      'withdrawal_fee_percentage',
      'withdrawal_fee_minimum',
      'minimum_withdrawal_amount',
      'price_adjustment_mtn',
```

- [ ] **Step 2: Destructure and validate both fields**

Find:

```ts
    // Validate fee percentages if present
    const {
      paystack_fee_percentage,
      wallet_topup_fee_percentage,
      withdrawal_fee_percentage,
      join_community_link
    } = updates

    if (paystack_fee_percentage !== undefined && (paystack_fee_percentage < 0 || paystack_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "paystack_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (wallet_topup_fee_percentage !== undefined && (wallet_topup_fee_percentage < 0 || wallet_topup_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "wallet_topup_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (withdrawal_fee_percentage !== undefined && (withdrawal_fee_percentage < 0 || withdrawal_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "withdrawal_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }
```

Replace with:

```ts
    // Validate fee percentages if present
    const {
      paystack_fee_percentage,
      wallet_topup_fee_percentage,
      withdrawal_fee_percentage,
      withdrawal_fee_minimum,
      minimum_withdrawal_amount,
      join_community_link
    } = updates

    if (paystack_fee_percentage !== undefined && (paystack_fee_percentage < 0 || paystack_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "paystack_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (wallet_topup_fee_percentage !== undefined && (wallet_topup_fee_percentage < 0 || wallet_topup_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "wallet_topup_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (withdrawal_fee_percentage !== undefined && (withdrawal_fee_percentage < 0 || withdrawal_fee_percentage > 100)) {
      return NextResponse.json(
        { error: "withdrawal_fee_percentage must be between 0 and 100" },
        { status: 400 }
      )
    }

    if (withdrawal_fee_minimum !== undefined && withdrawal_fee_minimum < 0) {
      return NextResponse.json(
        { error: "withdrawal_fee_minimum must be >= 0" },
        { status: 400 }
      )
    }

    if (minimum_withdrawal_amount !== undefined && minimum_withdrawal_amount < 0) {
      return NextResponse.json(
        { error: "minimum_withdrawal_amount must be >= 0" },
        { status: 400 }
      )
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/settings/route.ts
git commit -m "feat(withdrawals): validate withdrawal fee minimum and withdrawal minimum on save"
```

---

### Task 5: Admin UI — `app/admin/settings/page.tsx`

**Files:**
- Modify: `app/admin/settings/page.tsx`

- [ ] **Step 1: Add state hooks**

Find:

```ts
  // Fee settings
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)
  const [walletTopupFeePercentage, setWalletTopupFeePercentage] = useState(0)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
```

Replace with:

```ts
  // Fee settings
  const [paystackFeePercentage, setPaystackFeePercentage] = useState(3.0)
  const [walletTopupFeePercentage, setWalletTopupFeePercentage] = useState(0)
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
  const [withdrawalFeeMinimum, setWithdrawalFeeMinimum] = useState(0)
  const [minimumWithdrawalAmount, setMinimumWithdrawalAmount] = useState(5)
```

- [ ] **Step 2: Load both fields from the GET response**

Find:

```ts
        if (data.withdrawal_fee_percentage !== undefined) {
          setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
        }
```

Replace with:

```ts
        if (data.withdrawal_fee_percentage !== undefined) {
          setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
        }
        if (data.withdrawal_fee_minimum !== undefined) {
          setWithdrawalFeeMinimum(data.withdrawal_fee_minimum)
        }
        if (data.minimum_withdrawal_amount !== undefined) {
          setMinimumWithdrawalAmount(data.minimum_withdrawal_amount)
        }
```

- [ ] **Step 3: Include both fields in the save payload**

Find:

```ts
          paystack_fee_percentage: paystackFeePercentage,
          wallet_topup_fee_percentage: walletTopupFeePercentage,
          withdrawal_fee_percentage: withdrawalFeePercentage,
          price_adjustment_mtn: priceAdjustmentMtn,
```

Replace with:

```ts
          paystack_fee_percentage: paystackFeePercentage,
          wallet_topup_fee_percentage: walletTopupFeePercentage,
          withdrawal_fee_percentage: withdrawalFeePercentage,
          withdrawal_fee_minimum: withdrawalFeeMinimum,
          minimum_withdrawal_amount: minimumWithdrawalAmount,
          price_adjustment_mtn: priceAdjustmentMtn,
```

- [ ] **Step 4: Add the two new inputs after the existing Withdrawal Fee Percentage field**

Find:

```tsx
            <div>
              <Label htmlFor="withdrawalFee" className="text-sm font-medium">
                Withdrawal Fee Percentage
              </Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Fee deducted from withdrawal requests (e.g., 5 for 5%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="withdrawalFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={withdrawalFeePercentage}
                  onChange={(e) => setWithdrawalFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-muted-foreground">%</span>
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
```

Replace with:

```tsx
            <div>
              <Label htmlFor="withdrawalFee" className="text-sm font-medium">
                Withdrawal Fee Percentage
              </Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Fee deducted from withdrawal requests (e.g., 5 for 5%)
              </p>
              <div className="flex items-center gap-2">
                <Input
                  id="withdrawalFee"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={withdrawalFeePercentage}
                  onChange={(e) => setWithdrawalFeePercentage(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
                <span className="text-sm font-medium text-muted-foreground">%</span>
              </div>
            </div>

            <div>
              <Label htmlFor="withdrawalFeeMinimum" className="text-sm font-medium">
                Withdrawal Fee Minimum (GHS)
              </Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                The fee never goes below this amount, even if the percentage above would compute less. Set to 0 for no floor.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">GHS</span>
                <Input
                  id="withdrawalFeeMinimum"
                  type="number"
                  min="0"
                  step="0.01"
                  value={withdrawalFeeMinimum}
                  onChange={(e) => setWithdrawalFeeMinimum(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="0"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="minimumWithdrawalAmount" className="text-sm font-medium">
                Minimum Withdrawal Amount (GHS)
              </Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                The smallest amount a shop owner may request to withdraw.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">GHS</span>
                <Input
                  id="minimumWithdrawalAmount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={minimumWithdrawalAmount}
                  onChange={(e) => setMinimumWithdrawalAmount(parseFloat(e.target.value))}
                  className="flex-1"
                  placeholder="5"
                />
              </div>
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
```

- [ ] **Step 5: Apply the floor in the Withdrawal Preview box**

Find:

```tsx
                  <div className="flex justify-between">
                    <span className="text-primary">
                      Withdrawal fee ({withdrawalFeePercentage}%):
                    </span>
                    <span className="font-medium text-warning">
                      -GHS {(100 * withdrawalFeePercentage / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-primary/20 pt-1 flex justify-between">
                    <span className="text-primary font-semibold">Shop receives:</span>
                    <span className="font-bold text-success">
                      GHS {(100 - (100 * withdrawalFeePercentage / 100)).toFixed(2)}
                    </span>
                  </div>
```

Replace with:

```tsx
                  <div className="flex justify-between">
                    <span className="text-primary">
                      Withdrawal fee (max of {withdrawalFeePercentage}% or GHS {withdrawalFeeMinimum.toFixed(2)}):
                    </span>
                    <span className="font-medium text-warning">
                      -GHS {Math.max(100 * withdrawalFeePercentage / 100, withdrawalFeeMinimum).toFixed(2)}
                    </span>
                  </div>
                  <div className="border-t border-primary/20 pt-1 flex justify-between">
                    <span className="text-primary font-semibold">Shop receives:</span>
                    <span className="font-bold text-success">
                      GHS {(100 - Math.max(100 * withdrawalFeePercentage / 100, withdrawalFeeMinimum)).toFixed(2)}
                    </span>
                  </div>
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Manual verification**

Run the dev server, sign in as admin, go to `/admin/settings`, confirm the two new fields appear under "Withdrawal Fee Percentage", load their saved values correctly, save a change to each, reload the page and confirm they persisted, and confirm the "Withdrawal Preview" box reflects `max(percentage, floor)`.

- [ ] **Step 8: Commit**

```bash
git add app/admin/settings/page.tsx
git commit -m "feat(withdrawals): add fee minimum and withdrawal minimum inputs to admin settings"
```

---

### Task 6: Web withdrawal form — `app/dashboard/shop-dashboard/page.tsx`

**Files:**
- Modify: `app/dashboard/shop-dashboard/page.tsx`

- [ ] **Step 1: Add state hooks**

Find:

```ts
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
  const [orderStats, setOrderStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0, totalRevenue: 0 })
```

Replace with:

```ts
  const [withdrawalFeePercentage, setWithdrawalFeePercentage] = useState(0)
  const [withdrawalFeeMinimum, setWithdrawalFeeMinimum] = useState(0)
  const [minimumWithdrawalAmount, setMinimumWithdrawalAmount] = useState(5)
  const [orderStats, setOrderStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0, totalRevenue: 0 })
```

- [ ] **Step 2: Fetch both fields alongside the existing percentage fetch**

Find:

```ts
  const fetchWithdrawalFee = async () => {
    try {
      const response = await fetch("/api/settings/fees")
      const data = await response.json()
      if (data.withdrawal_fee_percentage !== undefined) {
        setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
      }
    } catch (error) {
      console.warn("Failed to fetch withdrawal fee:", error)
    }
  }
```

Replace with:

```ts
  const fetchWithdrawalFee = async () => {
    try {
      const response = await fetch("/api/settings/fees")
      const data = await response.json()
      if (data.withdrawal_fee_percentage !== undefined) {
        setWithdrawalFeePercentage(data.withdrawal_fee_percentage)
      }
      if (data.withdrawal_fee_minimum !== undefined) {
        setWithdrawalFeeMinimum(data.withdrawal_fee_minimum)
      }
      if (data.minimum_withdrawal_amount !== undefined) {
        setMinimumWithdrawalAmount(data.minimum_withdrawal_amount)
      }
    } catch (error) {
      console.warn("Failed to fetch withdrawal fee:", error)
    }
  }
```

- [ ] **Step 3: Replace the hardcoded pre-submit minimum check**

Find:

```ts
    if (amount < 5) {
      toast.error("Minimum withdrawal amount is GHS 5.00")
      return
    }
```

Replace with:

```ts
    if (amount < minimumWithdrawalAmount) {
      toast.error(`Minimum withdrawal amount is GHS ${minimumWithdrawalAmount.toFixed(2)}`)
      return
    }
```

- [ ] **Step 4: Replace the hardcoded input `min` and display text**

Find:

```tsx
                <Input
                  type="number"
                  step="0.01"
                  value={withdrawalForm.amount}
                  onChange={(e) => setWithdrawalForm({ ...withdrawalForm, amount: e.target.value })}
                  placeholder="0.00"
                  min="5"
                  max={balance}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Available: GHS {(balance || 0).toFixed(2)} | Minimum: GHS 5.00
                </p>
```

Replace with:

```tsx
                <Input
                  type="number"
                  step="0.01"
                  value={withdrawalForm.amount}
                  onChange={(e) => setWithdrawalForm({ ...withdrawalForm, amount: e.target.value })}
                  placeholder="0.00"
                  min={minimumWithdrawalAmount}
                  max={balance}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Available: GHS {(balance || 0).toFixed(2)} | Minimum: GHS {minimumWithdrawalAmount.toFixed(2)}
                </p>
```

- [ ] **Step 5: Apply the floor to the fee preview, and show it whenever either the percentage or the floor is active**

Find:

```tsx
                    {withdrawalFeePercentage > 0 && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-warning">Withdrawal fee ({withdrawalFeePercentage}%):</span>
                          <span className="font-medium text-warning">-GHS {(parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100).toFixed(2)}</span>
                        </div>
                        <div className="border-t border-border pt-1 flex justify-between">
                          <span className="text-warning font-semibold">You will receive:</span>
                          <span className="font-bold text-success">GHS {(parseFloat(withdrawalForm.amount) - (parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100)).toFixed(2)}</span>
                        </div>
                      </>
                    )}
```

Replace with:

```tsx
                    {(withdrawalFeePercentage > 0 || withdrawalFeeMinimum > 0) && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-warning">Withdrawal fee ({withdrawalFeePercentage}%):</span>
                          <span className="font-medium text-warning">-GHS {Math.max(parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100, withdrawalFeeMinimum).toFixed(2)}</span>
                        </div>
                        <div className="border-t border-border pt-1 flex justify-between">
                          <span className="text-warning font-semibold">You will receive:</span>
                          <span className="font-bold text-success">GHS {(parseFloat(withdrawalForm.amount) - Math.max(parseFloat(withdrawalForm.amount) * withdrawalFeePercentage / 100, withdrawalFeeMinimum)).toFixed(2)}</span>
                        </div>
                      </>
                    )}
```

(Previously this block was gated on `withdrawalFeePercentage > 0` alone — a pure-floor fee configuration, e.g. `0%` + a GHS 2 minimum, would have shown no fee line at all despite one being charged. Now it shows whenever either component is active.)

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Manual verification**

With the admin settings from Task 5's verification still in place (a non-zero fee minimum and a minimum withdrawal amount other than 5), open the shop dashboard's withdrawal form and confirm: the input's minimum and displayed "Minimum: GHS X" match the admin-configured value; requesting less than that minimum shows the correct error; the fee breakdown shows `max(percentage fee, floor)`; a `0%` + non-zero-floor configuration still shows the fee breakdown (not hidden).

- [ ] **Step 8: Commit**

```bash
git add app/dashboard/shop-dashboard/page.tsx
git commit -m "feat(withdrawals): make fee minimum and withdrawal minimum dynamic in the shop dashboard"
```

---

### Task 7: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all existing tests still pass (this plan adds no new test files — matches the codebase's established convention of not unit-testing `app/api/**` routes or `app/**/page.tsx` files, and `createWithdrawalRequest` itself has no existing test file to extend).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean production build.

- [ ] **Step 4: End-to-end manual pass**

Beyond Tasks 5 and 6's individual verification: place one real (or sandboxed, if a test shop/balance is available) withdrawal request at exactly the configured minimum amount (should succeed) and one at just below it (should be rejected with the correct GHS figure in the message) — confirm the created `withdrawal_requests` row's `fee_amount` column reflects `max(percentage fee, floor)`, not just the percentage.

- [ ] **Step 5: Update memory**

Add a short project memory entry noting the withdrawal fee minimum and minimum withdrawal amount are now admin-configurable (`app_settings.withdrawal_fee_minimum` / `minimum_withdrawal_amount`, defaults 0 and 5), enforced solely in `lib/shop-service.ts`'s `createWithdrawalRequest`, and that the mobile app's withdrawal screen still shows a hardcoded "min 5.00" label pending its own follow-up.

---
