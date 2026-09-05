# Live Phone-Number Verification at Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give customers a live, informational, non-blocking preview at checkout of whether their MTN number is verified by any admin-selected provider, with an accurate "proceed anyway, it'll still be delivered once verified" warning when it isn't.

**Architecture:** One new shared backend function (`lib/mtn-providers/customer-verification.ts`) reuses the existing `WHITELIST_REGISTRY` providers under a brand-new, independent admin toggle + provider subset. A public rate-limited API route (`/api/verify-phone-live`) exposes it to the two unauthenticated/browser call sites; the dealer API calls the shared function directly server-side. Four call sites get a live check inserted right before their existing order-creation call. No new database table, no new retry cron — the existing internal fulfillment-time whitelist gate and its 24h retry cron already provide the actual "held until verified" behavior regardless of what this preview says.

**Tech Stack:** Next.js 15 App Router API routes, TypeScript, Supabase (service-role client), Vitest, Upstash-backed rate limiter (`lib/rate-limiter.ts`).

## Global Constraints

- MTN only. Every call site must check network (case-insensitively, `.toUpperCase() === "MTN"`) before running the live check — non-MTN orders skip it entirely, exactly as today.
- Fail open, everywhere: a missing/unreadable admin setting, an unconfigured provider list, a provider's own check throwing, a network error on the public route, or a frontend fetch failure must all resolve to "verified" (no warning shown, order proceeds normally). Never let this feature block or slow down checkout on infrastructure trouble.
- No new persistence for this feature. Don't write to `mtn_number_registry` or any other table from the new code in this plan — the existing internal whitelist gate already owns that.
- Independent from the internal fulfillment gate's own `mtn_whitelist_enabled` setting and provider list — do not read, write, or reuse that setting's `admin_settings` key. New setting key: `customer_verification_settings`.
- Warning copy (verbatim, single-order surfaces): "This number hasn't been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until it clears — you'll receive it automatically once verified."

---

### Task 1: Shared backend check

**Files:**
- Create: `lib/mtn-providers/customer-verification.ts`
- Test: `lib/mtn-providers/customer-verification.test.ts`

**Interfaces:**
- Consumes: `WhitelistEntry`, `WHITELIST_REGISTRY` from `./provider-whitelist` (exact shape: `{name: string, configured(): boolean, check(msisdn: string): Promise<{allowed: boolean, provider: string, reason?: string}>, checkBatch(msisdns: string[]): Promise<Array<{msisdn: string, allowed: boolean, reason?: string}>>}`).
- Produces: `CustomerVerificationSettings` type, `getCustomerVerificationSettings()`, `checkCustomerFacingVerification(phones: string[], registry?: WhitelistEntry[])` — these exact names are used by Tasks 2 and 4-8.

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/mtn-providers/customer-verification.test.ts
import { checkCustomerFacingVerification, getCustomerVerificationSettings } from "./customer-verification"
import type { WhitelistEntry } from "./provider-whitelist"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

function fakeEntry(name: string, allowedSet: Set<string>, configured = true): WhitelistEntry {
  return {
    name,
    configured: () => configured,
    check: async (msisdn) => ({ allowed: allowedSet.has(msisdn), provider: name }),
    checkBatch: async (msisdns) => msisdns.map(m => ({ msisdn: m, allowed: allowedSet.has(m) })),
  }
}

describe("checkCustomerFacingVerification", () => {
  it("marks every phone verified when the feature is disabled", async () => {
    const registry = [fakeEntry("xpress", new Set())]
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0552222222"],
      registry,
      { enabled: false, providers: ["xpress"] }
    )
    expect(result).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: true },
    ])
  })

  it("marks every phone verified when no configured provider is selected", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: [] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("marks every phone verified when the selected provider isn't in the registry or isn't configured", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]), false)]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("returns per-phone results for a mixed batch against one configured provider", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0559999999"],
      registry,
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0559999999", verified: false },
    ])
  })

  it("is verified if ANY configured provider approves, checked in registry order", async () => {
    const registry = [
      fakeEntry("xpress", new Set()),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress", "codecraft"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("does not let one provider's thrown exception fail the whole check", async () => {
    const throwing: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async () => { throw new Error("network down") },
      checkBatch: async () => { throw new Error("network down") },
    }
    const registry = [throwing, fakeEntry("codecraft", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress", "codecraft"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("marks a phone unverified (not throws) when every configured provider is unreachable", async () => {
    const throwing: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async () => { throw new Error("network down") },
      checkBatch: async () => { throw new Error("network down") },
    }
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      [throwing],
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: false }])
  })
})

