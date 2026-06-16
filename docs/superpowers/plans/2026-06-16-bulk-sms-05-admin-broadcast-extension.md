# Bulk SMS — Plan 5 of 5: Admin Broadcast Extension Implementation Plan

> ### ⚠️ Cross-plan reconciliation (read first) — OVERRIDES the body where they differ
> One of 5 Bulk SMS milestone plans authored together; applied in order **M2 → M3 → M4 → M5**.
> - **Migration numbers are INDICATIVE.** At execution, use the next unused `NNNN_` prefix above the highest already in `migrations/` (don't trust literal `0065`/`0066` — allocate sequentially after M2/M3/M4).
> - **Do NOT create `lib/sms/personalize.ts`** — it is created and owned by **Milestone 3**. IMPORT it: `import { personalize } from "@/lib/sms/personalize"`. (M3 runs before M5, so the file exists.) Skip/replace any task in this plan that re-creates it.
> - **Build the Admin SMS Centre at a NEW page `app/admin/sms-centre/page.tsx`** (4 tabs: Broadcast · Contacts & Groups · Templates · Providers) and add a nav link in the admin section of `components/layout/sidebar.tsx`. **Do NOT restructure `app/admin/sms/page.tsx`** — that page belongs to Milestone 4 (metered moderation). Keeping the two admin surfaces separate matches the two-subsystem split. Replace references to `app/admin/sms/page.tsx` in this plan's tasks with `app/admin/sms-centre/page.tsx`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing admin broadcast system (the `broadcast_recipients` durable queue + `broadcast_logs` table, built before this plan) with: an address book (`sms_groups` / `sms_contacts`), global reusable templates (`sms_templates`), merge-field personalisation (via `lib/sms/personalize.ts` owned by Milestone 3), a recipient resolver (`lib/sms/recipients.ts`), DB-configurable provider routing (`lib/sms/routing.ts` — migrates today's env-only routing to `admin_settings` rows), sender-ID management (`sms_sender_ids`), and a restructured **Admin SMS Centre** at `app/admin/sms/` with four tabs (Broadcast · Contacts & Groups · Templates · Providers).

**Architecture:** Everything in this plan touches **only the un-metered admin broadcast path**. The credit ledger, content filter, and solvency gate are strictly subsystem-B concerns — they must not be imported or called here. The broadcast itself still travels through the existing `broadcast_recipients` queue and `lib/broadcast-drain.ts`; this plan adds the pre-send address-book resolution, merge rendering, and a richer compose UI in front of that queue. DB-configurable routing slots in beneath the existing `sendSMS` entry point in `lib/sms-service.ts` with a `getRoutingConfig()` call that replaces the `process.env.SMS_PROVIDER` read, preserving the env var as a compile-time fallback. The address-book tables are service-role–only (admin API check is the boundary; no client RLS hole).

**Tech Stack:** Next.js 15 App Router (route handlers + RSC), Supabase (Postgres + RLS, service-role client), Vitest (unit tests), TypeScript.

**Spec:** `docs/superpowers/specs/2026-06-16-bulk-sms-platform-design.md` — "Revision B → Admin broadcast additions (Subsystem A)."

---

## File Structure

**Create:**
- `migrations/0065_admin_broadcast_address_book.sql` — `sms_groups`, `sms_contacts`, `sms_templates`, `sms_sender_ids` tables + RLS + indexes
- `migrations/0066_sms_routing_settings.sql` — seed `admin_settings` rows for `sms_primary_provider` / `sms_fallback_providers` (upsert-safe)
- `lib/sms/personalize.ts` — `personalize(message, vars)` merge-field renderer (owned here as M3 is not yet built)
- `lib/sms/personalize.test.ts` — unit tests
- `lib/sms/recipients.ts` — `resolveRecipients(spec, supabase)` resolver: platform-user audiences + group audiences, dedupe + opt-out filter
- `lib/sms/recipients.test.ts` — unit tests with fake Supabase client
- `lib/sms/routing.ts` — `getRoutingConfig()` with 5-min TTL cache + `invalidateRoutingCache()`
- `lib/sms/routing.test.ts` — unit tests
- `app/api/admin/sms-groups/route.ts` — GET (list) + POST (create)
- `app/api/admin/sms-groups/[id]/route.ts` — GET + PATCH + DELETE
- `app/api/admin/sms-contacts/route.ts` — GET (list by group) + POST (single add) + POST with CSV bulk-import
- `app/api/admin/sms-contacts/[id]/route.ts` — PATCH (opted_out toggle) + DELETE
- `app/api/admin/sms-templates/route.ts` — GET + POST
- `app/api/admin/sms-templates/[id]/route.ts` — PATCH + DELETE
- `app/api/admin/sms-settings/route.ts` — GET + PATCH (provider routing; invalidates cache on write)
- `app/api/admin/sms-sender-ids/route.ts` — GET + POST (submit to Moolre type 3)
- `app/api/cron/sms-senderid-poll/route.ts` — poll pending sender IDs via Moolre type 1
- `app/admin/sms/page.tsx` — restructured 4-tab SMS Centre (Broadcast · Contacts & Groups · Templates · Providers)

**Modify:**
- `lib/sms-service.ts` — replace `process.env.SMS_PROVIDER` / `SMS_FALLBACK_PROVIDER` reads in `sendSMS` with a `getRoutingConfig()` call; keep env vars as compile-time fallbacks inside `getRoutingConfig()`
- `app/api/admin/broadcast/route.ts` — accept optional `groupId` in `recipients` (alongside existing `'roles'`/`'specific'`); accept optional `templateId` and `mergeFields` boolean; resolve group recipients via `resolveRecipients` and personalise per-recipient before enqueue
- `vercel.json` — register `sms-senderid-poll` cron (every 5 minutes)

**Do NOT touch:**
- `lib/sms/content-filter.ts` (subsystem B)
- `lib/sms/account-service.ts`, `lib/sms/bundle-service.ts`, credit RPCs (subsystem B)
- `sms_accounts`, `sms_unit_transactions`, `sms_pending_credits` (subsystem B)

---

## Conventions

- **Admin auth:** all `/api/admin/*` routes call `verifyAdminAccess(req)` from `@/lib/admin-auth` first; return `errorResponse` if not admin.
- **Service-role client:** use `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)` — never the anon client for address-book operations.
- **Phone normalisation:** import `normalizeGhanaPhone` from `@/lib/phone-format` (returns `0XXXXXXXXX` | `null`). A `null` result means unparseable — collect it into a `skipped` bucket, never silently drop.
- **No credit RPCs:** do not import or call `credit_sms_units_if_solvent`, `debit_sms_for_send`, `adjust_sms_units`, or any solvency helper. This path is un-metered.
- **Test pattern:** pure logic (`personalize`, `resolveRecipients` pure transforms, routing parser) gets real Vitest unit tests. Route logic uses the `vi.hoisted` fake-client pattern established in `lib/sms/bundle-service.test.ts`.
- **Migration operator flow:** write `.sql` file → apply via Supabase Management API or `psql` → smoke-verify with a `SELECT` query.
- **Merge-field syntax:** `[FirstName]`, `[LastName]`, `[Phone]` (square-bracket style, as specified in the Revision B spec).

---

## Tasks

### Task 1 — Migration: address-book + sender-ID tables

- [ ] Create `migrations/0065_admin_broadcast_address_book.sql`:

```sql
-- ============================================================
-- 0065_admin_broadcast_address_book.sql
-- Admin broadcast address book: groups, contacts, templates,
-- sender IDs.  All tables are service-role-only (no client RLS
-- exposure — admin API routes are the access boundary).
-- ============================================================

-- sms_groups -------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_groups_name ON sms_groups(name);

ALTER TABLE sms_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_groups" ON sms_groups;
CREATE POLICY "service_role_sms_groups" ON sms_groups
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- sms_contacts -----------------------------------------------
CREATE TABLE IF NOT EXISTS sms_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES sms_groups(id) ON DELETE CASCADE,
  first_name   TEXT,
  last_name    TEXT,
  phone_number TEXT NOT NULL,           -- stored normalised: 0XXXXXXXXX
  opted_out    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, phone_number)       -- idempotent per-group dedupe
);

CREATE INDEX IF NOT EXISTS idx_sms_contacts_group    ON sms_contacts(group_id);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_phone    ON sms_contacts(phone_number);
CREATE INDEX IF NOT EXISTS idx_sms_contacts_opted_out ON sms_contacts(group_id, opted_out)
  WHERE opted_out = false;

ALTER TABLE sms_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_contacts" ON sms_contacts;
CREATE POLICY "service_role_sms_contacts" ON sms_contacts
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- sms_templates (global, admin-managed) ----------------------
CREATE TABLE IF NOT EXISTS sms_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  body       TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sms_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_templates" ON sms_templates;
CREATE POLICY "service_role_sms_templates" ON sms_templates
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- sms_sender_ids (admin-managed, Moolre-registered) ----------
CREATE TABLE IF NOT EXISTS sms_sender_ids (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id      TEXT NOT NULL UNIQUE CHECK (char_length(sender_id) BETWEEN 1 AND 11),
  moolre_status  TEXT,                  -- raw status from Moolre type-1 response
  local_status   TEXT NOT NULL DEFAULT 'pending'  -- pending | active | rejected
                   CHECK (local_status IN ('pending','active','rejected')),
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_sender_ids_status ON sms_sender_ids(local_status);

ALTER TABLE sms_sender_ids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_sms_sender_ids" ON sms_sender_ids;
CREATE POLICY "service_role_sms_sender_ids" ON sms_sender_ids
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

- [ ] Apply the migration via Supabase Management API (SQL editor or `psql`).
- [ ] Smoke-verify:
  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('sms_groups','sms_contacts','sms_templates','sms_sender_ids');
  -- Expected: 4 rows
  ```

---

### Task 2 — Migration: seed routing settings in admin_settings

- [ ] Create `migrations/0066_sms_routing_settings.sql`:

```sql
-- ============================================================
-- 0066_sms_routing_settings.sql
-- Seed DB-configurable SMS provider routing keys.
-- Uses INSERT … ON CONFLICT DO NOTHING so safe to re-run.
-- ============================================================

INSERT INTO admin_settings (key, value, updated_at)
VALUES
  ('sms_primary_provider',   'moolre',          now()),
  ('sms_fallback_providers', '["mnotify"]',      now())
ON CONFLICT (key) DO NOTHING;
```

- [ ] Apply via Management API.
- [ ] Smoke-verify:
  ```sql
  SELECT key, value FROM admin_settings
  WHERE key IN ('sms_primary_provider','sms_fallback_providers');
  -- Expected: 2 rows
  ```

---

### Task 3 — Pure lib: `lib/sms/personalize.ts` + tests

Write the merge-field renderer test-first.

- [ ] Create `lib/sms/personalize.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { personalize } from "./personalize"

describe("personalize", () => {
  it("replaces [FirstName]", () => {
    expect(personalize("Hi [FirstName]!", { firstName: "Ama" })).toBe("Hi Ama!")
  })

  it("replaces [LastName]", () => {
    expect(personalize("Dear [LastName],", { lastName: "Mensah" })).toBe("Dear Mensah,")
  })

  it("replaces [Phone]", () => {
    expect(personalize("Your number is [Phone].", { phone: "0241234567" })).toBe(
      "Your number is 0241234567."
    )
  })

  it("replaces all three in one message", () => {
    expect(
      personalize("Hi [FirstName] [LastName], your number is [Phone].", {
        firstName: "Ama",
        lastName: "Mensah",
        phone: "0241234567",
      })
    ).toBe("Hi Ama Mensah, your number is 0241234567.")
  })

  it("leaves token in place when value is undefined", () => {
    expect(personalize("Hi [FirstName]!", {})).toBe("Hi [FirstName]!")
  })

  it("is case-insensitive on tokens", () => {
    expect(personalize("Hi [firstname]!", { firstName: "Kojo" })).toBe("Hi Kojo!")
  })

  it("replaces multiple occurrences of the same token", () => {
    expect(personalize("[FirstName] and [FirstName]", { firstName: "Ama" })).toBe("Ama and Ama")
  })

  it("returns the original message unchanged when no tokens", () => {
    const msg = "Hello, this is a plain message."
    expect(personalize(msg, { firstName: "Ama" })).toBe(msg)
  })
})
```

- [ ] Run `npm test -- lib/sms/personalize` — expect **8 failing** tests.
- [ ] Create `lib/sms/personalize.ts`:

```typescript
/**
 * Merge-field personalization for admin broadcast messages.
 * Tokens: [FirstName], [LastName], [Phone] (case-insensitive).
 * Un-metered broadcast path — do NOT import credit or content-filter helpers.
 */

export interface MergeVars {
  firstName?: string
  lastName?: string
  phone?: string
}

/**
 * Replace merge tokens in `message` with values from `vars`.
 * Tokens without a corresponding value are left unchanged.
 */
export function personalize(message: string, vars: MergeVars): string {
  let out = message
  if (vars.firstName !== undefined) {
    out = out.replace(/\[firstname\]/gi, vars.firstName)
  }
  if (vars.lastName !== undefined) {
    out = out.replace(/\[lastname\]/gi, vars.lastName)
  }
  if (vars.phone !== undefined) {
    out = out.replace(/\[phone\]/gi, vars.phone)
  }
  return out
}
```

- [ ] Run `npm test -- lib/sms/personalize` — expect **8 passing**.

---

### Task 4 — Pure lib: `lib/sms/recipients.ts` + tests

Recipient resolver — turns an audience spec into a normalised, deduped, opt-out-filtered contact list.

- [ ] Create `lib/sms/recipients.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { buildContactList } from "./recipients"
import type { Contact } from "./recipients"

// ---------------------------------------------------------------------------
// buildContactList is the pure transform layer (normalize → filter-null →
// dedupe → drop opted_out).  It takes pre-fetched rows so it is fully
// unit-testable without Supabase.
// ---------------------------------------------------------------------------

describe("buildContactList", () => {
  const raw = (
    phone: string,
    opts: { firstName?: string; lastName?: string; optedOut?: boolean } = {}
  ) => ({
    phone_number: phone,
    first_name: opts.firstName ?? null,
    last_name: opts.lastName ?? null,
    opted_out: opts.optedOut ?? false,
  })

  it("normalises Ghanaian numbers to 0XXXXXXXXX form", () => {
    const result = buildContactList([raw("233241234567")])
    expect(result.contacts[0].phone).toBe("0241234567")
  })

  it("filters out un-parseable numbers into skipped", () => {
    const result = buildContactList([raw("not-a-number")])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].reason).toBe("invalid_phone")
  })

  it("dedupes by normalised phone (keeps first occurrence)", () => {
    const result = buildContactList([raw("0241234567"), raw("233241234567")])
    expect(result.contacts).toHaveLength(1)
    expect(result.contacts[0].phone).toBe("0241234567")
  })

  it("drops opted-out contacts", () => {
    const result = buildContactList([raw("0241234567", { optedOut: true })])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped[0].reason).toBe("opted_out")
  })

  it("preserves first_name and last_name", () => {
    const result = buildContactList([raw("0241234567", { firstName: "Ama", lastName: "Mensah" })])
    const c = result.contacts[0]
    expect(c.firstName).toBe("Ama")
    expect(c.lastName).toBe("Mensah")
  })

  it("handles an empty input without error", () => {
    const result = buildContactList([])
    expect(result.contacts).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it("processes mixed valid, invalid, and opted-out in one pass", () => {
    const result = buildContactList([
      raw("0241234567"),
      raw("bad"),
      raw("0209999999", { optedOut: true }),
      raw("0241234567"), // duplicate
    ])
    expect(result.contacts).toHaveLength(1)
    expect(result.skipped).toHaveLength(3) // bad + opted_out + duplicate
  })
})
```

