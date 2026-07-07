# Order-Time Network↔Prefix Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-block data-bundle orders whose beneficiary phone prefix doesn't match the selected network (all networks, all 6 order-creation channels), with an admin-editable prefix map (add/remove prefixes without deploy) that drives both the TS validator and the SQL registry classifier `gh_is_mtn`, behind a kill-switch defaulting ON.

**Architecture:** A pure map-driven validator (`DEFAULT_NETWORK_PREFIXES`, `detectNetworkWithMap`, `validateNetworkPrefix`) lives in `lib/phone-format.ts`; the existing shared client validator `lib/phone-validation.ts` (whose MTN/AT branch is the hole — it accepts any 02x/05x) delegates its network branch to it. A server config module reads `admin_settings.network_prefix_map` + `network_prefix_validation_enabled` in one query. A migration seeds the map and redefines `gh_is_mtn` (STABLE) to read it with a hardcoded fallback. Six server sites enforce; a self-contained admin card (toggle + prefix chips) manages; a small public endpoint feeds client hints.

**Tech Stack:** Next.js 15, Supabase (admin_settings jsonb), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-07-network-prefix-validation-design.md`

---

## Verified environment facts (from extraction — rely on these)

- **The hole:** `lib/phone-validation.ts:96-130` — Telecel branch is strict (020/050) but the `else` branch (MTN/AT/etc.) only requires second digit 2|5, so MTN orders accept 020/050/026/027… It IS already network-aware in signature (`validatePhoneNumber(phone, network?)`) and is used client-side by the storefront (`app/shop/[slug]/page.tsx:16,242,321,332`) and (per its header) the bulk + data-packages pages.
- `lib/phone-format.ts` is the prefix source of truth (`detectGhanaNetwork` :51-59, sets 24/25/53/54/55/59 MTN; 20/50 TELECEL; 26/27/56/57 AT). Keep it Supabase-free (client-safe).
- **Server sites (exact anchors):**
  1. `app/api/orders/purchase/route.ts` — body destructured at :66-67 (`{ packageId, network, size, price, phoneNumber }`); ONLY validation is `!phoneNumber` at :77-79; INSERT at :240.
  2. `app/api/orders/create-bulk/route.ts` — `{ orders, network }` at :32; per-row loop :48-59 (generic 7-15-digit regex at :53); request-level `network` validated :61-66; error shape `{ error }` 400.
  3. `app/api/shop/orders/create/route.ts` — `network` from body at :78 (client-supplied; package lookup never re-derives network); phone format block :128-134 producing `normalizedPhone`.
  4. `app/api/v1/orders/route.ts` — body field is **`recipient`** (not recipient_phone) :108; phone regex :123-127 producing `cleanRecipient`; `sanitizedNetwork` at :135; error shape `{ success: false, error }` (no error_code convention yet).
  5. `lib/ussd/handlers/bundles.ts` — `handleEnterRecipient` :209-241; format check :228; re-prompt via `cont('...')`; network in `session.network` (types: `lib/ussd/types.ts:72`).
  6. `lib/ussd-shop/handlers/bundles.ts` — same shape :262-294; check :280; `session.network` (`lib/ussd-shop/types.ts:36`).
- **Client pages:** storefront phone input `app/shop/[slug]/page.tsx:1075-1090` (hint text :1087-1089 "starting with 02 or 05"; submit-time validation :321,:332 already passes `selectedPackage.network`); dashboard buyer page `app/dashboard/data-packages/page.tsx` (the only client of `/api/orders/purchase`). `components/checkout/steps/step-customer.tsx` is DEAD CODE (not imported by the live flow) — do NOT touch it.
- **Admin settings page** `app/admin/settings/page.tsx` (2065 lines): repo precedent for big cards = self-contained component imported at top (`PhoneBlacklistManager` :18, `AirtimeSettingsCard` :19 rendered at :992). `Switch` already imported (:16). Mirror the Switch usage of the "Global Ordering Status" card (:795-822). Add our card as a NEW component file + 1 import + 1 JSX line.
- Settings-route pattern to copy: `app/api/admin/settings/mtn-registration-gate/route.ts` (built today). Audit-log insert shape: `admin_audit_log(admin_id, action, new_value, created_at)`.
- `admin_settings(key unique, value jsonb, description, updated_at)`. Supabase Management-API helper pattern for applying migrations: recreate `_supabase_sql.js` (content in the Phase 1 plan `2026-07-07-mtn-number-registration-phase1.md`, "Verified environment facts"), delete after use. Token in gitignored `.mcp.json` — never print it.
- Suite currently **280 passing**; `npx tsc --noEmit` clean. Tests co-located.

## File structure

- **Modify** `lib/phone-format.ts` (+ **create** `lib/phone-format.test.ts`) — map + validator.
- **Modify** `lib/phone-validation.ts` (+ **create** `lib/phone-validation.test.ts`) — delegate network branch.
- **Create** `lib/network-prefix-config.ts` — server readers (`getPrefixValidationConfig` et al).
- **Create** `migrations/20260707_network_prefix_map.sql` — seed + `gh_is_mtn` redefinition.
- **Create** `app/api/network-prefixes/route.ts` (public GET), `app/api/admin/settings/network-prefix-validation/route.ts` (toggle), `app/api/admin/settings/network-prefixes/route.ts` (add/remove).
- **Create** `components/admin/network-prefix-settings-card.tsx`; **modify** `app/admin/settings/page.tsx` (import + render).
- **Modify** the 6 server sites; **modify** `app/shop/[slug]/page.tsx` + `app/dashboard/data-packages/page.tsx` (client hints/map).

---

## Task 1: Map + pure validator in `lib/phone-format.ts` — TDD

**Files:**
- Modify: `lib/phone-format.ts`
- Create: `lib/phone-format.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/phone-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NETWORK_PREFIXES,
  detectGhanaNetwork,
  detectNetworkWithMap,
  validateNetworkPrefix,
} from './phone-format'

