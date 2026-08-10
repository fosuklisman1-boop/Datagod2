# Phone Verification Whitelist Provider Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick which whitelist-capable providers (Xpress/CodeCraft/AgentPortalGH) a bulk MTN-whitelist check on `/admin/phone-verification` uses, instead of always checking all configured providers.

**Architecture:** A new per-session `whitelist_providers` column records the chosen subset; `checkWhitelistBatch` already accepts a registry override, so the whitelist processor just needs to filter `WHITELIST_REGISTRY` by that subset before calling it. The harder part is dedupe: a new cumulative `mtn_number_registry.whitelist_checked_providers` column tracks every provider ever consulted for a number, so the 24h freshness dedupe can tell whether *this run's* selection has genuinely already been asked, rather than treating any prior check (by any provider) as sufficient.

**Tech Stack:** Next.js 15 App Router API routes, Supabase (service-role client), Vitest, React/Tailwind.

## Global Constraints

- Provider selection is a per-session choice (like `check_type`), not per-number and not reorderable — a subset of the fixed `WHITELIST_REGISTRY` order, never a custom priority order.
- All configured providers are selected by default when the MTN Whitelist toggle is chosen — opt-out, not opt-in.
- Dedupe must become selection-aware: an **allowed** stored result counts as "known" only if its `whitelist_allowed_by` provider is in this run's selection; a **blocked** stored result counts as "known" only if this run's *entire* selection is already a subset of everything ever tried against that number (`whitelist_checked_providers`). Either the 24h freshness window OR this coverage check failing means: treat as fresh, re-check.
- `mtn_number_registry.whitelist_checked_providers` is a cumulative union across every write, from either entry point (`phone-verify` upload flow and the pre-existing `mtn-whitelist/batch-verify` bulk tool) — never overwritten, always unioned with what was already there.
- No backfill for historical registry rows — the new column defaults to `'{}'`; it self-heals the first time any row is touched by either write path again.
- `checkWhitelistForOrder` (the real-time order-fulfillment path) is untouched — this feature only touches the two bulk/admin tools.

---

### Task 1: Migration — schema changes

**Files:**
- Create: `migrations/0095_whitelist_provider_selection.sql`

**Interfaces:**
- Produces: `phone_verification_sessions.whitelist_providers TEXT[]` (nullable — null for `moolre` sessions, populated for `mtn_whitelist` sessions), `mtn_number_registry.whitelist_checked_providers TEXT[]` (`NOT NULL DEFAULT '{}'`). All later tasks read/write these exact column names.

- [ ] **Step 1: Write the migration**

```sql
-- Lets an admin pick a subset of whitelist-capable providers
-- (xpress/codecraft/agentportalgh) for a bulk MTN whitelist check, instead
-- of always checking every configured one.
--
-- whitelist_providers records which providers a given phone_verification
-- session was configured to use (null for moolre sessions).
--
-- whitelist_checked_providers is the cumulative union, across every write
-- from either entry point (the phone-verify upload flow and the
-- mtn-whitelist/batch-verify bulk tool), of every provider ever consulted
-- to produce a number's current whitelist_status. This is new information —
-- previously only "who allowed it" (whitelist_allowed_by) was tracked, never
-- "who was asked and said no." It's what makes dedupe provider-selection-
-- aware: a stored "blocked" result only counts as "known" for a given run if
-- every provider that run would ask has already been tried.
ALTER TABLE phone_verification_sessions
  ADD COLUMN IF NOT EXISTS whitelist_providers TEXT[];

ALTER TABLE mtn_number_registry
  ADD COLUMN IF NOT EXISTS whitelist_checked_providers TEXT[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 2: Apply the migration**

Apply it against the live Supabase project via the Management API SQL endpoint (see `reference-supabase-access` memory), or however this project's migrations are normally applied. Verify with:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'phone_verification_sessions' and column_name = 'whitelist_providers';

select column_name, data_type, column_default from information_schema.columns
where table_name = 'mtn_number_registry' and column_name = 'whitelist_checked_providers';
```

Expected: 1 row from each query.

- [ ] **Step 3: Commit**

```bash
git add migrations/0095_whitelist_provider_selection.sql
git commit -m "feat(mtn-whitelist): add whitelist_providers/whitelist_checked_providers columns"
```

---