- [ ] Run `npm test -- lib/sms/recipients` — expect **7 failing** tests.
- [ ] Create `lib/sms/recipients.ts`:

```typescript
/**
 * Recipient resolver for admin broadcast.
 * Un-metered path — no credit RPCs, no content filter.
 */

import { normalizeGhanaPhone } from "@/lib/phone-format"
import type { SupabaseClient } from "@supabase/supabase-js"

export interface Contact {
  phone: string
  firstName?: string
  lastName?: string
}

export interface Skipped {
  rawPhone: string
  reason: "invalid_phone" | "opted_out" | "duplicate"
}

export interface ResolveResult {
  contacts: Contact[]
  skipped: Skipped[]
}

// ---------------------------------------------------------------------------
// buildContactList — pure transform; testable without DB
// ---------------------------------------------------------------------------

interface RawContactRow {
  phone_number: string
  first_name: string | null
  last_name: string | null
  opted_out: boolean
}

export function buildContactList(rows: RawContactRow[]): ResolveResult {
  const contacts: Contact[] = []
  const skipped: Skipped[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const normalised = normalizeGhanaPhone(row.phone_number)

    if (normalised === null) {
      skipped.push({ rawPhone: row.phone_number, reason: "invalid_phone" })
      continue
    }

    if (row.opted_out) {
      skipped.push({ rawPhone: row.phone_number, reason: "opted_out" })
      continue
    }

    if (seen.has(normalised)) {
      skipped.push({ rawPhone: row.phone_number, reason: "duplicate" })
      continue
    }

    seen.add(normalised)
    contacts.push({
      phone: normalised,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
    })
  }

  return { contacts, skipped }
}

// ---------------------------------------------------------------------------
// AudienceSpec — the two supported audience shapes for admin broadcast
// ---------------------------------------------------------------------------

export type AudienceSpec =
  | { type: "users"; roles?: string[]; userIds?: string[] }
  | { type: "group"; groupId: string }

// ---------------------------------------------------------------------------
// resolveRecipients — fetches rows from DB then runs buildContactList
// ---------------------------------------------------------------------------

export async function resolveRecipients(
  spec: AudienceSpec,
  supabase: SupabaseClient
): Promise<ResolveResult> {
  if (spec.type === "group") {
    const { data, error } = await supabase
      .from("sms_contacts")
      .select("phone_number, first_name, last_name, opted_out")
      .eq("group_id", spec.groupId)

    if (error) throw error
    return buildContactList(data ?? [])
  }

  // type === "users": fetch from the users table
  let query = supabase.from("users").select("phone, first_name:name, last_name")

  if (spec.roles && spec.roles.length > 0) {
    query = query.in("role", spec.roles)
  }
  if (spec.userIds && spec.userIds.length > 0) {
    query = query.in("id", spec.userIds)
  }

  const { data, error } = await query
  if (error) throw error

  // Map user rows to the RawContactRow shape
  const rows: RawContactRow[] = (data ?? []).map((u: any) => ({
    phone_number: u.phone ?? "",
    first_name: u.first_name ?? null,
    last_name: u.last_name ?? null,
    opted_out: false, // users table has no opted_out flag — honour at contacts level only
  }))

  return buildContactList(rows)
}
```

- [ ] Run `npm test -- lib/sms/recipients` — expect **7 passing**.

---

### Task 5 — Pure lib: `lib/sms/routing.ts` + tests

DB-configurable provider routing with a 5-minute TTL in-memory cache.

- [ ] Create `lib/sms/routing.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist the fake admin_settings store before any module import
const mockSettings = vi.hoisted(() => ({
  store: {} as Record<string, string>,
  reset() {
    this.store = {
      sms_primary_provider: "moolre",
      sms_fallback_providers: '["mnotify"]',
    }
  },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (_: string) => ({
      select: () => ({
        in: (_col: string, keys: string[]) => ({
          data: keys
            .filter((k) => k in mockSettings.store)
            .map((k) => ({ key: k, value: mockSettings.store[k] })),
          error: null,
        }),
      }),
    }),
  })),
}))

// Import AFTER mock registration
import { parseRoutingConfig, type RoutingConfig } from "./routing"

describe("parseRoutingConfig", () => {
  it("returns primary + fallbacks from settings rows", () => {
    const rows = [
      { key: "sms_primary_provider", value: "moolre" },
      { key: "sms_fallback_providers", value: '["mnotify","brevo"]' },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.primary).toBe("moolre")
    expect(result.fallbacks).toEqual(["mnotify", "brevo"])
  })

  it("falls back to env defaults when rows are missing", () => {
    const result = parseRoutingConfig([])
    // env fallback is tested via the module default; just assert type safety
    expect(typeof result.primary).toBe("string")
    expect(Array.isArray(result.fallbacks)).toBe(true)
  })

  it("handles malformed JSON for fallbacks by returning an empty array", () => {
    const rows = [
      { key: "sms_primary_provider", value: "mnotify" },
      { key: "sms_fallback_providers", value: "not-json" },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.primary).toBe("mnotify")
    expect(result.fallbacks).toEqual([])
  })

  it("trims unknown provider names out of the fallback list", () => {
    const rows = [
      { key: "sms_primary_provider", value: "moolre" },
      { key: "sms_fallback_providers", value: '["mnotify","unknown_provider"]' },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.fallbacks).toEqual(["mnotify"])
  })
})
```

- [ ] Run `npm test -- lib/sms/routing` — expect **4 failing**.
- [ ] Create `lib/sms/routing.ts`:

```typescript
/**
 * DB-configurable SMS provider routing.
 *
 * Reads `admin_settings` rows `sms_primary_provider` and
 * `sms_fallback_providers` (JSON array string).  Falls back to env vars
 * (SMS_PROVIDER / SMS_FALLBACK_PROVIDER) so existing deployments are
 * unaffected before the DB rows are seeded.
 *
 * Un-metered broadcast path — no credit helpers imported.
 */

import { createClient } from "@supabase/supabase-js"

const VALID_PROVIDERS = ["moolre", "mnotify", "brevo"] as const
type Provider = (typeof VALID_PROVIDERS)[number]

export interface RoutingConfig {
  primary: Provider | string
  fallbacks: (Provider | string)[]
}

// ---------------------------------------------------------------------------
// parseRoutingConfig — pure; exported for unit tests
// ---------------------------------------------------------------------------

interface SettingRow {
  key: string
  value: string
}

export function parseRoutingConfig(rows: SettingRow[]): RoutingConfig {
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))

  const primary =
    (map["sms_primary_provider"] as Provider) ||
    (process.env.SMS_PROVIDER as Provider) ||
    "moolre"

  let fallbacks: (Provider | string)[] = []
  try {
    const raw = map["sms_fallback_providers"] ?? process.env.SMS_FALLBACK_PROVIDER ?? '["mnotify"]'
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      fallbacks = parsed.filter((p) => VALID_PROVIDERS.includes(p as Provider))
    }
  } catch {
    fallbacks = []
  }

  return { primary, fallbacks }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000

let _cached: RoutingConfig | null = null
let _cachedAt = 0

export function invalidateRoutingCache(): void {
  _cached = null
  _cachedAt = 0
}

export async function getRoutingConfig(): Promise<RoutingConfig> {
  if (_cached && Date.now() - _cachedAt < CACHE_TTL_MS) return _cached

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", ["sms_primary_provider", "sms_fallback_providers"])

    if (error) throw error

    _cached = parseRoutingConfig(data ?? [])
    _cachedAt = Date.now()
    return _cached
  } catch {
    // On any DB error, fall back to env / defaults without poisoning the cache
    return parseRoutingConfig([])
  }
}
```

