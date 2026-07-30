# WhatsApp Activation Visibility on Admin USSD Shops Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins visibility into which shop codes have WhatsApp activated, and a manual grant/revoke override, on the existing `/admin/ussd-shops` page.

**Architecture:** Two new admin-only endpoints (`whatsapp-activate`, `whatsapp-deactivate`) mirror the existing USSD `/activate` endpoint's "manual activation, no real charge" pattern, backed by two new testable functions in `lib/shop-commerce/whatsapp-activation.ts` (same file, same conditional-update "claim" pattern as the existing `activateWhatsappShop`). The list endpoint (`GET /api/admin/ussd-shops`) starts returning the two existing `whatsapp_activated`/`whatsapp_activated_at` columns it already has access to but never selected. The admin page adds a badge, a conditional grant button, a stats card, and a fourth tab — all driven by the same `codes` state array already fetched today, no new client-side data fetching.

**Tech Stack:** Next.js 15 App Router, Supabase, Vitest, shadcn/ui (`Tabs`, `Badge`, `Button`), lucide-react icons.

## Global Constraints

- Admin-only: every new/modified endpoint uses the exact same `requireAdmin` guard (Bearer token → `supabase.auth.getUser` → `users.role === "admin"`) already used by every sibling route in `app/api/admin/ussd-shops/`.
- Grant records a `ussd_shop_token_purchases` row (`amount_paid: 0, payment_method: 'manual', is_whatsapp_activation: true`) so admin-granted and customer-paid activations report consistently. Revoke does **not** touch `ussd_shop_token_purchases` or `transactions` — it's a pure access-flag toggle, no refund/reversal logic.
- Both new lib functions use the same conditional-UPDATE "claim" pattern as `activateWhatsappShop` (`.eq("whatsapp_activated", false)` for grant / `.eq("whatsapp_activated", true)` for revoke) so a double-click or overlapping request can't double-log a purchase row or silently no-op.
- No changes to the customer-facing paid activation flow, the WhatsApp shop bot's runtime logic, or any refund logic.

---

## File Structure

- **Modify:** `lib/shop-commerce/whatsapp-activation.ts` — add `adminGrantWhatsappShop` and `adminRevokeWhatsappShop` alongside the existing `activateWhatsappShop`. Same file because they share the same table, the same `SupabaseClientLike` type alias, and the same conditional-update pattern — splitting them out would just duplicate that setup.
- **Test:** `lib/shop-commerce/whatsapp-activation.test.ts` — extend with tests for the two new functions, following the existing `makeClient`-style fake.
- **Create:** `app/api/admin/ussd-shops/[id]/whatsapp-activate/route.ts` — thin wrapper, mirrors `app/api/admin/ussd-shops/[id]/activate/route.ts`.
- **Create:** `app/api/admin/ussd-shops/[id]/whatsapp-deactivate/route.ts` — thin wrapper.
- **Modify:** `app/api/admin/ussd-shops/route.ts` — `GET` selects and returns the two new fields.
- **Modify:** `app/admin/ussd-shops/page.tsx` — interface, two new handlers, badge, conditional grant button, stats card, new tab.

---

### Task 1: `adminGrantWhatsappShop` / `adminRevokeWhatsappShop` + tests

**Files:**
- Modify: `lib/shop-commerce/whatsapp-activation.ts`
- Modify: `lib/shop-commerce/whatsapp-activation.test.ts`

**Interfaces:**
- Produces: `adminGrantWhatsappShop(input: { shopCodeId: string; shopId: string }, client?): Promise<{ ok: true } | { ok: false; status: number; error: string }>` and `adminRevokeWhatsappShop(input: { shopCodeId: string }, client?): Promise<{ ok: true } | { ok: false; status: number; error: string }>` — consumed by Task 2's two new route files.