describe("getCustomerVerificationSettings", () => {
  it("defaults to disabled with no providers when the setting row is missing", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })

  it("defaults to disabled when the read throws", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockImplementation(() => { throw new Error("db down") })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })

  it("returns the stored setting when present", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: true, providers: ["xpress", "apexprime"] } },
            error: null,
          }),
        }),
      }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: true, providers: ["xpress", "apexprime"] })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/customer-verification.test.ts`
Expected: FAIL — `Cannot find module './customer-verification'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/mtn-providers/customer-verification.ts
/**
 * Live, customer-facing phone-number verification preview at checkout.
 *
 * Deliberately independent of the internal fulfillment-time whitelist gate
 * (lib/mtn-fulfillment.ts's mtn_whitelist_enabled check) — its own admin
 * toggle, its own provider subset, its own admin_settings key. The two can
 * disagree occasionally; that's an accepted trade-off for independent
 * control, not a bug (see docs/superpowers/specs/2026-09-05-live-phone-
 * verification-checkout-design.md).
 *
 * Stateless — no persistence. The "you'll receive it once verified" promise
 * shown to customers is backed entirely by the EXISTING internal gate + its
 * 24h/72h retry cron, which runs on every order regardless of this preview.
 *
 * Fails open at every layer: disabled feature, unconfigured providers, a
 * provider erroring, or an unreadable setting all resolve to "verified".
 */

import { supabaseAdmin as supabase } from "@/lib/supabase"
import { WHITELIST_REGISTRY, type WhitelistEntry } from "./provider-whitelist"

const SETTING_KEY = "customer_verification_settings"

export type CustomerVerificationSettings = {
  enabled: boolean
  providers: string[]
}

const DEFAULT_SETTINGS: CustomerVerificationSettings = { enabled: false, providers: [] }

export async function getCustomerVerificationSettings(): Promise<CustomerVerificationSettings> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", SETTING_KEY)
      .maybeSingle()

    const value = data?.value
    if (!value || typeof value.enabled !== "boolean" || !Array.isArray(value.providers)) {
      return DEFAULT_SETTINGS
    }
    return { enabled: value.enabled, providers: value.providers }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Checks each phone against every admin-selected, registry-configured
 * provider in registry order — verified as soon as any one approves.
 * A provider whose check() throws simply doesn't count as an approval;
 * it never fails the batch.
 *
 * `settings` and `registry` are optional purely for testability (inject a
 * fake registry/settings instead of hitting the DB and real provider
 * APIs) — production callers omit both and get the real registry + a
 * fresh settings read every call.
 */
export async function checkCustomerFacingVerification(
  phones: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY,
  settings?: CustomerVerificationSettings
): Promise<Array<{ phone: string; verified: boolean }>> {
  const resolvedSettings = settings ?? await getCustomerVerificationSettings()

  if (!resolvedSettings.enabled || resolvedSettings.providers.length === 0) {
    return phones.map(phone => ({ phone, verified: true }))
  }

  const configured = registry.filter(
    p => resolvedSettings.providers.includes(p.name) && p.configured()
  )
  if (configured.length === 0) {
    return phones.map(phone => ({ phone, verified: true }))
  }

  const results: Array<{ phone: string; verified: boolean }> = []
  for (const phone of phones) {
    let verified = false
    for (const provider of configured) {
      try {
        const result = await provider.check(phone)
        if (result.allowed) {
          verified = true
          break
        }
      } catch {
        // this provider's failure doesn't count as approval; try the next one
      }
    }
    results.push({ phone, verified })
  }
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/customer-verification.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/customer-verification.ts lib/mtn-providers/customer-verification.test.ts
git commit -m "feat(customer-verification): shared live phone-check function, independent of the internal whitelist gate"
```

---

### Task 2: Admin settings API route

**Files:**
- Create: `app/api/admin/settings/customer-verification/route.ts`
- Test: `app/api/admin/settings/customer-verification/route.test.ts`

**Interfaces:**
- Consumes: `getCustomerVerificationSettings()` (Task 1), `listWhitelistProviders()` and `validateProviderSelection()` from `@/lib/mtn-providers/provider-whitelist` (already exist, exact signatures: `listWhitelistProviders(registry?: WhitelistEntry[]): Array<{name: string, configured: boolean}>`; `validateProviderSelection(names: string[], registry?: WhitelistEntry[]): {valid: true, providers: string[]} | {valid: false, error: string}`), `verifyAdminAccess` from `@/lib/admin-auth`.
- Produces: `GET`/`POST` handlers consumed by Task 3's admin UI.

- [ ] **Step 1: Write the failing test**

```typescript
// app/api/admin/settings/customer-verification/route.test.ts
import { GET, POST } from "./route"
import { NextRequest } from "next/server"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const upsertMock = vi.fn(async () => ({ error: null }))
const maybeSingleMock = vi.fn(async () => ({ data: null, error: null }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
      upsert: upsertMock,
    }),
  },
}))

describe("GET /api/admin/settings/customer-verification", () => {
  it("returns the default settings plus the list of available providers", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification")
    const res = await GET(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.settings).toEqual({ enabled: false, providers: [] })
    expect(Array.isArray(body.availableProviders)).toBe(true)
    expect(body.availableProviders.length).toBeGreaterThan(0)
  })
})