- [ ] Run `npm test -- lib/sms/routing` — expect **4 passing**.

---

### Task 6 — Wire `getRoutingConfig()` into `lib/sms-service.ts`

Replace the env-only provider reads in `sendSMS` with DB-driven config. The env vars remain as the fallback inside `getRoutingConfig()`.

- [ ] In `lib/sms-service.ts`, add the import near the top (after existing imports):

```typescript
import { getRoutingConfig } from "@/lib/sms/routing"
```

- [ ] Locate the `sendSMS` function. The current provider resolution block looks like:

```typescript
const fallback = process.env.SMS_FALLBACK_PROVIDER || 'mnotify'
// ...
const lead = breakerOpen ? fallback : (process.env.SMS_OTP_PROVIDER || SMS_PROVIDER)
// ...
order = [SMS_PROVIDER, fallback, 'brevo', 'moolre']
```

Replace that block with a DB-config call (make `sendSMS` async if it isn't already, or adapt with a top-level `await`). The replacement must preserve the OTP-breaker special case:

```typescript
const routing = await getRoutingConfig()
const primaryProvider = routing.primary
const fallbackProvider = routing.fallbacks[0] ?? "mnotify"

let order: string[]
if (payload.type === "otp") {
  const breakerOpen = await isSmsOtpBreakerOpen(supabase)
  const lead = breakerOpen ? fallbackProvider : (process.env.SMS_OTP_PROVIDER || primaryProvider)
  order = [lead, fallbackProvider, primaryProvider].filter(Boolean)
} else {
  order = [primaryProvider, ...routing.fallbacks].filter(Boolean)
}
// Deduplicate while preserving order
order = [...new Set(order)]
if (order.length === 0) order = [primaryProvider]
```

- [ ] Verify the file compiles: `npx tsc --noEmit` (no new errors expected).

---

### Task 7 — Admin CRUD routes: Groups + Contacts

- [ ] Create `app/api/admin/sms-groups/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase().from("sms_groups").select("*").order("created_at", { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ groups: data })
}

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()
  const { name, description } = body
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name is required" }, { status: 400 })
  }

  const { data, error } = await supabase()
    .from("sms_groups")
    .insert({ name: name.trim(), description: description ?? null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ group: data }, { status: 201 })
}
```

- [ ] Create `app/api/admin/sms-groups/[id]/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const { data, error } = await supabase().from("sms_groups").select("*").eq("id", id).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 404 })
  return NextResponse.json({ group: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const body = await req.json()
  const updates: Record<string, unknown> = {}
  if (typeof body.name === "string") updates.name = body.name.trim()
  if (typeof body.description === "string") updates.description = body.description
  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase()
    .from("sms_groups")
    .update(updates)
    .eq("id", id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ group: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const { error } = await supabase().from("sms_groups").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] Create `app/api/admin/sms-contacts/route.ts` (single-add + bulk CSV import):

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { normalizeGhanaPhone } from "@/lib/phone-format"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const groupId = req.nextUrl.searchParams.get("group_id")
  if (!groupId) return NextResponse.json({ error: "group_id is required" }, { status: 400 })

  const { data, error } = await supabase()
    .from("sms_contacts")
    .select("*")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ contacts: data })
}

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()
  const { group_id, contacts: rawContacts } = body

  if (!group_id) return NextResponse.json({ error: "group_id is required" }, { status: 400 })
  if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
    return NextResponse.json({ error: "contacts array is required" }, { status: 400 })
  }
  if (rawContacts.length > 5000) {
    return NextResponse.json({ error: "max 5000 contacts per import" }, { status: 400 })
  }

  const inserted: object[] = []
  const skipped: { raw: string; reason: string }[] = []

  for (const c of rawContacts) {
    const normalised = normalizeGhanaPhone(c.phone ?? c.phone_number ?? "")
    if (!normalised) {
      skipped.push({ raw: c.phone ?? c.phone_number ?? "", reason: "invalid_phone" })
      continue
    }
    inserted.push({
      group_id,
      phone_number: normalised,
      first_name: c.first_name ?? c.firstName ?? null,
      last_name: c.last_name ?? c.lastName ?? null,
      opted_out: false,
    })
  }

  if (inserted.length === 0) {
    return NextResponse.json({ inserted: 0, skipped }, { status: 422 })
  }

  // ON CONFLICT (group_id, phone_number) DO NOTHING — idempotent per-group dedupe
  const { error } = await supabase().from("sms_contacts").upsert(inserted, {
    onConflict: "group_id,phone_number",
    ignoreDuplicates: true,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ inserted: inserted.length, skipped }, { status: 201 })
}
```

- [ ] Create `app/api/admin/sms-contacts/[id]/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const body = await req.json()
  const updates: Record<string, unknown> = {}
  if (typeof body.opted_out === "boolean") updates.opted_out = body.opted_out
  if (typeof body.first_name === "string") updates.first_name = body.first_name
  if (typeof body.last_name === "string") updates.last_name = body.last_name

  const { data, error } = await supabase()
    .from("sms_contacts")
    .update(updates)
    .eq("id", id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ contact: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const { error } = await supabase().from("sms_contacts").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

---

### Task 8 — Admin CRUD routes: Templates

- [ ] Create `app/api/admin/sms-templates/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { data, error } = await supabase().from("sms_templates").select("*").order("name")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ templates: data })
}

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const body = await req.json()
  const { name, body: msgBody } = body
  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 })
  if (!msgBody?.trim()) return NextResponse.json({ error: "body is required" }, { status: 400 })
  const { data, error } = await supabase()
    .from("sms_templates")
    .insert({ name: name.trim(), body: msgBody.trim() })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data }, { status: 201 })
}
```

- [ ] Create `app/api/admin/sms-templates/[id]/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const body = await req.json()
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.name === "string") updates.name = body.name.trim()
  if (typeof body.body === "string") updates.body = body.body.trim()
  const { data, error } = await supabase()
    .from("sms_templates")
    .update(updates)
    .eq("id", id)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ template: data })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const { error } = await supabase().from("sms_templates").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

---

### Task 9 — Admin route: SMS settings (provider routing)

- [ ] Create `app/api/admin/sms-settings/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { invalidateRoutingCache } from "@/lib/sms/routing"

const ROUTING_KEYS = ["sms_primary_provider", "sms_fallback_providers"] as const
const VALID_PROVIDERS = ["moolre", "mnotify", "brevo"]

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase()
    .from("admin_settings")
    .select("key, value")
    .in("key", ROUTING_KEYS)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ settings: Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) })
}

export async function PATCH(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()

  if (body.sms_primary_provider !== undefined) {
    if (!VALID_PROVIDERS.includes(body.sms_primary_provider)) {
      return NextResponse.json({ error: `sms_primary_provider must be one of: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 })
    }
    await supabase()
      .from("admin_settings")
      .upsert({ key: "sms_primary_provider", value: body.sms_primary_provider, updated_at: new Date().toISOString() }, { onConflict: "key" })
  }

  if (body.sms_fallback_providers !== undefined) {
    if (!Array.isArray(body.sms_fallback_providers)) {
      return NextResponse.json({ error: "sms_fallback_providers must be an array" }, { status: 400 })
    }
    const invalid = body.sms_fallback_providers.filter((p: string) => !VALID_PROVIDERS.includes(p))
    if (invalid.length > 0) {
      return NextResponse.json({ error: `Unknown providers: ${invalid.join(", ")}` }, { status: 400 })
    }
    await supabase()
      .from("admin_settings")
      .upsert({ key: "sms_fallback_providers", value: JSON.stringify(body.sms_fallback_providers), updated_at: new Date().toISOString() }, { onConflict: "key" })
  }

  // Invalidate the in-memory routing cache so the next sendSMS picks up the new config
  invalidateRoutingCache()

  return NextResponse.json({ ok: true })
}
```

---

### Task 10 — Sender-ID management: submit + poll

- [ ] Create `app/api/admin/sms-sender-ids/route.ts`:

```typescript
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const MOOLRE_BASE = "https://api.moolre.com"