Read `lib/shop-commerce/whatsapp-activation.ts` in full before starting (it's short, ~116 lines) — the two new functions go at the bottom of the same file, reusing the module's existing `supabase`/`SupabaseClientLike` declarations at the top. Do not redeclare them.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `lib/shop-commerce/whatsapp-activation.test.ts` (the existing `makeClient` fake at the top of the file already supports everything these tests need — `ussd_shop_codes` conditional updates and `ussd_shop_token_purchases` inserts — no changes to the fake itself):

```typescript
import { adminGrantWhatsappShop, adminRevokeWhatsappShop } from "./whatsapp-activation"

describe("adminGrantWhatsappShop", () => {
  it("claims and records a manual (zero-fee) purchase row on a clean call", async () => {
    const { client, calls } = makeClient({ whatsappActivated: false, walletBalance: 0 })

    const result = await adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client)

    expect(result).toEqual({ ok: true })
    // No wallet deduction — this is an admin-granted activation, not a paid one.
    expect(calls.some(c => c.op === "rpc" && c.args?.fn === "deduct_wallet")).toBe(false)
    const purchaseInsert = calls.find(c => c.table === "ussd_shop_token_purchases")
    expect(purchaseInsert?.payload[0]).toMatchObject({
      shop_code_id: "sc1",
      shop_id: "s1",
      tokens_purchased: 0,
      amount_paid: 0,
      payment_method: "manual",
      payment_status: "completed",
      is_whatsapp_activation: true,
    })
  })

  it("rejects with 409 when already activated, and logs no purchase row", async () => {
    const { client, calls } = makeClient({ whatsappActivated: true, walletBalance: 0 })

    const result = await adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client)

    expect(result).toEqual({ ok: false, status: 409, error: "Already activated" })
    expect(calls.some(c => c.table === "ussd_shop_token_purchases")).toBe(false)
  })

  it("two concurrent grants: only one wins the claim and logs exactly one purchase row", async () => {
    const state = { whatsappActivated: false, walletBalance: 0 }
    const { client, calls } = makeClient(state)

    const [first, second] = await Promise.all([
      adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client),
      adminGrantWhatsappShop({ shopCodeId: "sc1", shopId: "s1" }, client),
    ])

    const winners = [first, second].filter(r => r.ok)
    const losers = [first, second].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ ok: false, status: 409 })
    expect(calls.filter(c => c.table === "ussd_shop_token_purchases")).toHaveLength(1)
  })
})

describe("adminRevokeWhatsappShop", () => {
  it("clears whatsapp_activated and whatsapp_activated_at on a clean call", async () => {
    const { client, calls } = makeClient({ whatsappActivated: true, walletBalance: 0 })

    const result = await adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client)

    expect(result).toEqual({ ok: true })
    const update = calls.find(c => c.table === "ussd_shop_codes" && c.op === "update")
    expect(update?.payload).toMatchObject({ whatsapp_activated: false, whatsapp_activated_at: null })
    // No purchase/transaction rows touched by a revoke.
    expect(calls.some(c => c.table === "ussd_shop_token_purchases")).toBe(false)
    expect(calls.some(c => c.table === "transactions")).toBe(false)
  })

  it("rejects with 409 when not currently activated", async () => {
    const { client } = makeClient({ whatsappActivated: false, walletBalance: 0 })

    const result = await adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client)

    expect(result).toEqual({ ok: false, status: 409, error: "Not currently activated" })
  })

  it("two concurrent revokes: only one wins the claim", async () => {
    const state = { whatsappActivated: true, walletBalance: 0 }
    const { client } = makeClient(state)

    const [first, second] = await Promise.all([
      adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client),
      adminRevokeWhatsappShop({ shopCodeId: "sc1" }, client),
    ])

    const winners = [first, second].filter(r => r.ok)
    const losers = [first, second].filter(r => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ ok: false, status: 409 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/shop-commerce/whatsapp-activation.test.ts`
Expected: FAIL — `adminGrantWhatsappShop`/`adminRevokeWhatsappShop` are not exported from `./whatsapp-activation`.

- [ ] **Step 3: Implement both functions**

Append to the bottom of `lib/shop-commerce/whatsapp-activation.ts` (after the existing `activateWhatsappShop` function, using the same module-level `supabase` and `SupabaseClientLike` already declared near the top of the file):

```typescript
// Admin-granted WhatsApp activation — no wallet charge. Mirrors the existing
// USSD-side admin /activate endpoint's "manual activation" pattern
// (app/api/admin/ussd-shops/[id]/activate/route.ts): the shop owner gets
// access without going through the real paid flow, but the same
// ussd_shop_token_purchases row shape is still logged (amount_paid: 0,
// payment_method: 'manual') so admin-granted and customer-paid activations
// report consistently anywhere ussd_shop_token_purchases is aggregated.
// Uses the same conditional-UPDATE "claim" pattern as activateWhatsappShop
// so a double-click can't log two purchase rows for one activation.
export interface AdminGrantWhatsappShopInput {
  shopCodeId: string
  shopId: string
}

export type AdminGrantWhatsappShopResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function adminGrantWhatsappShop(
  input: AdminGrantWhatsappShopInput,
  client: SupabaseClientLike = supabase
): Promise<AdminGrantWhatsappShopResult> {
  const { shopCodeId, shopId } = input

  const { data: claimed, error: claimErr } = await client
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: true,
      whatsapp_activated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCodeId)
    .eq("whatsapp_activated", false)
    .select("id")
    .maybeSingle()

  if (claimErr) {
    console.error("[ADMIN-WHATSAPP-GRANT] Failed to update shop code:", claimErr)
    return { ok: false, status: 500, error: "Grant failed — database update error" }
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "Already activated" }
  }

  await client.from("ussd_shop_token_purchases").insert([{
    shop_code_id: shopCodeId,
    shop_id: shopId,
    tokens_purchased: 0,
    amount_paid: 0,
    payment_method: "manual",
    payment_status: "completed",
    is_whatsapp_activation: true,
  }])

  return { ok: true }
}

// Manual revoke — a pure access-flag toggle, no refund/reversal logic. Any fee
// the shop owner previously paid (real or manually-granted) stays an
// unaffected historical ussd_shop_token_purchases/transactions record.
export interface AdminRevokeWhatsappShopInput {
  shopCodeId: string
}

export type AdminRevokeWhatsappShopResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export async function adminRevokeWhatsappShop(
  input: AdminRevokeWhatsappShopInput,
  client: SupabaseClientLike = supabase
): Promise<AdminRevokeWhatsappShopResult> {
  const { shopCodeId } = input

  const { data: claimed, error } = await client
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: false,
      whatsapp_activated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCodeId)
    .eq("whatsapp_activated", true)
    .select("id")
    .maybeSingle()

  if (error) {
    console.error("[ADMIN-WHATSAPP-REVOKE] Failed to update shop code:", error)
    return { ok: false, status: 500, error: "Revoke failed — database update error" }
  }
  if (!claimed) {
    return { ok: false, status: 409, error: "Not currently activated" }
  }

  return { ok: true }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/shop-commerce/whatsapp-activation.test.ts`
Expected: PASS (10/10 — 4 pre-existing + 6 new)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add lib/shop-commerce/whatsapp-activation.ts lib/shop-commerce/whatsapp-activation.test.ts
git commit -m "feat(admin-ussd-shops): add adminGrantWhatsappShop/adminRevokeWhatsappShop"
```

---

### Task 2: Admin API wiring — two new endpoints + GET field addition

**Files:**
- Create: `app/api/admin/ussd-shops/[id]/whatsapp-activate/route.ts`
- Create: `app/api/admin/ussd-shops/[id]/whatsapp-deactivate/route.ts`
- Modify: `app/api/admin/ussd-shops/route.ts`

**Interfaces:**
- Consumes: `adminGrantWhatsappShop`, `adminRevokeWhatsappShop` from Task 1 (`@/lib/shop-commerce/whatsapp-activation`).
- Produces: `POST /api/admin/ussd-shops/[id]/whatsapp-activate` → `{ success: true, whatsapp_activated: true }` (200) or `{ error }` (404/409/500). `POST /api/admin/ussd-shops/[id]/whatsapp-deactivate` → `{ success: true, whatsapp_activated: false }` (200) or `{ error }` (404/409/500). `GET /api/admin/ussd-shops`'s `data[]` entries gain `whatsapp_activated: boolean` and `whatsapp_activated_at: string | null` — consumed by Task 3's frontend.

No test file for this task — this codebase has no route-handler test convention under `app/api/` (see the comment at the top of `lib/shop-commerce/whatsapp-activation.ts`); the business logic these routes call is already tested in Task 1. Verify this task with `tsc` and a manual smoke check instead (Step 5).

Read `app/api/admin/ussd-shops/[id]/activate/route.ts` in full first — both new routes follow its exact shape (same `requireAdmin` helper, copy it verbatim into each new file, matching the existing convention where every route under `app/api/admin/ussd-shops/` redeclares its own copy rather than importing a shared one).

- [ ] **Step 1: Create the grant route**

```typescript
// app/api/admin/ussd-shops/[id]/whatsapp-activate/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { adminGrantWhatsappShop } from "@/lib/shop-commerce/whatsapp-activation"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return null
  const { data } = await supabase.from("users").select("role").eq("id", user.id).single()
  return data?.role === "admin" ? user.id : null
}