describe("POST /api/admin/settings/customer-verification", () => {
  it("rejects a non-boolean enabled value", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: "yes", providers: [] }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it("rejects an unknown provider name via validateProviderSelection", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: true, providers: ["not-a-real-provider"] }),
    })
    const res = await POST(req)
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/Unknown provider/)
  })

  it("accepts enabled:true with an empty provider list (feature on, nothing selected yet)", async () => {
    const req = new NextRequest("http://localhost/api/admin/settings/customer-verification", {
      method: "POST",
      body: JSON.stringify({ enabled: true, providers: [] }),
    })
    const res = await POST(req)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.settings).toEqual({ enabled: true, providers: [] })
    expect(upsertMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/api/admin/settings/customer-verification/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the implementation**

```typescript
// app/api/admin/settings/customer-verification/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { listWhitelistProviders, validateProviderSelection } from "@/lib/mtn-providers/provider-whitelist"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"

const SETTING_KEY = "customer_verification_settings"

export async function GET(request: NextRequest) {
  try {
    const settings = await getCustomerVerificationSettings()
    return NextResponse.json({
      success: true,
      settings,
      availableProviders: listWhitelistProviders(),
    })
  } catch (error) {
    console.error("[CUSTOMER-VERIFICATION-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const { enabled, providers } = await request.json()
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "'enabled' must be a boolean" }, { status: 400 })
    }
    if (!Array.isArray(providers)) {
      return NextResponse.json({ error: "'providers' must be an array" }, { status: 400 })
    }

    let validatedProviders: string[] = []
    if (providers.length > 0) {
      const validation = validateProviderSelection(providers)
      if (!validation.valid) {
        return NextResponse.json({ error: validation.error }, { status: 400 })
      }
      validatedProviders = validation.providers
    }

    const newValue = { enabled, providers: validatedProviders }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SETTING_KEY,
        value: newValue,
        description: "Independent, customer-facing live phone-verification preview shown at checkout — separate from the internal fulfillment-time whitelist gate (mtn_whitelist_enabled).",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    return NextResponse.json({ success: true, settings: newValue })
  } catch (error) {
    console.error("[CUSTOMER-VERIFICATION-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/api/admin/settings/customer-verification/route.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/settings/customer-verification/route.ts app/api/admin/settings/customer-verification/route.test.ts
git commit -m "feat(customer-verification): admin settings API route"
```

---

### Task 3: Admin UI card

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

**Interfaces:**
- Consumes: `GET`/`POST /api/admin/settings/customer-verification` (Task 2) — response shapes `{settings: {enabled, providers}, availableProviders: Array<{name, configured}>}` and `{settings: {enabled, providers}}`.

This page already has the exact pattern to copy: `whitelistEnabled` state + `loadWhitelistSetting`/`toggleWhitelist` handlers + a `Card` in the Overview tab (see `lib/mtn-providers/provider-whitelist.ts`'s sibling settings route, mirrored at `app/api/admin/settings/mtn-whitelist/route.ts`). This task adds a second, independent card with a provider checklist alongside the toggle.

- [ ] **Step 1: Add state, near the existing whitelist state (after line 75, `const [togglingWhitelist, setTogglingWhitelist] = useState(false)`)**

```typescript
  const [custVerifyEnabled, setCustVerifyEnabled] = useState(false)
  const [custVerifyProviders, setCustVerifyProviders] = useState<string[]>([])
  const [custVerifyAvailable, setCustVerifyAvailable] = useState<Array<{ name: string; configured: boolean }>>([])
  const [loadingCustVerify, setLoadingCustVerify] = useState(true)
  const [savingCustVerify, setSavingCustVerify] = useState(false)
```

- [ ] **Step 2: Add load + save handlers, right after the existing `toggleWhitelist` function (after line 736)**

```typescript
  const loadCustomerVerificationSetting = async () => {
    try {
      setLoadingCustVerify(true)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/customer-verification", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) {
        const d = await res.json()
        setCustVerifyEnabled(d.settings?.enabled ?? false)
        setCustVerifyProviders(d.settings?.providers ?? [])
        setCustVerifyAvailable(d.availableProviders ?? [])
      }
    } catch (e) { console.error("Error loading customer verification setting:", e) }
    finally { setLoadingCustVerify(false) }
  }

  const saveCustomerVerificationSetting = async (enabled: boolean, providers: string[]) => {
    try {
      setSavingCustVerify(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/customer-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled, providers }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      const d = await res.json()
      setCustVerifyEnabled(d.settings.enabled)
      setCustVerifyProviders(d.settings.providers)
      toast.success("Customer verification settings saved")
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setSavingCustVerify(false) }
  }

  const toggleCustVerifyProvider = (name: string) => {
    const next = custVerifyProviders.includes(name)
      ? custVerifyProviders.filter(p => p !== name)
      : [...custVerifyProviders, name]
    setCustVerifyProviders(next)
    saveCustomerVerificationSetting(custVerifyEnabled, next)
  }
```

- [ ] **Step 3: Call the loader on mount, alongside the existing whitelist loader (find the `useEffect` that calls `loadWhitelistSetting()` and add the new call next to it)**

```typescript
    loadCustomerVerificationSetting()
```

- [ ] **Step 4: Add the UI card, immediately after the existing "MTN Whitelist Verification" card closes (after line 1379, `</Card>`, before the `{/* Info cards */}` comment)**

```tsx
            {/* Customer-Facing Live Verification (independent of the internal whitelist gate above) */}
            <Card className="border-2">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheck className={`h-5 w-5 ${custVerifyEnabled ? "text-success" : "text-muted-foreground"}`} />
                      Live Verification at Checkout
                    </CardTitle>
                    <CardDescription className="mt-1">Shows customers a warning at checkout if their MTN number isn&apos;t verified by any provider selected below. Independent of the whitelist gate above — has its own provider list.</CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    {loadingCustVerify ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
                      <>
                        {savingCustVerify && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        <span className={`text-sm font-medium ${custVerifyEnabled ? "text-success" : "text-muted-foreground"}`}>{custVerifyEnabled ? "Enabled" : "Disabled"}</span>
                        <Switch
                          checked={custVerifyEnabled}
                          onCheckedChange={(checked) => saveCustomerVerificationSetting(checked, custVerifyProviders)}
                          disabled={savingCustVerify || loadingCustVerify}
                        />
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-3">
                  {custVerifyAvailable.map(p => (
                    <label key={p.name} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer ${custVerifyProviders.includes(p.name) ? "border-primary bg-primary/5" : "border-border"} ${!p.configured ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={custVerifyProviders.includes(p.name)}
                        onChange={() => toggleCustVerifyProvider(p.name)}
                        disabled={!p.configured || savingCustVerify}
                      />
                      {p.name}{!p.configured && " (not configured)"}
                    </label>
                  ))}
                </div>
                <Alert className={custVerifyEnabled && custVerifyProviders.length > 0 ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}>
                  <ShieldCheck className={`h-4 w-4 ${custVerifyEnabled && custVerifyProviders.length > 0 ? "text-success" : "text-warning"}`} />
                  <AlertDescription className={custVerifyEnabled && custVerifyProviders.length > 0 ? "text-success" : "text-warning"}>
                    {!custVerifyEnabled
                      ? <><strong>OFF:</strong> Customers never see a verification warning at checkout.</>
                      : custVerifyProviders.length === 0
                      ? <><strong>ON, but no providers selected:</strong> every number is treated as verified until you pick at least one provider above.</>
                      : <><strong>ON:</strong> checking against {custVerifyProviders.join(", ")}. MTN only.</>}
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, sign in as admin, open `/admin/settings/mtn`. Confirm the new "Live Verification at Checkout" card appears below the existing "MTN Whitelist Verification" card, toggling the switch persists across a page reload, and checking/unchecking a provider box persists too.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: 0 errors

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(customer-verification): admin UI toggle and provider selector"
```

---

### Task 4: Public verify-phone-live API route

**Files:**
- Create: `app/api/verify-phone-live/route.ts`
- Test: `app/api/verify-phone-live/route.test.ts`
- Modify: `lib/rate-limit-config.ts`

**Interfaces:**
- Consumes: `checkCustomerFacingVerification()` (Task 1), `applyRateLimit`/`getClientIdentifier` from `@/lib/rate-limiter` (exact signature: `applyRateLimit(request: NextRequest, endpointName: string, maxRequests: number, windowMs: number, userId?: string): Promise<{allowed: boolean, remaining: number, resetAt: number, degraded?: boolean}>`).
- Produces: `POST /api/verify-phone-live` — `{phones: string[]}` → `{results: Array<{phone: string, verified: boolean}>}` — consumed by Tasks 5 and 7 (browser fetch calls).

- [ ] **Step 1: Add the rate limit config entry**

In `lib/rate-limit-config.ts`, inside the `RATE_LIMITS` object, under the "Public endpoints" comment (near `PUBLIC_PACKAGES`), add:

```typescript
    VERIFY_PHONE_LIVE: {
        maxRequests: 20,
        windowMs: 60 * 1000, // 1 minute per IP
        message: 'Too many verification requests. Please wait a moment and try again.',
    },
```

- [ ] **Step 2: Write the failing test**

```typescript
// app/api/verify-phone-live/route.test.ts
import { POST } from "./route"
import { NextRequest } from "next/server"

vi.mock("@/lib/rate-limiter", () => ({
  applyRateLimit: vi.fn(async () => ({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 })),
}))

vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  checkCustomerFacingVerification: vi.fn(async (phones: string[]) =>
    phones.map(phone => ({ phone, verified: phone !== "0559999999" }))
  ),
}))

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/verify-phone-live", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

describe("POST /api/verify-phone-live", () => {
  it("returns per-phone verification results", async () => {
    const res = await POST(makeRequest({ phones: ["0551111111", "0559999999"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0559999999", verified: false },
    ])
  })

  it("rejects a missing phones array with 400", async () => {
    const res = await POST(makeRequest({}))
    expect(res.status).toBe(400)
  })

  it("rejects an empty phones array with 400", async () => {
    const res = await POST(makeRequest({ phones: [] }))
    expect(res.status).toBe(400)
  })

  it("caps the phones array at 100 entries with 400", async () => {
    const res = await POST(makeRequest({ phones: Array.from({ length: 101 }, (_, i) => `055000${i}`) }))
    expect(res.status).toBe(400)
  })

  it("returns 429 when rate limited", async () => {
    const { applyRateLimit } = await import("@/lib/rate-limiter")
    ;(applyRateLimit as any).mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 60000 })
    const res = await POST(makeRequest({ phones: ["0551111111"] }))
    expect(res.status).toBe(429)
  })

  it("fails open (200, all verified) when the check function throws", async () => {
    const { checkCustomerFacingVerification } = await import("@/lib/mtn-providers/customer-verification")
    ;(checkCustomerFacingVerification as any).mockRejectedValueOnce(new Error("db down"))
    const res = await POST(makeRequest({ phones: ["0551111111", "0552222222"] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.results).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: true },
    ])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run app/api/verify-phone-live/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 4: Write the implementation**

```typescript
// app/api/verify-phone-live/route.ts
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { checkCustomerFacingVerification } from "@/lib/mtn-providers/customer-verification"

const MAX_PHONES = 100

export async function POST(request: NextRequest) {
  const rateLimit = await applyRateLimit(
    request,
    "verify_phone_live",
    RATE_LIMITS.VERIFY_PHONE_LIVE.maxRequests,
    RATE_LIMITS.VERIFY_PHONE_LIVE.windowMs
  )
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: RATE_LIMITS.VERIFY_PHONE_LIVE.message }, { status: 429 })
  }

  let phones: unknown
  try {
    const body = await request.json()
    phones = body?.phones
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(phones) || phones.length === 0 || !phones.every(p => typeof p === "string")) {
    return NextResponse.json({ error: "'phones' must be a non-empty array of strings" }, { status: 400 })
  }
  if (phones.length > MAX_PHONES) {
    return NextResponse.json({ error: `'phones' cannot exceed ${MAX_PHONES} entries` }, { status: 400 })
  }

  try {
    const results = await checkCustomerFacingVerification(phones)
    return NextResponse.json({ results })
  } catch (error) {
    // Fail open — a broken verification check must never block checkout.
    console.error("[VERIFY-PHONE-LIVE] Error, failing open:", error)
    return NextResponse.json({ results: phones.map(phone => ({ phone, verified: true })) })
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/api/verify-phone-live/route.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add app/api/verify-phone-live/route.ts app/api/verify-phone-live/route.test.ts lib/rate-limit-config.ts
git commit -m "feat(customer-verification): public rate-limited verify-phone-live endpoint"
```

---

### Task 5: Shop storefront wiring

**Files:**
- Modify: `app/shop/[slug]/page.tsx:336-420` (inside `handleSubmitOrder`)

**Interfaces:**
- Consumes: `POST /api/verify-phone-live` (Task 4).

- [ ] **Step 1: Add a confirmation-dialog state near the component's other `useState` declarations (wherever `submitting` is declared)**

```typescript
  const [verifyWarningOpen, setVerifyWarningOpen] = useState(false)
```

- [ ] **Step 2: Insert the live check right after `const normalizedPhone = phoneResult.normalized` (current line 362) and before `const pkg = selectedPackage.packages` (current line 364)**

```typescript
      if (selectedPackage.packages.network.toUpperCase() === "MTN") {
        try {
          const verifyRes = await fetch("/api/verify-phone-live", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phones: [normalizedPhone] }),
          })
          if (verifyRes.ok) {
            const verifyData = await verifyRes.json()
            const isVerified = verifyData.results?.[0]?.verified !== false
            if (!isVerified) {
              setSubmitting(false)
              setVerifyWarningOpen(true)
              return
            }
          }
        } catch (verifyErr) {
          console.warn("[CHECKOUT] Live verification check failed, proceeding:", verifyErr)
        }
      }

