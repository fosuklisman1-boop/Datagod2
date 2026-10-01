# USSD Shop Display Name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let shop owners set a dedicated, word-filtered display name for their shop's USSD header, separate from the unrestricted `shop_name`, so a shop name containing "data"/"bundle"/network wording can't reintroduce that wording into USSD copy.

**Architecture:** A pure validation module enforces a blocked-word list and a length cap. A new nullable `user_shops.ussd_display_name` column stores the opt-in override, and `resolveShopCode()` prefers it over `shop_name` when set. A shop-owner-scoped API route runs the same validation server-side (authoritative) before writing the column. A small card on the existing USSD dashboard tab lets the owner edit it.

**Tech Stack:** Next.js 15 App Router API route, Supabase (Postgres + `@supabase/supabase-js`), Vitest, existing shadcn/ui components already used on the page (`Card`, `Button`, `sonner` toast).

**Spec:** docs/superpowers/specs/2026-09-30-ussd-shop-display-name-design.md

## Global Constraints

- Blocked words (case-insensitive, whole-word match via `\b...\b`): `["data", "bundle", "bundles", "mtn", "telecel", "airteltigo", "at"]` — copied verbatim from the spec.
- Max length: 30 characters.
- `NULL`/empty `ussd_display_name` means "fall back to `shop_name`" everywhere it's read — no backfill, no migration of existing shops.
- Server-side validation in the API route is authoritative; any client-side validation is UX only and must not be trusted alone.
- No changes to `lib/ussd/*` (the main USSD) — only `lib/ussd-shop/*`'s shop-name resolution path (`resolveShopCode()` in `lib/shop-commerce/shop-code.ts`) is affected.
- The new API route follows the existing shop-owner dashboard auth pattern (raw `Authorization: Bearer <token>` → `supabase.auth.getUser(token)` → look up `user_shops` by `user_id`), matching `app/api/dashboard/ussd-shop/buy-sessions/route.ts` — **not** the admin-auth helper.

## Review Focus

- Whitespace-only input (e.g. `"   "`) — must be rejected as required, not saved as a blank string that then silently falls back via `||` at read time.
- A name that is exactly 30 characters vs. 31 characters — the boundary matters more than "too long" in general.
- A blocked word appearing as a substring without word boundaries (e.g. `"AirtelTigoDeals"`, `"Databright Ventures"`) — the spec explicitly wants these to PASS; whole-word matching is easy to accidentally regress to substring matching.
- Repeated saves of the same valid name — both calls must return `success: true`; no unique-constraint or "already set" assumption should sneak in.
- A `user.id` with no matching `user_shops` row — the route must return 404, not throw or 500, matching the established pattern in `buy-sessions/route.ts`.

---

### Task 1: Validation module

**Files:**
- Create: `lib/ussd-display-name.ts`
- Test: `lib/ussd-display-name.test.ts`

**Interfaces:**
- Produces: `BLOCKED_WORDS: string[]`, `validateUssdDisplayName(name: string): { valid: true } | { valid: false; reason: string }` — consumed by Task 3 (API route, server-side) and Task 4 (UI, client-side).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/ussd-display-name.test.ts
import { describe, it, expect } from "vitest"
import { validateUssdDisplayName, BLOCKED_WORDS } from "./ussd-display-name"