// POST /api/admin/ussd-shops/[id]/whatsapp-activate
// Admin-granted WhatsApp activation — no wallet charge. Mirrors the sibling
// USSD /activate route's "manual activation" pattern.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, code, user_shops!inner(user_id, shop_name)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await adminGrantWhatsappShop({ shopCodeId: id, shopId: shopCode.shop_id })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  const shopOwnerId = (shopCode as any).user_shops?.user_id
  const shopName: string = (shopCode as any).user_shops?.shop_name ?? "Your shop"
  const shopCodeStr: string = (shopCode as any).code ?? ""

  if (shopOwnerId) {
    sendPushToUser(shopOwnerId, {
      title: "WhatsApp Shop Activated",
      body: `WhatsApp ordering is now active for "${shopName}" (code ${shopCodeStr}).`,
      data: { url: `/dashboard/ussd-shop` },
    }).catch(() => {})
  }

  return NextResponse.json({ success: true, whatsapp_activated: true })
}
```

- [ ] **Step 2: Create the revoke route**

```typescript
// app/api/admin/ussd-shops/[id]/whatsapp-deactivate/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { adminRevokeWhatsappShop } from "@/lib/shop-commerce/whatsapp-activation"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return null
  const { data } = await supabase.from("users").select("role").eq("id", user.id).single()
  return data?.role === "admin" ? user.id : null
}