```

- [ ] **Step 3: Add a "Proceed anyway" continuation.** Since `handleSubmitOrder` returns early on step 2 to show the dialog, the actual order-creation logic (current lines 364 onward, everything currently inside the `try` block after the check) needs to be reachable both from the normal path AND from a "Proceed anyway" click. Wrap it in a new function, and call that function from both places. Replace the whole body of `handleSubmitOrder` from `const pkg = selectedPackage.packages` (current line 364) through the end of the function with a call to this extracted function, and define the extracted function right above `handleSubmitOrder`:

```typescript
  const proceedWithOrderCreation = async (normalizedPhone: string) => {
    const pkg = selectedPackage.packages
    const profitAmount = selectedPackage.profit_margin

    const totalPrice = selectedPackage.selling_price !== undefined
      ? selectedPackage.selling_price
      : (pkg.price + profitAmount)

    const basePrice = totalPrice - profitAmount
    const volumeGb = parseInt(pkg.size.toString().replace(/[^0-9]/g, "")) || 0

    console.log("[CHECKOUT] Creating order with details:", {
      shop_slug: shopSlug,
      customer_name: orderData.customer_name,
      customer_email: orderData.customer_email,
      network: pkg.network,
      totalPrice,
    })

    // ... the rest of the existing handleSubmitOrder body, UNCHANGED, starting
    // from the existing `const createOrderResponse = await fetch("/api/shop/orders/create", ...)`
    // call through to the end of the current function (including its existing
    // try/catch/finally structure and the `setSubmitting(false)` in `finally`).
  }

  const handleSubmitOrder = async () => {
    if (!orderData.customer_name.trim()) {
      toast.error("Please enter your name")
      return
    }
    if (!orderData.customer_email.trim()) {
      toast.error("Please enter your email")
      return
    }
    if (!validatePhoneNumberField(orderData.customer_phone, selectedPackage.packages.network, prefixMap)) {
      toast.error("Please enter a valid phone number")
      return
    }

    setSubmitting(true)
    const phoneResult = validatePhoneNumber(orderData.customer_phone, selectedPackage.packages.network, prefixMap)
    if (!phoneResult.isValid) {
      toast.error(phoneResult.error || "Invalid phone number")
      setSubmitting(false)
      return
    }
    const normalizedPhone = phoneResult.normalized

    if (selectedPackage.packages.network.toUpperCase() === "MTN") {
      try {
        const verifyRes = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: [normalizedPhone] }),
        })
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json()
          const isVerified = verifyData.results?.[0]?.verified !== false
          if (!isVerified) {
            setSubmitting(false)
            setVerifyWarningOpen(true)
            return
          }
        }
      } catch (verifyErr) {
        console.warn("[CHECKOUT] Live verification check failed, proceeding:", verifyErr)
      }
    }

    await proceedWithOrderCreation(normalizedPhone)
  }

  const handleProceedAfterWarning = async () => {
    setVerifyWarningOpen(false)
    const phoneResult = validatePhoneNumber(orderData.customer_phone, selectedPackage.packages.network, prefixMap)
    if (!phoneResult.isValid) return
    setSubmitting(true)
    await proceedWithOrderCreation(phoneResult.normalized)
  }
