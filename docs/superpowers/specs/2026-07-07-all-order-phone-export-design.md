# Design: Admin All-Time Order Phone Export (grouped by network)

**Date:** 2026-07-07
**Branch:** feat/moolre-withdrawal-integration
**Status:** Approved (brainstorming) — ready for implementation planning

## Goal

Let an admin download **every phone number that has ever appeared on any order**, across **all order
types**, grouped by mobile network, as an Excel (`.xlsx`) workbook. The non-negotiable requirement:
**no order type may be missed.**

Primary use is a customer-contact / marketing list (e.g. per-network broadcasts), so the output is a
deduplicated contact list, not an order-by-order dump.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Order scope | **Every order, any status** — the widest net of all phone numbers (incl. pending/failed/abandoned). |
| No-network order types | **Include; infer network** (known-network-wins → AFA→MTN → phone-prefix → Unknown). Nothing dropped. |
| Uniqueness | **Unique phone per network**, with `order_count` + first/last order date. |
| Workbook layout | **One sheet per network + a Summary tab.** |
| AT sub-products | **iShare and BigTime kept as their own sheets** (segment by bundle product). Sheets: MTN, Telecel, AT, AT - iShare, AT - BigTime, Unknown. |
| Architecture | **Approach A** — pre-aggregated SQL union view + pure TS inference module + thin admin route. |

## The 9 order-bearing tables ("nothing missed" checklist)

| # | Table | Phone column (beneficiary/recipient) | Network column | Product |
|---|-------|--------------------------------------|----------------|---------|
| 1 | `orders` | `phone_number` | `network` (MTN/Telecel/AT/iShare/BigTime) | Data (bulk/wallet) |
| 2 | `shop_orders` | `customer_phone` | `network` | Data (storefront) |
| 3 | `api_orders` | `recipient_phone` | `network` | Data (v1 API) |
| 4 | `ussd_orders` | `recipient_phone` | `network` | Data (USSD) |
| 5 | `ussd_shop_orders` | `recipient_phone` | `network` | Data (shop USSD) |
| 6 | `airtime_orders` | `beneficiary_phone` | `network` (MTN/Telecel/AT) | Airtime |
| 7 | `afa_orders` | `phone_number` | — (none) | AFA registration |
| 8 | `ussd_afa_orders` | `dialing_phone` | — (none) | AFA via USSD |
| 9 | `results_checker_orders` | `customer_phone` | — (none) | Exam results voucher |

Notes:
- For USSD data tables, the **recipient/beneficiary** number is used (the number actually on the
  network receiving data), not the payer's `dialing_phone`. AFA-via-USSD only has `dialing_phone`, so
  that is used there.
- Existing `combined_orders_view` covers only the 5 data-bundle tables and is fulfillment-oriented
  ("claims" pending orders); it is intentionally **left untouched**. This feature builds a new,
  read-only view.

## Architecture (Approach A)

### A. Union view — `all_order_phones` (new migration)

A read-only view `UNION ALL`-ing all 9 tables into one shape:

```
source_table | product_type | phone | network_raw | status | created_at
```

Two jobs happen inside the view so the app never pulls raw orders:

- **Phone normalization** via a SQL helper `normalize_gh_phone(text)` — formatting only: strip
  non-digits, fold `233…` / `+233…` / 9-digit → canonical `0XXXXXXXXX`. Returns `NULL` for
  un-normalizable input. This makes dedup correct.
- **Network canonicalization** reusing the exact `CASE` expression from `combined_orders_view`
  (`'at-ishare'`/`'AT - iShare'`/`'ishare'` → `AT - iShare`; `'at - bigtime'` → `AT - BigTime`;
  mtn/telecel/at → canonical). `network_raw` is `NULL` for tables 7–9.

`product_type` ∈ {`data`, `airtime`, `afa`, `results`}.

Scope = all statuses, so the view does **not** filter by status; `status` is carried for possible
future use.

### Aggregating layer

Collapses to **one row per `(source_table, network_raw, phone)`** with `order_count`,
`first_order_at`, `last_order_at`. Exposed as a Postgres function `get_all_order_phones()` returning a
**single JSONB array**, so one `.rpc()` call returns the whole compact set in one row — dodging
PostgREST's ~1,000-row cap without pagination.

**Fallback** if the payload ever gets too large: keyset-paginate the aggregated view by
`(network_raw, phone)`. The route contract is unchanged either way.

### B. Network inference — `lib/order-phone-network.ts` (pure TS module)