// POST /api/admin/ussd-shops/[id]/whatsapp-deactivate
// Pure access-flag revoke — no refund/reversal logic.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await adminRevokeWhatsappShop({ shopCodeId: id })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ success: true, whatsapp_activated: false })
}
```

- [ ] **Step 3: Add the two fields to the GET list endpoint**

In `app/api/admin/ussd-shops/route.ts`, replace:

```typescript
  const { data: codes, error } = await supabase
    .from("ussd_shop_codes")
    .select(`
      id, code, status, token_balance, activation_fee_paid, activation_paid_at, created_at,
      user_shops!inner(id, shop_name, user_id)
    `)
    .order("created_at", { ascending: false })
```

with:

```typescript
  const { data: codes, error } = await supabase
    .from("ussd_shop_codes")
    .select(`
      id, code, status, token_balance, activation_fee_paid, activation_paid_at, created_at,
      whatsapp_activated, whatsapp_activated_at,
      user_shops!inner(id, shop_name, user_id)
    `)
    .order("created_at", { ascending: false })
```

And replace:

```typescript
  const result = (codes ?? []).map((c: any) => ({
    id: c.id,
    code: c.code,
    status: c.status,
    token_balance: c.token_balance,
    activation_fee_paid: c.activation_fee_paid,
    activation_paid_at: c.activation_paid_at,
    created_at: c.created_at,
    shop_id: c.user_shops?.id,
    shop_name: c.user_shops?.shop_name,
    shop_owner_user_id: c.user_shops?.user_id,
    order_count: orderCounts[c.id] ?? 0,
  }))
```

with:

```typescript
  const result = (codes ?? []).map((c: any) => ({
    id: c.id,
    code: c.code,
    status: c.status,
    token_balance: c.token_balance,
    activation_fee_paid: c.activation_fee_paid,
    activation_paid_at: c.activation_paid_at,
    whatsapp_activated: c.whatsapp_activated,
    whatsapp_activated_at: c.whatsapp_activated_at,
    created_at: c.created_at,
    shop_id: c.user_shops?.id,
    shop_name: c.user_shops?.shop_name,
    shop_owner_user_id: c.user_shops?.user_id,
    order_count: orderCounts[c.id] ?? 0,
  }))
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 5: Manual smoke check**