```

**Note for whoever implements this step:** moving the existing body into `proceedWithOrderCreation` must not change any of its existing logic, variable names, or the try/catch/finally structure that manages `setSubmitting(false)` and error toasts — it is a pure extraction. Read the full current `handleSubmitOrder` (lines 336-600) before making this edit so nothing is dropped.

- [ ] **Step 4: Add the warning dialog JSX.** Find where the component's other `<Dialog>` elements are rendered (near the existing checkout dialog) and add:

```tsx
      <Dialog open={verifyWarningOpen} onOpenChange={setVerifyWarningOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Number not yet verified</DialogTitle>
            <DialogDescription>
              This number hasn&apos;t been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until it clears — you&apos;ll receive it automatically once verified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerifyWarningOpen(false)}>Change number</Button>
            <Button onClick={handleProceedAfterWarning}>Proceed anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

Confirm `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` are already imported at the top of the file (they are, for the existing checkout dialog) — if any are missing from the import list, add them from `@/components/ui/dialog`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, open a shop storefront page, select an MTN package, enter a phone number, and submit. With the customer-verification admin toggle OFF (Task 3's default), confirm checkout proceeds exactly as before with no dialog ever appearing. This is the primary regression check for this task — the whole existing checkout flow must work unchanged when the feature is off.

- [ ] **Step 7: Commit**

```bash
git add "app/shop/[slug]/page.tsx"
git commit -m "feat(customer-verification): wire live check into shop storefront checkout"
```

---

### Task 6: Dashboard individual purchase wiring

**Files:**
- Modify: `app/dashboard/data-packages/page.tsx:256-300` (inside `handlePhoneNumberSubmit`)

**Interfaces:**
- Consumes: `POST /api/verify-phone-live` (Task 4).

- [ ] **Step 1: Add a confirmation-dialog state near the component's other `useState` declarations**

```typescript
  const [verifyWarningOpen, setVerifyWarningOpen] = useState(false)
  const [pendingPhoneNumber, setPendingPhoneNumber] = useState<string | null>(null)
```

- [ ] **Step 2: Insert the live check inside `handlePhoneNumberSubmit`, right after the existing `phoneCheck.isValid` guard (current lines 264-268) and before `setPurchasing(selectedPackageForPurchase.id)` (current line 271)**

```typescript
    if (selectedPackageForPurchase.network.toUpperCase() === "MTN") {
      try {
        const verifyRes = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: [phoneNumber] }),
        })
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json()
          const isVerified = verifyData.results?.[0]?.verified !== false
          if (!isVerified) {
            setPendingPhoneNumber(phoneNumber)
            setVerifyWarningOpen(true)
            return
          }
        }
      } catch (verifyErr) {
        console.warn("[DATA-PACKAGES] Live verification check failed, proceeding:", verifyErr)
      }
    }

```

- [ ] **Step 3: Add the "Proceed anyway" continuation handler, right after `handlePhoneNumberSubmit`'s closing brace**

```typescript
  const handleProceedAfterVerifyWarning = async () => {
    setVerifyWarningOpen(false)
    if (pendingPhoneNumber) {
      const phone = pendingPhoneNumber
      setPendingPhoneNumber(null)
      await handlePhoneNumberSubmit(phone)
    }
  }
```

**Note for whoever implements this step:** this re-invokes `handlePhoneNumberSubmit` with the same phone number. Since the MTN network check + `/api/verify-phone-live` call runs again, and the (already-shown-once) warning would just fire again, add a guard parameter to skip the re-check on this second pass — change `handlePhoneNumberSubmit`'s signature to `handlePhoneNumberSubmit(phoneNumber: string, skipVerification = false)` and wrap the Step 2 block in `if (!skipVerification && selectedPackageForPurchase.network.toUpperCase() === "MTN") { ... }`, then call `handlePhoneNumberSubmit(phone, true)` from `handleProceedAfterVerifyWarning` above.

- [ ] **Step 4: Add the warning dialog JSX**, near the existing `PhoneNumberModal` usage:

```tsx
      <Dialog open={verifyWarningOpen} onOpenChange={setVerifyWarningOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Number not yet verified</DialogTitle>
            <DialogDescription>
              This number hasn&apos;t been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until it clears — you&apos;ll receive it automatically once verified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setVerifyWarningOpen(false); setPendingPhoneNumber(null) }}>Change number</Button>
            <Button onClick={handleProceedAfterVerifyWarning}>Proceed anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

Add the `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` import from `@/components/ui/dialog` if not already present in this file.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, sign in, go to `/dashboard/data-packages`, purchase an MTN package. With the feature toggle OFF, confirm the purchase flow is unchanged.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/data-packages/page.tsx
git commit -m "feat(customer-verification): wire live check into dashboard individual purchase"
```

---

### Task 7: Dashboard bulk-paste form wiring

**Files:**
- Modify: `components/bulk-orders-form.tsx:457-516` (`handleConfirmSubmission`)

**Interfaces:**
- Consumes: `POST /api/verify-phone-live` (Task 4), accepting a `phones` array of more than one entry.

- [ ] **Step 1: Add state for the batch warning dialog, near the component's other `useState` declarations (after `const [walletBalance, setWalletBalance] = useState<number | null>(null)`)**

```typescript
  const [batchVerifyWarning, setBatchVerifyWarning] = useState<{
    unverifiedPhones: string[]
    ordersToSubmit: ValidationResult["orders"]
    networkLabel: string
  } | null>(null)
```

- [ ] **Step 2: Extract the actual submission call into its own function.** Replace the current `handleConfirmSubmission` (lines 457-516) with two functions — the extracted submitter, and a slimmer `handleConfirmSubmission` that runs the live check first:

```typescript
  const submitBulkOrders = async (ordersToSubmit: ValidationResult["orders"], networkLabel: string) => {
    setIsSubmitting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token || !session.user?.id) {
        throw new Error("Not authenticated")
      }

      const response = await fetch("/api/orders/create-bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          orders: ordersToSubmit.map(o => ({
            phone_number: o.phone,
            volume_gb: o.volume,
            price: o.price,
          })),
          network: networkLabel,
        }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || "Failed to submit orders")
      }

      toast.success(`Successfully created ${data.count} orders!`)
      setShowSummary(false)
      setBatchVerifyWarning(null)
      setValidationResults(null)
      setTextInput("")
      setSelectedNetwork("")
      setWalletBalance(null)

      console.log("Orders created:", data.orders)
    } catch (error) {
      console.error("Error submitting orders:", error)
      toast.error(error instanceof Error ? error.message : "Failed to submit orders")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleConfirmSubmission = async () => {
    if (!validationResults) return

    const validOrders = validationResults.orders.filter(o => o.status === "valid")
    const selectedNetworkLabel = networks.find(n => n.id === selectedNetwork)?.label
    if (!selectedNetworkLabel) {
      toast.error("Invalid network selected")
      return
    }

    if (selectedNetworkLabel.toUpperCase() === "MTN" && validOrders.length > 0) {
      try {
        const verifyRes = await fetch("/api/verify-phone-live", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phones: validOrders.map(o => o.phone) }),
        })
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json()
          const results: Array<{ phone: string; verified: boolean }> = verifyData.results ?? []
          const unverifiedPhones = results.filter(r => !r.verified).map(r => r.phone)
          if (unverifiedPhones.length > 0) {
            setBatchVerifyWarning({ unverifiedPhones, ordersToSubmit: validOrders, networkLabel: selectedNetworkLabel })
            return
          }
        }
      } catch (verifyErr) {
        console.warn("[BULK-ORDERS] Live verification check failed, proceeding:", verifyErr)
      }
    }

    await submitBulkOrders(validOrders, selectedNetworkLabel)
  }
```

- [ ] **Step 3: Add the three-way batch warning dialog**, near the existing summary `Dialog` in this component's JSX (find the existing `<Dialog open={showSummary} ...>` block and add this as a sibling):

```tsx
      <Dialog open={!!batchVerifyWarning} onOpenChange={(open) => { if (!open) setBatchVerifyWarning(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{batchVerifyWarning?.unverifiedPhones.length} number(s) not yet verified</DialogTitle>
            <DialogDescription>
              The following numbers haven&apos;t been verified yet: {batchVerifyWarning?.unverifiedPhones.join(", ")}.
              Orders for these may be delayed until they clear — they&apos;ll still be delivered automatically once verified.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setBatchVerifyWarning(null)}>Cancel</Button>
            <Button
              variant="outline"
              disabled={
                !batchVerifyWarning ||
                batchVerifyWarning.ordersToSubmit.length === batchVerifyWarning.unverifiedPhones.length
              }
              onClick={() => {
                if (!batchVerifyWarning) return
                const filtered = batchVerifyWarning.ordersToSubmit.filter(
                  o => !batchVerifyWarning.unverifiedPhones.includes(o.phone)
                )
                submitBulkOrders(filtered, batchVerifyWarning.networkLabel)
              }}
            >
              Remove unverified &amp; submit rest
            </Button>
            <Button
              onClick={() => {
                if (!batchVerifyWarning) return
                submitBulkOrders(batchVerifyWarning.ordersToSubmit, batchVerifyWarning.networkLabel)
              }}
            >
              Proceed with all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

The "Remove unverified & submit rest" button is disabled when every order in the batch is unverified (filtering would leave zero orders to submit) — matches the spec's requirement not to submit an empty batch.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, sign in, use the bulk order form on the dashboard home page, paste several MTN numbers, validate, and confirm submission. With the feature toggle OFF, confirm the flow is completely unchanged (no dialog, submits immediately as today).

- [ ] **Step 6: Commit**

```bash
git add components/bulk-orders-form.tsx
git commit -m "feat(customer-verification): wire live check into bulk-paste order form with 3-way batch dialog"
```

---

### Task 8: Dealer API wiring

**Files:**
- Modify: `app/api/v1/orders/route.ts:225-292`

**Interfaces:**
- Consumes: `checkCustomerFacingVerification()` (Task 1), called directly server-side.

- [ ] **Step 1: Insert the check right before the final `return NextResponse.json(...)` (current line 279), after the MTN/non-MTN fulfillment-trigger block (current lines 225-277)**

```typescript
  let verificationWarning = false
  if (normalizedNetwork === "mtn") {
    try {
      const { checkCustomerFacingVerification } = await import("@/lib/mtn-providers/customer-verification")
      const [result] = await checkCustomerFacingVerification([normalizePhoneNumber(cleanRecipient)])
      verificationWarning = result ? !result.verified : false
    } catch (err) {
      console.error("[API v1] Live verification check error (failing open):", err)
      verificationWarning = false
    }
  }

```

- [ ] **Step 2: Add the field to the response object.** Modify the existing final return statement (current lines 279-292) to include it:

```typescript
  return NextResponse.json({
    success: true,
    message: "Order placed successfully",
    order: {
      id: orderId,
      reference,
      network: sanitizedNetwork,
      volume_gb: volumeGb,
      price: orderPrice,
      recipient: cleanRecipient,
      status: "pending",
      created_at: orderCreatedAt,
    },
    verification_warning: verificationWarning,
  }, { status: 201 })
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all existing tests + the new ones from Tasks 1, 2, 4)