`inferNetwork(aggregatedRows) → Map<network, PhoneEntry[]>`. No DB, no I/O. Precedence per phone:

1. **Known-network-wins** — build `phone → networks` from the 6 network-bearing sources; any phone
   seen there is assigned its real network(s).
2. **AFA → MTN** — a no-network phone from `afa_orders`/`ussd_afa_orders` not already known → `MTN`
   (AFA is an MTN scheme).
3. **Prefix inference** — a no-network phone (results-checker) not otherwise known → `GhanaNetwork`
   from `lib/phone-format.ts` prefix → MTN / Telecel / AT.
4. **Unknown bucket** — prefix returns `UNKNOWN`, or the number won't normalize (junk/typo surfaced by
   "all statuses") → `Unknown` sheet, carried as-is. **Nothing is ever dropped.**

A phone that legitimately spans networks appears in **both** networks' sheets (correct — it's a real
contact on each list). Counts/dates are merged per `(final_network, phone)`.

Prefix inference can only yield MTN/Telecel/AT (carrier), never iShare/BigTime (bundle products) — so
inferred AT phones land in the `AT` sheet; the `AT - iShare`/`AT - BigTime` sheets only receive rows
whose `network_raw` was explicitly that value.

### C. Admin export route — `app/api/admin/orders/phone-export/route.ts` (new)

```
GET /api/admin/orders/phone-export
  → verifyAdminAccess(request)          // admin-only; reuses existing guard + heavy rate-limit
  → supabaseAdmin.rpc('get_all_order_phones')   // service role, bypasses RLS, sees all 9 tables
  → inferNetwork(rows)                  // pure TS module (B)
  → build workbook with `xlsx`          // already a dependency
  → write admin_audit_log row
  → return .xlsx  (Content-Disposition: attachment; filename="order-phones-YYYY-MM-DD.xlsx")
```

### D. Workbook structure

- **`Summary` tab:** `Network | Unique Phones | Total Orders` (one row per network + grand total).
- **Per-network tabs** (`MTN`, `Telecel`, `AT`, `AT - iShare`, `AT - BigTime`, `Unknown`):
  `Phone | Orders | First Order | Last Order | Products`.
  - `Products` = comma list of product lines the number appears in (`data, airtime, afa, results`).
  - Empty networks still get a header-only tab (predictable layout).

### E. Admin UI trigger

A **"Download phone numbers"** button on the existing admin orders page (`app/admin/orders/…`), beside
the current downloads — calls the route, streams the file, shows a toast. No new page; follows the
existing download-button pattern.

### F. Security & audit

- Admin-gated via `verifyAdminAccess`; service-role read is server-only.
- **Read-only** — unlike the existing "claim pending orders" download, this mutates nothing.
- Writes one `admin_audit_log` row (`action: 'export_all_order_phones'`, actor, timestamp, total
  phones/orders). A bulk all-time PII export should be captured in the audit trail.

## Testing (Vitest configured)

- **Pure unit tests** for `inferNetwork()` — table-driven precedence cases: known-wins beats prefix;
  AFA→MTN; results-checker→prefix; junk→Unknown; multi-network phone lands in multiple sheets; count
  and last-order merging.
- **Unit tests** for phone normalization/dedup correctness (format folding, `233…`/`+233…`/9-digit).
- **"No table missed" guard test** — assert the union/config lists exactly the 9 known order tables, so
  adding a 10th table later fails the test until it's wired in. This encodes the core requirement.

## Files touched

- `migrations/20260707_all_order_phones_view.sql` — `normalize_gh_phone()` helper + `all_order_phones`
  union view + `get_all_order_phones()` aggregate function.
- `lib/order-phone-network.ts` — pure inference + workbook-row shaping.
- `app/api/admin/orders/phone-export/route.ts` — the route.
- `app/admin/orders/…` — one download button.
- `lib/__tests__/order-phone-network.test.ts` — unit tests.

## Out of scope

- Bulk SMS recipient lists (`bulk-sms` product) — that is a send-list, not an order beneficiary.
- Date-range / network filtering on the export (this is deliberately all-time, all-network). Could be a
  future enhancement.
- Changing or reusing the existing fulfillment downloads.

## Open risks / notes

- **Number portability** makes prefix inference a heuristic; mitigated by known-network-wins taking
  precedence, so only never-seen-on-a-network phones rely on the prefix.
- **Un-normalizable numbers** (from failed/typo orders in the all-status scope) are preserved in the
  `Unknown` sheet rather than dropped.
- **View drift** — if a new order table is added later, the guard test fails until the view + config are
  updated.