Run the dev server (`npm run dev`), sign in as an admin, and from a REST client (or the browser devtools Network tab against the running `/admin/ussd-shops` page once Task 3 lands) confirm: `GET /api/admin/ussd-shops` now includes `whatsapp_activated`/`whatsapp_activated_at` per row. This step can also just be verified visually once Task 3's UI is in place — note it here so it isn't skipped if Task 3 is done by a different session.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/ussd-shops/[id]/whatsapp-activate/route.ts app/api/admin/ussd-shops/[id]/whatsapp-deactivate/route.ts app/api/admin/ussd-shops/route.ts
git commit -m "feat(admin-ussd-shops): add whatsapp-activate/deactivate endpoints, expose fields on GET"
```

---

### Task 3: Admin page UI — badge, grant button, stats card, new tab

**Files:**
- Modify: `app/admin/ussd-shops/page.tsx`

**Interfaces:**
- Consumes: `whatsapp_activated: boolean`, `whatsapp_activated_at: string | null` on each `ShopCode` (from Task 2's GET response). `POST /api/admin/ussd-shops/[id]/whatsapp-activate` and `POST /api/admin/ussd-shops/[id]/whatsapp-deactivate` (Task 2).

Read the current file in full first (869 lines) — this task touches five distinct spots. Each step below gives the exact surrounding text to anchor the edit.

- [ ] **Step 1: Add the two new fields to the `ShopCode` interface**

Replace:

```typescript
interface ShopCode {
  id: string
  code: string
  status: 'inactive' | 'active' | 'suspended'
  token_balance: number
  activation_fee_paid: boolean
  activation_paid_at: string | null
  created_at: string
  shop_id: string
  shop_name: string
  shop_owner_user_id: string
  order_count: number
}
```

with:

```typescript
interface ShopCode {
  id: string
  code: string
  status: 'inactive' | 'active' | 'suspended'
  token_balance: number
  activation_fee_paid: boolean
  activation_paid_at: string | null
  whatsapp_activated: boolean
  whatsapp_activated_at: string | null
  created_at: string
  shop_id: string
  shop_name: string
  shop_owner_user_id: string
  order_count: number
}
```

- [ ] **Step 2: Add the `MessageCircle` icon import and two new loading-state fields**

Replace:

```typescript
import { Plus, Coins, CheckCircle, PauseCircle, Trash2, RefreshCw, Hash, Settings2, Save, ShieldCheck, Activity, Banknote, Database } from "lucide-react"
```

with:

```typescript
import { Plus, Coins, CheckCircle, PauseCircle, Trash2, RefreshCw, Hash, Settings2, Save, ShieldCheck, Activity, Banknote, Database, MessageCircle } from "lucide-react"
```

Then, right after the existing `activating` state declaration:

```typescript
  const [showActivate, setShowActivate] = useState(false)
  const [activateTarget, setActivateTarget] = useState<ShopCode | null>(null)
  const [activateTokens, setActivateTokens] = useState("0")
  const [activating, setActivating] = useState(false)
```

add:

```typescript
  const [showActivate, setShowActivate] = useState(false)
  const [activateTarget, setActivateTarget] = useState<ShopCode | null>(null)
  const [activateTokens, setActivateTokens] = useState("0")
  const [activating, setActivating] = useState(false)

  // WhatsApp grant/revoke — tracks which single row is mid-request so only
  // that row's button shows a disabled/loading state, not every row's.
  const [whatsappActionId, setWhatsappActionId] = useState<string | null>(null)
```

- [ ] **Step 3: Add the two handler functions**

Right after the existing `handleActivate` function (before the `statusBadge` function), add:

```typescript
  const handleGrantWhatsapp = async (code: ShopCode) => {
    setWhatsappActionId(code.id)
    try {
      const res = await fetch(`/api/admin/ussd-shops/${code.id}/whatsapp-activate`, {
        method: "POST",
        headers: await authHeader(),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? "Failed to grant WhatsApp access"); return }
      toast.success(`WhatsApp activated for ${code.shop_name}`)
      await loadAll()
    } finally {
      setWhatsappActionId(null)
    }
  }

  const handleRevokeWhatsapp = async (code: ShopCode) => {
    if (!confirm(`Revoke WhatsApp access for ${code.shop_name} (${code.code})?`)) return
    setWhatsappActionId(code.id)
    try {
      const res = await fetch(`/api/admin/ussd-shops/${code.id}/whatsapp-deactivate`, {
        method: "POST",
        headers: await authHeader(),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error ?? "Failed to revoke WhatsApp access"); return }
      toast.success(`WhatsApp revoked for ${code.shop_name}`)
      await loadAll()
    } finally {
      setWhatsappActionId(null)
    }
  }