describe("validateUssdDisplayName", () => {
  it("rejects an empty string", () => {
    expect(validateUssdDisplayName("")).toEqual({ valid: false, reason: "Name is required" })
  })

  it("rejects a whitespace-only string", () => {
    expect(validateUssdDisplayName("   ")).toEqual({ valid: false, reason: "Name is required" })
  })

  it("accepts an ordinary name", () => {
    expect(validateUssdDisplayName("Kwame Mobile Shop")).toEqual({ valid: true })
  })

  it("accepts a name exactly 30 characters long", () => {
    const name = "A".repeat(30)
    expect(validateUssdDisplayName(name)).toEqual({ valid: true })
  })

  it("rejects a name 31 characters long", () => {
    const name = "A".repeat(31)
    expect(validateUssdDisplayName(name)).toEqual({
      valid: false,
      reason: "Name must be 30 characters or fewer",
    })
  })

  it.each(BLOCKED_WORDS)("rejects the whole word \"%s\" case-insensitively", (word) => {
    const result = validateUssdDisplayName(`Best ${word.toUpperCase()} Shop`)
    expect(result.valid).toBe(false)
  })

  it("passes a name containing a blocked word as a substring without word boundaries (AirtelTigoDeals)", () => {
    expect(validateUssdDisplayName("AirtelTigoDeals")).toEqual({ valid: true })
  })

  it("passes a name containing a blocked word as a substring without word boundaries (Databright Ventures)", () => {
    expect(validateUssdDisplayName("Databright Ventures")).toEqual({ valid: true })
  })

  it("rejects the bare word \"AT\" when it stands alone", () => {
    const result = validateUssdDisplayName("At Express")
    expect(result.valid).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/ussd-display-name.test.ts`
Expected: FAIL — `Cannot find module './ussd-display-name'`

- [ ] **Step 3: Implement the module**

```ts
// lib/ussd-display-name.ts

// Blocks the exact wording removed from USSD copy by the 2026-09-30 "Browse
// Services" rebrand from reappearing via a shop owner's freely-settable
// shop_name. Whole-word matching (not substring) is deliberate: it avoids
// false positives like "AirtelTigoDeals" or "Databright" while still
// catching "MTN Direct" or "At Express". The bare "at" is included despite
// its own false-positive risk on short ordinary words — an accepted
// trade-off per the design spec.
export const BLOCKED_WORDS = ["data", "bundle", "bundles", "mtn", "telecel", "airteltigo", "at"]
const MAX_LENGTH = 30

export function validateUssdDisplayName(
  name: string
): { valid: true } | { valid: false; reason: string } {
  const trimmed = name.trim()
  if (!trimmed) return { valid: false, reason: "Name is required" }
  if (trimmed.length > MAX_LENGTH) {
    return { valid: false, reason: `Name must be ${MAX_LENGTH} characters or fewer` }
  }
  for (const word of BLOCKED_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(trimmed)) {
      return { valid: false, reason: `Name can't contain "${word}"` }
    }
  }
  return { valid: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/ussd-display-name.test.ts`
Expected: PASS (all cases, including the `it.each(BLOCKED_WORDS)` loop)

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-display-name.ts lib/ussd-display-name.test.ts
git commit -m "feat(ussd-shop): add USSD display name validation module"
```

---

### Task 2: Migration + `resolveShopCode()` fallback

**Files:**
- Create: `migrations/0099_ussd_shop_display_name.sql`
- Modify: `lib/shop-commerce/shop-code.ts:36-58` (the `select` inside `resolveShopCode` and the `shopName` field of its return value)
- Test: `lib/shop-commerce/shop-code.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveShopCode()`'s `ResolvedShopCode.shopName` now prefers `ussd_display_name` when the column is set and non-empty, otherwise falls back to `shop_name` exactly as before — consumed downstream by every caller of `resolveShopCode()` (unchanged call sites, no signature change).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0099_ussd_shop_display_name.sql

-- Lets a shop owner set a dedicated, word-filtered name for their shop's
-- USSD header, separate from the unrestricted shop_name (which has zero
-- content validation and is otherwise used on the web storefront etc).
-- See docs/superpowers/specs/2026-09-30-ussd-shop-display-name-design.md.
-- NULL means "keep showing shop_name, unchanged" -- no backfill needed.
ALTER TABLE user_shops ADD COLUMN IF NOT EXISTS ussd_display_name TEXT;
```

- [ ] **Step 2: Write the failing tests**

Add these cases to the existing `describe("resolveShopCode", ...)` block in `lib/shop-commerce/shop-code.test.ts` (the file already defines `makeChain` and `fakeClient` helpers — reuse them):

```ts
  it("prefers ussd_display_name over shop_name when it is set", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc5", shop_id: "s5", status: "active", token_balance: 1, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "MTN Data Direct", parent_shop_id: null, ussd_display_name: "Kwame Mobile" },
      },
    })

    const result = await resolveShopCode("DISP01", client)
    expect(result?.shopName).toBe("Kwame Mobile")
  })

  it("falls back to shop_name when ussd_display_name is null", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc6", shop_id: "s6", status: "active", token_balance: 1, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "Test Shop", parent_shop_id: null, ussd_display_name: null },
      },
    })

    const result = await resolveShopCode("DISP02", client)
    expect(result?.shopName).toBe("Test Shop")
  })