describe('DEFAULT_NETWORK_PREFIXES', () => {
  it('pins the canonical seed — 053 IS MTN', () => {
    expect(DEFAULT_NETWORK_PREFIXES).toEqual({
      MTN: ['24', '25', '53', '54', '55', '59'],
      TELECEL: ['20', '50'],
      AT: ['26', '27', '56', '57'],
    })
  })
})

describe('detectNetworkWithMap', () => {
  it('matches detectGhanaNetwork on the default map for every seed prefix', () => {
    for (const [net, prefixes] of Object.entries(DEFAULT_NETWORK_PREFIXES)) {
      for (const p of prefixes) {
        const phone = `0${p}1234567`
        expect(detectNetworkWithMap(phone, DEFAULT_NETWORK_PREFIXES)).toBe(net)
        expect(detectGhanaNetwork(phone)).toBe(net)
      }
    }
  })
  it('honors an extended map (admin-added prefix)', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(detectNetworkWithMap('0581234567', extended)).toBe('MTN')
    expect(detectNetworkWithMap('0581234567', DEFAULT_NETWORK_PREFIXES)).toBe('UNKNOWN')
  })
})

describe('validateNetworkPrefix', () => {
  // Full seed matrix: every prefix vs every order-network string.
  const NETWORK_STRINGS: Array<[string, keyof typeof DEFAULT_NETWORK_PREFIXES]> = [
    ['MTN', 'MTN'], ['mtn', 'MTN'],
    ['Telecel', 'TELECEL'], ['TELECEL', 'TELECEL'],
    ['AT', 'AT'], ['AirtelTigo', 'AT'], ['AT - iShare', 'AT'], ['at-ishare', 'AT'],
    ['AT - BigTime', 'AT'], ['bigtime', 'AT'],
  ]
  it('accepts matching prefixes and rejects mismatches, for every seed prefix', () => {
    for (const [orderNet, carrier] of NETWORK_STRINGS) {
      for (const [net, prefixes] of Object.entries(DEFAULT_NETWORK_PREFIXES)) {
        for (const p of prefixes) {
          const res = validateNetworkPrefix(orderNet, `0${p}1234567`)
          expect(res.ok).toBe(net === carrier)
        }
      }
    }
  })
  it('053 + MTN passes (explicit pin)', () => {
    expect(validateNetworkPrefix('MTN', '0531234567').ok).toBe(true)
  })
  it('020 + MTN fails with a helpful message (the historical hole)', () => {
    const res = validateNetworkPrefix('MTN', '0201234567')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message).toContain('Telecel')
  })
  it('blocks unknown prefixes', () => {
    const res = validateNetworkPrefix('MTN', '0231234567')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.message.toLowerCase()).toContain('check the number')
  })
  it('blocks invalid formats', () => {
    expect(validateNetworkPrefix('MTN', 'abc').ok).toBe(false)
    expect(validateNetworkPrefix('MTN', '024123').ok).toBe(false)
  })
  it('normalizes 233/+233/spaced input before judging', () => {
    expect(validateNetworkPrefix('MTN', '233241234567').ok).toBe(true)
    expect(validateNetworkPrefix('MTN', '+233 24 123 4567').ok).toBe(true)
  })
  it('passes an unrecognized order-network string (never blocks what it does not understand)', () => {
    expect(validateNetworkPrefix('AFA', '0201234567').ok).toBe(true)
  })
  it('uses a custom map when provided', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(validateNetworkPrefix('MTN', '0581234567', extended).ok).toBe(true)
    expect(validateNetworkPrefix('Telecel', '0581234567', extended).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/phone-format.test.ts`
Expected: FAIL — `DEFAULT_NETWORK_PREFIXES` etc. not exported.

- [ ] **Step 3: Implement in `lib/phone-format.ts`**

Replace the existing `detectGhanaNetwork` block (lines 46-59) with:

```ts
/** Ghana mobile network for a number, by prefix. "UNKNOWN" when the prefix
 *  isn't a recognised mobile range (callers verifying via Moolre coerce UNKNOWN
 *  to MTN, matching the admin phone-audit). Based on the first two significant
 *  digits of the canonical 0XXXXXXXXX form. */
export type GhanaNetwork = "MTN" | "TELECEL" | "AT" | "UNKNOWN"

/** Significant 2-digit prefixes per carrier. This is the SEED/default —
 *  the live map is admin-editable (admin_settings.network_prefix_map) and
 *  read server-side via lib/network-prefix-config.ts. 053 IS MTN. */
export type NetworkPrefixMap = Record<Exclude<GhanaNetwork, "UNKNOWN">, string[]>
export const DEFAULT_NETWORK_PREFIXES: NetworkPrefixMap = {
  MTN: ["24", "25", "53", "54", "55", "59"],
  TELECEL: ["20", "50"],
  AT: ["26", "27", "56", "57"],
}

export function detectNetworkWithMap(phone: string, map: NetworkPrefixMap): GhanaNetwork {
  const sig = ghanaSignificant(phone)
  if (!sig) return "UNKNOWN"
  const p = sig.slice(0, 2)
  if (map.MTN.includes(p)) return "MTN"
  if (map.TELECEL.includes(p)) return "TELECEL"
  if (map.AT.includes(p)) return "AT"
  return "UNKNOWN"
}

export function detectGhanaNetwork(phone: string): GhanaNetwork {
  return detectNetworkWithMap(phone, DEFAULT_NETWORK_PREFIXES)
}
```

Then append at the end of the file:

```ts
/** Human display names for mismatch messages. */
const NETWORK_DISPLAY: Record<Exclude<GhanaNetwork, "UNKNOWN">, string> = {
  MTN: "MTN",
  TELECEL: "Telecel",
  AT: "AT",
}

/** Map an order's network string (any historical spelling) to the carrier it
 *  requires. Returns null for strings the validator doesn't understand —
 *  those are never blocked. */
export function orderNetworkToCarrier(orderNetwork: string): Exclude<GhanaNetwork, "UNKNOWN"> | null {
  const n = (orderNetwork || "").toLowerCase().trim()
  if (n === "mtn") return "MTN"
  if (n === "telecel") return "TELECEL"
  if (["at", "airteltigo", "at - ishare", "at-ishare", "ishare", "at - bigtime", "at-bigtime", "bigtime"].includes(n)) return "AT"
  return null
}

export type OrderNetworkCheck =
  | { ok: true; detected: GhanaNetwork }
  | { ok: false; detected: GhanaNetwork; message: string }

/**
 * Order-time network↔prefix validation (hard block; see spec
 * 2026-07-07-network-prefix-validation-design.md). Pure and client-safe —
 * servers pass the live admin-editable map, clients may use the default.
 */
export function validateNetworkPrefix(
  orderNetwork: string,
  phone: string,
  map: NetworkPrefixMap = DEFAULT_NETWORK_PREFIXES
): OrderNetworkCheck {
  const expected = orderNetworkToCarrier(orderNetwork)
  if (!expected) return { ok: true, detected: detectNetworkWithMap(phone, map) }

  const norm = normalizeGhanaPhone(phone)
  if (!norm) {
    return { ok: false, detected: "UNKNOWN", message: "Please enter a valid Ghana mobile number." }
  }
  const detected = detectNetworkWithMap(norm, map)
  if (detected === "UNKNOWN") {
    return {
      ok: false,
      detected,
      message: `${norm} doesn't match any Ghana mobile network — please check the number.`,
    }
  }
  if (detected !== expected) {
    return {
      ok: false,
      detected,
      message: `${norm} looks like a ${NETWORK_DISPLAY[detected]} number — check the number or switch to ${NETWORK_DISPLAY[detected]}.`,
    }
  }
  return { ok: true, detected }
}
```

(Note: `GhanaNetwork`'s export moves position but keeps the same name/shape — existing importers are unaffected.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/phone-format.test.ts`
Expected: PASS. Then `npm run test:run` — all 280 pre-existing must still pass (detectGhanaNetwork behavior is identical).

- [ ] **Step 5: Commit**

```bash
git add lib/phone-format.ts lib/phone-format.test.ts
git commit -m "feat: map-driven network prefix validator (053=MTN pinned)"
```

---

## Task 2: Close the hole in `lib/phone-validation.ts` — TDD

**Files:**
- Modify: `lib/phone-validation.ts` (network branch :96-130)
- Create: `lib/phone-validation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/phone-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validatePhoneNumber } from './phone-validation'
import { DEFAULT_NETWORK_PREFIXES } from './phone-format'

describe('validatePhoneNumber (network-aware, strict)', () => {
  it('MTN rejects a Telecel number (the historical hole)', () => {
    const res = validatePhoneNumber('0201234567', 'MTN')
    expect(res.isValid).toBe(false)
    expect(res.error).toContain('Telecel')
  })
  it('MTN rejects an AT number', () => {
    expect(validatePhoneNumber('0271234567', 'MTN').isValid).toBe(false)
  })
  it('MTN accepts all MTN prefixes incl. 053', () => {
    for (const p of DEFAULT_NETWORK_PREFIXES.MTN) {
      expect(validatePhoneNumber(`0${p}1234567`, 'MTN').isValid).toBe(true)
    }
  })
  it('Telecel behavior stays strict', () => {
    expect(validatePhoneNumber('0201234567', 'Telecel').isValid).toBe(true)
    expect(validatePhoneNumber('0241234567', 'Telecel').isValid).toBe(false)
  })
  it('AT product names map to AT prefixes', () => {
    expect(validatePhoneNumber('0271234567', 'AT - iShare').isValid).toBe(true)
    expect(validatePhoneNumber('0241234567', 'AT - BigTime').isValid).toBe(false)
  })
  it('9-digit padding still works', () => {
    const res = validatePhoneNumber('241234567', 'MTN')
    expect(res.isValid).toBe(true)
    expect(res.normalized).toBe('0241234567')
  })
  it('no network → generic 02/05 validation unchanged', () => {
    expect(validatePhoneNumber('0201234567').isValid).toBe(true)
    expect(validatePhoneNumber('0611234567').isValid).toBe(false)
  })
  it('accepts a custom map (admin-added prefix)', () => {
    const extended = { ...DEFAULT_NETWORK_PREFIXES, MTN: [...DEFAULT_NETWORK_PREFIXES.MTN, '58'] }
    expect(validatePhoneNumber('0581234567', 'MTN', extended).isValid).toBe(true)
    expect(validatePhoneNumber('0581234567', 'MTN').isValid).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/phone-validation.test.ts`
Expected: FAIL — MTN currently accepts 020… and there's no third parameter.

- [ ] **Step 3: Delegate the network branch**

In `lib/phone-validation.ts`: add the import at the top:

```ts
import { validateNetworkPrefix, type NetworkPrefixMap } from "./phone-format"
```

Change the signature (line 60-63) to:

```ts
export function validatePhoneNumber(
  phone: string,
  network?: string,
  map?: NetworkPrefixMap
): PhoneValidationResult {
```

Replace the ENTIRE network-specific branch (lines 96-119, the `if (network) { ... }` block — keep the `else` generic branch as-is) with:

```ts
  // Network-specific validation — strict prefix↔network match via the shared
  // map-driven validator (see lib/phone-format.ts). Previously only Telecel
  // was strict; MTN/AT accepted any 02x/05x number, which let mistaken-network
  // orders through (411 found in prod, 2026-07-07).
  if (network) {
    const check = validateNetworkPrefix(network, normalized, map)
    if (!check.ok) {
      return { isValid: false, normalized: "", error: check.message }
    }
  } else {
```

- [ ] **Step 4: Run to verify pass + no regression**

Run: `npx vitest run lib/phone-validation.test.ts` then `npm run test:run`
Expected: new tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/phone-validation.ts lib/phone-validation.test.ts
git commit -m "fix: strict network-prefix matching in shared phone validation (closes the 020-on-MTN hole)"
```

---

## Task 3: Server config module, migration (+ apply), public + admin routes

**Files:**
- Create: `lib/network-prefix-config.ts`
- Create: `migrations/20260707_network_prefix_map.sql`
- Create: `app/api/network-prefixes/route.ts`
- Create: `app/api/admin/settings/network-prefix-validation/route.ts`
- Create: `app/api/admin/settings/network-prefixes/route.ts`
- Create then delete: `_supabase_sql.js` (helper from the Phase 1 plan)

- [ ] **Step 1: Create `lib/network-prefix-config.ts`**

```ts
// Server-side config for order-time network-prefix validation.
// The prefix map is admin-editable (admin_settings.network_prefix_map) and
// also drives the SQL classifier gh_is_mtn — see
// migrations/20260707_network_prefix_map.sql. lib/phone-format.ts stays
// Supabase-free (client-safe), so the readers live here.
import { createClient } from "@supabase/supabase-js"
import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "./phone-format"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const PREFIX_MAP_KEY = "network_prefix_map"
export const PREFIX_TOGGLE_KEY = "network_prefix_validation_enabled"

function sanitizeMap(raw: unknown): NetworkPrefixMap {
  const out: NetworkPrefixMap = {
    MTN: [...DEFAULT_NETWORK_PREFIXES.MTN],
    TELECEL: [...DEFAULT_NETWORK_PREFIXES.TELECEL],
    AT: [...DEFAULT_NETWORK_PREFIXES.AT],
  }
  if (raw && typeof raw === "object") {
    for (const net of ["MTN", "TELECEL", "AT"] as const) {
      const v = (raw as Record<string, unknown>)[net]
      if (Array.isArray(v)) {
        const cleaned = v.map(String).filter(p => /^[2-9]\d$/.test(p))
        if (cleaned.length > 0) out[net] = cleaned
      }
    }
  }
  return out
}

export interface PrefixValidationConfig {
  enabled: boolean
  map: NetworkPrefixMap
}

/**
 * One query for both settings. Defaults: enabled=true (only an explicit
 * enabled:false disables), map=DEFAULT_NETWORK_PREFIXES merged per-network.
 * Fails toward validating with defaults — validation is cheap and blocking a
 * mismatch is the safe behavior.
 */
export async function getPrefixValidationConfig(): Promise<PrefixValidationConfig> {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    const { data, error } = await supabase
      .from("admin_settings")
      .select("key, value")
      .in("key", [PREFIX_MAP_KEY, PREFIX_TOGGLE_KEY])
    if (error) throw error
    const rows = new Map((data ?? []).map(r => [r.key, r.value]))
    const toggle = rows.get(PREFIX_TOGGLE_KEY) as { enabled?: boolean } | undefined
    return {
      enabled: toggle?.enabled !== false,
      map: sanitizeMap(rows.get(PREFIX_MAP_KEY)),
    }
  } catch (err) {
    console.error("[PREFIX-CONFIG] read failed — using defaults (enabled):", err)
    return { enabled: true, map: DEFAULT_NETWORK_PREFIXES }
  }
}
```

- [ ] **Step 2: Create the migration**

Create `migrations/20260707_network_prefix_map.sql`:

```sql
-- Admin-editable network prefix map. Seeds the canonical table (053 IS MTN)
-- and redefines gh_is_mtn to read it (STABLE, hardcoded fallback), so order
-- validation (TS) and registry classification (SQL capture trigger) always
-- agree — an admin-added prefix takes effect in both at once.

INSERT INTO admin_settings (key, value, description)
VALUES (
  'network_prefix_map',
  '{"MTN":["24","25","53","54","55","59"],"TELECEL":["20","50"],"AT":["26","27","56","57"]}'::jsonb,
  'Significant 2-digit prefix -> network map. Drives order-time prefix validation (TS) and gh_is_mtn (SQL). Admin-editable via /api/admin/settings/network-prefixes.'
)
ON CONFLICT (key) DO NOTHING;

-- gh_is_mtn: was IMMUTABLE with a hardcoded list; now STABLE reading the map.
-- Fallback chain: no settings row -> NULL -> hardcoded; empty MTN list -> NULLIF -> hardcoded.
CREATE OR REPLACE FUNCTION gh_is_mtn(raw text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    substring(normalize_gh_phone(raw) FROM 2 FOR 2) = ANY (
      COALESCE(
        NULLIF(
          (SELECT array(SELECT jsonb_array_elements_text(value->'MTN'))
             FROM admin_settings WHERE key = 'network_prefix_map'),
          '{}'::text[]
        ),
        ARRAY['24','25','53','54','55','59']
      )
    ),
    false
  );
$$;
REVOKE ALL ON FUNCTION gh_is_mtn(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gh_is_mtn(text) TO service_role;
```

- [ ] **Step 3: Apply + verify against prod (transactional)**

Recreate `_supabase_sql.js` (verbatim from the Phase 1 plan's "Verified environment facts"). Then:

```bash
node _supabase_sql.js migrations/20260707_network_prefix_map.sql
node _supabase_sql.js "SELECT gh_is_mtn('0241234567') AS mtn_true, gh_is_mtn('0531234567') AS mtn_053_true, gh_is_mtn('0201112223') AS telecel_false, (SELECT value FROM admin_settings WHERE key='network_prefix_map') AS map;"
node _supabase_sql.js "BEGIN; UPDATE admin_settings SET value = jsonb_set(value, '{MTN}', value->'MTN' || '\"20\"'::jsonb) WHERE key='network_prefix_map'; DO \$\$ BEGIN IF NOT gh_is_mtn('0201112223') THEN RAISE EXCEPTION 'map does not drive gh_is_mtn'; END IF; END \$\$; ROLLBACK;"
node _supabase_sql.js "SELECT gh_is_mtn('0201112223') AS still_false_after_rollback;"
```
Expected: apply `HTTP 201 []`; `mtn_true=true, mtn_053_true=true, telecel_false=false`, map = seeded json; the transactional test returns `HTTP 201` (a failure raises → HTTP error); final check `false`. (Write multi-statement SQL to a temp file if Git Bash quoting fights back; delete it after.)

- [ ] **Step 4: Public read route**

Create `app/api/network-prefixes/route.ts`:

```ts
// Public, cacheable prefix map for client-side hints. The mapping is public
// knowledge (which prefix belongs to which Ghana carrier) — no auth needed.
import { NextResponse } from "next/server"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"

export const dynamic = "force-dynamic"

export async function GET() {
  const { map } = await getPrefixValidationConfig()
  return NextResponse.json({ map }, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
  })
}
```

- [ ] **Step 5: Toggle route**

Create `app/api/admin/settings/network-prefix-validation/route.ts` — copy the SHAPE of `app/api/admin/settings/mtn-registration-gate/route.ts` with: key `network_prefix_validation_enabled`; **default-create `{ enabled: true }`** (this feature defaults ON — note this differs from the gate route's `false`); GET returns `enabled: data.value?.enabled !== false`; POST validates boolean and upserts `{ key, value: { enabled }, description: "Order-time network-prefix validation (hard block on mismatch)", updated_at }` with `onConflict: "key"`; log prefix `[PREFIX-VALIDATION]`.

- [ ] **Step 6: Prefix add/remove route**

Create `app/api/admin/settings/network-prefixes/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getPrefixValidationConfig, PREFIX_MAP_KEY } from "@/lib/network-prefix-config"