### Task 2: Provider-selection utilities in `provider-whitelist.ts`

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts`
- Modify: `lib/mtn-providers/provider-whitelist.test.ts`

**Interfaces:**
- Produces: `listWhitelistProviders(registry?): Array<{ name: string; configured: boolean }>`, `validateProviderSelection(names: string[], registry?): { valid: true; providers: string[] } | { valid: false; error: string }`, `unionProviders(existing: string[], added: string[]): string[]` — all exported from `lib/mtn-providers/provider-whitelist.ts`. Task 3 (availability route) calls `listWhitelistProviders`. Task 5 (upload route) calls `validateProviderSelection`. Tasks 6 and 7 (whitelist processor, batch-verify route) call `unionProviders`.

- [ ] **Step 1: Write the failing tests**

Open `lib/mtn-providers/provider-whitelist.test.ts` and change its import line from:

```ts
import { checkWhitelistBatch, type WhitelistEntry } from "./provider-whitelist"
```

to:

```ts
import { checkWhitelistBatch, listWhitelistProviders, validateProviderSelection, unionProviders, type WhitelistEntry } from "./provider-whitelist"
```

Then append these new `describe` blocks at the end of the file (after the existing `describe("checkWhitelistBatch", ...)` block):

```ts
describe("listWhitelistProviders", () => {
  it("reports each registry entry's name and configured state", () => {
    const registry = [
      fakeEntry("xpress", new Set(), true),
      fakeEntry("codecraft", new Set(), false),
    ]
    expect(listWhitelistProviders(registry)).toEqual([
      { name: "xpress", configured: true },
      { name: "codecraft", configured: false },
    ])
  })
})

describe("validateProviderSelection", () => {
  const registry = [
    fakeEntry("xpress", new Set(), true),
    fakeEntry("codecraft", new Set(), true),
    fakeEntry("agentportalgh", new Set(), false),
  ]

  it("rejects an empty selection", () => {
    const result = validateProviderSelection([], registry)
    expect(result).toEqual({ valid: false, error: "At least one provider must be selected" })
  })

  it("rejects an unknown provider name", () => {
    const result = validateProviderSelection(["xpress", "bogus"], registry)
    expect(result).toEqual({ valid: false, error: "Unknown provider(s): bogus" })
  })

  it("rejects a known but unconfigured provider", () => {
    const result = validateProviderSelection(["agentportalgh"], registry)
    expect(result).toEqual({ valid: false, error: "Provider(s) not configured: agentportalgh" })
  })

  it("accepts a valid subset, deduped and normalized to registry order", () => {
    const result = validateProviderSelection(["codecraft", "xpress", "codecraft"], registry)
    expect(result).toEqual({ valid: true, providers: ["xpress", "codecraft"] })
  })
})