- [ ] **Step 5: Manual verification**

Use `curl` or an existing dealer API test call against a local dev server to place an MTN order and confirm the response includes `"verification_warning": false` (with the admin toggle OFF, per Task 3's default). Confirm the field's absence never breaks anything for dealers who don't look at it (it's purely additive to the response shape).

- [ ] **Step 6: Commit**

```bash
git add app/api/v1/orders/route.ts
git commit -m "feat(customer-verification): add verification_warning field to dealer API order response"
```

---

## Self-Review Notes

**Spec coverage:** §1 (shared backend check) → Task 1. §2 (public API route) → Task 4. §3 (admin settings + UI) → Tasks 2-3. §4 (shop storefront) → Task 5. §5 (dashboard individual purchase) → Task 6. §6 (dashboard bulk-paste) → Task 7. §7 (dealer API) → Task 8. §8 (error handling / fail-open) → covered inline in every task (Task 1's provider-level try/catch, Task 4's route-level catch-all, Tasks 5-7's frontend try/catch around the fetch, Task 2's settings-read default). §9 (testing) → Tasks 1, 2, 4 have full unit/integration test coverage; Tasks 3, 5-8 are manually verified per the plan's own stated convention (matches how this codebase already tests its other UI checkout flows and its existing admin-settings UI).