export const dynamic = "force-dynamic"

const NETWORKS = ["MTN", "TELECEL", "AT"] as const
type Net = (typeof NETWORKS)[number]

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const { map } = await getPrefixValidationConfig()
  return NextResponse.json({ map }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { network, prefix, action } = await request.json()
    if (!NETWORKS.includes(network)) {
      return NextResponse.json({ error: "network must be MTN, TELECEL or AT" }, { status: 400 })
    }
    if (action !== "add" && action !== "remove") {
      return NextResponse.json({ error: "action must be add or remove" }, { status: 400 })
    }
    // Accept "058" or "58"; store the significant 2 digits.
    const raw = String(prefix ?? "").trim()
    const sig = /^0\d{2}$/.test(raw) ? raw.slice(1) : raw
    if (!/^[2-9]\d$/.test(sig)) {
      return NextResponse.json({ error: "prefix must be 2 digits (e.g. 58 or 058), starting 2-9" }, { status: 400 })
    }

    const { map } = await getPrefixValidationConfig()

    if (action === "add") {
      const owner = (NETWORKS as readonly Net[]).find(n => map[n].includes(sig))
      if (owner && owner !== network) {
        return NextResponse.json(
          { error: `Prefix 0${sig} is already assigned to ${owner} — remove it there first.` },
          { status: 409 }
        )
      }
      if (!map[network as Net].includes(sig)) map[network as Net].push(sig)
    } else {
      if (!map[network as Net].includes(sig)) {
        return NextResponse.json({ error: `Prefix 0${sig} is not assigned to ${network}.` }, { status: 404 })
      }
      if (map[network as Net].length === 1) {
        return NextResponse.json({ error: `Cannot remove the last ${network} prefix.` }, { status: 400 })
      }
      map[network as Net] = map[network as Net].filter(p => p !== sig)
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert(
        {
          key: PREFIX_MAP_KEY,
          value: map,
          description: "Significant 2-digit prefix -> network map. Drives order-time prefix validation (TS) and gh_is_mtn (SQL).",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      )
    if (error) throw error

    // Audit: prefix map changes affect ordering + registry export.
    try {
      const { error: auditErr } = await supabase.from("admin_audit_log").insert([{
        admin_id: adminId || null,
        action: "network_prefix_" + action,
        new_value: { network, prefix: sig, map },
        created_at: new Date().toISOString(),
      }])
      if (auditErr) console.warn("[PREFIX-ADMIN] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[PREFIX-ADMIN] audit insert threw:", auditErr)
    }

    return NextResponse.json({ ok: true, map })
  } catch (error) {
    console.error("[PREFIX-ADMIN] error:", error)
    return NextResponse.json({ error: "Failed to update prefixes" }, { status: 500 })
  }
}
```

- [ ] **Step 7: Verify + cleanup + commit**

Run: `npx tsc --noEmit` (clean). Delete `_supabase_sql.js` (and any temp SQL file).

```bash
git add lib/network-prefix-config.ts migrations/20260707_network_prefix_map.sql app/api/network-prefixes/route.ts app/api/admin/settings/network-prefix-validation/route.ts app/api/admin/settings/network-prefixes/route.ts
git commit -m "feat: admin-editable network prefix map (seeds DB, drives gh_is_mtn) + toggle/public routes"
```

---

## Task 4: Server enforcement — 6 sites

**Files (all Modify):** the 6 sites below. Shared shape at each:

```ts
const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
if (prefixCheckEnabled) {
  const check = validateNetworkPrefix(<network>, <phone>, prefixMap)
  if (!check.ok) return <channel-specific 400 / re-prompt with check.message>
}
```

Imports per site: `import { validateNetworkPrefix } from "@/lib/phone-format"` and `import { getPrefixValidationConfig } from "@/lib/network-prefix-config"` (relative `../..` forms in `lib/ussd*` files if the alias isn't used there — match each file's existing import style).

- [ ] **Step 1: `app/api/orders/purchase/route.ts`** — directly after the `!phoneNumber` check (:77-79), add:

```ts
    // Order-time network↔prefix validation (hard block; admin-toggleable).
    const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
    if (prefixCheckEnabled) {
      const prefixCheck = validateNetworkPrefix(network, phoneNumber, prefixMap)
      if (!prefixCheck.ok) {
        console.warn(`[PURCHASE] ⛔ Prefix mismatch: ${network} / ${String(phoneNumber).slice(0, 12)}`)
        return NextResponse.json({ error: prefixCheck.message }, { status: 400 })
      }
    }
```

- [ ] **Step 2: `app/api/orders/create-bulk/route.ts`** — the `network` is request-level but validated AFTER the row loop (:61-66). Move nothing; instead add AFTER the existing network check (:66):

```ts
    // Order-time network↔prefix validation — reject the WHOLE batch with an
    // itemized list so the uploader can fix their file (partial acceptance
    // would complicate wallet pricing/refunds).
    const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
    if (prefixCheckEnabled) {
      const invalidRows: Array<{ row: number; phone: string; message: string }> = []
      for (let i = 0; i < orders.length; i++) {
        const check = validateNetworkPrefix(network, orders[i].phone_number, prefixMap)
        if (!check.ok) invalidRows.push({ row: i + 1, phone: orders[i].phone_number, message: check.message })
      }
      if (invalidRows.length > 0) {
        return NextResponse.json(
          {
            error: `${invalidRows.length} number(s) don't match the ${network} network. Fix these rows and re-upload.`,
            invalidRows: invalidRows.slice(0, 50),
          },
          { status: 400 }
        )
      }
    }
```

- [ ] **Step 3: `app/api/shop/orders/create/route.ts`** — directly after the phone-format block (:128-134), add (uses the `normalizedPhone` + body `network` already in scope):

```ts
    // Order-time network↔prefix validation (hard block; admin-toggleable).
    const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
    if (prefixCheckEnabled) {
      const prefixCheck = validateNetworkPrefix(network, normalizedPhone, prefixMap)
      if (!prefixCheck.ok) {
        console.warn(`[SHOP-ORDER] ⛔ Prefix mismatch for shop ${shop_id}: ${network} / ${normalizedPhone.slice(0, 12)}`)
        return NextResponse.json({ error: prefixCheck.message }, { status: 400 })
      }
    }
```

- [ ] **Step 4: `app/api/v1/orders/route.ts`** — after the `sanitizedNetwork` line (:135), add:

```ts
  // Order-time network↔prefix validation (hard block; admin-toggleable).
  const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
  if (prefixCheckEnabled) {
    const prefixCheck = validateNetworkPrefix(sanitizedNetwork, cleanRecipient, prefixMap)
    if (!prefixCheck.ok) {
      return NextResponse.json(
        { success: false, error: prefixCheck.message, error_code: "NETWORK_MISMATCH" },
        { status: 400 }
      )
    }
  }
```

- [ ] **Step 5: `lib/ussd/handlers/bundles.ts`** — in `handleEnterRecipient`, directly after the format check (:228-230), add:

```ts
  // Network↔prefix validation (hard block; admin-toggleable).
  const { enabled: prefixCheckEnabled, map: prefixMap } = await getPrefixValidationConfig()
  if (prefixCheckEnabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefixMap)
    if (!check.ok) {
      return cont(`${check.message}\n\nEnter recipient number:\n0. Back`)
    }
  }