```

- [ ] **Step 3: Run the tests to verify the new cases fail**

Run: `npx vitest run lib/shop-commerce/shop-code.test.ts`
Expected: The two new tests FAIL (`shopName` comes back as `"MTN Data Direct"` instead of `"Kwame Mobile"` in the first case); all pre-existing tests in the file still PASS.

- [ ] **Step 4: Apply the migration and update `resolveShopCode()`**

Apply `migrations/0099_ussd_shop_display_name.sql` to the Supabase project (see the project's Supabase access reference for how migrations are applied).

In `lib/shop-commerce/shop-code.ts`, change:

```ts
  const { data: shopRow } = await client
    .from("user_shops")
    .select("shop_name, parent_shop_id")
    .eq("id", shopCode.shop_id)
    .single()

  return {
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    shopName: shopRow?.shop_name ?? 'Shop',
```

to:

```ts
  const { data: shopRow } = await client
    .from("user_shops")
    .select("shop_name, parent_shop_id, ussd_display_name")
    .eq("id", shopCode.shop_id)
    .single()

  return {
    shopCodeId: shopCode.id,
    shopId: shopCode.shop_id,
    shopName: shopRow?.ussd_display_name || shopRow?.shop_name || 'Shop',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/shop-commerce/shop-code.test.ts`
Expected: PASS (all tests in the file, including the two new ones and every pre-existing case)

- [ ] **Step 6: Commit**

```bash
git add migrations/0099_ussd_shop_display_name.sql lib/shop-commerce/shop-code.ts lib/shop-commerce/shop-code.test.ts
git commit -m "feat(ussd-shop): add ussd_display_name column with resolveShopCode fallback"
```

---

### Task 3: API route

**Files:**
- Create: `app/api/dashboard/ussd-shop/display-name/route.ts`
- Test: `app/api/dashboard/ussd-shop/display-name/route.test.ts`

**Interfaces:**
- Consumes: `validateUssdDisplayName` from `@/lib/ussd-display-name` (Task 1: `(name: string) => { valid: true } | { valid: false; reason: string }`).
- Produces: `POST` handler at `/api/dashboard/ussd-shop/display-name`. Request body `{ name: string }`. Responses: `401 { error: "Unauthorized" }` (no/invalid token), `400 { error: string }` (validation failure, `error` is the `reason` from `validateUssdDisplayName`), `404 { error: "Shop not found" }`, `500 { error: "Failed to save display name" }`, `200 { success: true, ussd_display_name: string }` — consumed by Task 4 (UI).

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/dashboard/ussd-shop/display-name/route.test.ts
import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    authUser: { id: "user-1" } as { id: string } | null,
    shopRow: { id: "shop-1" } as { id: string } | null,
    updateCalls: [] as { id: string; data: any }[],
    failUpdate: false,
  }
  const fake = {
    auth: {
      getUser: async (_token: string) => ({ data: { user: state.authUser } }),
    },
    from: (table: string) => {
      if (table === "user_shops") {
        return {
          select: () => ({
            eq: (_col: string, _val: string) => ({
              single: () => Promise.resolve({ data: state.shopRow }),
            }),
          }),
          update: (data: any) => ({
            eq: (_col: string, id: string) => {
              state.updateCalls.push({ id, data })
              return Promise.resolve({ error: state.failUpdate ? new Error("simulated failure") : null })
            },
          }),
        }
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

function postRequest(body: unknown, withAuth = true) {
  return new NextRequest("http://localhost/api/dashboard/ussd-shop/display-name", {
    method: "POST",
    headers: withAuth ? { Authorization: "Bearer test-token" } : {},
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.authUser = { id: "user-1" }
  h.state.shopRow = { id: "shop-1" }
  h.state.updateCalls = []
  h.state.failUpdate = false
})

describe("POST /api/dashboard/ussd-shop/display-name", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await POST(postRequest({ name: "Kwame Shop" }, false))
    expect(res.status).toBe(401)
  })

  it("rejects when the token doesn't resolve to a user", async () => {
    h.state.authUser = null
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(401)
  })

  it("rejects a name containing a blocked word and does not write", async () => {
    const res = await POST(postRequest({ name: "MTN Direct Shop" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain("mtn")
    expect(h.state.updateCalls).toHaveLength(0)
  })

  it("rejects when no shop is found for the authenticated user", async () => {
    h.state.shopRow = null
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(404)
  })

  it("saves a valid trimmed name and returns it", async () => {
    const res = await POST(postRequest({ name: "  Kwame Shop  " }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, ussd_display_name: "Kwame Shop" })
    expect(h.state.updateCalls).toEqual([{ id: "shop-1", data: { ussd_display_name: "Kwame Shop" } }])
  })

  it("returns success on repeated saves of the same valid name", async () => {
    const first = await POST(postRequest({ name: "Kwame Shop" }))
    const second = await POST(postRequest({ name: "Kwame Shop" }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(h.state.updateCalls).toHaveLength(2)
  })

  it("reports a DB update failure as a 500 without claiming success", async () => {
    h.state.failUpdate = true
    const res = await POST(postRequest({ name: "Kwame Shop" }))
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/api/dashboard/ussd-shop/display-name/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement the route**

```ts
// app/api/dashboard/ussd-shop/display-name/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { validateUssdDisplayName } from "@/lib/ussd-display-name"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/display-name
// Body: { name: string }
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { name } = await request.json()

  const validation = validateUssdDisplayName(String(name ?? ""))
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 })
  }
  const trimmed = String(name).trim()

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { error: updateError } = await supabase
    .from("user_shops")
    .update({ ussd_display_name: trimmed })
    .eq("id", shop.id)

  if (updateError) {
    console.error("[USSD-DISPLAY-NAME] update failed:", updateError)
    return NextResponse.json({ error: "Failed to save display name" }, { status: 500 })
  }

  return NextResponse.json({ success: true, ussd_display_name: trimmed })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/dashboard/ussd-shop/display-name/route.test.ts`
Expected: PASS (all 7 cases)

- [ ] **Step 5: Commit**

```bash
git add app/api/dashboard/ussd-shop/display-name/route.ts app/api/dashboard/ussd-shop/display-name/route.test.ts
git commit -m "feat(ussd-shop): add display-name save API route"
```

---

### Task 4: Dashboard UI card

**Files:**
- Modify: `app/dashboard/ussd-shop/page.tsx`

**Interfaces:**
- Consumes: `validateUssdDisplayName` from `@/lib/ussd-display-name` (Task 1, client-side pre-check only); `POST /api/dashboard/ussd-shop/display-name` (Task 3).
- Produces: nothing consumed by later tasks — this is the last task.

No automated test exists for this page (no `.test.tsx` files exist anywhere under `app/dashboard/` in this repo — page-level UI isn't unit-tested here). Verification for this task is manual, in a running dev server, per step 4 below.

- [ ] **Step 1: Add the import and new state**

In `app/dashboard/ussd-shop/page.tsx`, add to the existing lucide-react import (line 11) the `Tag` icon:

```ts
import { Smartphone, Hash, Coins, Copy, CheckCircle, RefreshCw, AlertCircle, Wallet, Loader2, MessageCircle, Tag } from "lucide-react"
```

Add a new import below the existing ones:

```ts
import { validateUssdDisplayName } from "@/lib/ussd-display-name"
```

Add new state alongside the existing `useState` declarations (after `const [waLinkCopied, setWaLinkCopied] = useState(false)`):

```ts
  const [shopName, setShopName] = useState("")
  const [displayNameInput, setDisplayNameInput] = useState("")
  const [savingDisplayName, setSavingDisplayName] = useState(false)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null)