```

- [ ] **Step 4: Add the WhatsApp badge next to the shop name in the "Shop Codes" table**

Replace (inside the `codes` tab's table body):

```typescript
                            <td className="py-3 pr-4">
                              <span className="font-medium text-foreground">{code.shop_name}</span>
                            </td>
                            <td className="py-3 pr-4">{statusBadge(code.status)}</td>
```

with:

```typescript
                            <td className="py-3 pr-4">
                              <span className="font-medium text-foreground inline-flex items-center gap-1.5">
                                {code.shop_name}
                                {code.whatsapp_activated && (
                                  <MessageCircle className="w-3.5 h-3.5 text-success shrink-0" aria-label="WhatsApp activated" />
                                )}
                              </span>
                            </td>
                            <td className="py-3 pr-4">{statusBadge(code.status)}</td>
```

- [ ] **Step 5: Add the "Grant WhatsApp" button to the "Shop Codes" table's Actions column**

Replace:

```typescript
                                {code.activation_fee_paid && (
                                  <Button
                                    size="sm" variant="outline"
                                    className={`h-7 text-xs ${code.status === 'active' ? 'border-border text-warning hover:bg-warning/10' : 'border-border text-success hover:bg-success/10'}`}
                                    onClick={() => handleStatusToggle(code)}
                                  >
                                    <PauseCircle className="w-3 h-3 mr-1" />
                                    {code.status === 'active' ? 'Suspend' : 'Activate'}
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs border-border text-destructive hover:bg-destructive/10"
                                  onClick={() => handleDelete(code)}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="active">
```

with:

```typescript
                                {code.activation_fee_paid && (
                                  <Button
                                    size="sm" variant="outline"
                                    className={`h-7 text-xs ${code.status === 'active' ? 'border-border text-warning hover:bg-warning/10' : 'border-border text-success hover:bg-success/10'}`}
                                    onClick={() => handleStatusToggle(code)}
                                  >
                                    <PauseCircle className="w-3 h-3 mr-1" />
                                    {code.status === 'active' ? 'Suspend' : 'Activate'}
                                  </Button>
                                )}
                                {!code.whatsapp_activated && (
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-7 text-xs border-border text-success hover:bg-success/10"
                                    disabled={whatsappActionId === code.id}
                                    onClick={() => handleGrantWhatsapp(code)}
                                  >
                                    <MessageCircle className="w-3 h-3 mr-1" /> Grant WhatsApp
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs border-border text-destructive hover:bg-destructive/10"
                                  onClick={() => handleDelete(code)}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="active">
```

- [ ] **Step 6: Add the badge and "Grant WhatsApp" button to the "Active Codes" table**

Replace:

```typescript
                            <td className="py-3 pr-4">
                              <span className="font-medium text-foreground">{code.shop_name}</span>
                            </td>
                            <td className="py-3 pr-4">
                              <span className={`font-bold ${code.token_balance <= 5 ? 'text-destructive' : 'text-foreground'}`}>
                                {code.token_balance}
                              </span>
                              {code.token_balance <= 5 && code.token_balance > 0 && (
                                <span className="text-xs text-destructive ml-1">low</span>
                              )}
                              {code.token_balance === 0 && (
                                <span className="text-xs text-destructive ml-1">empty</span>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-muted-foreground">{code.order_count}</td>
                            <td className="py-3">
                              <div className="flex gap-1 flex-wrap">
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => { setTokensTarget(code); setTokenQty("10"); setShowTokens(true) }}
                                >
                                  <Coins className="w-3 h-3 mr-1" /> Tokens
                                </Button>
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs border-border text-warning hover:bg-warning/10"
                                  onClick={() => handleStatusToggle(code)}
                                >
                                  <PauseCircle className="w-3 h-3 mr-1" /> Suspend
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders">
```

with:

```typescript
                            <td className="py-3 pr-4">
                              <span className="font-medium text-foreground inline-flex items-center gap-1.5">
                                {code.shop_name}
                                {code.whatsapp_activated && (
                                  <MessageCircle className="w-3.5 h-3.5 text-success shrink-0" aria-label="WhatsApp activated" />
                                )}
                              </span>
                            </td>
                            <td className="py-3 pr-4">
                              <span className={`font-bold ${code.token_balance <= 5 ? 'text-destructive' : 'text-foreground'}`}>
                                {code.token_balance}
                              </span>
                              {code.token_balance <= 5 && code.token_balance > 0 && (
                                <span className="text-xs text-destructive ml-1">low</span>
                              )}
                              {code.token_balance === 0 && (
                                <span className="text-xs text-destructive ml-1">empty</span>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-muted-foreground">{code.order_count}</td>
                            <td className="py-3">
                              <div className="flex gap-1 flex-wrap">
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => { setTokensTarget(code); setTokenQty("10"); setShowTokens(true) }}
                                >
                                  <Coins className="w-3 h-3 mr-1" /> Tokens
                                </Button>
                                {!code.whatsapp_activated && (
                                  <Button
                                    size="sm" variant="outline"
                                    className="h-7 text-xs border-border text-success hover:bg-success/10"
                                    disabled={whatsappActionId === code.id}
                                    onClick={() => handleGrantWhatsapp(code)}
                                  >
                                    <MessageCircle className="w-3 h-3 mr-1" /> Grant WhatsApp
                                  </Button>
                                )}
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 text-xs border-border text-warning hover:bg-warning/10"
                                  onClick={() => handleStatusToggle(code)}
                                >
                                  <PauseCircle className="w-3 h-3 mr-1" /> Suspend
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="orders">
```

- [ ] **Step 7: Add the "WhatsApp Activated" stats card**

Replace:

```typescript
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Today&apos;s Activations</p>
                  <p className="text-3xl font-bold text-foreground mt-1">
                    GH¢{todayActivationRevenue.toFixed(2)}
                  </p>
                </div>
                <Banknote className="w-8 h-8 text-warning opacity-80 shrink-0" />
              </div>
            </CardContent>
          </Card>
        </div>
```

with:

```typescript
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">Today&apos;s Activations</p>
                  <p className="text-3xl font-bold text-foreground mt-1">
                    GH¢{todayActivationRevenue.toFixed(2)}
                  </p>
                </div>
                <Banknote className="w-8 h-8 text-warning opacity-80 shrink-0" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide font-medium">WhatsApp Activated</p>
                  <p className="text-3xl font-bold text-foreground mt-1">
                    {codes.filter(c => c.whatsapp_activated).length}
                  </p>
                </div>
                <MessageCircle className="w-8 h-8 text-success opacity-80 shrink-0" />
              </div>
            </CardContent>
          </Card>
        </div>
```

(This makes the stats grid 6 cards. The existing grid classes `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` don't need to change — a 6th card simply wraps to a second row at all breakpoints, which is acceptable and matches how the grid already behaves with 5 cards on `sm` (3-wide, wraps to 2).)

- [ ] **Step 8: Add the new "WhatsApp Active" tab**

Replace:

```typescript
        <Tabs defaultValue="codes">
          <TabsList className="mb-4">
            <TabsTrigger value="codes">Shop Codes ({codes.length})</TabsTrigger>
            <TabsTrigger value="active">Active Codes ({codes.filter(c => c.status === 'active').length})</TabsTrigger>
            <TabsTrigger value="orders">Orders ({ordersTotalCount})</TabsTrigger>
          </TabsList>
```

with:

```typescript
        <Tabs defaultValue="codes">
          <TabsList className="mb-4">
            <TabsTrigger value="codes">Shop Codes ({codes.length})</TabsTrigger>
            <TabsTrigger value="active">Active Codes ({codes.filter(c => c.status === 'active').length})</TabsTrigger>
            <TabsTrigger value="whatsapp">WhatsApp Active ({codes.filter(c => c.whatsapp_activated).length})</TabsTrigger>
            <TabsTrigger value="orders">Orders ({ordersTotalCount})</TabsTrigger>
          </TabsList>
```

Then, immediately after the closing `</TabsContent>` of the `"active"` tab and before `<TabsContent value="orders">`, insert the new tab's content:

```typescript
          <TabsContent value="whatsapp">
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium">WhatsApp-Activated Shops</CardTitle>
              </CardHeader>
              <CardContent>
                {codes.filter(c => c.whatsapp_activated).length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <MessageCircle className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p>No shops have WhatsApp activated yet.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground text-xs uppercase tracking-wide">
                          <th className="pb-3 pr-4">Code</th>
                          <th className="pb-3 pr-4">Shop</th>
                          <th className="pb-3 pr-4">Activated</th>
                          <th className="pb-3 pr-4">Tokens</th>
                          <th className="pb-3 pr-4">Orders</th>
                          <th className="pb-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {codes.filter(c => c.whatsapp_activated).map(code => (
                          <tr key={code.id} className="border-b last:border-0 hover:bg-accent">
                            <td className="py-3 pr-4">
                              <code className="bg-success/10 text-success font-mono font-bold text-base px-2 py-1 rounded border border-border">
                                {code.code}
                              </code>
                            </td>
                            <td className="py-3 pr-4">
                              <span className="font-medium text-foreground">{code.shop_name}</span>
                            </td>
                            <td className="py-3 pr-4 text-muted-foreground text-xs">
                              {code.whatsapp_activated_at ? new Date(code.whatsapp_activated_at).toLocaleDateString() : "—"}
                            </td>
                            <td className="py-3 pr-4">
                              <span className={`font-bold ${code.token_balance <= 5 ? 'text-destructive' : 'text-foreground'}`}>
                                {code.token_balance}
                              </span>
                              {code.token_balance <= 5 && code.token_balance > 0 && (
                                <span className="text-xs text-destructive ml-1">low</span>
                              )}
                              {code.token_balance === 0 && (
                                <span className="text-xs text-destructive ml-1">empty</span>
                              )}
                            </td>
                            <td className="py-3 pr-4 text-muted-foreground">{code.order_count}</td>
                            <td className="py-3">
                              <Button
                                size="sm" variant="outline"
                                className="h-7 text-xs border-border text-destructive hover:bg-destructive/10"
                                disabled={whatsappActionId === code.id}
                                onClick={() => handleRevokeWhatsapp(code)}
                              >
                                <PauseCircle className="w-3 h-3 mr-1" /> Revoke
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

```

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 10: Manual smoke check**

Run: `npm run dev`, sign in as an admin, open `/admin/ussd-shops`. Verify:
- The stats row shows a 6th "WhatsApp Activated" card with the correct count.
- The new "WhatsApp Active" tab appears between "Active Codes" and "Orders", listing only `whatsapp_activated: true` rows, with a working "Revoke" button (confirm dialog → toast → row disappears from this tab and its badge disappears elsewhere).
- On the "Shop Codes" and "Active Codes" tabs, a row with `whatsapp_activated: false` shows a "Grant WhatsApp" button; clicking it toasts success, the row gains the green WhatsApp badge next to its shop name, and it now appears on the "WhatsApp Active" tab.
- A row that's already `whatsapp_activated: true` does NOT show the "Grant WhatsApp" button (only the badge).

- [ ] **Step 11: Commit**

```bash
git add app/admin/ussd-shops/page.tsx
git commit -m "feat(admin-ussd-shops): add WhatsApp activation badge, grant/revoke UI, and dedicated tab"
```

---

## Plan Self-Review Notes

- **Spec coverage:** §1 (API includes fields) → Task 2 Step 3; §2 (grant endpoint) → Task 2 Step 1 + Task 1; §3 (revoke endpoint) → Task 2 Step 2 + Task 1; §4 (new tab) → Task 3 Step 8; §5 (badge in existing tables) → Task 3 Steps 4 & 6; §6 (grant button in existing tables) → Task 3 Steps 5 & 6; §7 (stats card) → Task 3 Step 7.
- **Out of scope items** (customer-facing flow, WhatsApp bot runtime, refund logic) are untouched by every task above — confirmed no task modifies `app/api/dashboard/ussd-shop/whatsapp-activate/route.ts`, `lib/whatsapp-bot/*`, or adds any refund/transaction-reversal code.
- **Type consistency:** `AdminGrantWhatsappShopInput`/`AdminRevokeWhatsappShopInput` (Task 1) match exactly what Task 2's two routes construct and pass. `whatsapp_activated`/`whatsapp_activated_at` field names are identical across Task 2's GET mapping and Task 3's `ShopCode` interface/JSX usage. `whatsappActionId` (Task 3 Step 2) is referenced consistently in Steps 5, 6, and 8's disabled/onClick handlers.