```

- [ ] **Step 6: `lib/ussd-shop/handlers/bundles.ts`** — same insertion after :280-282, identical block.

- [ ] **Step 7: Verify + commit**

Run: `npx tsc --noEmit && npm run test:run`
Expected: clean / full suite green (new tests from Tasks 1-2 included).

```bash
git add app/api/orders/purchase/route.ts app/api/orders/create-bulk/route.ts app/api/shop/orders/create/route.ts app/api/v1/orders/route.ts lib/ussd/handlers/bundles.ts lib/ussd-shop/handlers/bundles.ts
git commit -m "feat: enforce network-prefix validation at all 6 order-creation sites"
```

---

## Task 5: Admin UI card (toggle + prefix chips)

**Files:**
- Create: `components/admin/network-prefix-settings-card.tsx`
- Modify: `app/admin/settings/page.tsx` (1 import + 1 JSX line)

- [ ] **Step 1: Create the card component**

Create `components/admin/network-prefix-settings-card.tsx` (self-contained, mirroring the `PhoneBlacklistManager`/`AirtimeSettingsCard` precedent):

```tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Loader2, ShieldCheck, X, Plus } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"

type Net = "MTN" | "TELECEL" | "AT"
const NETWORKS: Net[] = ["MTN", "TELECEL", "AT"]
const NETWORK_LABEL: Record<Net, string> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function NetworkPrefixSettingsCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [map, setMap] = useState<Record<Net, string[]> | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [newPrefix, setNewPrefix] = useState<Record<Net, string>>({ MTN: "", TELECEL: "", AT: "" })
  const [busyPrefix, setBusyPrefix] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const [tRes, mRes] = await Promise.all([
        fetch("/api/admin/settings/network-prefix-validation", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/admin/settings/network-prefixes", { headers: { Authorization: `Bearer ${token}` } }),
      ])
      if (tRes.ok) setEnabled((await tRes.json()).enabled)
      if (mRes.ok) setMap((await mRes.json()).map)
    } catch {
      toast.error("Failed to load prefix validation settings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (next: boolean) => {
    setToggling(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/network-prefix-validation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to update")
      setEnabled(next)
      toast.success(data.message || `Prefix validation ${next ? "enabled" : "disabled"}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update")
    } finally {
      setToggling(false)
    }
  }

  const mutatePrefix = async (network: Net, prefix: string, action: "add" | "remove") => {
    setBusyPrefix(`${network}:${prefix}:${action}`)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/settings/network-prefixes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ network, prefix, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to update prefixes")
      setMap(data.map)
      if (action === "add") setNewPrefix(prev => ({ ...prev, [network]: "" }))
      toast.success(`0${prefix.replace(/^0/, "")} ${action === "add" ? "added to" : "removed from"} ${NETWORK_LABEL[network]}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update prefixes")
    } finally {
      setBusyPrefix(null)
    }
  }

  return (
    <Card className="mb-6 border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5" />
          Network Prefix Validation
        </CardTitle>
        <CardDescription>
          Blocks data orders when the phone number&apos;s prefix doesn&apos;t match the selected
          network (e.g. a Telecel 020 number on an MTN bundle). The prefix map below also drives
          the MTN registration export.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
              <div>
                <p className="font-medium text-foreground">
                  {enabled ? "🟢 ENABLED — mismatched orders are blocked" : "⚪ DISABLED — orders accepted as before"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Turn off temporarily if a genuinely ported number needs to order.
                </p>
              </div>
              <Switch checked={!!enabled} onCheckedChange={handleToggle} disabled={toggling} />
            </div>

            <div className="space-y-4">
              {NETWORKS.map(net => (
                <div key={net} className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{NETWORK_LABEL[net]} prefixes</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {(map?.[net] ?? []).map(p => (
                      <Badge key={p} variant="secondary" className="gap-1">
                        0{p}
                        <button
                          onClick={() => mutatePrefix(net, p, "remove")}
                          disabled={busyPrefix !== null}
                          className="ml-1 hover:text-destructive"
                          title={`Remove 0${p} from ${NETWORK_LABEL[net]}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                    <div className="flex items-center gap-1">
                      <Input
                        value={newPrefix[net]}
                        onChange={e => setNewPrefix(prev => ({ ...prev, [net]: e.target.value }))}
                        placeholder="058"
                        className="h-8 w-20 text-sm"
                        maxLength={3}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => mutatePrefix(net, newPrefix[net], "add")}
                        disabled={busyPrefix !== null || !newPrefix[net].trim()}
                      >
                        {busyPrefix?.startsWith(`${net}:`) ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Plus className="w-3 h-3" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Wire into the settings page**

In `app/admin/settings/page.tsx`: add `import NetworkPrefixSettingsCard from "@/components/admin/network-prefix-settings-card"` next to the `PhoneBlacklistManager` import (:18), and render `<NetworkPrefixSettingsCard />` directly after `<AirtimeSettingsCard />` (:992).

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit`
Expected: clean. (Confirm `components/ui/switch` and `badge` exports match usage — both standard shadcn in this repo.)

```bash
git add components/admin/network-prefix-settings-card.tsx app/admin/settings/page.tsx
git commit -m "feat(admin): network prefix validation card (toggle + editable prefixes)"
```

---

## Task 6: Client hints (storefront + dashboard)

**Files:**
- Modify: `app/shop/[slug]/page.tsx` (:16 imports, :1075-1090 input block, plus map state)
- Modify: `app/dashboard/data-packages/page.tsx`

- [ ] **Step 1: Storefront — live map + network-aware hint**

In `app/shop/[slug]/page.tsx`:
(a) extend the import at :16: `import { validatePhoneNumber } from "@/lib/phone-validation"` → also import the map type + default: `import { DEFAULT_NETWORK_PREFIXES, type NetworkPrefixMap } from "@/lib/phone-format"`.
(b) add state + a one-time fetch near the other `useState`s:

```tsx
const [prefixMap, setPrefixMap] = useState<NetworkPrefixMap>(DEFAULT_NETWORK_PREFIXES)

useEffect(() => {
  fetch("/api/network-prefixes")
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d?.map) setPrefixMap(d.map) })
    .catch(() => {}) // fall back to defaults silently
}, [])
```
(c) thread the map into BOTH `validatePhoneNumber` call sites (:242-ish helper and :332): `validatePhoneNumber(orderData.customer_phone, selectedPackage.network, prefixMap)` (adjust the helper `validatePhoneNumberField` signature to accept and pass the map).
(d) replace the static hint (:1087-1089):

```tsx
<p className="text-xs text-muted-foreground mt-1">
  {selectedPackage?.network
    ? `Must be a ${selectedPackage.network} number — the prefix is checked at checkout.`
    : "Format: 10 digits starting with 02 or 05 (e.g., 0201234567)"}
</p>
```
(Use the component's actual selected-package variable at that JSX location — verify whether it's `selectedPackage` or another name in scope there and match it.)

- [ ] **Step 2: Dashboard data-packages page**

Open `app/dashboard/data-packages/page.tsx`; find its phone validation (it posts to `/api/orders/purchase`; per `lib/phone-validation.ts`'s header it should already import `validatePhoneNumber` — if it does, thread the fetched map + selected network exactly as in Step 1 (add the same `prefixMap` state + fetch). If it does NOT call `validatePhoneNumber` with a network today, add the call before submit using the page's selected-network state, surfacing `result.error` via the page's existing error UI (toast or inline). Keep the edit minimal and matching the file's style; the server now enforces regardless.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit && npm run test:run`
Expected: clean / green.

```bash
git add "app/shop/[slug]/page.tsx" app/dashboard/data-packages/page.tsx
git commit -m "feat: network-aware phone hints with live prefix map on order pages"
```

---

## Task 7: Full verification + memory

- [ ] **Step 1:** `npm run test:run` (expect ~296+: 280 pre-existing + Task 1 & 2 suites) and `npx tsc --noEmit` — both clean.
- [ ] **Step 2 (operator, after deploy):** storefront MTN package + 020 number → blocked client-side AND (via curl) server-side; add prefix `58` to MTN in the admin card → `0581234567` accepted for MTN orders and `gh_is_mtn('0581234567')` returns true (SQL); remove it → both revert; toggle OFF → orders accepted as before.
- [ ] **Step 3:** Update memory (`project-mtn-number-registration.md` gains a pointer; new memory or section for prefix validation) + `MEMORY.md` line.

---

## Self-review notes (author)

- **Spec coverage:** validator+map (Task 1) ↔ spec §A; delegation closing the 020-hole (Task 2) ↔ spec background; config readers + seed migration + STABLE `gh_is_mtn` + transactional map-drives-SQL verification (Task 3) ↔ §A2/B; 6 enforcement sites incl. bulk itemized rejection + v1 `error_code` + USSD re-prompts (Task 4) ↔ §C; admin card w/ chips + guardrails (move-conflict 409, last-prefix 400, audit log) (Tasks 3/5) ↔ §A2/E; public endpoint + client threading + hint-text fix (Tasks 3/6) ↔ §D; 053=MTN pinned in Task 1 AND Task 2 tests AND the SQL verification.
- **Type consistency:** `NetworkPrefixMap`/`DEFAULT_NETWORK_PREFIXES`/`validateNetworkPrefix(orderNetwork, phone, map?)` identical across Tasks 1/2/3/4/6; `getPrefixValidationConfig() → { enabled, map }` used at all 6 sites; toggle default-ON semantics (`enabled !== false`) consistent between the reader (Task 3 Step 1) and the toggle route (Task 3 Step 5).
- **Honest flexibility points (bounded):** the storefront hint's in-scope package variable (Task 6 Step 1d verifies), data-packages page's existing validation shape (Task 6 Step 2 gives both branches), USSD files' import style (alias vs relative — match file). Everything else verbatim.
- **Deliberate simplification:** client inline hints use the fetched map but do not read the toggle (spec-sanctioned YAGNI); `step-customer.tsx` untouched (dead code — flagged, not deleted; removing it is unrelated refactoring).