const supabase = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const { data, error } = await supabase()
    .from("sms_sender_ids")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ senderIds: data })
}

export async function POST(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const body = await req.json()
  const { sender_id } = body

  if (!sender_id || typeof sender_id !== "string" || sender_id.trim().length === 0) {
    return NextResponse.json({ error: "sender_id is required" }, { status: 400 })
  }
  if (sender_id.trim().length > 11) {
    return NextResponse.json({ error: "sender_id must be 11 characters or fewer" }, { status: 400 })
  }

  const sid = sender_id.trim()

  // Submit to Moolre (type 3, no approve — ASMQ09 constraint)
  try {
    const res = await fetch(`${MOOLRE_BASE}/open/sms/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-VASKEY": process.env.MOOLRE_API_KEY!,
      },
      body: JSON.stringify({ type: 3, senderids: [{ senderid: sid }] }),
    })
    const json = await res.json()
    // Log the Moolre response but don't block on it — they may return ASMQ09 even on success
    console.log("[SENDER-ID] Moolre submit response:", JSON.stringify(json))
  } catch (e) {
    console.error("[SENDER-ID] Moolre submit failed:", e)
    // Don't hard-fail — upsert the row as pending so the poll cron retries status
  }

  const { data, error } = await supabase()
    .from("sms_sender_ids")
    .upsert(
      { sender_id: sid, local_status: "pending", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { onConflict: "sender_id" }
    )
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ senderId: data }, { status: 201 })
}
```

- [ ] Create `app/api/cron/sms-senderid-poll/route.ts`:

```typescript
/**
 * Polls pending/active sender IDs against Moolre type-1 query.
 * Runs every 5 minutes via vercel.json cron.
 * Auth: CRON_SECRET header or verifyAdminAccess.
 */
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const MOOLRE_BASE = "https://api.moolre.com"

export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret")
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Only poll non-active IDs (pending and rejected get re-polled in case of transient failure)
  const { data: rows, error } = await supabase
    .from("sms_sender_ids")
    .select("id, sender_id, local_status")
    .neq("local_status", "active")
    .order("last_polled_at", { ascending: true, nullsFirst: true })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ polled: 0 })

  let updated = 0
  for (const row of rows) {
    try {
      const res = await fetch(`${MOOLRE_BASE}/open/sms/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-VASKEY": process.env.MOOLRE_API_KEY!,
        },
        body: JSON.stringify({ type: 1, senderid: row.sender_id }),
      })
      const json = await res.json()
      const moolreStatus = json?.data?.status ?? json?.status ?? null
      // Moolre returns ASMQ02 for "Approved"
      const localStatus =
        moolreStatus === "ASMQ02" || moolreStatus === "Approved" ? "active"
        : moolreStatus === "ASMQ07" || moolreStatus === "Rejected" ? "rejected"
        : "pending"

      await supabase
        .from("sms_sender_ids")
        .update({ moolre_status: moolreStatus, local_status: localStatus, last_polled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", row.id)

      updated++
    } catch (e) {
      console.error(`[SENDERID-POLL] error polling ${row.sender_id}:`, e)
    }
  }

  return NextResponse.json({ polled: rows.length, updated })
}
```

---

### Task 11 — Extend broadcast route to accept group audiences + merge fields

Modify `app/api/admin/broadcast/route.ts` to support two new optional fields on the `init` action:
- `recipients.type === "group"` — resolve via `resolveRecipients`
- `mergeFields: true` — personalise each recipient's message via `personalize` before enqueue

- [ ] In `app/api/admin/broadcast/route.ts`, add imports after existing imports:

```typescript
import { resolveRecipients } from "@/lib/sms/recipients"
import { personalize } from "@/lib/sms/personalize"
```

- [ ] After the `recipients.type` validation block (currently checks for `'roles'`/`'specific'`), add a third accepted type:

```typescript
// Add "group" as a valid recipients type alongside existing "roles" / "specific"
if (!["roles", "specific", "group"].includes(recipients.type)) {
  return NextResponse.json({ error: "recipients.type must be 'roles', 'specific', or 'group'" }, { status: 400 })
}
if (recipients.type === "group" && !recipients.groupId) {
  return NextResponse.json({ error: "recipients.groupId is required for group targeting" }, { status: 400 })
}
```

- [ ] Before the `enqueueRecipients` call, resolve the group audience when `recipients.type === "group"`:

```typescript
// Resolve group contacts → flatten to specificUsers shape so enqueueRecipients can process them
let resolvedSpecificUsers = recipients.users ?? []
if (recipients.type === "group") {
  const resolved = await resolveRecipients({ type: "group", groupId: recipients.groupId }, supabase)
  resolvedSpecificUsers = resolved.contacts.map((c) => ({
    id: undefined,
    phone: c.phone,
    name: c.firstName ? `${c.firstName} ${c.lastName ?? ""}`.trim() : undefined,
    // Store merge vars so the enqueue step can personalise
    _mergeVars: { firstName: c.firstName, lastName: c.lastName, phone: c.phone },
  }))
  if (resolvedSpecificUsers.length === 0) {
    return NextResponse.json({ error: "No eligible contacts in the selected group (all opted out or invalid)" }, { status: 400 })
  }
}

// Personalise message per-recipient when mergeFields flag is set
const { mergeFields = false } = body
const buildMessage = (recipient: any) => {
  if (!mergeFields || !recipient._mergeVars) return message
  return personalize(message, recipient._mergeVars)
}
```

> Note: `enqueueRecipients` in `lib/broadcast-drain.ts` currently accepts a single `message` string. For per-recipient personalisation, pass a `renderedMessage` field on each recipient object; update `enqueueRecipients` to use `recipient.renderedMessage ?? message` when inserting into `broadcast_recipients`. This is a minimal, backwards-compatible change.

- [ ] In `lib/broadcast-drain.ts`, locate the `enqueueRecipients` insert. Change the message stored per row from the global `message` to `recipient.renderedMessage ?? message`:

```typescript
// In the bulk insert inside enqueueRecipients, change:
//   message: message
// to:
//   message: recipient.renderedMessage ?? message
```

- [ ] Back in the broadcast route, after `resolvedSpecificUsers` is built, tag each with `renderedMessage`:

```typescript
if (mergeFields) {
  resolvedSpecificUsers = resolvedSpecificUsers.map((r: any) => ({
    ...r,
    renderedMessage: buildMessage(r),
  }))
}
```

- [ ] Pass the (possibly updated) users to `enqueueRecipients`:

```typescript
const enqueued = await enqueueRecipients(supabase, broadcastId, {
  targetType: recipients.type === "group" ? "specific" : recipients.type,
  roles: recipients.roles,
  specificUsers: recipients.type === "group" ? resolvedSpecificUsers : recipients.users,
})
```

---

### Task 12 — Register the sender-ID poll cron in `vercel.json`

- [ ] Open `vercel.json`. Locate the `crons` array. Add:

```json
{ "path": "/api/cron/sms-senderid-poll", "schedule": "*/5 * * * *" }
```

- [ ] Verify the `vercel.json` is valid JSON: `node -e "require('./vercel.json')"` (no output = valid).

---

### Task 13 — Restructure `app/admin/sms/page.tsx` into the 4-tab SMS Centre

The existing page is a minimal scaffold (52 lines, bare "Allocate units" + bundles list). Replace it with a 4-tab layout. Each tab is a self-contained client component that fetches its own data. The metered-tenant moderation view (Milestone 4) lives at a separate admin route — do not duplicate it here.

- [ ] Replace the full contents of `app/admin/sms/page.tsx`:

```typescript
"use client"

