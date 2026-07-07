# Design: Order-Time Network↔Prefix Validation

**Date:** 2026-07-07
**Branch:** feat/moolre-withdrawal-integration
**Status:** Approved (brainstorming) — ready for implementation planning
**Related:** `2026-07-07-mtn-number-registration-phase1-design.md` / `...-phase2-design.md` (downstream containment); this feature is the **upstream prevention** for the same error class.

## Background / problem

No order-creation path validates that the entered beneficiary number's prefix matches the selected
network — every channel accepts any syntactically-valid Ghana number for any network (shop:
`create/route.ts:128-133`; USSD: `bundles.ts:228`; checkout UI literally says "02 or 05 prefix").
Result: customers pay for doomed orders (411 mistaken-network numbers found in prod on 2026-07-07),
which fail at the provider and land in the admin manual queue.

Airtime is NOT affected (it auto-detects network from the number). Data bundles only.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Behavior on mismatch | **Hard block everywhere** — order rejected pre-payment with a clear message. |
| Networks | **All** — MTN, Telecel, AT (incl. iShare/BigTime products). |
| Kill-switch | `admin_settings.network_prefix_validation_enabled`; **absent = ON** (live from deploy; one click to disable if ported-number false positives cause complaints). |
| Unknown prefixes | Blocked (a valid-format number on no known network can't receive data; 63 of the 411 were such typos). |
| Bulk orders | Per-row check; **whole batch rejected** with an itemized list of offending rows (partial acceptance would complicate wallet pricing/refunds). |
| Ported numbers | Accepted casualty of hard-block (rare); remedy = toggle off momentarily or use the matching network. |
| Prefix management | **Admin-editable** (added requirement): the prefix→network map lives in `admin_settings.network_prefix_map` (seeded with the canonical table below); admins can add/remove prefixes from the admin panel — no deploy needed when a telco launches a new range. The map drives the validator (TS) **and** the registry classifier `gh_is_mtn` (SQL) so order acceptance and export inclusion can never disagree. |

## Canonical prefix table (the SEED — MUST be pinned by tests; note 053 = MTN)

This table seeds `admin_settings.network_prefix_map` and is the hardcoded DEFAULT fallback in
`lib/phone-format.ts` (used when the setting row is missing/unreadable, and by client-side hints
before the live map loads). Admin additions extend it at runtime.

| Prefix (local) | Significant | Network |
|---|---|---|
| 024, 025, **053**, 054, 055, 059 | 24, 25, **53**, 54, 55, 59 | **MTN** |
| 020, 050 | 20, 50 | Telecel |
| 026, 027, 056, 057 | 26, 27, 56, 57 | AT |
| all others (e.g. 023, 052, 058) | — | UNKNOWN → blocked |

The test suite includes a table-driven case for EVERY prefix above — explicitly including
`053xxxxxxx` + MTN package → `ok: true` — so the mapping can never silently regress.

## Architecture

### A. Prefix map + pure validator — `lib/phone-format.ts` (client-safe)

```ts
export type NetworkPrefixMap = Record<"MTN" | "TELECEL" | "AT", string[]> // significant 2-digit prefixes

export const DEFAULT_NETWORK_PREFIXES: NetworkPrefixMap = {
  MTN: ["24", "25", "53", "54", "55", "59"],   // 053 IS MTN — pinned by test
  TELECEL: ["20", "50"],
  AT: ["26", "27", "56", "57"],
}

export function detectNetworkWithMap(phone: string, map: NetworkPrefixMap): GhanaNetwork

export type OrderNetworkCheck =
  | { ok: true; detected: GhanaNetwork }
  | { ok: false; detected: GhanaNetwork; message: string }

export function validateNetworkPrefix(
  orderNetwork: string,
  phone: string,
  map: NetworkPrefixMap = DEFAULT_NETWORK_PREFIXES
): OrderNetworkCheck
```

- `detectGhanaNetwork` becomes a thin wrapper over `detectNetworkWithMap(phone, DEFAULT_NETWORK_PREFIXES)`
  (existing behavior unchanged; existing callers untouched).
- Maps order-network strings (case/format-insensitive) to expected carrier:
  `mtn` → MTN; `telecel` → TELECEL; `at`, `airteltigo`, `at - ishare`, `at-ishare`, `ishare`,
  `at - bigtime`, `at-bigtime`, `bigtime` → AT. An UNRECOGNIZED order-network string returns
  `ok: true` (validator only judges what it understands — never blocks a network it doesn't know).
- Invalid format (fails `normalizeGhanaPhone`) → `ok: false`, "Please enter a valid Ghana mobile number."
- Detected = UNKNOWN under the map → `ok: false`, "{phone} doesn't match any Ghana mobile network — please check the number."
- Detected ≠ expected → `ok: false`, "{phone} looks like a {Detected} number — check the number or switch to {Detected}." (Display names: MTN, Telecel, AT.)
- Match → `ok: true`.

### A2. Admin-editable prefix map (added requirement)

- **Storage:** `admin_settings.network_prefix_map` = jsonb `{"MTN":["24",...],"TELECEL":[...],"AT":[...]}`,
  seeded by migration with `DEFAULT_NETWORK_PREFIXES`. Single row — cheap to read, fits the repo's
  admin_settings convention.
- **Server read:** `getNetworkPrefixMap()` helper (beside the toggle reader): reads the setting,
  validates shape, merges with/falls back to `DEFAULT_NETWORK_PREFIXES` on missing/malformed.
- **SQL side (consistency-critical):** `gh_is_mtn(text)` is redefined (migration) from a hardcoded
  `IN ('24','25','53','54','55','59')` to a **STABLE** function reading the MTN list from
  `admin_settings.network_prefix_map`, with the hardcoded list as COALESCE fallback. This keeps the
  capture trigger + gate classification in lockstep with admin-added prefixes (adding "58"→MTN makes
  058 numbers both orderable AND exportable, atomically).
- **Admin management API:** `app/api/admin/settings/network-prefixes/route.ts` — GET returns the map;
  POST body `{ network: "MTN"|"TELECEL"|"AT", prefix: "058", action: "add"|"remove" }`:
  normalizes input (accepts `058`/`58`; stores significant 2-digit), validates digits + length,
  rejects a prefix already assigned to a DIFFERENT network (move = remove then add), never allows
  removing ALL prefixes of a network. Audit-logged (`admin_audit_log`).
- **Admin UI:** the toggle card (section E) grows a "Network prefixes" section — three network rows
  showing current prefixes as removable chips + an add field. Add/remove takes effect immediately
  (next settings read) — no deploy.
- **Public read for client hints:** small public GET `app/api/network-prefixes/route.ts` returning
  the merged map (`Cache-Control: public, max-age=300`) — no auth (prefix→network mapping is public
  knowledge), used by the two checkout UIs so client hints match server enforcement; clients fall
  back to `DEFAULT_NETWORK_PREFIXES` if the fetch fails.

### B. Kill-switch reader — server-side helper (new, small)

`isNetworkPrefixValidationEnabled()` (placed beside the other setting readers — plan decides the
exact home, keeping `lib/phone-format.ts` free of Supabase imports): reads
`admin_settings.network_prefix_validation_enabled` and **returns true when the row is absent**
(`value?.enabled !== false`) — that is what "default ON" means. On a read ERROR it also returns
`true`: validation is cheap and blocking-on-mismatch is the safe default; only an explicit
`enabled: false` row disables it. The toggle route auto-creates `{enabled: true}` on first GET.

### C. Server enforcement — 6 sites (before order INSERT / payment init)

| # | Site | Behavior on block |
|---|------|-------------------|
| 1 | `app/api/orders/purchase/route.ts` (web dashboard + WhatsApp bot) | 400 JSON `{ error: <message> }` |
| 2 | `app/api/orders/create-bulk/route.ts` | validate every row; if any fail → 400 with `{ error, invalidRows: [{ row, phone, message }] }`, NOTHING created |
| 3 | `app/api/shop/orders/create/route.ts` (storefront) | 400 JSON `{ error: <message> }` |
| 4 | `app/api/v1/orders/route.ts` (resellers) | 400 JSON `{ error: <message>, error_code: "NETWORK_MISMATCH" }` |
| 5 | `lib/ussd/handlers/bundles.ts` (recipient step) | in-session re-prompt with the message |
| 6 | `lib/ussd-shop/handlers/bundles.ts` | same |

Each site: one combined settings read (toggle + prefix map — a single `.in("key",[...])` query via a
shared `getPrefixValidationConfig()` helper) → `validateNetworkPrefix(network, phone, map)` → block
or proceed. USSD sites do one read per entry (stateless handlers; fine).

### D. Client-side UX (fast feedback; NOT enforcement)

- `components/checkout/steps/step-customer.tsx` (dashboard checkout): inline field error via the
  pure validator; also fix the helper text ("02 or 05 prefix" → network-aware hint).
- Shop storefront checkout phone step (exact component located at plan time): same inline error.
- Both fetch the live map from the public `GET /api/network-prefixes` (fallback:
  `DEFAULT_NETWORK_PREFIXES`), so hints match server enforcement even after admin prefix edits.
- Client checks do NOT read the toggle (pure UX); server remains the gate. If the admin disables
  the toggle, the client hint still shows but the server accepts — acceptable (YAGNI on threading
  the flag to clients).

### E. Admin toggle

- Route `app/api/admin/settings/network-prefix-validation/route.ts` — copy of the
  `mtn-registration-gate` settings route (GET auto-creates `{enabled: true}`; POST validates boolean).
- Toggle card on the admin settings surface (exact page — `/admin/settings` general page or
  `/admin/settings/mtn` — chosen at plan time based on where non-MTN-specific toggles live; it is
  NOT MTN-specific).

## Interplay with the registration pipeline

Blocked orders are never created → no junk enters `mtn_number_registry` upstream. The capture
trigger's non-MTN-prefix→`rejected` classification stays as the backstop for toggle-off windows.
No changes to the registry/gate needed.

## Testing

- **Pure unit tests** (Vitest, co-located):
  table-driven matrix over every seed prefix × {MTN, Telecel, AT, iShare, BigTime} order networks —
  including explicitly `053… + MTN → ok`; unknown prefixes blocked; invalid format blocked;
  unrecognized order-network string passes; message copy asserted for one mismatch case;
  format-variant inputs (`233…`, `+233…`, spaces) normalize before judgment;
  **custom-map cases**: `validateNetworkPrefix` with an extended map (e.g. MTN+["58"]) accepts 058
  for MTN and rejects it for Telecel; `detectGhanaNetwork` still equals the default-map wrapper.
- **SQL verification on apply**: seeded `network_prefix_map` matches the table; redefined
  `gh_is_mtn('0241234567')=true`, `('0201112223')=false`; then in a TRANSACTION add "20" to MTN in
  the setting, assert `gh_is_mtn('0201112223')=true`, ROLLBACK (proves the map drives SQL).
- Server sites verified by `tsc` + full suite (behavior change is additive rejection).
- Operator: MTN package + 020 number on each channel → blocked with message; add a test prefix in
  the admin UI → immediately accepted; flip toggle off → everything accepted (as today).

## Out of scope

- Airtime / AFA / results checker (airtime self-detects; others aren't network products).
- Soft-warn / override flows (hard block chosen).
- Porting database lookups (no reliable public API; toggle is the escape hatch).
- Retroactive cleanup (done separately on 2026-07-07 — the 411).

## Files (anticipated)

- `lib/phone-format.ts` (+ test file) — `DEFAULT_NETWORK_PREFIXES`, `detectNetworkWithMap`,
  `validateNetworkPrefix` + types.
- Settings/config readers (placement per plan): `getNetworkPrefixMap`, `isNetworkPrefixValidationEnabled`,
  combined `getPrefixValidationConfig`.
- `migrations/<date>_network_prefix_map.sql` — seed `admin_settings.network_prefix_map` + redefine
  `gh_is_mtn` to read it (STABLE, hardcoded fallback).
- `app/api/admin/settings/network-prefix-validation/route.ts` (toggle) +
  `app/api/admin/settings/network-prefixes/route.ts` (add/remove, audit-logged) +
  `app/api/network-prefixes/route.ts` (public read).
- Admin UI: toggle card + prefix-chips management section.
- 6 server enforcement sites (table above).
- 2 client components (checkout step + storefront phone step).