```

- [ ] **Step 2: Fetch and populate the new fields in `loadData()`**

Change the shop-row select from:

```ts
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id")
        .eq("user_id", user!.id)
        .single()

      if (!shopRow) { setLoading(false); return }
```

to:

```ts
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id, shop_name, ussd_display_name")
        .eq("user_id", user!.id)
        .single()

      if (!shopRow) { setLoading(false); return }

      setShopName(shopRow.shop_name ?? "")
      setDisplayNameInput(shopRow.ussd_display_name ?? "")
```

- [ ] **Step 3: Add the save handler**

Add this function next to `handleBuySessions` (after its closing `}` around line 183):

```ts
  const handleSaveDisplayName = async () => {
    const validation = validateUssdDisplayName(displayNameInput)
    if (!validation.valid) {
      setDisplayNameError(validation.reason)
      return
    }
    setDisplayNameError(null)
    setSavingDisplayName(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/dashboard/ussd-shop/display-name", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ name: displayNameInput }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Save failed")
      setDisplayNameInput(json.ussd_display_name)
      toast.success("USSD display name saved!")
    } catch (err: any) {
      setDisplayNameError(err.message ?? "Save failed")
    } finally {
      setSavingDisplayName(false)
    }
  }
```

- [ ] **Step 4: Add the card JSX**

Insert this new card immediately after the Shop Code card's closing `</Card>` (after line 345) and before the `{/* Buy Sessions */}` comment:

```tsx
            {/* USSD Display Name */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Tag className="w-4 h-4" />
                  USSD Display Name
                </CardTitle>
                <CardDescription>
                  Optional — overrides your shop name on USSD screens only.
                  {!displayNameInput && shopName && ` Currently showing: "${shopName}"`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <input
                  type="text"
                  maxLength={30}
                  placeholder={shopName || "Shop"}
                  value={displayNameInput}
                  onChange={e => { setDisplayNameInput(e.target.value); setDisplayNameError(null) }}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-card focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {displayNameError && <p className="text-xs text-destructive">{displayNameError}</p>}
                <Button
                  size="sm"
                  disabled={savingDisplayName || !displayNameInput.trim()}
                  onClick={handleSaveDisplayName}
                  className="w-full"
                >
                  {savingDisplayName ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                  Save
                </Button>
              </CardContent>
            </Card>
```

- [ ] **Step 5: Manually verify in a running dev server**

Run: `npm run dev`

1. Sign in as a user with an active shop and navigate to `/dashboard/ussd-shop`.
2. Confirm the new "USSD Display Name" card renders under the Shop Code card, on the "USSD" tab.
3. Type a name containing a blocked word (e.g. `"MTN Direct"`) and click Save — confirm an inline error appears under the input and no success toast fires.
4. Clear the input and type a valid name (e.g. `"Kwame Mobile"`) and click Save — confirm a success toast fires and the input keeps the saved value after a page reload.
5. Reload the page — confirm the saved name is pre-filled in the input (persisted via `loadData()`'s new select).

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS (all suites, including the three new/modified ones from Tasks 1–3)

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/ussd-shop/page.tsx
git commit -m "feat(ussd-shop): add USSD display name card to shop dashboard"
```
