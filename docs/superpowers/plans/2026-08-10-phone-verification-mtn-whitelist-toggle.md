# Phone Verification MTN Whitelist Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second check method — MTN whitelist status (can this number currently receive an MTN data order) — to `/admin/phone-verification`, selectable via a toggle, reusing the existing upload/progress/history/export flow that today only runs a Moolre account-name check.

**Architecture:** A new `check_type` column on `phone_verification_sessions` (`'moolre' | 'mtn_whitelist'`) picks which of two processors handles a session's pending rows: the existing Moolre processor (untouched) or a new whitelist processor built on the existing `lib/mtn-providers/provider-whitelist.ts` registry (Xpress/CodeCraft/AgentPortalGH). A shared `checkWhitelistBatch()` function is extracted from the existing `mtn-whitelist/batch-verify` route so both that route and the new processor use identical provider-fallback logic. Every MTN number checked also upserts `mtn_number_registry` (the table that gates live order fulfillment), so a bulk verify here also warms the live gating data.

**Tech Stack:** Next.js 15 App Router API routes, Supabase (service-role client), Vitest.

## Global Constraints

- Toggle is per-session (whole upload batch uses one check method), not per-number and not "both at once."
- Whitelist check tries providers in registry order (Xpress → CodeCraft → AgentPortalGH) and stops at the first `allowed: true` — no full-breakdown mode.
- Whitelist and Moolre results share `phone_verification_sessions` / `phone_verification_results` (tagged by `check_type`), not separate tables.
- Dedupe is scoped per check type: a number checked under one type is always fresh under the other.
- Whitelist dedupe is time-boxed to 24h (keyed off `mtn_number_registry.whitelist_last_checked`), not permanent like Moolre's.
- Non-MTN and unrecognized-network numbers in whitelist mode never call a provider — they resolve to a new `not_applicable` status.
- Every MTN number actually checked (allowed or blocked) upserts `mtn_number_registry` (`whitelist_status`, `whitelist_allowed_by`, `whitelist_last_checked`), inserting a new registry row if the number wasn't tracked before.
- **Deviation from the approved spec, discovered while reading the actual provider code**: `checkXpressBatch`/`checkCodecraftBatch`/`checkAgentPortalGHBatch` (in `lib/mtn-providers/provider-whitelist.ts`) already swallow network/API errors into `allowed: true` (fail-open) — there is no way for a caller to distinguish "provider said yes" from "provider errored, defaulted to yes." The spec's item 5 ("all providers error → row stays pending for retry") is therefore not implementable without changing that fail-open contract, which is shared by live order fulfillment (`lib/mtn-fulfillment.ts`) and is out of scope to change here. This plan keeps the existing system-wide fail-open behavior instead: an errored provider call resolves exactly like a real "allowed" response, everywhere in this codebase, including here.
- Export keeps the existing "only `status = 'verified'` rows" convention for both check types.

---

### Task 1: Migration — schema changes

**Files:**
- Create: `migrations/0094_phone_verification_whitelist_check.sql`

**Interfaces:**
- Produces: `phone_verification_sessions.check_type` (`'moolre' | 'mtn_whitelist'`, default `'moolre'`), `phone_verification_sessions.not_applicable_count` (int, default 0), `phone_verification_results.whitelist_provider` (text, nullable). All later tasks read/write these exact column names.

- [ ] **Step 1: Write the migration**

```sql
-- Adds MTN-whitelist check support to the existing phone-verification tables.
-- check_type distinguishes a Moolre account-name session from an MTN
-- whitelist-eligibility session (both share the same results table).
-- not_applicable_count tracks numbers skipped in whitelist mode because they
-- aren't MTN (or the network couldn't be determined) — kept as its own
-- column, mirroring verified_count/invalid_count, so "duplicate" can still be
-- derived by subtraction without conflating it with "not applicable."
-- whitelist_provider records which provider (xpress|codecraft|agentportalgh)
-- allowed a number in a whitelist session; stays null for Moolre rows and for
-- blocked/not-applicable whitelist rows.
ALTER TABLE phone_verification_sessions
  ADD COLUMN IF NOT EXISTS check_type TEXT NOT NULL DEFAULT 'moolre'
    CHECK (check_type IN ('moolre', 'mtn_whitelist')),
  ADD COLUMN IF NOT EXISTS not_applicable_count INT NOT NULL DEFAULT 0;

ALTER TABLE phone_verification_results
  ADD COLUMN IF NOT EXISTS whitelist_provider TEXT;
```

- [ ] **Step 2: Apply the migration**