import { useState } from "react"
import BroadcastTab from "./_components/BroadcastTab"
import ContactsTab from "./_components/ContactsTab"
import TemplatesTab from "./_components/TemplatesTab"
import ProvidersTab from "./_components/ProvidersTab"

type Tab = "broadcast" | "contacts" | "templates" | "providers"

export default function AdminSmsCentrePage() {
  const [activeTab, setActiveTab] = useState<Tab>("broadcast")

  const tabs: { id: Tab; label: string }[] = [
    { id: "broadcast", label: "Broadcast" },
    { id: "contacts", label: "Contacts & Groups" },
    { id: "templates", label: "Templates" },
    { id: "providers", label: "Providers" },
  ]

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">SMS Centre</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={[
              "px-4 py-2 text-sm font-medium rounded-t transition-colors",
              activeTab === t.id
                ? "bg-background border border-b-background border-border text-foreground -mb-px"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div className="pt-2">
        {activeTab === "broadcast" && <BroadcastTab />}
        {activeTab === "contacts" && <ContactsTab />}
        {activeTab === "templates" && <TemplatesTab />}
        {activeTab === "providers" && <ProvidersTab />}
      </div>
    </div>
  )
}
```

- [ ] Create `app/admin/sms/_components/BroadcastTab.tsx` — compose + audience picker (roles / specific / group) + merge-field toggle + segment estimate + send:

```typescript
"use client"

import { useState, useEffect } from "react"

interface Group { id: string; name: string }
interface Template { id: string; name: string; body: string }

export default function BroadcastTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [audienceType, setAudienceType] = useState<"roles" | "group">("roles")
  const [selectedRoles, setSelectedRoles] = useState<string[]>(["customer"])
  const [selectedGroupId, setSelectedGroupId] = useState("")
  const [message, setMessage] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [mergeFields, setMergeFields] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    fetch("/api/admin/sms-groups").then((r) => r.json()).then((d) => setGroups(d.groups ?? []))
    fetch("/api/admin/sms-templates").then((r) => r.json()).then((d) => setTemplates(d.templates ?? []))
  }, [])

  const charCount = message.length
  const segmentCount = charCount === 0 ? 0 : Math.ceil(charCount / 160)

  const handleTemplateSelect = (id: string) => {
    setTemplateId(id)
    const t = templates.find((t) => t.id === id)
    if (t) setMessage(t.body)
  }

  const handleSend = async () => {
    if (!message.trim()) return setStatus("Message is required.")
    setSending(true)
    setStatus(null)
    try {
      const recipients =
        audienceType === "group"
          ? { type: "group", groupId: selectedGroupId }
          : { type: "roles", roles: selectedRoles }

      const res = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "init",
          channels: ["sms"],
          recipients,
          message,
          mergeFields,
        }),
      })
      const json = await res.json()
      if (!res.ok) setStatus(`Error: ${json.error}`)
      else setStatus(`Broadcast queued — ${json.total} recipients.`)
    } catch (e: any) {
      setStatus(`Error: ${e.message}`)
    } finally {
      setSending(false)
    }
  }

  const ROLES = ["admin", "shop_owner", "sub_agent", "customer"]

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Audience */}
      <div className="space-y-2">
        <label className="block text-sm font-medium">Audience</label>
        <div className="flex gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={audienceType === "roles"} onChange={() => setAudienceType("roles")} />
            By role
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={audienceType === "group"} onChange={() => setAudienceType("group")} />
            Contact group
          </label>
        </div>

        {audienceType === "roles" && (
          <div className="flex flex-wrap gap-2 pt-1">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={selectedRoles.includes(r)}
                  onChange={(e) =>
                    setSelectedRoles((prev) =>
                      e.target.checked ? [...prev, r] : prev.filter((x) => x !== r)
                    )
                  }
                />
                {r}
              </label>
            ))}
          </div>
        )}

        {audienceType === "group" && (
          <select
            className="border rounded px-2 py-1 text-sm w-full max-w-xs"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
          >
            <option value="">Select a group…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Template picker */}
      <div className="space-y-1">
        <label className="block text-sm font-medium">Template (optional)</label>
        <select
          className="border rounded px-2 py-1 text-sm w-full max-w-xs"
          value={templateId}
          onChange={(e) => handleTemplateSelect(e.target.value)}
        >
          <option value="">— none —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* Message */}
      <div className="space-y-1">
        <label className="block text-sm font-medium">Message</label>
        <textarea
          className="w-full border rounded px-3 py-2 text-sm resize-y min-h-[100px]"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Your message here. Use [FirstName], [LastName], [Phone] for merge fields."
          maxLength={1000}
        />
        <p className="text-xs text-muted-foreground">
          {charCount} chars · {segmentCount} segment{segmentCount !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Merge fields toggle */}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={mergeFields} onChange={(e) => setMergeFields(e.target.checked)} />
        Personalise with merge fields ([FirstName] etc.)
      </label>

      <button
        onClick={handleSend}
        disabled={sending}
        className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-medium disabled:opacity-50"
      >
        {sending ? "Sending…" : "Send Broadcast"}
      </button>

      {status && <p className="text-sm mt-2">{status}</p>}
    </div>
  )
}
```

- [ ] Create `app/admin/sms/_components/ContactsTab.tsx` — group CRUD, contact list, CSV import (paste or file upload):

```typescript
"use client"

import { useState, useEffect, useRef } from "react"

interface Group { id: string; name: string; description?: string }
interface Contact { id: string; group_id: string; phone_number: string; first_name: string | null; last_name: string | null; opted_out: boolean }