describe("unionProviders", () => {
  it("merges two lists without duplicates", () => {
    expect(unionProviders(["xpress"], ["xpress", "codecraft"])).toEqual(["xpress", "codecraft"])
  })

  it("returns the added list as-is when existing is empty", () => {
    expect(unionProviders([], ["xpress"])).toEqual(["xpress"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts`
Expected: FAIL — `listWhitelistProviders`, `validateProviderSelection`, `unionProviders` are not exported yet.

- [ ] **Step 3: Implement the three functions**

In `lib/mtn-providers/provider-whitelist.ts`, add this new section at the very end of the file (after the existing `isWhitelistProvider` function):

```ts
// ── Provider selection (bulk admin tools) ──────────────────────────────────────

/**
 * Per-provider configuration snapshot — used by the phone-verification
 * upload UI to show which providers a bulk whitelist check can use.
 */
export function listWhitelistProviders(
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): Array<{ name: string; configured: boolean }> {
  return registry.map(p => ({ name: p.name, configured: p.configured() }))
}

/**
 * Validates an admin-chosen subset of provider names for a bulk whitelist
 * run: every name must be a real registry entry AND currently configured.
 * Returns the validated names deduped and normalized to registry order, or
 * an error message naming exactly what's wrong.
 */
export function validateProviderSelection(
  names: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): { valid: true; providers: string[] } | { valid: false; error: string } {
  if (names.length === 0) return { valid: false, error: "At least one provider must be selected" }
  const unknown = names.filter(n => !registry.some(p => p.name === n))
  if (unknown.length > 0) return { valid: false, error: `Unknown provider(s): ${unknown.join(", ")}` }
  const configuredNames = new Set(registry.filter(p => p.configured()).map(p => p.name))
  const unconfigured = names.filter(n => !configuredNames.has(n))
  if (unconfigured.length > 0) return { valid: false, error: `Provider(s) not configured: ${unconfigured.join(", ")}` }
  const selected = new Set(names)
  return { valid: true, providers: registry.filter(p => selected.has(p.name)).map(p => p.name) }
}

/** Union of two provider-name lists, deduped, order-preserving on first occurrence. */
export function unionProviders(existing: string[], added: string[]): string[] {
  return Array.from(new Set([...existing, ...added]))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts`
Expected: PASS — 11/11 tests (5 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/provider-whitelist.ts lib/mtn-providers/provider-whitelist.test.ts
git commit -m "feat(mtn-whitelist): add provider-selection validation and listing utilities"
```

---

### Task 3: Extend the whitelist-availability endpoint

**Files:**
- Modify: `app/api/admin/phone-verify/whitelist-availability/route.ts`

**Interfaces:**
- Consumes: `listWhitelistProviders()` (Task 2).
- Produces: `GET /api/admin/phone-verify/whitelist-availability` now returns `{ available: boolean, providers: Array<{ name: string; configured: boolean }> }` (previously just `{ available: boolean }`). Task 9 (frontend) consumes the new `providers` field.

- [ ] **Step 1: Rewrite the route**

Replace the entire file with:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { hasWhitelistProviders, listWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  return NextResponse.json({ available: hasWhitelistProviders(), providers: listWhitelistProviders() })
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (this route has no dedicated test file, matching its pre-existing untested state).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/phone-verify/whitelist-availability/route.ts
git commit -m "feat(mtn-whitelist): expose per-provider config state from whitelist-availability"
```

---

### Task 4: Selection-aware dedupe in `lib/phone-verify-upload.ts`

**Files:**
- Modify: `lib/phone-verify-upload.ts`
- Modify: `lib/phone-verify-upload.test.ts`

**Interfaces:**
- Produces: `isWhitelistResultCovered(row: { status, allowedBy, checkedProviders }, selectedProviders: string[]): boolean` (new, pure). `findRecentWhitelistChecks(supabase, candidates, selectedProviders: string[])` — **signature change**: gains a required third parameter. Task 5 (upload route) is the only caller and is updated in the next task to pass it.

This is the core of the feature: today, `findRecentWhitelistChecks` treats any resolved `allowed`/`blocked` result within 24h as "known." This task makes that provider-selection-aware per the Global Constraints above.

- [ ] **Step 1: Write the failing tests**

Replace the entire `lib/phone-verify-upload.test.ts` file with:

```ts
import {
  findExistingMoolreNumbers,
  findRecentWhitelistChecks,
  isWhitelistResultCovered,
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

describe("isWhitelistResultCovered", () => {
  it("covers an allowed row when the allowing provider is selected", () => {
    expect(isWhitelistResultCovered(
      { status: "allowed", allowedBy: "xpress", checkedProviders: ["xpress"] },
      ["xpress", "codecraft"]
    )).toBe(true)
  })

  it("does not cover an allowed row when the allowing provider is excluded from selection", () => {
    expect(isWhitelistResultCovered(
      { status: "allowed", allowedBy: "xpress", checkedProviders: ["xpress"] },
      ["codecraft"]
    )).toBe(false)
  })

  it("covers a blocked row when every selected provider was already tried", () => {
    expect(isWhitelistResultCovered(
      { status: "blocked", allowedBy: null, checkedProviders: ["xpress", "codecraft"] },
      ["xpress"]
    )).toBe(true)
  })

  it("does not cover a blocked row when a selected provider was never tried", () => {
    expect(isWhitelistResultCovered(
      { status: "blocked", allowedBy: null, checkedProviders: ["xpress"] },
      ["xpress", "codecraft"]
    )).toBe(false)
  })
})

describe("findRecentWhitelistChecks", () => {
  it("includes an allowed row when the allowing provider is in the selected set", async () => {
    const fake = fakeSupabase([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0551111111"], ["xpress", "codecraft"])
    expect(result.get("0551111111")).toEqual({ status: "allowed", allowedBy: "xpress" })
  })

  it("excludes an allowed row when the allowing provider is NOT in the selected set (treated as fresh)", async () => {
    const fake = fakeSupabase([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0551111111"], ["codecraft"])
    expect(result.has("0551111111")).toBe(false)
  })

  it("includes a blocked row only when every selected provider was already tried", async () => {
    const fake = fakeSupabase([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_checked_providers: ["xpress", "codecraft"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0552222222"], ["xpress"])
    expect(result.get("0552222222")).toEqual({ status: "blocked", allowedBy: null })
  })

  it("excludes a blocked row when a selected provider was never tried against it (treated as fresh)", async () => {
    const fake = fakeSupabase([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0552222222"], ["xpress", "codecraft"])
    expect(result.has("0552222222")).toBe(false)
  })

  it("still excludes rows with no resolved allowed/blocked status", async () => {
    const fake = fakeSupabase([
      { phone: "0553333333", whitelist_status: "unchecked", whitelist_allowed_by: null, whitelist_checked_providers: [], whitelist_last_checked: null },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0553333333"], ["xpress"])
    expect(result.has("0553333333")).toBe(false)
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
Expected: FAIL — `isWhitelistResultCovered` not exported, `findRecentWhitelistChecks` called with 3 args but only accepts 2.

- [ ] **Step 3: Implement the changes**

In `lib/phone-verify-upload.ts`, replace the existing `findRecentWhitelistChecks` function (and its docstring) with:

```ts
/**
 * True if a stored whitelist result for a number is "covered" by a run's
 * selected provider set — i.e. re-checking wouldn't ask anything genuinely
 * new. An allowed row is covered only if the allowing provider is itself
 * selected; a blocked row is covered only if every selected provider has
 * already been tried against this number (checkedProviders is a superset
 * of selectedProviders). Narrowing or changing the provider selection
 * between runs can un-cover a previously "known" result on purpose.
 */
export function isWhitelistResultCovered(
  row: { status: "allowed" | "blocked"; allowedBy: string | null; checkedProviders: string[] },
  selectedProviders: string[]
): boolean {
  if (row.status === "allowed") {
    return row.allowedBy !== null && selectedProviders.includes(row.allowedBy)
  }
  const checked = new Set(row.checkedProviders)
  return selectedProviders.every(p => checked.has(p))
}

/**
 * Numbers whose MTN whitelist status was checked within the last 24h AND
 * whose stored result is covered (see isWhitelistResultCovered) by this
 * run's selected provider set. Unlike Moolre account names, whitelist status
 * is time-varying (that's why the 24h retry cron exists) AND now also
 * selection-dependent (narrowing which providers are asked can make a
 * previously-known result no longer "known enough" to skip) — either
 * condition failing means treat the number as unchecked.
 * mtn_number_registry.phone is unique, so unlike findExistingMoolreNumbers
 * this never needs inner pagination per chunk.
 */
export async function findRecentWhitelistChecks(
  supabase: SupabaseClient,
  candidates: string[],
  selectedProviders: string[]
): Promise<Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>> {
  const result = new Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>()
  const cutoff = new Date(Date.now() - WHITELIST_FRESHNESS_MS).toISOString()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_status, whitelist_allowed_by, whitelist_checked_providers, whitelist_last_checked")
      .in("phone", chunk)
      .gte("whitelist_last_checked", cutoff)
      .range(0, 999) // phone is unique, chunk size is well under a page
    if (error) throw new Error(`Whitelist freshness lookup failed: ${error.message}`)
    for (const row of data ?? []) {
      if (row.whitelist_status !== "allowed" && row.whitelist_status !== "blocked") continue
      const covered = isWhitelistResultCovered(
        { status: row.whitelist_status, allowedBy: row.whitelist_allowed_by, checkedProviders: row.whitelist_checked_providers ?? [] },
        selectedProviders
      )
      if (covered) {
        result.set(row.phone, { status: row.whitelist_status, allowedBy: row.whitelist_allowed_by })
      }
    }
  }
  return result
}
```

Leave everything else in the file (`findExistingMoolreNumbers`, `buildMoolreRows`, `buildWhitelistRows`, the type exports) exactly as it is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/phone-verify-upload.test.ts`
Expected: PASS — 13/13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/phone-verify-upload.ts lib/phone-verify-upload.test.ts
git commit -m "feat(mtn-whitelist): make whitelist dedupe provider-selection-aware"
```

---

### Task 5: Upload route — read, validate, and store provider selection

**Files:**
- Modify: `app/api/admin/phone-verify/upload/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `validateProviderSelection` (Task 2), `findRecentWhitelistChecks` with its new 3rd parameter (Task 4).
- Produces: the upload response gains a `whitelistProviders: string[] | null` field (echoed back, mirroring the existing `checkType` echo). Task 9 (frontend) reads it.

- [ ] **Step 1: Rewrite the route**

Replace the entire file with:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhoneNumber } from "@/lib/phone-validation"
import { detectNetworkWithMap } from "@/lib/phone-format"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { hasWhitelistProviders, validateProviderSelection } from "@/lib/mtn-providers/provider-whitelist"
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

    let whitelistProviders: string[] | null = null
    if (checkType === "mtn_whitelist") {
      if (!hasWhitelistProviders()) {
        return NextResponse.json(
          { error: "No MTN whitelist provider is configured (Xpress/CodeCraft/AgentPortalGH)" },
          { status: 400 }
        )
      }
      const requestedProviders = String(formData.get("providers") ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
      const validated = validateProviderSelection(requestedProviders)
      if (!validated.valid) {
        return NextResponse.json({ error: validated.error }, { status: 400 })
      }
      whitelistProviders = validated.providers
    }

    const phoneLines = await fileToPhoneLines(file)
    if (phoneLines.length === 0) return NextResponse.json({ error: "No phone numbers found in file" }, { status: 400 })

    const phones = [...new Set(phoneLines.map(normalizeGhanaPhoneNumber).filter(p => p.length >= 9))]

    const { map: prefixMap } = await getPrefixValidationConfig()
    const phoneInputs = phones.map(phone => ({ phone, network: detectNetworkWithMap(phone, prefixMap) }))

    let rows: ReturnType<typeof buildMoolreRows>
    let duplicates: number

    if (checkType === "mtn_whitelist") {
      const recent = await findRecentWhitelistChecks(supabase, phones, whitelistProviders!)
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
      .insert({
        file_name: file.name,
        total_count: phones.length,
        status: "processing",
        created_by: userId,
        check_type: checkType,
        whitelist_providers: whitelistProviders,
      })
      .select("id")
      .single()

    if (sessionError || !session) throw new Error(`Session creation failed: ${sessionError?.message}`)

    const finalRows = rows.map(r => ({ ...r, session_id: session.id }))
    for (let i = 0; i < finalRows.length; i += 1000) {
      const { error } = await supabase.from("phone_verification_results").insert(finalRows.slice(i, i + 1000))
      if (error) throw new Error(`Bulk insert failed at offset ${i}: ${error.message}`)
    }

    return NextResponse.json({ sessionId: session.id, total: phones.length, newCount, duplicates, checkType, whitelistProviders })
  } catch (error) {
    console.error("[PHONE-VERIFY-UPLOAD]", error)
    return NextResponse.json({ error: "Upload failed" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/phone-verify/upload/route.ts
git commit -m "feat(mtn-whitelist): validate and store the selected provider subset on upload"
```

---

### Task 6: Whitelist processor — filter by selection, union checked-providers

**Files:**
- Modify: `lib/phone-verify-whitelist-processor.ts`

**Interfaces:**
- Consumes: `unionProviders`, `WHITELIST_REGISTRY` (Task 2 / pre-existing) from `lib/mtn-providers/provider-whitelist.ts`.
- `decideWhitelistOutcomes`'s signature and behavior are UNCHANGED — every row in one processing chunk shares the same session-level selected providers, so folding them into the registry write is a uniform per-chunk step that belongs in the orchestrator (`processWhitelistChunk`), not the per-row pure decision function. Its existing test file (`lib/phone-verify-whitelist-processor.test.ts`) needs no changes — confirm it still passes in Step 2.

- [ ] **Step 1: Rewrite the file**

Replace the entire file with:

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { checkWhitelistBatch, unionProviders, WHITELIST_REGISTRY } from "@/lib/mtn-providers/provider-whitelist"

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
  notApplicable: number
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
 *
 * Does NOT know about provider selection or whitelist_checked_providers —
 * every row in one processing chunk shares the same session-level selected
 * provider set, so folding the newly-tried providers into
 * whitelist_checked_providers is a uniform per-chunk step handled by the
 * caller (processWhitelistChunk), not per-row decision logic.
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

/** Fetches each phone's current whitelist_checked_providers, defaulting to []. */
async function fetchCheckedProviders(
  supabase: SupabaseClient,
  phones: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  for (let i = 0; i < phones.length; i += 500) {
    const chunk = phones.slice(i, i + 500)
    const { data } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_checked_providers")
      .in("phone", chunk)
    for (const row of data ?? []) {
      result.set(row.phone, row.whitelist_checked_providers ?? [])
    }
  }
  return result
}

export async function processWhitelistChunk(
  supabase: SupabaseClient,
  sessionId: string
): Promise<WhitelistChunkResult> {
  const { data: session, error: sessionErr } = await supabase
    .from("phone_verification_sessions")
    .select("id, status, verified_count, invalid_count, not_applicable_count, whitelist_providers")
    .eq("id", sessionId)
    .single()

  if (sessionErr || !session) throw new Error("Session not found")

  if (session.status === "completed") {
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, notApplicable: session.not_applicable_count, rateLimited: 0, status: "completed" }
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
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, notApplicable: session.not_applicable_count, rateLimited: 0, status: "completed" }
  }

  // Sessions created before this feature (or a defensive fallback) use the
  // full registry; every session created going forward always has this set
  // by the upload route's provider-selection validation.
  const selectedProviders: string[] = session.whitelist_providers ?? WHITELIST_REGISTRY.map(p => p.name)
  const registry = WHITELIST_REGISTRY.filter(p => selectedProviders.includes(p.name))

  const mtnPhones = pending.filter(r => r.network === "MTN").map(r => r.phone_number)
  if (mtnPhones.length > 0 && !registry.some(p => p.configured())) {
    // Should be unreachable: the upload route already validates every
    // selected provider is configured before a session can start.
    throw new Error("No selected MTN whitelist provider is configured")
  }
  const whitelistResults = mtnPhones.length > 0
    ? await checkWhitelistBatch(mtnPhones, registry)
    : new Map<string, { allowed: boolean; allowedBy?: string }>()

  const decision = decideWhitelistOutcomes(pending, whitelistResults, now)

  if (decision.notApplicableIds.length > 0) {
    const { error: notApplicableError } = await supabase.from("phone_verification_results")
      .update({ status: "not_applicable", verified_at: now })
      .in("id", decision.notApplicableIds)
    if (notApplicableError) console.error("[PHONE-VERIFY-WHITELIST] not_applicable update failed:", notApplicableError.message)
  }
  for (const [provider, ids] of decision.verifiedByProvider) {
    const { error: verifiedError } = await supabase.from("phone_verification_results")
      .update({ status: "verified", whitelist_provider: provider, verified_at: now })
      .in("id", ids)
    if (verifiedError) console.error(`[PHONE-VERIFY-WHITELIST] verified update failed for provider ${provider}:`, verifiedError.message)
  }
  if (decision.invalidIds.length > 0) {
    const { error: invalidError } = await supabase.from("phone_verification_results")
      .update({ status: "invalid", whitelist_provider: null, verified_at: now })
      .in("id", decision.invalidIds)
    if (invalidError) console.error("[PHONE-VERIFY-WHITELIST] invalid update failed:", invalidError.message)
  }

  if (decision.registryUpserts.length > 0) {
    const phones = decision.registryUpserts.map(r => r.phone)
    const existingCheckedProviders = await fetchCheckedProviders(supabase, phones)
    const upsertsWithProviders = decision.registryUpserts.map(r => ({
      ...r,
      whitelist_checked_providers: unionProviders(existingCheckedProviders.get(r.phone) ?? [], selectedProviders),
    }))
    for (let i = 0; i < upsertsWithProviders.length; i += 500) {
      const { error: upsertError } = await supabase
        .from("mtn_number_registry")
        .upsert(upsertsWithProviders.slice(i, i + 500), { onConflict: "phone" })
      if (upsertError) console.error("[PHONE-VERIFY-WHITELIST] registry upsert failed:", upsertError.message)
    }
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
    notApplicable: newNotApplicable,
    rateLimited: 0,
    status: isDone ? "completed" : "in_progress",
  }
}
```

- [ ] **Step 2: Run tests to verify the existing decision-logic tests still pass**

Run: `npx vitest run lib/phone-verify-whitelist-processor.test.ts`
Expected: PASS — 5/5 tests, unchanged (this file's tests only exercise `decideWhitelistOutcomes`, whose signature and logic did not change in this task).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/phone-verify-whitelist-processor.ts
git commit -m "feat(mtn-whitelist): filter provider checks by session selection, union checked-providers"
```

---

### Task 7: `batch-verify` route — union checked-providers on write

**Files:**
- Modify: `app/api/admin/mtn-whitelist/batch-verify/route.ts` (full rewrite)

**Interfaces:**
- Consumes: `unionProviders` (Task 2).

This existing tool writes to the same `mtn_number_registry` rows the phone-verify upload flow does. Without this change, `whitelist_checked_providers` would only ever be populated by one of the two entry points, making the new column's cumulative guarantee false.

- [ ] **Step 1: Rewrite the route**

Replace the entire file with:

```ts
// Admin endpoint: batch-verify MTN numbers from mtn_number_registry against
// all configured whitelist providers (Xpress, Codecraft, AgentPortalGH).
// Paginated — call repeatedly with increasing ?offset until done=true.
// POST body: { offset?: number, limit?: number, providers?: "xpress,codecraft,agentportalgh" (comma-separated, default = all configured) }
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { WHITELIST_REGISTRY, checkWhitelistBatch, unionProviders } from "@/lib/mtn-providers/provider-whitelist"

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
  const attemptedProviders = configuredProviders.map(p => p.name)

  // Fetch existing checked-providers per phone so the write below unions
  // rather than overwrites — this endpoint and the phone-verification upload
  // flow both touch whitelist_checked_providers, and neither should erase
  // what the other already recorded.
  const existingCheckedProviders = new Map<string, string[]>()
  for (let i = 0; i < phones.length; i += 500) {
    const chunk = phones.slice(i, i + 500)
    const { data: existingRows } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_checked_providers")
      .in("phone", chunk)
    for (const row of existingRows ?? []) {
      existingCheckedProviders.set(row.phone, row.whitelist_checked_providers ?? [])
    }
  }

  let allowedCount = 0
  let blockedCount = 0
  const upsertRows = phones.map(phone => {
    const r = results.get(phone)
    const allowed = r?.allowed === true
    if (allowed) allowedCount++
    else blockedCount++
    return {
      phone,
      whitelist_status: allowed ? ("allowed" as const) : ("blocked" as const),
      whitelist_allowed_by: allowed ? (r?.allowedBy ?? null) : null,
      whitelist_last_checked: now,
      whitelist_retry_count: 0,
      whitelist_checked_providers: unionProviders(existingCheckedProviders.get(phone) ?? [], attemptedProviders),
    }
  })

  for (let i = 0; i < upsertRows.length; i += 500) {
    const { error: upsertError } = await supabase
      .from("mtn_number_registry")
      .upsert(upsertRows.slice(i, i + 500), { onConflict: "phone" })
    if (upsertError) console.error("[MTN-WHITELIST-BATCH-VERIFY] registry upsert failed:", upsertError.message)
  }

  const total = count ?? 0
  const nextOffset = offset + phones.length
  const done = nextOffset >= total

  return NextResponse.json({
    ok: true,
    done,
    processed: phones.length,
    allowed: allowedCount,
    blocked: blockedCount,
    nextOffset,
    total,
  })
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass (this route has no dedicated test file, matching its pre-existing untested state).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/mtn-whitelist/batch-verify/route.ts
git commit -m "feat(mtn-whitelist): union whitelist_checked_providers in batch-verify writes"
```

---

### Task 8: Surface `whitelist_providers` on the session read routes

**Files:**
- Modify: `app/api/admin/phone-verify/sessions/route.ts`
- Modify: `app/api/admin/phone-verify/session/[id]/route.ts`

**Interfaces:**
- Produces: every session object returned to the frontend now includes `whitelist_providers`. Task 9 (frontend) assumes this field is present.

- [ ] **Step 1: Update `sessions/route.ts`**

In `app/api/admin/phone-verify/sessions/route.ts`, change the `.select(...)` call from:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, status, created_at, completed_at")
```

to:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, whitelist_providers, status, created_at, completed_at")
```

- [ ] **Step 2: Update `session/[id]/route.ts`**

In `app/api/admin/phone-verify/session/[id]/route.ts`, change the session select from:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, status, created_at, completed_at")
```

to:

```ts
      .select("id, file_name, total_count, verified_count, invalid_count, not_applicable_count, check_type, whitelist_providers, status, created_at, completed_at")
```

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/phone-verify/sessions/route.ts "app/api/admin/phone-verify/session/[id]/route.ts"
git commit -m "feat(mtn-whitelist): surface whitelist_providers on session read routes"
```

---

### Task 9: Frontend — provider checkboxes

**Files:**
- Modify: `app/admin/phone-verification/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `GET /api/admin/phone-verify/whitelist-availability`'s new `providers` field (Task 3); upload response's new `whitelistProviders` field (Task 5); session objects' new `whitelist_providers` field (Task 8).

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
import { Loader2, Upload, Download, CheckCircle, XCircle, Eye, Phone, ClipboardList, Copy, CircleMinus, ShieldCheck } from "lucide-react"

type Tab = "upload" | "history"
type VerifyState = "idle" | "uploading" | "processing" | "completed" | "error"
type InputMode = "file" | "text"
type CheckType = "moolre" | "mtn_whitelist"
type ResultFilter = "all" | "verified" | "invalid" | "duplicate" | "not_applicable"

const NORMAL_DELAY_MS = 200
const MAX_BACKOFF_MS = 120_000

const PROVIDER_LABELS: Record<string, string> = {
  xpress: "Xpress",
  codecraft: "CodeCraft",
  agentportalgh: "AgentPortalGH",
}

interface Progress {
  sessionId: string
  fileName: string
  checkType: CheckType
  whitelistProviders: string[]
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
  whitelist_providers: string[] | null
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
  const [availableProviders, setAvailableProviders] = useState<Array<{ name: string; configured: boolean }>>([])
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
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
          const providers: Array<{ name: string; configured: boolean }> = Array.isArray(data.providers) ? data.providers : []
          setAvailableProviders(providers)
          setSelectedProviders(new Set(providers.filter(p => p.configured).map(p => p.name)))
        } catch {
          // Leave the defaults (whitelist enabled, no providers known yet) —
          // a real check happens server-side on upload too.
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

  const toggleProvider = (name: string) => {
    setSelectedProviders(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleFileSelect = useCallback(async (file: File) => {
    if (checkType === "mtn_whitelist" && selectedProviders.size === 0) {
      toast.error("Select at least one provider to check against")
      return
    }

    setVerifyState("uploading")
    setProgress(null)
    setResultsPage(null)

    try {
      const token = await getToken()
      const formData = new FormData()
      formData.append("file", file)
      formData.append("checkType", checkType)
      if (checkType === "mtn_whitelist") {
        formData.append("providers", Array.from(selectedProviders).join(","))
      }

      const uploadRes = await fetch("/api/admin/phone-verify/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.error ?? "Upload failed")

      const {
        sessionId, total, newCount = total, duplicates = 0,
        checkType: sessionCheckType, whitelistProviders: sessionWhitelistProviders,
      } = uploadData
      setProgress({
        sessionId, fileName: file.name, checkType: sessionCheckType ?? checkType,
        whitelistProviders: sessionWhitelistProviders ?? [],
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
          notApplicable: processData.notApplicable ?? prev.notApplicable,
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
  }, [loadResults, checkType, selectedProviders])

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
      whitelistProviders: session.whitelist_providers ?? [],
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
            {isWhitelistView
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

                  {/* Provider selection — only relevant in whitelist mode */}
                  {checkType === "mtn_whitelist" && (
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
                      <span className="text-xs text-muted-foreground">Check against:</span>
                      {availableProviders.map(p => (
                        <label
                          key={p.name}
                          className={`flex items-center gap-1.5 text-sm ${!p.configured ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          title={p.configured ? undefined : "Not configured"}
                        >
                          <input
                            type="checkbox"
                            checked={selectedProviders.has(p.name)}
                            disabled={!p.configured}
                            onChange={() => toggleProvider(p.name)}
                            className="accent-primary"
                          />
                          {PROVIDER_LABELS[p.name] ?? p.name}
                        </label>
                      ))}
                    </div>
                  )}

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
                        <Button
                          onClick={handleTextSubmit}
                          disabled={!pastedNumbers.trim() || (checkType === "mtn_whitelist" && selectedProviders.size === 0)}
                          className="gap-2"
                        >
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
                  {isWhitelistView && progress.whitelistProviders.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Checked against: {progress.whitelistProviders.map(p => PROVIDER_LABELS[p] ?? p).join(", ")}
                    </p>
                  )}
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
                                  <CircleMinus className="w-3 h-3 mr-1" /> N/A
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

Note: this session's "Checked against: ..." line is only surfaced in the progress card (shown both for an active/just-finished upload and when viewing a historical session via History → View) — the compact History table itself doesn't gain an extra column for it, to keep that table's width reasonable.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `app/admin/phone-verification/page.tsx`.

- [ ] **Step 3: Manual end-to-end verification**

Start the dev server (`npm run dev`), sign in as admin, on `/admin/phone-verification`:
1. Select "MTN Whitelist" — confirm a checkbox row appears with all 3 providers, unconfigured ones (per your local env) disabled/grayed, configured ones pre-checked.
2. Uncheck a provider, confirm the upload button/dropzone still works with the remaining selection; uncheck ALL providers, confirm an upload attempt shows the "Select at least one provider" toast and doesn't proceed.
3. Upload a small list with only one provider selected; confirm the progress card shows "Checked against: <that provider>".
4. Re-upload the SAME numbers within a few minutes with the SAME single provider selected — confirm they're marked duplicate (skipped). Re-upload again with an ADDITIONAL provider now also selected — confirm they're treated as fresh/re-checked this time (per the new coverage logic), not silently skipped.
5. View that session from History — confirm the progress card correctly shows the providers that session used.

- [ ] **Step 4: Commit**

```bash
git add app/admin/phone-verification/page.tsx
git commit -m "feat(mtn-whitelist): add provider selection checkboxes to the UI"
```

---

## Final verification

- [ ] Run the full suite once more: `npx vitest run` — expect all tests (existing + new) passing.
- [ ] Run `npx tsc --noEmit -p tsconfig.json` — expect no new errors.
- [ ] Re-read `docs/superpowers/specs/2026-08-10-phone-verification-whitelist-provider-selection-design.md` against the finished code and confirm every section (data model, dedupe, processing, upload validation, frontend, `batch-verify` union) has a corresponding implemented piece.
- [ ] Specifically double-check for any OTHER entry point that writes to `mtn_number_registry.whitelist_status`/`whitelist_allowed_by` outside of the two updated in this plan (the phone-verify whitelist processor and `batch-verify`) — the previous phone-verification feature's final review found a missed cron entry point (`app/api/cron/phone-verify/route.ts`) that this plan's Task 6 changes flow through automatically (since it just calls `processWhitelistChunk`, already fixed), but it's worth a final grep for `whitelist_status` writes across the whole repo to be sure nothing else needs the same `whitelist_checked_providers` treatment.