Run it against the live Supabase project via the Management API SQL endpoint (see `reference-supabase-access` memory for the exact `POST /v1/projects/{ref}/database/query` pattern used throughout this codebase's other migrations) or however this project's migrations are normally applied. Verify with:

```sql
select column_name, data_type, column_default from information_schema.columns
where table_name = 'phone_verification_sessions' and column_name in ('check_type', 'not_applicable_count');

select column_name, data_type from information_schema.columns
where table_name = 'phone_verification_results' and column_name = 'whitelist_provider';
```

Expected: 2 rows from the first query, 1 row from the second.

- [ ] **Step 3: Commit**

```bash
git add migrations/0094_phone_verification_whitelist_check.sql
git commit -m "feat(phone-verification): add check_type/not_applicable_count/whitelist_provider columns"
```

---

### Task 2: Extract shared `checkWhitelistBatch()` and refactor `batch-verify`

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts`
- Modify: `app/api/admin/mtn-whitelist/batch-verify/route.ts`
- Create: `lib/mtn-providers/provider-whitelist.test.ts`

**Interfaces:**
- Produces: `export type WhitelistEntry` (was already defined, now exported), `export async function checkWhitelistBatch(msisdns: string[], registry?: WhitelistEntry[]): Promise<Map<string, { allowed: boolean; allowedBy?: string }>>`. Task 4's whitelist processor calls this exact function/signature.

This also fixes a real bug found while reading the existing route: `batch-verify`'s current inline loop never writes `whitelist_allowed_by` when marking a number allowed — only `whitelist_status`/`whitelist_last_checked`/`whitelist_retry_count`. The refactor fixes this as a natural side effect of using the new function's per-provider attribution.

- [ ] **Step 1: Write the failing test**

Create `lib/mtn-providers/provider-whitelist.test.ts`:

```ts
import { checkWhitelistBatch, type WhitelistEntry } from "./provider-whitelist"

function fakeEntry(name: string, allowedSet: Set<string>, configured = true): WhitelistEntry {
  return {
    name,
    configured: () => configured,
    check: async (msisdn) => ({ allowed: allowedSet.has(msisdn), provider: name }),
    checkBatch: async (msisdns) => msisdns.map(m => ({ msisdn: m, allowed: allowedSet.has(m) })),
  }
}

describe("checkWhitelistBatch", () => {
  it("allows a number via the first provider that says yes", async () => {
    const registry = [
      fakeEntry("xpress", new Set(["0551111111"])),
      fakeEntry("codecraft", new Set(["0552222222"])),
    ]
    const result = await checkWhitelistBatch(["0551111111", "0552222222"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "xpress" })
    expect(result.get("0552222222")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("falls through to the next provider when the first denies", async () => {
    const registry = [
      fakeEntry("xpress", new Set()),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("marks a number blocked when every configured provider denies it", async () => {
    const registry = [fakeEntry("xpress", new Set()), fakeEntry("codecraft", new Set())]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: false })
  })

  it("skips unconfigured providers entirely", async () => {
    const registry = [
      fakeEntry("xpress", new Set(["0551111111"]), false),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("does not call a later provider once every number is already allowed", async () => {
    let secondProviderCalled = false
    const registry: WhitelistEntry[] = [
      fakeEntry("xpress", new Set(["0551111111"])),
      {
        name: "codecraft",
        configured: () => true,
        check: async () => ({ allowed: false, provider: "codecraft" }),
        checkBatch: async (msisdns) => {
          secondProviderCalled = true
          return msisdns.map(m => ({ msisdn: m, allowed: false }))
        },
      },
    ]
    await checkWhitelistBatch(["0551111111"], registry)
    expect(secondProviderCalled).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts`
Expected: FAIL — `checkWhitelistBatch` is not exported.

- [ ] **Step 3: Implement — export `WhitelistEntry` and add `checkWhitelistBatch`**

In `lib/mtn-providers/provider-whitelist.ts`, change the existing local type declaration (around line 145) from:

```ts
type WhitelistEntry = {
```

to:

```ts
export type WhitelistEntry = {
```

Then add this new function immediately after `hasWhitelistProviders()` (after line 221, before the "Batch helpers" comment block):

```ts
/**
 * Check a batch of numbers against every configured whitelist provider,
 * stopping at the first provider that allows each number (mirrors
 * checkWhitelistForOrder's precedence, batched for bulk use).
 *
 * Unlike checkWhitelistForOrder, this does NOT filter out fulfillment-disabled
 * providers — it answers "is this number allowed by ANY whitelist-capable
 * provider we have credentials for," independent of which provider
 * fulfillment currently prefers.
 *
 * Callers must ensure at least one provider is configured first (see
 * hasWhitelistProviders()) — with none configured this returns every number
 * as not allowed rather than failing open, since bulk reporting must never
 * claim a check happened when it didn't.
 */
export async function checkWhitelistBatch(
  msisdns: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): Promise<Map<string, { allowed: boolean; allowedBy?: string }>> {
  const result = new Map<string, { allowed: boolean; allowedBy?: string }>()
  msisdns.forEach(m => result.set(m, { allowed: false }))

  const configured = registry.filter(p => p.configured())
  for (const entry of configured) {
    const toCheck = msisdns.filter(m => !result.get(m)!.allowed)
    if (toCheck.length === 0) break
    const batchResults = await entry.checkBatch(toCheck)
    for (const r of batchResults) {
      if (r.allowed) result.set(r.msisdn, { allowed: true, allowedBy: entry.name })
    }
  }

  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts`
Expected: PASS — 5/5 tests.

- [ ] **Step 5: Refactor `batch-verify/route.ts` to use `checkWhitelistBatch`**

Replace the whole body of `app/api/admin/mtn-whitelist/batch-verify/route.ts` with:

```ts
// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// all configured whitelist providers (Xpress, Codecraft, AgentPortalGH).
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, providers?: "xpress,codecraft,agentportalgh" (comma-separated, default = all configured) }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY, checkWhitelistBatch } from "@/lib/mtn-providers/provider-whitelist"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({}))
  const offset = Number(body.offset ?? 0)
  const limit = Number(body.limit ?? 1000)
  // Optional filter: only run specific providers (comma-separated names), default = all configured
  const providerFilter: string[] = body.providers
    ? String(body.providers).split(",").map((s: string) => s.trim())
    : []

  const configuredProviders = WHITELIST_REGISTRY.filter(
    p => p.configured() && (providerFilter.length === 0 || providerFilter.includes(p.name))
  )
  if (configuredProviders.length === 0) {
    return NextResponse.json({ error: "No whitelist providers configured" }, { status: 400 })
  }

  // Fetch a page of numbers to verify
  const { data: rows, error, count } = await supabase
    .from("mtn_number_registry")
    .select("phone", { count: "exact" })
    .range(offset, offset + limit - 1)
    .order("phone")

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const phones = (rows ?? []).map(r => r.phone as string)
  if (phones.length === 0) return NextResponse.json({ ok: true, done: true, total: count ?? 0 })

  const results = await checkWhitelistBatch(phones, configuredProviders)

  const now = new Date().toISOString()
  const allowedPhones: string[] = []
  const blockedPhones: string[] = []
  // Group allowed phones by which provider allowed them so whitelist_allowed_by
  // is recorded per number (the previous inline loop never set this column).
  const allowedByProvider = new Map<string, string[]>()

  for (const phone of phones) {
    const r = results.get(phone)
    if (r?.allowed) {
      allowedPhones.push(phone)
      const provider = r.allowedBy ?? "unknown"
      if (!allowedByProvider.has(provider)) allowedByProvider.set(provider, [])
      allowedByProvider.get(provider)!.push(phone)
    } else {
      blockedPhones.push(phone)
    }
  }

  for (const [provider, phonesForProvider] of allowedByProvider) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "allowed", whitelist_allowed_by: provider, whitelist_last_checked: now, whitelist_retry_count: 0 })
      .in("phone", phonesForProvider)
  }
  if (blockedPhones.length > 0) {
    await supabase.from("mtn_number_registry")
      .update({ whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_last_checked: now, whitelist_retry_count: 0 })
      .in("phone", blockedPhones)
  }

  const total = count ?? 0
  const nextOffset = offset + phones.length
  const done = nextOffset >= total

  return NextResponse.json({
    ok: true,
    done,
    processed: phones.length,
    allowed: allowedPhones.length,
    blocked: blockedPhones.length,
    nextOffset,
    total,
  })
}
```

- [ ] **Step 6: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: all tests pass (no test file exercises `batch-verify/route.ts` directly today, so this step is a safety net for anything that imports `provider-whitelist.ts`).

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-providers/provider-whitelist.ts lib/mtn-providers/provider-whitelist.test.ts app/api/admin/mtn-whitelist/batch-verify/route.ts
git commit -m "refactor(mtn-whitelist): extract checkWhitelistBatch, fix missing whitelist_allowed_by write"
```

---

### Task 3: Extracted upload logic (`lib/phone-verify-upload.ts`) + rewritten upload route

**Files:**
- Create: `lib/phone-verify-upload.ts`
- Create: `lib/phone-verify-upload.test.ts`
- Modify: `app/api/admin/phone-verify/upload/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `detectNetworkWithMap(phone, map)` and `DEFAULT_NETWORK_PREFIXES`/`NetworkPrefixMap` from `lib/phone-format.ts` (already exist); `getPrefixValidationConfig()` from `lib/network-prefix-config.ts` (already exists); `hasWhitelistProviders()` from `lib/mtn-providers/provider-whitelist.ts` (already exists, exported).
- Produces: `findExistingMoolreNumbers(supabase, candidates)`, `findRecentWhitelistChecks(supabase, candidates)`, `buildMoolreRows(phones, existing)`, `buildWhitelistRows(phones, recent)`, all exported from `lib/phone-verify-upload.ts`. The route (this task) and no later task call these directly, but they are the toolkit any future upload-path change should extend.

This task also fixes a real accuracy bug found while reading the code: the current `detectNetwork()` inline in `upload/route.ts` hardcodes `["024", "025", "054", "055", "059"]` as MTN prefixes, missing `053` — which the canonical, admin-editable `DEFAULT_NETWORK_PREFIXES.MTN` (`lib/phone-format.ts`) already includes. This only mattered cosmetically for Moolre (its processor coerces `UNKNOWN` to `MTN` anyway), but whitelist mode skips non-MTN numbers outright, so a `053` number would be wrongly skipped as `not_applicable` without this fix.

- [ ] **Step 1: Write the failing tests**

Create `lib/phone-verify-upload.test.ts`:

```ts
import {
  findExistingMoolreNumbers,
  findRecentWhitelistChecks,
  buildMoolreRows,
  buildWhitelistRows,
} from "./phone-verify-upload"

function fakeSupabase(rows: any[]) {
  return {
    from() {
      return {
        select() {
          return {
            in() { return this },
            gte() { return this },
            order() { return this },
            range: () => Promise.resolve({ data: rows, error: null }),
          }
        },
      }
    },
  } as any
}

describe("findExistingMoolreNumbers", () => {
  it("maps a phone to the best (non-null) account name seen across rows", async () => {
    const fake = fakeSupabase([
      { phone_number: "0551111111", account_name: null },
      { phone_number: "0551111111", account_name: "Kwame Doe" },
    ])
    const result = await findExistingMoolreNumbers(fake, ["0551111111"])
    expect(result.get("0551111111")).toBe("Kwame Doe")
  })

  it("does not include numbers with no history", async () => {
    const fake = fakeSupabase([])
    const result = await findExistingMoolreNumbers(fake, ["0559999999"])
    expect(result.has("0559999999")).toBe(false)
  })
})

describe("findRecentWhitelistChecks", () => {
  it("only includes rows with a resolved allowed/blocked status", async () => {
    const fake = fakeSupabase([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_last_checked: "2026-08-10T00:00:00Z" },
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0551111111", "0552222222"])
    expect(result.get("0551111111")).toEqual({ status: "allowed", allowedBy: "xpress" })
    expect(result.get("0552222222")).toEqual({ status: "blocked", allowedBy: null })
  })
})

describe("buildMoolreRows", () => {
  it("marks a known number duplicate with its remembered name", () => {
    const rows = buildMoolreRows(
      [{ phone: "0551111111", network: "MTN" }],
      new Map([["0551111111", "Kwame Doe"]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", account_name: "Kwame Doe", whitelist_provider: null })
  })

  it("marks a new number pending with no name", () => {
    const rows = buildMoolreRows([{ phone: "0552222222", network: "MTN" }], new Map())
    expect(rows[0]).toMatchObject({ status: "pending", account_name: null })
  })
})

describe("buildWhitelistRows", () => {
  it("marks a recently-allowed number duplicate, carrying the provider", () => {
    const rows = buildWhitelistRows(
      [{ phone: "0551111111", network: "MTN" }],
      new Map([["0551111111", { status: "allowed" as const, allowedBy: "xpress" }]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", whitelist_provider: "xpress" })
  })

  it("marks a recently-blocked number duplicate with no provider", () => {
    const rows = buildWhitelistRows(
      [{ phone: "0552222222", network: "MTN" }],
      new Map([["0552222222", { status: "blocked" as const, allowedBy: null }]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", whitelist_provider: null })
  })

  it("marks an unchecked/stale number pending regardless of network", () => {
    const rows = buildWhitelistRows([{ phone: "0553333333", network: "TELECEL" }], new Map())
    expect(rows[0]).toMatchObject({ status: "pending", whitelist_provider: null })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/phone-verify-upload.test.ts`
Expected: FAIL — `lib/phone-verify-upload.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/phone-verify-upload.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js"

export const WHITELIST_FRESHNESS_MS = 24 * 60 * 60 * 1000

/**
 * Numbers already seen in a PRIOR Moolre session (from ANY session, no time
 * limit — a MoMo account name doesn't go stale), mapped to the best account
 * name previously seen for that number (null if only ever invalid/pending).
 */
export async function findExistingMoolreNumbers(
  supabase: SupabaseClient,
  candidates: string[]
): Promise<Map<string, string | null>> {
  const existing = new Map<string, string | null>()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("phone_verification_results")
        .select("phone_number, account_name")
        .in("phone_number", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`Duplicate lookup failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        if (!existing.has(row.phone_number) || (row.account_name && existing.get(row.phone_number) == null)) {
          existing.set(row.phone_number, row.account_name ?? null)
        }
      }
      if (data.length < 1000) break
      from += 1000
    }
  }
  return existing
}

/**
 * Numbers whose MTN whitelist status was checked within the last 24h — see
 * WHITELIST_FRESHNESS_MS. Unlike Moolre account names, whitelist status is
 * time-varying (that's why the 24h retry cron exists), so only a RECENT
 * check counts as "already known" — an older or missing one is treated as
 * unchecked. mtn_number_registry.phone is unique, so unlike
 * findExistingMoolreNumbers this never needs inner pagination per chunk.
 */
export async function findRecentWhitelistChecks(
  supabase: SupabaseClient,
  candidates: string[]
): Promise<Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>> {
  const result = new Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>()
  const cutoff = new Date(Date.now() - WHITELIST_FRESHNESS_MS).toISOString()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_status, whitelist_allowed_by, whitelist_last_checked")
      .in("phone", chunk)
      .gte("whitelist_last_checked", cutoff)
    if (error) throw new Error(`Whitelist freshness lookup failed: ${error.message}`)
    for (const row of data ?? []) {
      if (row.whitelist_status === "allowed" || row.whitelist_status === "blocked") {
        result.set(row.phone, { status: row.whitelist_status, allowedBy: row.whitelist_allowed_by })
      }
    }
  }
  return result
}

export interface VerificationRowInput {
  phone: string
  network: string
}

export interface VerificationRow {
  phone_number: string
  network: string
  account_name: string | null
  status: "pending" | "duplicate"
  whitelist_provider: string | null
}

/** Builds insertable phone_verification_results rows for a Moolre session. */
export function buildMoolreRows(
  phones: VerificationRowInput[],
  existing: Map<string, string | null>
): VerificationRow[] {
  return phones.map(({ phone, network }) => {
    const isDuplicate = existing.has(phone)
    return {
      phone_number: phone,
      network,
      account_name: isDuplicate ? (existing.get(phone) ?? null) : null,
      status: isDuplicate ? "duplicate" : "pending",
      whitelist_provider: null,
    }
  })
}

/**
 * Builds insertable phone_verification_results rows for an MTN-whitelist
 * session. Network filtering (MTN vs not_applicable) happens later, during
 * processing — every non-duplicate number is queued "pending" here,
 * regardless of network.
 */
export function buildWhitelistRows(
  phones: VerificationRowInput[],
  recent: Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>
): VerificationRow[] {
  return phones.map(({ phone, network }) => {
    const recentCheck = recent.get(phone)
    if (recentCheck) {
      return {
        phone_number: phone,
        network,
        account_name: null,
        status: "duplicate",
        whitelist_provider: recentCheck.allowedBy,
      }
    }
    return {
      phone_number: phone,
      network,
      account_name: null,
      status: "pending",
      whitelist_provider: null,
    }
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/phone-verify-upload.test.ts`
Expected: PASS — 8/8 tests.

- [ ] **Step 5: Rewrite `app/api/admin/phone-verify/upload/route.ts`**

Replace the entire file with:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhoneNumber } from "@/lib/phone-validation"
import { detectNetworkWithMap } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { hasWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"
import {
  findExistingMoolreNumbers,
  findRecentWhitelistChecks,
  buildMoolreRows,
  buildWhitelistRows,
} from "@/lib/phone-verify-upload"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_FILE_SIZE = 50 * 1024 * 1024

function extractPhoneColumn(rows: string[][]): string[] {
  if (rows.length === 0) return []
  const header = rows[0].map(h => h.toLowerCase().trim())
  const phoneCol = header.findIndex(h => h.includes("phone"))
  const col = phoneCol >= 0 ? phoneCol : 0
  const dataRows = phoneCol >= 0 ? rows.slice(1) : rows
  return dataRows.map(r => String(r[col] ?? "").trim()).filter(Boolean)
}

async function fileToPhoneLines(file: File): Promise<string[]> {
  if (file.name.match(/\.xlsx?$/i)) {
    const { read, utils } = await import("xlsx")
    const buf = await file.arrayBuffer()
    const wb = read(buf, { type: "array" })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" })
    return extractPhoneColumn(rows as string[][])
  }
  const text = await file.text()
  const rows = text.split(/[\r\n]+/).map(line => line.split(",").map(c => c.trim()))
  return extractPhoneColumn(rows)
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const formData = await request.formData()
    const file = formData.get("file") as File | null
    const checkType = formData.get("checkType") === "mtn_whitelist" ? "mtn_whitelist" : "moolre"

    if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 })
    if (file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "File exceeds 50 MB limit" }, { status: 400 })
    if (!file.name.match(/\.(csv|xlsx|xls)$/i)) {
      return NextResponse.json({ error: "Only .csv and .xlsx files are supported" }, { status: 400 })
    }

    if (checkType === "mtn_whitelist" && !hasWhitelistProviders()) {
      return NextResponse.json(
        { error: "No MTN whitelist provider is configured (Xpress/CodeCraft/AgentPortalGH)" },
        { status: 400 }
      )
    }

    const phoneLines = await fileToPhoneLines(file)
    if (phoneLines.length === 0) return NextResponse.json({ error: "No phone numbers found in file" }, { status: 400 })

    const phones = [...new Set(phoneLines.map(normalizeGhanaPhoneNumber).filter(p => p.length >= 9))]

    const { map: prefixMap } = await getPrefixValidationConfig()
    const phoneInputs = phones.map(phone => ({ phone, network: detectNetworkWithMap(phone, prefixMap) }))

    let rows: ReturnType<typeof buildMoolreRows>
    let duplicates: number

    if (checkType === "mtn_whitelist") {
      const recent = await findRecentWhitelistChecks(supabase, phones)
      duplicates = phones.filter(p => recent.has(p)).length
      rows = buildWhitelistRows(phoneInputs, recent)
    } else {
      const existing = await findExistingMoolreNumbers(supabase, phones)
      duplicates = phones.filter(p => existing.has(p)).length
      rows = buildMoolreRows(phoneInputs, existing)
    }

    const newCount = phones.length - duplicates

    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .insert({ file_name: file.name, total_count: phones.length, status: "processing", created_by: userId, check_type: checkType })
      .select("id")
      .single()

    if (sessionError || !session) throw new Error(`Session creation failed: ${sessionError?.message}`)

    const finalRows = rows.map(r => ({ ...r, session_id: session.id }))
    for (let i = 0; i < finalRows.length; i += 1000) {
      const { error } = await supabase.from("phone_verification_results").insert(finalRows.slice(i, i + 1000))
      if (error) throw new Error(`Bulk insert failed at offset ${i}: ${error.message}`)
    }

    return NextResponse.json({ sessionId: session.id, total: phones.length, newCount, duplicates, checkType })
  } catch (error) {
    console.error("[PHONE-VERIFY-UPLOAD]", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
```

Note: `checkType` is now echoed back in the upload response so the frontend (Task 8) doesn't need to separately remember which toggle state it sent.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/phone-verify-upload.ts lib/phone-verify-upload.test.ts app/api/admin/phone-verify/upload/route.ts
git commit -m "feat(phone-verification): support mtn_whitelist sessions in the upload route"
```

---

### Task 4: Whitelist processor (`lib/phone-verify-whitelist-processor.ts`)

**Files:**
- Create: `lib/phone-verify-whitelist-processor.ts`
- Create: `lib/phone-verify-whitelist-processor.test.ts`

**Interfaces:**
- Consumes: `checkWhitelistBatch`, `hasWhitelistProviders` from `lib/mtn-providers/provider-whitelist.ts` (Task 2).
- Produces: `export async function processWhitelistChunk(supabase, sessionId): Promise<WhitelistChunkResult>` — same `WhitelistChunkResult` shape as the existing `ChunkResult` from `lib/phone-verify-processor.ts` (`processed, remaining, verified, invalid, rateLimited, status`), so `process/route.ts` (Task 5) can treat both processors identically. Also produces `export function decideWhitelistOutcomes(pending, whitelistResults, now): WhitelistDecision` — the pure decision core, unit-tested directly (this codebase's existing `lib/phone-verify-processor.ts` has no test file at all; this plan holds the new whitelist path to a higher bar by testing its core logic, without hand-rolling a fragile full Supabase fluent-chain fake for the orchestrator — the same trade-off `lib/mtn-reversal.ts` makes for its own untested query-shaping functions).

- [ ] **Step 1: Write the failing test**

Create `lib/phone-verify-whitelist-processor.test.ts`:

```ts
import { decideWhitelistOutcomes } from "./phone-verify-whitelist-processor"

const NOW = "2026-08-10T00:00:00.000Z"

describe("decideWhitelistOutcomes", () => {
  it("routes a non-MTN row to not_applicable without needing a whitelist result", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 1, phone_number: "0201111111", network: "TELECEL" }],
      new Map(),
      NOW
    )
    expect(decision.notApplicableIds).toEqual([1])
    expect(decision.invalidIds).toEqual([])
    expect(decision.verifiedByProvider.size).toBe(0)
    expect(decision.registryUpserts).toEqual([])
  })

  it("groups an allowed MTN row under its allowing provider", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 2, phone_number: "0551111111", network: "MTN" }],
      new Map([["0551111111", { allowed: true, allowedBy: "xpress" }]]),
      NOW
    )
    expect(decision.verifiedByProvider.get("xpress")).toEqual([2])
    expect(decision.registryUpserts).toEqual([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_last_checked: NOW, whitelist_retry_count: 0 },
    ])
  })

  it("marks a blocked MTN row invalid with no allowed_by", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 3, phone_number: "0552222222", network: "MTN" }],
      new Map([["0552222222", { allowed: false }]]),
      NOW
    )
    expect(decision.invalidIds).toEqual([3])
    expect(decision.registryUpserts).toEqual([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_last_checked: NOW, whitelist_retry_count: 0 },
    ])
  })

  it("treats an MTN row missing from the results map as blocked (defensive default)", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 4, phone_number: "0553333333", network: "MTN" }],
      new Map(),
      NOW
    )
    expect(decision.invalidIds).toEqual([4])
  })

  it("groups multiple MTN rows allowed by different providers separately", () => {
    const decision = decideWhitelistOutcomes(
      [
        { id: 5, phone_number: "0551111111", network: "MTN" },
        { id: 6, phone_number: "0552222222", network: "MTN" },
      ],
      new Map([
        ["0551111111", { allowed: true, allowedBy: "xpress" }],
        ["0552222222", { allowed: true, allowedBy: "codecraft" }],
      ]),
      NOW
    )
    expect(decision.verifiedByProvider.get("xpress")).toEqual([5])
    expect(decision.verifiedByProvider.get("codecraft")).toEqual([6])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/phone-verify-whitelist-processor.test.ts`
Expected: FAIL — `lib/phone-verify-whitelist-processor.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/phone-verify-whitelist-processor.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { checkWhitelistBatch, hasWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"

// CodeCraft's own batch endpoint caps at 100 numbers per call — the binding
// constraint among the three whitelist-capable providers (Xpress allows up to
// 1000; AgentPortalGH is effectively unbounded). checkWhitelistBatch chunks
// internally per-provider regardless, but capping how many "pending" rows we
// pull per tick keeps a single processing tick bounded.
const CHUNK_SIZE = 100

export interface WhitelistChunkResult {
  processed: number
  remaining: number
  verified: number
  invalid: number
  rateLimited: number
  status: "completed" | "in_progress"
}

export interface WhitelistRegistryUpsert {
  phone: string
  whitelist_status: "allowed" | "blocked"
  whitelist_allowed_by: string | null
  whitelist_last_checked: string
  whitelist_retry_count: number
}

export interface WhitelistDecision {
  notApplicableIds: number[]
  verifiedByProvider: Map<string, number[]>
  invalidIds: number[]
  registryUpserts: WhitelistRegistryUpsert[]
}

/**
 * Pure decision logic: given a chunk of pending rows and each MTN number's
 * whitelist result, decides the new status bucket for every row and the
 * mtn_number_registry upsert payload. Non-MTN rows always become
 * not_applicable without needing a whitelist result. An MTN row missing from
 * whitelistResults (shouldn't normally happen — checkWhitelistBatch always
 * returns an entry for every input) defaults to blocked, matching
 * checkWhitelistBatch's own "unconfigured/no answer = not allowed" stance.
 */
export function decideWhitelistOutcomes(
  pending: Array<{ id: number; phone_number: string; network: string }>,
  whitelistResults: Map<string, { allowed: boolean; allowedBy?: string }>,
  now: string
): WhitelistDecision {
  const notApplicableIds: number[] = []
  const verifiedByProvider = new Map<string, number[]>()
  const invalidIds: number[] = []
  const registryUpserts: WhitelistRegistryUpsert[] = []

  for (const row of pending) {
    if (row.network !== "MTN") {
      notApplicableIds.push(row.id)
      continue
    }
    const result = whitelistResults.get(row.phone_number)
    const allowed = result?.allowed === true
    if (allowed) {
      const provider = result?.allowedBy ?? "unknown"
      if (!verifiedByProvider.has(provider)) verifiedByProvider.set(provider, [])
      verifiedByProvider.get(provider)!.push(row.id)
    } else {
      invalidIds.push(row.id)
    }
    registryUpserts.push({
      phone: row.phone_number,
      whitelist_status: allowed ? "allowed" : "blocked",
      whitelist_allowed_by: allowed ? (result?.allowedBy ?? null) : null,
      whitelist_last_checked: now,
      whitelist_retry_count: 0,
    })
  }

  return { notApplicableIds, verifiedByProvider, invalidIds, registryUpserts }
}

export async function processWhitelistChunk(
  supabase: SupabaseClient,
  sessionId: string
): Promise<WhitelistChunkResult> {
  const { data: session, error: sessionErr } = await supabase
    .from("phone_verification_sessions")
    .select("id, status, verified_count, invalid_count")
    .eq("id", sessionId)
    .single()

  if (sessionErr || !session) throw new Error("Session not found")

  if (session.status === "completed") {
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, rateLimited: 0, status: "completed" }
  }

  const { data: pending, error: fetchError } = await supabase
    .from("phone_verification_results")
    .select("id, phone_number, network")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .limit(CHUNK_SIZE)

  if (fetchError) throw fetchError

  const now = new Date().toISOString()

  if (!pending || pending.length === 0) {
    await supabase.from("phone_verification_sessions").update({ status: "completed", completed_at: now }).eq("id", sessionId)
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, rateLimited: 0, status: "completed" }
  }

  const mtnPhones = pending.filter(r => r.network === "MTN").map(r => r.phone_number)
  if (mtnPhones.length > 0 && !hasWhitelistProviders()) {
    // Should be unreachable: the upload route already refuses to start an
    // mtn_whitelist session when no provider is configured.
    throw new Error("No MTN whitelist provider is configured")
  }
  const whitelistResults = mtnPhones.length > 0
    ? await checkWhitelistBatch(mtnPhones)
    : new Map<string, { allowed: boolean; allowedBy?: string }>()

  const decision = decideWhitelistOutcomes(pending, whitelistResults, now)

  if (decision.notApplicableIds.length > 0) {
    await supabase.from("phone_verification_results")
      .update({ status: "not_applicable", verified_at: now })
      .in("id", decision.notApplicableIds)
  }
  for (const [provider, ids] of decision.verifiedByProvider) {
    await supabase.from("phone_verification_results")
      .update({ status: "verified", whitelist_provider: provider, verified_at: now })
      .in("id", ids)
  }
  if (decision.invalidIds.length > 0) {
    await supabase.from("phone_verification_results")
      .update({ status: "invalid", whitelist_provider: null, verified_at: now })
      .in("id", decision.invalidIds)
  }
  for (let i = 0; i < decision.registryUpserts.length; i += 500) {
    const { error: upsertError } = await supabase
      .from("mtn_number_registry")
      .upsert(decision.registryUpserts.slice(i, i + 500), { onConflict: "phone" })
    if (upsertError) console.error("[PHONE-VERIFY-WHITELIST] registry upsert failed:", upsertError.message)
  }

  const [{ count: verifiedCount }, { count: invalidCount }, { count: notApplicableCount }, { count: remaining }] =
    await Promise.all([
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "verified"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "invalid"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "not_applicable"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "pending"),
    ])

  const newVerified = verifiedCount ?? 0
  const newInvalid = invalidCount ?? 0
  const newNotApplicable = notApplicableCount ?? 0
  const isDone = (remaining ?? 0) === 0

  await supabase.from("phone_verification_sessions").update({
    verified_count: newVerified,
    invalid_count: newInvalid,
    not_applicable_count: newNotApplicable,
    ...(isDone ? { status: "completed", completed_at: now } : {}),
  }).eq("id", sessionId)

  return {
    processed: pending.length,
    remaining: remaining ?? 0,
    verified: newVerified,
    invalid: newInvalid,
    rateLimited: 0,
    status: isDone ? "completed" : "in_progress",
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/phone-verify-whitelist-processor.test.ts`
Expected: PASS — 5/5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/phone-verify-whitelist-processor.ts lib/phone-verify-whitelist-processor.test.ts
git commit -m "feat(phone-verification): add MTN whitelist chunk processor"
```

---

### Task 5: Dispatch by `check_type` in `process/route.ts`

**Files:**
- Modify: `app/api/admin/phone-verify/process/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `processVerificationChunk` (existing, unchanged) and `processWhitelistChunk` (Task 4).

- [ ] **Step 1: Rewrite the route**

Replace the entire file with:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { processVerificationChunk } from "@/lib/phone-verify-processor"
import { processWhitelistChunk } from "@/lib/phone-verify-whitelist-processor"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const maxDuration = 60

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({}))
  const sessionId: string | undefined = body.sessionId
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

  try {
    const { data: session, error: sessionError } = await supabase
      .from("phone_verification_sessions")
      .select("check_type")
      .eq("id", sessionId)
      .single()
    if (sessionError || !session) return NextResponse.json({ error: "Session not found" }, { status: 404 })

    const result = session.check_type === "mtn_whitelist"
      ? await processWhitelistChunk(supabase, sessionId)
      : await processVerificationChunk(supabase, sessionId)
    return NextResponse.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("[PHONE-VERIFY-PROCESS]", msg)
    return NextResponse.json({ error: msg || "Processing failed" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (this route has no dedicated test, matching its pre-existing untested state — verified manually in Task 8's end-to-end check).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/phone-verify/process/route.ts
git commit -m "feat(phone-verification): dispatch chunk processing by session check_type"
```

---

### Task 6: Whitelist-availability endpoint

**Files:**
- Create: `app/api/admin/phone-verify/whitelist-availability/route.ts`

**Interfaces:**
- Produces: `GET /api/admin/phone-verify/whitelist-availability` → `{ available: boolean }`. Consumed by the frontend (Task 8) to disable the whitelist toggle when no provider is configured.

- [ ] **Step 1: Implement the route**

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { hasWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  return NextResponse.json({ available: hasWhitelistProviders() })
}
```

- [ ] **Step 2: Verify manually**

Run the dev server and hit the endpoint with an admin session token:

```bash
curl -s http://localhost:3000/api/admin/phone-verify/whitelist-availability -H "Authorization: Bearer <admin-token>"
```

Expected: `{"available":true}` if any of `XPRESS_KEY`/`CODECRAFT_API_KEY`/`AGENTPORTALGH_API_KEY` is set in the environment, `{"available":false}` otherwise.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/phone-verify/whitelist-availability/route.ts
git commit -m "feat(phone-verification): add whitelist-provider availability endpoint"
```

---

### Task 7: Surface the new columns on every read route

**Files:**
- Modify: `app/api/admin/phone-verify/sessions/route.ts`
- Modify: `app/api/admin/phone-verify/session/[id]/route.ts`
- Modify: `app/api/admin/phone-verify/session/[id]/export/route.ts`

**Interfaces:**
- Produces: every session object returned to the frontend now includes `check_type` and `not_applicable_count`; every result row returned includes `whitelist_provider`. Task 8's frontend types assume these fields are present.

- [ ] **Step 1: Update `sessions/route.ts`**

In `app/api/admin/phone-verify/sessions/route.ts`, change the `.select(...)` call from:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, status, created_at, completed_at")
```

to:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, status, created_at, completed_at")
```

- [ ] **Step 2: Update `session/[id]/route.ts`**

In `app/api/admin/phone-verify/session/[id]/route.ts`, change the session select (line 29) from:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, status, created_at, completed_at")
```

to:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, status, created_at, completed_at")
```

And change the results select (line 39) from:

```ts
      .select("id, phone_number, account_name, network, status, verified_at", { count: "exact" })
```

to:

```ts
      .select("id, phone_number, account_name, network, status, whitelist_provider, verified_at", { count: "exact" })
```

- [ ] **Step 3: Update `session/[id]/export/route.ts`**

In `app/api/admin/phone-verify/session/[id]/export/route.ts`:

Change the `fetchAllResults` select (line 16) from:

```ts
      .select("phone_number, account_name, network, status")
```

to:

```ts
      .select("phone_number, account_name, network, status, whitelist_provider")
```

Change the session lookup (line 41) from:

```ts
      .select("id, file_name")
```

to:

```ts
      .select("id, file_name, check_type")
```

Change the `toRow` mapping and the sheet-building block (lines 53-66) from:

```ts
    const toRow = (r: any) => ({
      "Phone Number": r.phone_number,
      "Account Name": r.account_name ?? "",
      "Network": r.network,
      "Status": r.status === "verified" ? "Verified" : r.status === "invalid" ? "Invalid" : "Pending",
    })

    // Export contains verified numbers only — never invalids or duplicates.
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allResults.filter(r => r.status === "verified").map(toRow)),
      "Verified"
    )
```

to:

```ts
    const isWhitelist = session.check_type === "mtn_whitelist"

    const toRow = (r: any) => isWhitelist
      ? {
          "Phone Number": r.phone_number,
          "Network": r.network,
          "Allowed By": r.whitelist_provider ?? "",
          "Status": r.status === "verified" ? "Allowed" : r.status === "invalid" ? "Blocked" : r.status === "not_applicable" ? "N/A" : "Pending",
        }
      : {
          "Phone Number": r.phone_number,
          "Account Name": r.account_name ?? "",
          "Network": r.network,
          "Status": r.status === "verified" ? "Verified" : r.status === "invalid" ? "Invalid" : "Pending",
        }

    // Export contains verified/allowed numbers only — never invalids, duplicates, or not-applicable.
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(allResults.filter(r => r.status === "verified").map(toRow)),
      isWhitelist ? "Allowed" : "Verified"
    )
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/admin/phone-verify/sessions/route.ts app/api/admin/phone-verify/session/[id]/route.ts "app/api/admin/phone-verify/session/[id]/export/route.ts"
git commit -m "feat(phone-verification): surface check_type/not_applicable_count/whitelist_provider on read routes"
```

---

### Task 8: Frontend toggle and type-aware UI

**Files:**
- Modify: `app/admin/phone-verification/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: upload response now includes `checkType` (Task 3); `GET /api/admin/phone-verify/whitelist-availability` (Task 6); session/result objects now include `check_type`/`not_applicable_count`/`whitelist_provider` (Task 7).

This task also fixes the "duplicate count" derivation (`total_count - verified_count - invalid_count`), which appears at three call sites in this file (originally lines 230, 495, 595) — introducing `not_applicable` as a new terminal status means that subtraction now needs to also subtract `not_applicable_count`, or a whitelist session's "Duplicate" badge would silently include not-applicable numbers too. For Moolre sessions `not_applicable_count` is always 0 (the column defaults to 0 and nothing ever writes to it for that check type), so this is a no-op change for existing behavior.

- [ ] **Step 1: Rewrite the file**

Replace the entire file with:

```tsx
"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Upload, Download, CheckCircle, XCircle, Eye, Phone, ClipboardList, Copy, MinusCircle, ShieldCheck } from "lucide-react"

type Tab = "upload" | "history"
type VerifyState = "idle" | "uploading" | "processing" | "completed" | "error"
type InputMode = "file" | "text"
type CheckType = "moolre" | "mtn_whitelist"
type ResultFilter = "all" | "verified" | "invalid" | "duplicate" | "not_applicable"

const NORMAL_DELAY_MS = 200
const MAX_BACKOFF_MS = 120_000

interface Progress {
  sessionId: string
  fileName: string
  checkType: CheckType
  total: number
  verified: number
  invalid: number
  notApplicable: number
  duplicates: number
  processed: number
}

interface VerificationResult {
  id: number
  phone_number: string
  account_name: string | null
  whitelist_provider: string | null
  network: string
  status: "pending" | "verified" | "invalid" | "duplicate" | "not_applicable"
}

interface SessionSummary {
  id: string
  file_name: string
  check_type: CheckType
  total_count: number
  verified_count: number
  invalid_count: number
  not_applicable_count: number
  status: string
  created_at: string
  completed_at: string | null
}

interface ResultsPage {
  session: SessionSummary
  results: VerificationResult[]
  total: number
  page: number
  pages: number
}

function duplicateCount(s: { total_count: number; verified_count: number; invalid_count: number; not_applicable_count: number }): number {
  return Math.max(0, s.total_count - s.verified_count - s.invalid_count - s.not_applicable_count)
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function PhoneVerificationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<Tab>("upload")
  const [verifyState, setVerifyState] = useState<VerifyState>("idle")
  const [checkType, setCheckType] = useState<CheckType>("moolre")
  const [whitelistAvailable, setWhitelistAvailable] = useState(true)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [resultsPage, setResultsPage] = useState<ResultsPage | null>(null)
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>("file")
  const [pastedNumbers, setPastedNumbers] = useState("")
  const [rateLimitWarning, setRateLimitWarning] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      (async () => {
        try {
          const token = await getToken()
          const res = await fetch("/api/admin/phone-verify/whitelist-availability", {
            headers: { Authorization: `Bearer ${token}` },
          })
          const data = await res.json()
          setWhitelistAvailable(data.available !== false)
        } catch {
          // Leave the default (enabled) — a real check happens server-side on upload too.
        }
      })()
    }
  }, [isAdmin, adminLoading])

  useEffect(() => {
    if (isAdmin && !adminLoading && activeTab === "history") loadSessions()
  }, [isAdmin, adminLoading, activeTab])

  const loadSessions = async () => {
    setHistoryLoading(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/phone-verify/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setSessions(Array.isArray(data) ? data : [])
    } catch {
      toast.error("Failed to load session history")
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadResults = useCallback(async (
    sessionId: string,
    filter: ResultFilter = "all",
    page = 1
  ) => {
    try {
      const token = await getToken()
      const res = await fetch(
        `/api/admin/phone-verify/session/${sessionId}?status=${filter}&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      setResultsPage(data)
    } catch {
      toast.error("Failed to load results")
    }
  }, [])

  const handleFileSelect = useCallback(async (file: File) => {
    setVerifyState("uploading")
    setProgress(null)
    setResultsPage(null)

    try {
      const token = await getToken()
      const formData = new FormData()
      formData.append("file", file)
      formData.append("checkType", checkType)

      const uploadRes = await fetch("/api/admin/phone-verify/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.error ?? "Upload failed")

      const { sessionId, total, newCount = total, duplicates = 0, checkType: sessionCheckType } = uploadData
      setProgress({
        sessionId, fileName: file.name, checkType: sessionCheckType ?? checkType,
        total, verified: 0, invalid: 0, notApplicable: 0, duplicates, processed: duplicates,
      })
      setRateLimitWarning(false)
      setVerifyState("processing")

      if (duplicates > 0) {
        toast.info(
          newCount === 0
            ? `All ${duplicates.toLocaleString()} number(s) were already uploaded before — nothing new to verify.`
            : `${duplicates.toLocaleString()} number(s) were already uploaded before — marked as duplicate and skipped.`
        )
      }

      let remaining = total
      let backoffMs = 10_000
      let consecutiveRateLimits = 0

      while (remaining > 0) {
        let processData: any = null
        try {
          const processRes = await fetch("/api/admin/phone-verify/process", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          })
          processData = await processRes.json()

          if (!processRes.ok) {
            consecutiveRateLimits++
            const wait = Math.min(backoffMs * consecutiveRateLimits, MAX_BACKOFF_MS)
            setRateLimitWarning(true)
            await new Promise(r => setTimeout(r, wait))
            continue
          }
        } catch {
          consecutiveRateLimits++
          await new Promise(r => setTimeout(r, Math.min(10_000 * consecutiveRateLimits, MAX_BACKOFF_MS)))
          continue
        }

        remaining = processData.remaining
        setProgress(prev => prev ? {
          ...prev,
          verified: processData.verified,
          invalid: processData.invalid,
          processed: prev.total - processData.remaining,
        } : prev)

        if (processData.status === "completed") break

        if (processData.rateLimited > 0) {
          consecutiveRateLimits++
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
          setRateLimitWarning(true)
          await new Promise(r => setTimeout(r, backoffMs))
        } else {
          consecutiveRateLimits = 0
          backoffMs = 10_000
          setRateLimitWarning(false)
          await new Promise(r => setTimeout(r, NORMAL_DELAY_MS))
        }
      }

      setVerifyState("completed")
      await loadResults(sessionId, "all", 1)
      toast.success("Verification complete!")
    } catch (error: any) {
      setVerifyState("error")
      toast.error(error.message ?? "Verification failed")
    }
  }, [loadResults, checkType])

  const handleTextSubmit = useCallback(async () => {
    const trimmed = pastedNumbers.trim()
    if (!trimmed) { toast.error("Paste at least one phone number"); return }
    const blob = new Blob([trimmed], { type: "text/csv" })
    const file = new File([blob], "pasted-numbers.csv", { type: "text/csv" })
    await handleFileSelect(file)
  }, [pastedNumbers, handleFileSelect])

  const handleFilterChange = (filter: ResultFilter) => {
    setResultFilter(filter)
    setCurrentPage(1)
    if (progress?.sessionId) loadResults(progress.sessionId, filter, 1)
  }

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    if (progress?.sessionId) loadResults(progress.sessionId, resultFilter, page)
  }

  const handleViewSession = async (session: SessionSummary) => {
    setActiveTab("upload")
    setVerifyState("completed")
    const dupCount = duplicateCount(session)
    setProgress({
      sessionId: session.id,
      fileName: session.file_name,
      checkType: session.check_type,
      total: session.total_count,
      verified: session.verified_count,
      invalid: session.invalid_count,
      notApplicable: session.not_applicable_count,
      duplicates: dupCount,
      processed: session.verified_count + session.invalid_count + session.not_applicable_count + dupCount,
    })
    setResultFilter("all")
    setCurrentPage(1)
    await loadResults(session.id, "all", 1)
  }

  const downloadExport = async (sessionId: string) => {
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/phone-verify/session/${sessionId}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) { toast.error("Export failed"); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `verification-${sessionId.slice(0, 8)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Export failed")
    }
  }

  const downloadTemplate = () => {
    const content = [
      "Title,First Name,Last Name,Phone Number,Email Address,Country",
      "Mr.,Kwame,Doe,0551234567,kwame.doe@example.com,Ghana",
      "Miss,Akosua,Smith,0241234567,akosua.smith@example.com,Ghana",
      "",
      "Note:",
      "Phone Number is the only required field.",
      "Delete this note i.e. row 5 6 7 before uploading",
    ].join("\n")
    const blob = new Blob([content], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "phone-verification-template.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  if (adminLoading) return null

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0
  const activeCheckType = progress?.checkType ?? checkType
  const isWhitelistView = activeCheckType === "mtn_whitelist"

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Phone className="w-6 h-6" /> Phone Number Verification
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {checkType === "mtn_whitelist"
              ? "Bulk-check Ghana numbers against MTN whitelist-capable providers (Xpress/CodeCraft/AgentPortalGH) to see which can currently receive an MTN data order."
              : "Bulk-verify Ghana MoMo numbers against Moolre. Numbers with a returned account name are saved as verified."}
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border">
          {(["upload", "history"] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "upload" ? "📤 Upload & Verify" : "🕓 Session History"}
            </button>
          ))}
        </div>

        {/* Tab 1: Upload & Verify */}
        {activeTab === "upload" && (
          <div className="space-y-4">
            {(verifyState === "idle" || verifyState === "error") && (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  {/* Check type toggle */}
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      onClick={() => setCheckType("moolre")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        checkType === "moolre"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Phone className="w-4 h-4" /> Moolre (MoMo Check)
                    </button>
                    <button
                      onClick={() => whitelistAvailable && setCheckType("mtn_whitelist")}
                      disabled={!whitelistAvailable}
                      title={whitelistAvailable ? undefined : "No MTN whitelist provider is configured (Xpress/CodeCraft/AgentPortalGH)"}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        !whitelistAvailable
                          ? "text-muted-foreground/50 cursor-not-allowed"
                          : checkType === "mtn_whitelist"
                            ? "bg-background shadow text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ShieldCheck className="w-4 h-4" /> MTN Whitelist (Order Eligibility)
                    </button>
                  </div>

                  {/* Input mode toggle */}
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      onClick={() => setInputMode("file")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        inputMode === "file"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Upload className="w-4 h-4" /> File Upload
                    </button>
                    <button
                      onClick={() => setInputMode("text")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        inputMode === "text"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ClipboardList className="w-4 h-4" /> Paste Numbers
                    </button>
                  </div>

                  {inputMode === "file" ? (
                    <>
                      <div
                        onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f) }}
                        onDragOver={e => e.preventDefault()}
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:border-primary transition-colors"
                      >
                        <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                        <p className="text-sm font-medium mb-1">
                          Drag & drop your file here, or <span className="text-primary underline">browse</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Accepts .csv or .xlsx · Max 50 MB · Multi-column format supported (Phone Number column auto-detected) · Numbers uploaded in earlier sessions are flagged as duplicates
                        </p>
                        <Button
                          variant="outline" size="sm" className="mt-4"
                          onClick={e => { e.stopPropagation(); downloadTemplate() }}
                        >
                          <Download className="w-4 h-4 mr-2" /> Download Template
                        </Button>
                      </div>
                      <input
                        ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); e.target.value = "" }}
                      />
                    </>
                  ) : (
                    <div className="space-y-3">
                      <textarea
                        value={pastedNumbers}
                        onChange={e => setPastedNumbers(e.target.value)}
                        placeholder={"Paste phone numbers here, one per line:\n0551234567\n0241234567\n0207654321"}
                        className="w-full h-48 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {pastedNumbers.trim()
                            ? `${pastedNumbers.trim().split(/[\r\n]+/).filter(l => l.trim()).length.toLocaleString()} numbers detected`
                            : "One number per line · numbers already uploaded before are flagged as duplicates"}
                        </span>
                        <Button onClick={handleTextSubmit} disabled={!pastedNumbers.trim()} className="gap-2">
                          <Phone className="w-4 h-4" /> Verify Numbers
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {verifyState === "uploading" && (
              <Card>
                <CardContent className="pt-6 text-center">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
                  <p className="text-sm text-muted-foreground">Uploading and parsing file...</p>
                </CardContent>
              </Card>
            )}

            {(verifyState === "processing" || verifyState === "completed") && progress && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    {verifyState === "processing"
                      ? <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      : <CheckCircle className="w-4 h-4 text-success" />}
                    {progress.fileName}
                    <Badge variant="outline" className="ml-1">{isWhitelistView ? "MTN Whitelist" : "Moolre"}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>
                        {verifyState === "processing"
                          ? `Checking... ${progress.processed.toLocaleString()} done / ${progress.total.toLocaleString()} total`
                          : "Verification complete"}
                      </span>
                      <span>{progressPct}%</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>

                  <div className={`grid grid-cols-2 gap-3 ${isWhitelistView ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
                    <div className="bg-success/10 border border-success/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-success">{progress.verified.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">{isWhitelistView ? "Allowed" : "Verified"}</div>
                    </div>
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-destructive">{progress.invalid.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">{isWhitelistView ? "Blocked" : "Invalid"}</div>
                    </div>
                    {isWhitelistView && (
                      <div className="bg-muted border border-border rounded-lg p-3 text-center">
                        <div className="text-2xl font-bold">{progress.notApplicable.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">N/A</div>
                      </div>
                    )}
                    <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-warning">{progress.duplicates.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Duplicate</div>
                    </div>
                    <div className="bg-muted rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold">{progress.total.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                  </div>

                  {rateLimitWarning && verifyState === "processing" && (
                    <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                      Rate limit hit — backing off and retrying automatically...
                    </div>
                  )}

                  {verifyState === "completed" && (
                    <div className="flex gap-2 flex-wrap">
                      <Button onClick={() => downloadExport(progress.sessionId)} className="gap-2">
                        <Download className="w-4 h-4" /> Export .xlsx
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setVerifyState("idle"); setProgress(null); setResultsPage(null); setPastedNumbers(""); setRateLimitWarning(false) }}
                      >
                        Verify More Numbers
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {verifyState === "completed" && resultsPage && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-sm">Results</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      {(["all", "verified", "invalid", "duplicate", ...(isWhitelistView ? ["not_applicable" as const] : [])] as const).map(f => (
                        <Button
                          key={f} size="sm"
                          variant={resultFilter === f ? "default" : "outline"}
                          onClick={() => handleFilterChange(f)}
                        >
                          {f === "all" && `All (${resultsPage.session.total_count.toLocaleString()})`}
                          {f === "verified" && `✓ ${isWhitelistView ? "Allowed" : "Verified"} (${resultsPage.session.verified_count.toLocaleString()})`}
                          {f === "invalid" && `✗ ${isWhitelistView ? "Blocked" : "Invalid"} (${resultsPage.session.invalid_count.toLocaleString()})`}
                          {f === "duplicate" && `⧉ Duplicate (${duplicateCount(resultsPage.session).toLocaleString()})`}
                          {f === "not_applicable" && `– N/A (${resultsPage.session.not_applicable_count.toLocaleString()})`}
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 pr-4">#</th>
                          <th className="pb-2 pr-4">Phone</th>
                          <th className="pb-2 pr-4">{isWhitelistView ? "Allowed By" : "Account Name"}</th>
                          <th className="pb-2 pr-4">Network</th>
                          <th className="pb-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultsPage.results.map((row, i) => (
                          <tr key={row.id} className="border-b last:border-0">
                            <td className="py-2 pr-4 text-muted-foreground">{(resultsPage.page - 1) * 100 + i + 1}</td>
                            <td className="py-2 pr-4 font-mono">{row.phone_number}</td>
                            <td className="py-2 pr-4">{(isWhitelistView ? row.whitelist_provider : row.account_name) ?? "—"}</td>
                            <td className="py-2 pr-4"><Badge variant="outline">{row.network}</Badge></td>
                            <td className="py-2">
                              {row.status === "verified" ? (
                                <Badge className="bg-success/10 text-success border-success/30">
                                  <CheckCircle className="w-3 h-3 mr-1" /> {isWhitelistView ? "Allowed" : "Verified"}
                                </Badge>
                              ) : row.status === "duplicate" ? (
                                <Badge className="bg-warning/10 text-warning border-warning/30">
                                  <Copy className="w-3 h-3 mr-1" /> Duplicate
                                </Badge>
                              ) : row.status === "not_applicable" ? (
                                <Badge className="bg-muted text-muted-foreground border-border">
                                  <MinusCircle className="w-3 h-3 mr-1" /> N/A
                                </Badge>
                              ) : (
                                <Badge className="bg-destructive/10 text-destructive border-destructive/30">
                                  <XCircle className="w-3 h-3 mr-1" /> {isWhitelistView ? "Blocked" : "Invalid"}
                                </Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {resultsPage.pages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <span className="text-xs text-muted-foreground">
                        Page {resultsPage.page} of {resultsPage.pages} ({resultsPage.total.toLocaleString()} results)
                      </span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => handlePageChange(currentPage - 1)}>
                          Previous
                        </Button>
                        <Button variant="outline" size="sm" disabled={currentPage >= resultsPage.pages} onClick={() => handlePageChange(currentPage + 1)}>
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Tab 2: Session History */}
        {activeTab === "history" && (
          <Card>
            <CardHeader><CardTitle>Past Verification Sessions</CardTitle></CardHeader>
            <CardContent>
              {historyLoading ? (
                <div className="text-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-8">No sessions yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4">Date</th>
                        <th className="pb-2 pr-4">File</th>
                        <th className="pb-2 pr-4">Type</th>
                        <th className="pb-2 pr-4 text-center">Total</th>
                        <th className="pb-2 pr-4 text-center">Verified</th>
                        <th className="pb-2 pr-4 text-center">Invalid</th>
                        <th className="pb-2 pr-4 text-center">Dup</th>
                        <th className="pb-2 pr-4 text-center">Status</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map(session => (
                        <tr key={session.id} className="border-b last:border-0">
                          <td className="py-2 pr-4 text-muted-foreground text-xs">{new Date(session.created_at).toLocaleString()}</td>
                          <td className="py-2 pr-4 max-w-[180px] truncate">{session.file_name}</td>
                          <td className="py-2 pr-4">
                            <Badge variant="outline" className="text-xs">
                              {session.check_type === "mtn_whitelist" ? "Whitelist" : "Moolre"}
                            </Badge>
                          </td>
                          <td className="py-2 pr-4 text-center">{session.total_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-success font-medium">{session.verified_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-destructive">{session.invalid_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-warning">{duplicateCount(session).toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center">
                            <Badge variant={session.status === "completed" ? "default" : "secondary"}>{session.status}</Badge>
                          </td>
                          <td className="py-2">
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => handleViewSession(session)}>
                                <Eye className="w-4 h-4 mr-1" /> View
                              </Button>
                              {session.status === "completed" && (
                                <Button variant="ghost" size="sm" onClick={() => downloadExport(session.id)}>
                                  <Download className="w-4 h-4 mr-1" /> xlsx
                                </Button>
                              )}
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
        )}
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `app/admin/phone-verification/page.tsx`.

- [ ] **Step 3: Manual end-to-end verification**

Start the dev server (`npm run dev`), sign in as an admin, and on `/admin/phone-verification`:
1. Confirm the "MTN Whitelist" toggle button is enabled/disabled correctly based on whether `XPRESS_KEY`/`CODECRAFT_API_KEY`/`AGENTPORTALGH_API_KEY` is set in your local env.
2. Paste a handful of test numbers (mix of MTN and non-MTN prefixes) with the Moolre toggle selected — confirm existing behavior is unchanged (verified/invalid/duplicate all populate as before).
3. Switch to MTN Whitelist, paste the same numbers, and confirm: MTN numbers get checked (Allowed/Blocked), non-MTN numbers land in the new "N/A" bucket without any network calls, and the History tab shows a "Whitelist" badge for that session with correct counts.
4. Re-upload the exact same whitelist-checked numbers within a few minutes — confirm they're marked "Duplicate" (fresh, so skipped) rather than re-checked.
5. Export the whitelist session's .xlsx and confirm it contains an "Allowed By" column and only allowed numbers.

- [ ] **Step 4: Commit**

```bash
git add app/admin/phone-verification/page.tsx
git commit -m "feat(phone-verification): add MTN whitelist check-type toggle to the UI"
```

---

## Final verification

- [ ] Run the full suite once more: `npx vitest run` — expect all tests (existing + new) passing.
- [ ] Run `npx tsc --noEmit -p tsconfig.json` — expect no new errors.
- [ ] Re-read `docs/superpowers/specs/2026-08-10-phone-verification-mtn-whitelist-toggle-design.md` against the finished code and confirm every section has a corresponding implemented piece, noting the one documented deviation (fail-open on provider errors, Global Constraints section above).