**Global Constraints check:** MTN-only gating appears in every call site (Task 5's `selectedPackage.packages.network.toUpperCase() === "MTN"`, Task 6's `selectedPackageForPurchase.network.toUpperCase() === "MTN"`, Task 7's `selectedNetworkLabel.toUpperCase() === "MTN"`, Task 8's existing `normalizedNetwork === "mtn"`). Fail-open appears at every layer per Task 1's tests, Task 4's catch-all, and Tasks 5-8's try/catch wrapping every fetch/call. No new table or cron anywhere in this plan. The new setting key (`customer_verification_settings`) never overlaps with `mtn_whitelist_enabled`. Warning copy is verbatim-identical in Tasks 5 and 6; Task 7's batch-appropriate variant preserves the same core promise ("still be delivered automatically once verified").

**Type consistency:** `checkCustomerFacingVerification(phones: string[], registry?, settings?): Promise<Array<{phone: string, verified: boolean}>>` (Task 1) is called identically by Task 2 (indirectly, via the settings route which doesn't call it), Task 4's route (`checkCustomerFacingVerification(phones)`), and Task 8 (`checkCustomerFacingVerification([normalizePhoneNumber(cleanRecipient)])`) — same name, same return shape, destructured consistently (`result.verified`, `r.verified`) everywhere it's consumed. The public route's response shape `{results: Array<{phone, verified}>}` is consumed identically in Tasks 5, 6, and 7 (`verifyData.results?.[0]?.verified` for single-phone call sites, `verifyData.results` iterated for Task 7's batch). `CustomerVerificationSettings = {enabled: boolean, providers: string[]}` (Task 1) matches exactly what Task 2's route reads/writes and what Task 3's UI state (`custVerifyEnabled`, `custVerifyProviders`) mirrors.