export default function ContactsTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [activeGroup, setActiveGroup] = useState<Group | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [newGroupName, setNewGroupName] = useState("")
  const [csvText, setCsvText] = useState("")
  const [importResult, setImportResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const loadGroups = () =>
    fetch("/api/admin/sms-groups").then((r) => r.json()).then((d) => setGroups(d.groups ?? []))

  const loadContacts = (g: Group) => {
    setActiveGroup(g)
    fetch(`/api/admin/sms-contacts?group_id=${g.id}`)
      .then((r) => r.json())
      .then((d) => setContacts(d.contacts ?? []))
  }

  useEffect(() => { loadGroups() }, [])

  const createGroup = async () => {
    if (!newGroupName.trim()) return
    await fetch("/api/admin/sms-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newGroupName.trim() }),
    })
    setNewGroupName("")
    loadGroups()
  }

  const deleteGroup = async (id: string) => {
    if (!confirm("Delete this group and all its contacts?")) return
    await fetch(`/api/admin/sms-groups/${id}`, { method: "DELETE" })
    if (activeGroup?.id === id) { setActiveGroup(null); setContacts([]) }
    loadGroups()
  }

  const importCsv = async () => {
    if (!activeGroup || !csvText.trim()) return
    setLoading(true)
    setImportResult(null)
    // Parse CSV lines: phone[,first_name[,last_name]]
    const lines = csvText.trim().split("\n").filter(Boolean)
    const contacts = lines.map((line) => {
      const [phone, first_name, last_name] = line.split(",").map((s) => s.trim())
      return { phone, first_name: first_name || null, last_name: last_name || null }
    })
    const res = await fetch("/api/admin/sms-contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: activeGroup.id, contacts }),
    })
    const json = await res.json()
    setLoading(false)
    if (!res.ok) {
      setImportResult(`Error: ${json.error}`)
    } else {
      setImportResult(`Imported ${json.inserted}, skipped ${json.skipped?.length ?? 0}`)
      setCsvText("")
      loadContacts(activeGroup)
    }
  }

  const toggleOptOut = async (c: Contact) => {
    await fetch(`/api/admin/sms-contacts/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opted_out: !c.opted_out }),
    })
    if (activeGroup) loadContacts(activeGroup)
  }

  const deleteContact = async (id: string) => {
    await fetch(`/api/admin/sms-contacts/${id}`, { method: "DELETE" })
    if (activeGroup) loadContacts(activeGroup)
  }

  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      {/* Group list */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Groups</h3>
        <ul className="space-y-1">
          {groups.map((g) => (
            <li key={g.id} className={["flex justify-between items-center px-2 py-1 rounded text-sm cursor-pointer", activeGroup?.id === g.id ? "bg-accent" : "hover:bg-muted"].join(" ")} onClick={() => loadContacts(g)}>
              <span>{g.name}</span>
              <button className="text-destructive text-xs" onClick={(e) => { e.stopPropagation(); deleteGroup(g.id) }}>del</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1">
          <input className="border rounded px-2 py-1 text-xs flex-1" placeholder="New group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
          <button className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs" onClick={createGroup}>+</button>
        </div>
      </div>

      {/* Contact panel */}
      <div className="space-y-4">
        {!activeGroup ? (
          <p className="text-sm text-muted-foreground">Select a group to view contacts.</p>
        ) : (
          <>
            <h3 className="text-sm font-semibold">{activeGroup.name} — {contacts.length} contacts</h3>

            {/* CSV import */}
            <div className="space-y-1">
              <label className="text-xs font-medium">Import CSV (phone,first_name,last_name — one per line)</label>
              <textarea
                className="w-full border rounded px-2 py-1 text-xs font-mono h-24 resize-y"
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder="0241234567,Ama,Mensah&#10;0209999999"
              />
              <button className="px-3 py-1 bg-primary text-primary-foreground rounded text-xs" onClick={importCsv} disabled={loading}>
                {loading ? "Importing…" : "Import"}
              </button>
              {importResult && <p className="text-xs mt-1">{importResult}</p>}
            </div>

            {/* Contact table */}
            <table className="w-full text-xs border-collapse">
              <thead><tr className="border-b text-left"><th className="py-1 pr-3">Phone</th><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Opted out</th><th /></tr></thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-b hover:bg-muted/40">
                    <td className="py-1 pr-3 font-mono">{c.phone_number}</td>
                    <td className="py-1 pr-3">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td className="py-1 pr-3">
                      <button className="underline text-xs" onClick={() => toggleOptOut(c)}>{c.opted_out ? "Yes (re-opt)" : "No (opt out)"}</button>
                    </td>
                    <td className="py-1"><button className="text-destructive text-xs" onClick={() => deleteContact(c.id)}>del</button></td>
                  </tr>
                ))}
                {contacts.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-muted-foreground">No contacts yet.</td></tr>}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] Create `app/admin/sms/_components/TemplatesTab.tsx` — global template CRUD:

```typescript
"use client"

import { useState, useEffect } from "react"

interface Template { id: string; name: string; body: string; created_at: string }

export default function TemplatesTab() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState("")
  const [body, setBody] = useState("")
  const [editId, setEditId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = () => fetch("/api/admin/sms-templates").then((r) => r.json()).then((d) => setTemplates(d.templates ?? []))

  useEffect(() => { load() }, [])

  const save = async () => {
    if (!name.trim() || !body.trim()) return setStatus("Name and body are required.")
    const url = editId ? `/api/admin/sms-templates/${editId}` : "/api/admin/sms-templates"
    const method = editId ? "PATCH" : "POST"
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, body }) })
    const json = await res.json()
    if (!res.ok) return setStatus(`Error: ${json.error}`)
    setName(""); setBody(""); setEditId(null); setStatus(editId ? "Template updated." : "Template created.")
    load()
  }

  const del = async (id: string) => {
    if (!confirm("Delete this template?")) return
    await fetch(`/api/admin/sms-templates/${id}`, { method: "DELETE" })
    load()
  }

  const edit = (t: Template) => { setEditId(t.id); setName(t.name); setBody(t.body); setStatus(null) }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="space-y-2 border rounded p-4">
        <h3 className="text-sm font-semibold">{editId ? "Edit template" : "New template"}</h3>
        <input className="w-full border rounded px-3 py-1.5 text-sm" placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className="w-full border rounded px-3 py-2 text-sm min-h-[80px] resize-y" placeholder="Message body — use [FirstName], [LastName], [Phone]" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex gap-2">
          <button className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm" onClick={save}>{editId ? "Update" : "Create"}</button>
          {editId && <button className="px-3 py-1.5 border rounded text-sm" onClick={() => { setEditId(null); setName(""); setBody("") }}>Cancel</button>}
        </div>
        {status && <p className="text-xs">{status}</p>}
      </div>

      <table className="w-full text-sm border-collapse">
        <thead><tr className="border-b text-left"><th className="py-1 pr-4">Name</th><th className="py-1 pr-4">Body</th><th /></tr></thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} className="border-b hover:bg-muted/40">
              <td className="py-1.5 pr-4 font-medium">{t.name}</td>
              <td className="py-1.5 pr-4 text-muted-foreground line-clamp-2">{t.body}</td>
              <td className="py-1.5 flex gap-2">
                <button className="text-xs underline" onClick={() => edit(t)}>edit</button>
                <button className="text-xs text-destructive" onClick={() => del(t.id)}>del</button>
              </td>
            </tr>
          ))}
          {templates.length === 0 && <tr><td colSpan={3} className="py-3 text-center text-muted-foreground text-xs">No templates yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] Create `app/admin/sms/_components/ProvidersTab.tsx` — primary/fallback routing + sender-ID management:

```typescript
"use client"

import { useState, useEffect } from "react"

const PROVIDERS = ["moolre", "mnotify", "brevo"]

interface SenderId { id: string; sender_id: string; local_status: string; moolre_status: string | null; last_polled_at: string | null }

export default function ProvidersTab() {
  const [primary, setPrimary] = useState("moolre")
  const [fallbacks, setFallbacks] = useState<string[]>(["mnotify"])
  const [routingStatus, setRoutingStatus] = useState<string | null>(null)
  const [senderIds, setSenderIds] = useState<SenderId[]>([])
  const [newSenderId, setNewSenderId] = useState("")
  const [senderStatus, setSenderStatus] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/admin/sms-settings").then((r) => r.json()).then((d) => {
      if (d.settings?.sms_primary_provider) setPrimary(d.settings.sms_primary_provider)
      if (d.settings?.sms_fallback_providers) {
        try { setFallbacks(JSON.parse(d.settings.sms_fallback_providers)) } catch {}
      }
    })
    loadSenderIds()
  }, [])

  const loadSenderIds = () =>
    fetch("/api/admin/sms-sender-ids").then((r) => r.json()).then((d) => setSenderIds(d.senderIds ?? []))

  const saveRouting = async () => {
    const res = await fetch("/api/admin/sms-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sms_primary_provider: primary, sms_fallback_providers: fallbacks }),
    })
    const json = await res.json()
    setRoutingStatus(res.ok ? "Saved." : `Error: ${json.error}`)
  }

  const submitSenderId = async () => {
    if (!newSenderId.trim()) return
    const res = await fetch("/api/admin/sms-sender-ids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_id: newSenderId.trim() }),
    })
    const json = await res.json()
    if (!res.ok) return setSenderStatus(`Error: ${json.error}`)
    setNewSenderId("")
    setSenderStatus("Submitted — poll cron will update status within 5 minutes.")
    loadSenderIds()
  }

  const toggleFallback = (p: string) =>
    setFallbacks((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p])

  const statusBadge = (s: string) => {
    const col = s === "active" ? "text-green-600" : s === "rejected" ? "text-destructive" : "text-amber-600"
    return <span className={`text-xs font-medium ${col}`}>{s}</span>
  }

  return (
    <div className="space-y-8 max-w-xl">
      {/* Provider routing */}
      <div className="space-y-3 border rounded p-4">
        <h3 className="text-sm font-semibold">Provider Routing</h3>
        <div className="space-y-1">
          <label className="text-xs font-medium">Primary provider</label>
          <select className="border rounded px-2 py-1 text-sm w-full max-w-xs" value={primary} onChange={(e) => setPrimary(e.target.value)}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Fallback providers (ordered)</label>
          <div className="flex gap-3">
            {PROVIDERS.filter((p) => p !== primary).map((p) => (
              <label key={p} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={fallbacks.includes(p)} onChange={() => toggleFallback(p)} />
                {p}
              </label>
            ))}
          </div>
        </div>
        <button className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm" onClick={saveRouting}>Save routing</button>
        {routingStatus && <p className="text-xs mt-1">{routingStatus}</p>}
      </div>

      {/* Sender IDs */}
      <div className="space-y-3 border rounded p-4">
        <h3 className="text-sm font-semibold">Sender IDs</h3>
        <div className="flex gap-2">
          <input
            className="border rounded px-2 py-1 text-sm flex-1 max-w-[200px]"
            placeholder="e.g. BOLDTELCO"
            value={newSenderId}
            maxLength={11}
            onChange={(e) => setNewSenderId(e.target.value)}
          />
          <button className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-sm" onClick={submitSenderId}>Submit to Moolre</button>
        </div>
        {senderStatus && <p className="text-xs">{senderStatus}</p>}

        <table className="w-full text-sm border-collapse mt-2">
          <thead><tr className="border-b text-left text-xs"><th className="py-1 pr-4">Sender ID</th><th className="py-1 pr-4">Status</th><th className="py-1">Last polled</th></tr></thead>
          <tbody>
            {senderIds.map((s) => (
              <tr key={s.id} className="border-b hover:bg-muted/40">
                <td className="py-1.5 pr-4 font-mono">{s.sender_id}</td>
                <td className="py-1.5 pr-4">{statusBadge(s.local_status)}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{s.last_polled_at ? new Date(s.last_polled_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {senderIds.length === 0 && <tr><td colSpan={3} className="py-3 text-center text-muted-foreground text-xs">No sender IDs submitted yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

---

### Task 14 — TypeScript compile check + full test run

- [ ] Run TypeScript check across all modified files:
  ```bash
  npx tsc --noEmit
  ```
  Expected: zero new errors (pre-existing errors are acceptable; new errors from this plan's files must be zero).

- [ ] Run the full test suite:
  ```bash
  npm test -- --run lib/sms/personalize lib/sms/recipients lib/sms/routing
  ```
  Expected output:
  ```
  ✓ lib/sms/personalize.test.ts (8)
  ✓ lib/sms/recipients.test.ts (7)
  ✓ lib/sms/routing.test.ts (4)
  Test Files  3 passed (3)
  Tests      19 passed (19)
  ```

- [ ] Verify the `broadcast_logs` table is confirmed present (required FK for `broadcast_recipients`):
  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_name = 'broadcast_logs' AND table_schema = 'public';
  -- Expected: 1 row
  ```

- [ ] Verify the `admin_settings` routing rows were seeded:
  ```sql
  SELECT key, value FROM admin_settings
  WHERE key IN ('sms_primary_provider','sms_fallback_providers');
  -- Expected: 2 rows
  ```

---

### Task 15 — Smoke-test the Admin SMS Centre in dev

- [ ] Start the dev server: `npm run dev`
- [ ] Navigate to `/admin/sms`. Verify:
  - Four tabs render without console errors.
  - **Broadcast tab:** audience type toggle switches between "By role" and "Contact group"; group dropdown populates; char/segment counter updates as you type; Send button is visible and returns a `broadcastId` in the network response.
  - **Contacts & Groups tab:** group list loads; creating a group via the text input + "+" button adds it to the list; selecting a group shows the contact table; CSV import with a test line `0241234567,Test,User` imports 1 contact.
  - **Templates tab:** creating a template stores it; it appears in the list; editing and saving updates the name/body.
  - **Providers tab:** primary/fallback selectors load current DB values; saving routing returns `{"ok":true}` in the network response; sender-ID submit field is present.

---

## Self-Review

### Spec → task coverage

| Spec requirement | Covered by |
|---|---|
| `sms_groups` + `sms_contacts` (UNIQUE group+phone, opted_out, cascade delete) | Task 1 (migration) |
| `sms_templates` global | Task 1 (migration) |
| `sms_sender_ids` table | Task 1 (migration) |
| DB routing settings seeded | Task 2 (migration) |
| `lib/sms/personalize.ts` — `[FirstName]/[LastName]/[Phone]` | Task 3 |
| Personalize unit tests | Task 3 |
| `lib/sms/recipients.ts` — normalize→filter-null→dedupe→drop-opted-out | Task 4 |
| Recipients unit tests | Task 4 |
| `lib/sms/routing.ts` — `getRoutingConfig()`, 5-min TTL, `invalidateRoutingCache()` | Task 5 |
| Routing unit tests (including malformed-JSON + unknown-provider branches) | Task 5 |
| Wire routing into `lib/sms-service.ts` (replace env-only reads) | Task 6 |
| Admin CRUD: `/api/admin/sms-groups` + `/:id` | Task 7 |
| Admin CRUD: `/api/admin/sms-contacts` (single + bulk import, dedupe) | Task 7 |
| Admin CRUD: `/api/admin/sms-templates` + `/:id` | Task 8 |
| `/api/admin/sms-settings` GET+PATCH, invalidate cache on write | Task 9 |
| Sender-ID submit (Moolre type 3) | Task 10 |
| Sender-ID poll cron (Moolre type 1) | Task 10 |
| Extend broadcast route to accept `type:"group"` + merge-field rendering | Task 11 |
| Register sender-ID poll cron in `vercel.json` | Task 12 |
| Admin SMS Centre 4-tab UI | Task 13 |
| Broadcast tab (compose + audience + merge-field toggle) | Task 13 |
| Contacts & Groups tab (group CRUD, contact table, CSV import) | Task 13 |
| Templates tab (CRUD) | Task 13 |
| Providers tab (routing config + sender-ID management) | Task 13 |
| Type check + full test run | Task 14 |
| Dev smoke test | Task 15 |

### Key architecture decisions recorded

- **`lib/sms/personalize.ts` is created here (not imported from M3)** because M3 is not yet built. When M3 is implemented it should import from this file, not recreate it.
- **`broadcast_logs` exists** — confirmed in `migrations/create_broadcast_recipients.sql` (FK source). No new table needed.
- **`admin_settings` exists** — confirmed with 86+ file references; migration 0066 only seeds new keys, it does not recreate the table.
- **RLS is deny-all to clients** on all four new tables. The admin API check (`verifyAdminAccess`) is the sole access boundary, consistent with the platform RLS audit findings (`project-rls-grant-model`).
- **`resolveRecipients` for group audiences** returns a contact list that is passed to `enqueueRecipients` as `type:"specific"` recipients — the existing drain code handles that shape unchanged. The `renderedMessage` field on each recipient row requires a one-line change in `enqueueRecipients` (use `recipient.renderedMessage ?? message`).
- **No credit RPCs anywhere in this plan** — confirmed by searching for `credit_sms_units_if_solvent`, `debit_sms_for_send`, and `adjust_sms_units`; none appear.
- **`normalizeGhanaPhone` from `lib/phone-format`** is the canonical normaliser used here (returns `0XXXXXXXXX | null`). The `+233`-form normalizer inside `lib/sms-service.ts` is separate and unaffected.
- **Sender-ID "type 3, no approve"** — noted as ASMQ09 constraint in the spec; the route logs the Moolre response but does not hard-fail on it, because Moolre may still process the submission. The row is always written as `pending` so the poll cron can determine the final status.
- **`mergeFields` in broadcast route** is opt-in (defaults `false`) — existing broadcasts without the flag continue to work exactly as before; the change is purely additive.
