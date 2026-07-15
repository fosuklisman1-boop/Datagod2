# All-Time Order Phone Export (grouped by network) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a one-click download of every phone number that has ever appeared on any order, across all 9 order tables, deduplicated per mobile network, as an `.xlsx` workbook (one sheet per network + a summary).

**Architecture:** A read-only Postgres view `all_order_phones` `UNION ALL`s all 9 order tables into a common shape, normalizing phone format and canonicalizing network strings; a SQL function `get_all_order_phones()` pre-aggregates it to one compact row per `(source, network, phone)` and returns a single JSONB array (dodging PostgREST's row cap). A pure TS module (`lib/order-phone-network.ts`) does network inference for the no-network order types (AFA, results-checker) and groups phones into per-network buckets. A thin admin route builds the workbook with `xlsx` and audit-logs the export. One button on the existing admin orders page triggers it.

**Tech Stack:** Next.js 15 App Router (route handlers), Supabase (Postgres + service-role client), `xlsx` (already a dependency), Vitest (already configured), TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-07-all-order-phone-export-design.md`

---

## The 9 order-bearing tables (verified against migrations)

| Source table | Phone column used | Network column | Product type |
|--------------|-------------------|----------------|--------------|
| `orders` | `phone_number` | `network` | data |
| `shop_orders` | `customer_phone` | `network` | data |
| `api_orders` | `recipient_phone` | `network` | data |
| `ussd_orders` | `recipient_phone` | `network` | data |
| `ussd_shop_orders` | `recipient_phone` | `network` | data |
| `airtime_orders` | `beneficiary_phone` | `network` | airtime |
| `afa_orders` | `phone_number` | — (none) | afa |
| `ussd_afa_orders` | `dialing_phone` | — (none) | afa |
| `results_checker_orders` | `customer_phone` | — (none) | results |

Scope = **all statuses** (no status filter). Sheets: `MTN`, `Telecel`, `AT`, `AT - iShare`, `AT - BigTime`, `Unknown`.

---

## File structure

- **Create** `migrations/20260707_all_order_phones.sql` — `normalize_gh_phone()` helper, `all_order_phones` view, `get_all_order_phones()` aggregate function.
- **Create** `lib/order-phone-network.ts` — pure inference + sheet/summary row shaping; exports `ORDER_SOURCE_TABLES`, `NETWORK_SHEETS`, `RawPhoneRow`, `PhoneEntry`, `groupPhonesByNetwork`, `toSheetRows`, `buildSummaryRows`.
- **Create** `lib/order-phone-network.test.ts` — unit tests (co-located, matching repo convention).
- **Create** `app/api/admin/orders/phone-export/route.ts` — admin GET route: rpc → group → workbook → audit-log → xlsx.
- **Modify** `app/admin/orders/page.tsx` — add a "Download phone numbers" button + handler.

---

## Task 1: Database migration (view + aggregate function)

**Files:**
- Create: `migrations/20260707_all_order_phones.sql`

> This repo applies migrations directly to Supabase (SQL editor / Management API / Supabase MCP `apply_migration`), not via a local migrate runner. The "test" for this task is applying the SQL and running a verification query. Requires Supabase access.

- [ ] **Step 1: Write the migration file**

Create `migrations/20260707_all_order_phones.sql`:

```sql
-- All-time order phone export: union all 9 order tables into one read-only view,
-- normalize phone format + canonicalize network, and expose a pre-aggregated
-- JSONB accessor. Read-only; does not touch the fulfillment combined_orders_view.

-- 1. Phone normalizer: mirrors lib/phone-format.ts (canonical local 0XXXXXXXXX),
--    returns NULL for anything that isn't a plausible Ghana mobile number.
CREATE OR REPLACE FUNCTION normalize_gh_phone(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH d AS (
    SELECT regexp_replace(COALESCE(raw, ''), '\D', '', 'g') AS digits
  ),
  sig AS (
    SELECT CASE
      WHEN digits LIKE '233%' THEN substring(digits FROM 4)
      WHEN digits LIKE '0%'   THEN substring(digits FROM 2)
      ELSE digits
    END AS s
    FROM d
  )
  SELECT CASE WHEN s ~ '^[2-9][0-9]{8}$' THEN '0' || s ELSE NULL END
  FROM sig;
$$;

-- 2. Union view. network_raw is canonicalized here; NULL for the no-network tables.
DROP VIEW IF EXISTS all_order_phones;
CREATE VIEW all_order_phones AS
SELECT 'orders'::text AS source_table, 'data'::text AS product_type,
       normalize_gh_phone(o.phone_number) AS phone, o.phone_number AS phone_original,
       CASE
         WHEN LOWER(o.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(o.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(o.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(o.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(o.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(o.network)
       END AS network_raw,
       o.created_at
FROM orders o
UNION ALL
SELECT 'shop_orders', 'data',
       normalize_gh_phone(so.customer_phone), so.customer_phone,
       CASE
         WHEN LOWER(so.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(so.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(so.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(so.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(so.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(so.network)
       END,
       so.created_at
FROM shop_orders so
UNION ALL
SELECT 'api_orders', 'data',
       normalize_gh_phone(ao.recipient_phone), ao.recipient_phone,
       CASE
         WHEN LOWER(ao.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(ao.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(ao.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(ao.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(ao.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(ao.network)
       END,
       ao.created_at
FROM api_orders ao
UNION ALL
SELECT 'ussd_orders', 'data',
       normalize_gh_phone(uo.recipient_phone), uo.recipient_phone,
       CASE
         WHEN LOWER(uo.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(uo.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(uo.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(uo.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(uo.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(uo.network)
       END,
       uo.created_at
FROM ussd_orders uo
UNION ALL
SELECT 'ussd_shop_orders', 'data',
       normalize_gh_phone(uso.recipient_phone), uso.recipient_phone,
       CASE
         WHEN LOWER(uso.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(uso.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(uso.network) IN ('at','airteltigo') THEN 'AT'
         WHEN LOWER(uso.network) IN ('at - ishare','at-ishare','ishare') THEN 'AT - iShare'
         WHEN LOWER(uso.network) IN ('at - bigtime','at-bigtime','bigtime') THEN 'AT - BigTime'
         ELSE UPPER(uso.network)
       END,
       uso.created_at
FROM ussd_shop_orders uso
UNION ALL
SELECT 'airtime_orders', 'airtime',
       normalize_gh_phone(air.beneficiary_phone), air.beneficiary_phone,
       CASE
         WHEN LOWER(air.network) = 'mtn' THEN 'MTN'
         WHEN LOWER(air.network) = 'telecel' THEN 'Telecel'
         WHEN LOWER(air.network) IN ('at','airteltigo') THEN 'AT'
         ELSE UPPER(air.network)
       END,
       air.created_at
FROM airtime_orders air
UNION ALL
SELECT 'afa_orders', 'afa',
       normalize_gh_phone(afa.phone_number), afa.phone_number,
       NULL::text,
       afa.created_at
FROM afa_orders afa
UNION ALL
SELECT 'ussd_afa_orders', 'afa',
       normalize_gh_phone(ua.dialing_phone), ua.dialing_phone,
       NULL::text,
       ua.created_at
FROM ussd_afa_orders ua
UNION ALL
SELECT 'results_checker_orders', 'results',
       normalize_gh_phone(rc.customer_phone), rc.customer_phone,
       NULL::text,
       rc.created_at
FROM results_checker_orders rc;

-- 3. Pre-aggregated accessor: one row per (source, network_raw, phone), returned
--    as a single JSONB array so the route reads it in one PostgREST call.
CREATE OR REPLACE FUNCTION get_all_order_phones()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (
    SELECT
      source_table,
      product_type,
      network_raw,
      COALESCE(phone, phone_original) AS phone,
      (phone IS NOT NULL) AS normalized,
      COUNT(*)            AS order_count,
      MIN(created_at)     AS first_order_at,
      MAX(created_at)     AS last_order_at
    FROM all_order_phones
    GROUP BY source_table, product_type, network_raw,
             COALESCE(phone, phone_original), (phone IS NOT NULL)
  ) t;
$$;
```

- [ ] **Step 2: Apply the migration to Supabase**

Apply the file via the Supabase SQL editor / Management API / Supabase MCP `apply_migration` (project ref per `reference-supabase-access`).
Expected: no error. If any column/table name is wrong, `CREATE VIEW` fails loudly here — fix the offending line and re-apply.

- [ ] **Step 3: Verify the helper normalizes correctly**

Run:
```sql
SELECT normalize_gh_phone('0241234567') AS a,      -- expect 0241234567
       normalize_gh_phone('233241234567') AS b,    -- expect 0241234567
       normalize_gh_phone('+233 24 123 4567') AS c,-- expect 0241234567
       normalize_gh_phone('241234567') AS d,        -- expect 0241234567
       normalize_gh_phone('hello') AS e;            -- expect NULL
```
Expected: a=b=c=d=`0241234567`, e=`NULL`.

- [ ] **Step 4: Verify the aggregate returns rows in the expected shape**

Run:
```sql
SELECT jsonb_array_length(get_all_order_phones()) AS row_count;
SELECT get_all_order_phones() -> 0 AS sample_row;
```
Expected: `row_count` ≥ 0 (a number), and `sample_row` (if any orders exist) has keys `source_table, product_type, network_raw, phone, normalized, order_count, first_order_at, last_order_at`.

- [ ] **Step 5: Commit**

```bash
git add migrations/20260707_all_order_phones.sql
git commit -m "feat(db): all_order_phones view + get_all_order_phones() aggregate"
```

---

## Task 2: TS module scaffolding + "no table missed" guard test

**Files:**
- Create: `lib/order-phone-network.ts`
- Test: `lib/order-phone-network.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `lib/order-phone-network.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ORDER_SOURCE_TABLES, NETWORK_SHEETS } from './order-phone-network'

describe('order source coverage (no order type missed)', () => {
  it('lists exactly the 9 known order tables', () => {
    expect([...ORDER_SOURCE_TABLES].sort()).toEqual(
      [
        'afa_orders',
        'airtime_orders',
        'api_orders',
        'orders',
        'results_checker_orders',
        'shop_orders',
        'ussd_afa_orders',
        'ussd_orders',
        'ussd_shop_orders',
      ].sort()
    )
    // If a new order table is ever added, wire it into the view AND this list.
    expect(ORDER_SOURCE_TABLES).toHaveLength(9)
  })

  it('exposes the six network sheets in display order', () => {
    expect(NETWORK_SHEETS).toEqual([
      'MTN', 'Telecel', 'AT', 'AT - iShare', 'AT - BigTime', 'Unknown',
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: FAIL — cannot import from `./order-phone-network` (module does not exist yet).

- [ ] **Step 3: Create the module with the constants and types**

Create `lib/order-phone-network.ts`:

```ts
// Pure, DB-free logic for the all-time order phone export.
// Consumes the pre-aggregated rows from the get_all_order_phones() SQL function
// and groups phone numbers into per-network buckets, inferring the network for
// the order types that don't carry one (AFA, results-checker).
import { detectGhanaNetwork } from './phone-format'

/** The 9 order-bearing tables the export must cover. Kept in lockstep with the
 *  all_order_phones view. Adding a 10th order table means updating BOTH. */
export const ORDER_SOURCE_TABLES = [
  'orders',
  'shop_orders',
  'api_orders',
  'ussd_orders',
  'ussd_shop_orders',
  'airtime_orders',
  'afa_orders',
  'ussd_afa_orders',
  'results_checker_orders',
] as const

/** Order tables that have NO network column — network is inferred for these. */
export const NO_NETWORK_SOURCES = ['afa_orders', 'ussd_afa_orders', 'results_checker_orders'] as const

/** AFA is an MTN government scheme; its unknown-network phones default to MTN. */
export const AFA_SOURCES = ['afa_orders', 'ussd_afa_orders'] as const

/** Workbook sheet names, in display order. */
export const NETWORK_SHEETS = [
  'MTN', 'Telecel', 'AT', 'AT - iShare', 'AT - BigTime', 'Unknown',
] as const
export type NetworkSheet = (typeof NETWORK_SHEETS)[number]

/** One pre-aggregated row from get_all_order_phones(). */
export interface RawPhoneRow {
  source_table: string
  product_type: string // 'data' | 'airtime' | 'afa' | 'results'
  network_raw: string | null
  phone: string // normalized 0XXXXXXXXX, or the raw value when normalized === false
  normalized: boolean
  order_count: number
  first_order_at: string | null
  last_order_at: string | null
}

/** One deduplicated phone entry within a network sheet. */
export interface PhoneEntry {
  phone: string
  orderCount: number
  firstOrderAt: string | null
  lastOrderAt: string | null
  products: string[] // sorted unique product types
}
```

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: PASS (both tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/order-phone-network.ts lib/order-phone-network.test.ts
git commit -m "feat: order-phone-network module scaffold + coverage guard test"
```

---

## Task 3: Network inference + grouping (`groupPhonesByNetwork`)

**Files:**
- Modify: `lib/order-phone-network.ts`
- Test: `lib/order-phone-network.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/order-phone-network.test.ts`:

```ts
import { groupPhonesByNetwork } from './order-phone-network'
import type { RawPhoneRow } from './order-phone-network'

function row(p: Partial<RawPhoneRow>): RawPhoneRow {
  return {
    source_table: 'orders',
    product_type: 'data',
    network_raw: 'MTN',
    phone: '0241234567',
    normalized: true,
    order_count: 1,
    first_order_at: '2026-01-01T00:00:00Z',
    last_order_at: '2026-01-01T00:00:00Z',
    ...p,
  }
}

describe('groupPhonesByNetwork', () => {
  it('always returns all six sheets, even when empty', () => {
    const g = groupPhonesByNetwork([])
    expect([...g.keys()]).toEqual([...NETWORK_SHEETS])
    for (const s of NETWORK_SHEETS) expect(g.get(s)).toEqual([])
  })

  it('places a network-bearing order in its network sheet', () => {
    const g = groupPhonesByNetwork([row({ network_raw: 'Telecel', phone: '0201112223' })])
    expect(g.get('Telecel')!.map(e => e.phone)).toEqual(['0201112223'])
    expect(g.get('MTN')).toEqual([])
  })

  it('merges duplicate phones within a network (sum counts, widen date range, union products)', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'orders', product_type: 'data', order_count: 3,
            first_order_at: '2026-01-01T00:00:00Z', last_order_at: '2026-02-01T00:00:00Z' }),
      row({ source_table: 'airtime_orders', product_type: 'airtime', order_count: 2,
            first_order_at: '2025-12-01T00:00:00Z', last_order_at: '2026-03-01T00:00:00Z' }),
    ])
    const e = g.get('MTN')!.find(x => x.phone === '0241234567')!
    expect(e.orderCount).toBe(5)
    expect(e.firstOrderAt).toBe('2025-12-01T00:00:00Z')
    expect(e.lastOrderAt).toBe('2026-03-01T00:00:00Z')
    expect(e.products).toEqual(['airtime', 'data'])
  })

  it('known-network-wins: an AFA phone also seen on an AT order goes to AT, not prefix', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'api_orders', network_raw: 'AT', phone: '0241234567' }), // MTN prefix, but known AT
      row({ source_table: 'afa_orders', product_type: 'afa', network_raw: null, phone: '0241234567' }),
    ])
    expect(g.get('AT')!.find(e => e.phone === '0241234567')!.orderCount).toBe(2)
    expect(g.get('MTN')).toEqual([])
  })

  it('AFA with no known network defaults to MTN (ignoring prefix)', () => {
    // 0271234567 is an AT prefix, but AFA => MTN when otherwise unknown.
    const g = groupPhonesByNetwork([
      row({ source_table: 'afa_orders', product_type: 'afa', network_raw: null, phone: '0271234567' }),
    ])
    expect(g.get('MTN')!.map(e => e.phone)).toEqual(['0271234567'])
    expect(g.get('AT')).toEqual([])
  })

  it('results-checker with no known network infers from phone prefix', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'results_checker_orders', product_type: 'results', network_raw: null, phone: '0271234567' }),
    ])
    expect(g.get('AT')!.map(e => e.phone)).toEqual(['0271234567'])
  })

  it('un-normalizable / unknown-prefix phones land in Unknown, never dropped', () => {
    const g = groupPhonesByNetwork([
      row({ source_table: 'results_checker_orders', product_type: 'results', network_raw: null,
            phone: 'garbage', normalized: false }),
    ])
    expect(g.get('Unknown')!.map(e => e.phone)).toEqual(['garbage'])
  })

  it('a phone bought on two networks appears in both sheets', () => {
    const g = groupPhonesByNetwork([
      row({ network_raw: 'MTN', phone: '0241234567' }),
      row({ network_raw: 'AT', phone: '0241234567' }),
    ])
    expect(g.get('MTN')!.some(e => e.phone === '0241234567')).toBe(true)
    expect(g.get('AT')!.some(e => e.phone === '0241234567')).toBe(true)
  })

  it('maps an unexpected network_raw value to Unknown', () => {
    const g = groupPhonesByNetwork([row({ network_raw: 'GLO', phone: '0241234567' })])
    expect(g.get('Unknown')!.map(e => e.phone)).toEqual(['0241234567'])
  })

  it('sorts each sheet by order count descending', () => {
    const g = groupPhonesByNetwork([
      row({ phone: '0241111111', order_count: 1 }),
      row({ phone: '0242222222', order_count: 9 }),
    ])
    expect(g.get('MTN')!.map(e => e.phone)).toEqual(['0242222222', '0241111111'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: FAIL — `groupPhonesByNetwork` is not exported.

- [ ] **Step 3: Implement `groupPhonesByNetwork`**

Append to `lib/order-phone-network.ts`:

```ts
/** Map a canonical network_raw string to one of the workbook sheets. */
function networkRawToSheet(networkRaw: string): NetworkSheet {
  return (NETWORK_SHEETS as readonly string[]).includes(networkRaw)
    ? (networkRaw as NetworkSheet)
    : 'Unknown'
}

/** Map lib/phone-format's detectGhanaNetwork output to a workbook sheet. */
function prefixToSheet(phone: string): NetworkSheet {
  switch (detectGhanaNetwork(phone)) {
    case 'MTN': return 'MTN'
    case 'TELECEL': return 'Telecel'
    case 'AT': return 'AT'
    default: return 'Unknown'
  }
}

function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
function later(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/**
 * Group pre-aggregated rows into per-network sheets.
 * Precedence for a phone's network:
 *   1. Known-network-wins — any network the phone was actually seen on.
 *   2. AFA source with no known network -> MTN.
 *   3. Otherwise infer from the phone prefix.
 *   4. Unknown prefix / un-normalizable -> Unknown. Nothing is dropped.
 */
export function groupPhonesByNetwork(rows: RawPhoneRow[]): Map<NetworkSheet, PhoneEntry[]> {
  // Step 1: known-network map (only rows that actually carry a network).
  const known = new Map<string, Set<NetworkSheet>>()
  for (const r of rows) {
    if (r.network_raw == null) continue
    const sheet = networkRawToSheet(r.network_raw)
    if (!known.has(r.phone)) known.set(r.phone, new Set())
    known.get(r.phone)!.add(sheet)
  }

  // Step 2: accumulate into (sheet -> phone -> entry).
  const acc = new Map<NetworkSheet, Map<string, PhoneEntry & { _products: Set<string> }>>()
  for (const s of NETWORK_SHEETS) acc.set(s, new Map())

  const addTo = (sheet: NetworkSheet, r: RawPhoneRow) => {
    const bucket = acc.get(sheet)!
    let e = bucket.get(r.phone)
    if (!e) {
      e = { phone: r.phone, orderCount: 0, firstOrderAt: null, lastOrderAt: null,
            products: [], _products: new Set<string>() }
      bucket.set(r.phone, e)
    }
    e.orderCount += Number(r.order_count) || 0
    e.firstOrderAt = earlier(e.firstOrderAt, r.first_order_at)
    e.lastOrderAt = later(e.lastOrderAt, r.last_order_at)
    e._products.add(r.product_type)
  }

  for (const r of rows) {
    if (r.network_raw != null) {
      addTo(networkRawToSheet(r.network_raw), r)
      continue
    }
    // No network on this row: resolve via precedence.
    const knownSheets = known.get(r.phone)
    if (knownSheets && knownSheets.size > 0) {
      for (const s of knownSheets) addTo(s, r)
    } else if ((AFA_SOURCES as readonly string[]).includes(r.source_table)) {
      addTo('MTN', r)
    } else {
      addTo(prefixToSheet(r.phone), r)
    }
  }

  // Step 3: finalize — resolve products, sort by orderCount desc then phone.
  const out = new Map<NetworkSheet, PhoneEntry[]>()
  for (const s of NETWORK_SHEETS) {
    const entries = [...acc.get(s)!.values()].map(e => ({
      phone: e.phone,
      orderCount: e.orderCount,
      firstOrderAt: e.firstOrderAt,
      lastOrderAt: e.lastOrderAt,
      products: [...e._products].sort(),
    }))
    entries.sort((a, b) => b.orderCount - a.orderCount || a.phone.localeCompare(b.phone))
    out.set(s, entries)
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: PASS (all inference cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/order-phone-network.ts lib/order-phone-network.test.ts
git commit -m "feat: network inference + per-network grouping with precedence"
```

---

## Task 4: Sheet + summary row shaping

**Files:**
- Modify: `lib/order-phone-network.ts`
- Test: `lib/order-phone-network.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/order-phone-network.test.ts`:

```ts
import { toSheetRows, buildSummaryRows } from './order-phone-network'

describe('toSheetRows', () => {
  it('shapes entries into flat spreadsheet rows with date-only dates', () => {
    const rows = toSheetRows([
      { phone: '0241234567', orderCount: 4, firstOrderAt: '2026-01-02T09:00:00Z',
        lastOrderAt: '2026-03-04T10:00:00Z', products: ['airtime', 'data'] },
    ])
    expect(rows).toEqual([
      { Phone: '0241234567', Orders: 4, 'First Order': '2026-01-02',
        'Last Order': '2026-03-04', Products: 'airtime, data' },
    ])
  })

  it('renders empty dates as empty strings', () => {
    const rows = toSheetRows([
      { phone: 'garbage', orderCount: 1, firstOrderAt: null, lastOrderAt: null, products: ['results'] },
    ])
    expect(rows[0]['First Order']).toBe('')
    expect(rows[0]['Last Order']).toBe('')
  })
})

describe('buildSummaryRows', () => {
  it('produces one row per network plus a TOTAL row', () => {
    const g = groupPhonesByNetwork([
      row({ network_raw: 'MTN', phone: '0241234567', order_count: 3 }),
      row({ network_raw: 'MTN', phone: '0242222222', order_count: 1 }),
      row({ network_raw: 'Telecel', phone: '0201112223', order_count: 2 }),
    ])
    const summary = buildSummaryRows(g)
    const mtn = summary.find(s => s.Network === 'MTN')!
    expect(mtn['Unique Phones']).toBe(2)
    expect(mtn['Total Orders']).toBe(4)
    const total = summary.find(s => s.Network === 'TOTAL')!
    expect(total['Unique Phones']).toBe(3)
    expect(total['Total Orders']).toBe(6)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: FAIL — `toSheetRows` / `buildSummaryRows` not exported.

- [ ] **Step 3: Implement the shapers**

Append to `lib/order-phone-network.ts`:

```ts
const dateOnly = (iso: string | null): string => (iso ? iso.split('T')[0] : '')

export interface SheetRow {
  Phone: string
  Orders: number
  'First Order': string
  'Last Order': string
  Products: string
}

export function toSheetRows(entries: PhoneEntry[]): SheetRow[] {
  return entries.map(e => ({
    Phone: e.phone,
    Orders: e.orderCount,
    'First Order': dateOnly(e.firstOrderAt),
    'Last Order': dateOnly(e.lastOrderAt),
    Products: e.products.join(', '),
  }))
}

export interface SummaryRow {
  Network: string
  'Unique Phones': number
  'Total Orders': number
}

export function buildSummaryRows(grouped: Map<NetworkSheet, PhoneEntry[]>): SummaryRow[] {
  const rows: SummaryRow[] = []
  let totalPhones = 0
  let totalOrders = 0
  for (const sheet of NETWORK_SHEETS) {
    const entries = grouped.get(sheet) ?? []
    const orders = entries.reduce((n, e) => n + e.orderCount, 0)
    totalPhones += entries.length
    totalOrders += orders
    rows.push({ Network: sheet, 'Unique Phones': entries.length, 'Total Orders': orders })
  }
  rows.push({ Network: 'TOTAL', 'Unique Phones': totalPhones, 'Total Orders': totalOrders })
  return rows
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/order-phone-network.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/order-phone-network.ts lib/order-phone-network.test.ts
git commit -m "feat: sheet + summary row shaping for phone export"
```

---

## Task 5: Admin export route

**Files:**
- Create: `app/api/admin/orders/phone-export/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/admin/orders/phone-export/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import * as XLSX from "xlsx"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  groupPhonesByNetwork,
  toSheetRows,
  buildSummaryRows,
  NETWORK_SHEETS,
  type RawPhoneRow,
} from "@/lib/order-phone-network"

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { data, error } = await supabase.rpc("get_all_order_phones")
    if (error) {
      console.error("[PHONE-EXPORT] rpc error:", error)
      return NextResponse.json({ error: "Failed to gather order phones" }, { status: 500 })
    }

    const rows = (data ?? []) as RawPhoneRow[]
    const grouped = groupPhonesByNetwork(rows)
    const summary = buildSummaryRows(grouped)

    // Build workbook: Summary first, then one sheet per network (always present).
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(summary),
      "Summary"
    )
    for (const sheet of NETWORK_SHEETS) {
      const sheetRows = toSheetRows(grouped.get(sheet) ?? [])
      // json_to_sheet on [] yields an empty sheet; add a header row explicitly.
      const ws = sheetRows.length
        ? XLSX.utils.json_to_sheet(sheetRows)
        : XLSX.utils.json_to_sheet([], {
            header: ["Phone", "Orders", "First Order", "Last Order", "Products"],
          })
      // Sheet names cannot exceed 31 chars or contain []:*?/\ — ours are safe.
      XLSX.utils.book_append_sheet(workbook, ws, sheet)
    }

    const totals = summary.find(s => s.Network === "TOTAL")
    // Audit trail: bulk PII export. AWAIT it (not fire-and-forget) so the record
    // is durably written before this serverless function freezes on response.
    // Best-effort: a failed audit insert must not fail the download.
    try {
      const { error: auditErr } = await supabase
        .from("admin_audit_log")
        .insert([{
          admin_id: adminId || null,
          action: "export_all_order_phones",
          new_value: {
            total_unique_phones: totals?.["Unique Phones"] ?? 0,
            total_orders: totals?.["Total Orders"] ?? 0,
            by_network: summary.filter(s => s.Network !== "TOTAL"),
          },
          created_at: new Date().toISOString(),
        }])
      if (auditErr) console.warn("[PHONE-EXPORT] audit insert failed:", auditErr.message)
    } catch (auditErr) {
      console.warn("[PHONE-EXPORT] audit insert threw:", auditErr)
    }

    const excelBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" })
    const fileName = `order-phones-${new Date().toISOString().split("T")[0]}.xlsx`
    return new NextResponse(excelBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
    })
  } catch (error) {
    console.error("[PHONE-EXPORT] Internal Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Type-check the route**

Run: `npx tsc --noEmit`
Expected: no errors introduced by the new file. (If the project has pre-existing unrelated errors, confirm none reference `app/api/admin/orders/phone-export/route.ts` or `lib/order-phone-network.ts`.)

- [ ] **Step 3: Manual smoke test (requires the migration applied + a running dev server)**

Run the app (`npm run dev`), sign in as an admin, then from the browser devtools console on an admin page:
```js
const { data: { session } } = await window.__supabase?.auth?.getSession?.() ?? {}
// Or copy the access_token from the existing orders page network calls, then:
const res = await fetch('/api/admin/orders/phone-export', {
  headers: { Authorization: `Bearer ${TOKEN}` }
})
console.log(res.status, res.headers.get('content-type'))
```
Expected: `200` and content-type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Saving the blob opens in Excel with a `Summary` tab + 6 network tabs.

Verification against the DB (optional sanity): the `Summary` TOTAL "Unique Phones" should be ≤ the raw distinct-phone count and each network tab's rows should be sorted by Orders desc.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/orders/phone-export/route.ts
git commit -m "feat(api): admin all-order phone export route (xlsx, audit-logged)"
```

---

## Task 6: Admin UI button

**Files:**
- Modify: `app/admin/orders/page.tsx`

- [ ] **Step 1: Add the export handler**

In `app/admin/orders/page.tsx`, add an `exporting` state next to the existing `downloading` state (near line 63):

```tsx
const [exporting, setExporting] = useState(false)
```

Then add this handler immediately after the existing `handleDownloadOrders` function (after its closing brace, ~line 523):

```tsx
const handleExportPhoneNumbers = async () => {
  setExporting(true)
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) {
      toast.error("Session expired. Please sign in again.")
      return
    }
    const response = await fetch("/api/admin/orders/phone-export", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || "Failed to export phone numbers")
    }
    const blob = await response.blob()
    const url = window.URL.createObjectURL(blob)
    const element = document.createElement("a")
    element.setAttribute("href", url)
    element.setAttribute("download", `order-phones-${new Date().toISOString().split("T")[0]}.xlsx`)
    element.style.display = "none"
    document.body.appendChild(element)
    element.click()
    document.body.removeChild(element)
    window.URL.revokeObjectURL(url)
    toast.success("Exported all-time order phone numbers by network.")
  } catch (error) {
    console.error("Error exporting phone numbers:", error)
    toast.error(error instanceof Error ? error.message : "Failed to export phone numbers")
  } finally {
    setExporting(false)
  }
}
```

- [ ] **Step 2: Render the button**

In the page's header/action area (near the other top-level buttons in the returned JSX), add:

```tsx
<Button variant="outline" onClick={handleExportPhoneNumbers} disabled={exporting}>
  {exporting ? "Exporting…" : "Download phone numbers"}
</Button>
```

If a `Download`/phone icon from `lucide-react` is already imported in this file, prefix the label with it to match the surrounding buttons; otherwise plain text is fine.

- [ ] **Step 3: Verify it builds and renders**

Run: `npm run build` (or confirm `npm run dev` compiles the page with no type errors).
Expected: compiles. Load `/admin/orders` as an admin, click "Download phone numbers" → a `.xlsx` downloads with the Summary + per-network tabs.

- [ ] **Step 4: Commit**

```bash
git add app/admin/orders/page.tsx
git commit -m "feat(admin): 'Download phone numbers' button on orders page"
```

---

## Task 7: Full verification + memory update

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test:run`
Expected: all tests pass, including `lib/order-phone-network.test.ts`.

- [ ] **Step 2: Confirm the end-to-end path once more**

With the migration applied and dev server running, download the workbook from `/admin/orders` and open it. Confirm:
- `Summary` tab totals look plausible vs. known order volume.
- A phone you know bought on two networks appears on both network tabs.
- AFA-only numbers appear on `MTN`; junk/typo numbers appear on `Unknown` (nothing dropped).

- [ ] **Step 3: Update project memory**

Per `feedback-memory-hygiene`, add a memory file summarizing this feature (new view `all_order_phones` + `get_all_order_phones()`, the `lib/order-phone-network.ts` module, the export route + button, the 9-table coverage guard test) and a one-line pointer in `MEMORY.md`.

- [ ] **Step 4: Final commit (if memory lives in-repo) / push per your workflow**

```bash
git add -A && git commit -m "docs: record all-order phone export feature"
```

---

## Self-review notes (author)

- **Spec coverage:** view + aggregate (Task 1) ↔ spec §A; inference precedence (Task 3) ↔ spec §B (known-wins → AFA→MTN → prefix → Unknown); route + audit (Task 5) ↔ spec §C/§F; workbook layout (Tasks 4–5) ↔ spec §D; button (Task 6) ↔ spec §E; tests incl. "no table missed" guard (Tasks 2–4) ↔ spec §Testing. All 9 tables enumerated identically in the view and `ORDER_SOURCE_TABLES`.
- **Type consistency:** `RawPhoneRow` fields match the `get_all_order_phones()` JSON keys exactly; `NETWORK_SHEETS` values match the SQL `CASE` outputs and the route's sheet loop; `PhoneEntry`/`SheetRow`/`SummaryRow` are consistent across Tasks 3–5 and the route import.
- **Known heuristic limits (intentional, per spec):** number portability makes prefix inference approximate — mitigated by known-wins precedence; un-normalizable numbers are preserved in `Unknown`.
```
