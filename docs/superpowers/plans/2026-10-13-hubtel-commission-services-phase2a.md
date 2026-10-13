# Hubtel Commission Services — Phase 2a (foundation fixes + airtime provider switch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Phase 1 plumbing that real orders will depend on, then let an admin route each airtime network to Digiwapy, Hubtel or manual fulfilment.

**Architecture:** Five small Phase 1 changes (5xx classification, atomic config patch RPC, order-sync column + re-notify sweep, needs_review alert, a single order hook in the runtime) followed by an airtime provider setting and a dispatcher at the existing single fulfilment chokepoint (`triggerDigiwapyFulfillment` in `lib/airtime-service.ts`), with an `airtime_orders` order adapter registered from the runtime.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service role), Vitest (`../../../node_modules/.bin/vitest run` from a worktree), existing `lib/hubtel-cs/*`.

**Spec:** `docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase2-design.md` (§4 carry-over, §5 airtime). API facts: `docs/hubtel-commission-services/hubtel-docs-full-2026-10-12.md`.

**Spec deltas (this plan wins; record in the ledger):**
- Spec §5 says a definitely-failed Hubtel airtime order becomes `failed`. The existing Digiwapy webhook maps a provider failure to `status: "pending"` so admins fulfil it manually (`app/api/webhooks/digiwapy/route.ts` `EVENT_STATUS_MAP`). The airtime adapter follows that **existing convention**: Hubtel failure ⇒ order back to `pending` + note + admin alert. Never auto-resent; an admin decides.
- Spec §5 mentions `refundToWallet` for airtime. Not built in 2a: airtime refunds stay on the existing `/admin/refunds` flow, so the Phase 1 review-queue "Refund" button stays disabled for airtime rows (no adapter `refundToWallet`).
- Config pause race fix is broadened: both `setHubtelCsPaused` and the admin `setHubtelCsConfig` go through one atomic `hubtel_cs_config_patch(jsonb)` RPC, so neither can overwrite the other.

## Global Constraints

- Ships **dark**: with no `airtime_provider_<net>` setting present, airtime behaves exactly as today (legacy `airtime_digiwapy_enabled_<net>` toggle decides Digiwapy vs manual).
- **Never auto-resend, never auto-refund.** No automatic fallback from Hubtel to Digiwapy or back.
- Hubtel airtime cap: **GHS 100 per request** (`HUBTEL_CS_SERVICES.airtime_*.maxAmount`). Larger orders on a Hubtel network go to manual with an alert; never split.
- Config lives in `admin_settings` (never `app_settings`). Airtime provider keys: `airtime_provider_mtn`, `airtime_provider_telecel`, `airtime_provider_at`; value `{ "provider": "digiwapy" | "hubtel" | "manual" }`.
- Order hooks must be idempotent and must never throw out of `notifyAdapter`/the order hook.
- Route files export only HTTP handlers / route config. Shared constants live in `lib/`.
- New migrations are additive, `IF NOT EXISTS`, functions `SET search_path = public`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`. Verify `0115`/`0116` are still the next free numbers on `origin/main` before creating them (rename upward if taken).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work only in the worktree created for this plan (branch off **origin/main**, not local main). Tests: `../../../node_modules/.bin/vitest run <files>`; typecheck: `../../../node_modules/.bin/tsc --noEmit -p .`.

## Review Focus

1. **A 5xx reply that carries `0000`/`0001`** must land in `needs_review`, never `fulfilled`/`pending` (Task 1 "5xx with success code").
2. **Admin saves the config while a 4075 pause is being written** — the pause must survive (Task 2: patch builder never emits pause keys unless the admin explicitly resumes; RPC merges, it does not replace).
3. **Adapter hook throws or the adapter is missing when a row settles** — the order must still be updated later by the cron's re-notify sweep, exactly once in effect (Task 3 "re-notify sweep retries a failed hook" + idempotent adapter in Task 6).
4. **Airtime over GHS 100 on a Hubtel network, or Hubtel disabled/paused** — order stays `pending`, admin alerted, nothing sent, no silent switch to Digiwapy (Task 6 tests "over cap", "paused").
5. **Provider setting unreadable (DB error) or absent** — behaviour is exactly today's legacy path (Task 5 "falls back to legacy", Task 6 "provider read error").

---

### Task 1: Treat any 5xx POST reply as unknown

**Files:**
- Modify: `lib/hubtel-cs/state-machine.ts` (`classifyCode`)
- Test: `lib/hubtel-cs/state-machine.test.ts`

**Interfaces:** Produces: `classifyCode(code, httpStatus?)` now returns `"unknown"` for any `httpStatus >= 500` before looking at the code. Callbacks call it without `httpStatus` and are unaffected.

- [ ] **Step 1: Write the failing tests** — append to `lib/hubtel-cs/state-machine.test.ts`:

```ts
describe("5xx replies are never trusted (phase 2a)", () => {
  it("classifies a success or pending code on a 5xx as unknown", () => {
    expect(classifyCode("0000", 502)).toBe("unknown")
    expect(classifyCode("0001", 500)).toBe("unknown")
    expect(classifyCode("4075", 503)).toBe("unknown")
  })
  it("still classifies normally below 500", () => {
    expect(classifyCode("0000", 200)).toBe("success")
    expect(classifyCode("0001", 200)).toBe("pending")
    expect(classifyCode("2001", 400)).toBe("failed")
  })
  it("a 5xx POST reply with 0000 goes to needs_review", () => {
    const tx = makeTx({ state: "created" })
    const t = applyPostResponse(tx, { httpStatus: 503, body: { ResponseCode: "0000", Data: { TransactionId: "x" } } }, new Date())
    expect("ignored" in t).toBe(false)
    if (!("ignored" in t)) expect(t.next).toBe("needs_review")
  })
})
```

(Import `classifyCode`, `applyPostResponse` from `./state-machine` and `makeTx` from `./testing/fixtures` if not already imported in the file.)

- [ ] **Step 2: Run and confirm failure** — `../../../node_modules/.bin/vitest run lib/hubtel-cs/state-machine.test.ts` → the three-`unknown` assertions fail.

- [ ] **Step 3: Implement** — replace `classifyCode` in `lib/hubtel-cs/state-machine.ts`:

```ts
export function classifyCode(code: unknown, httpStatus?: number): CodeClass {
  // A 5xx reply is never trusted, whatever code its body carries (Phase 2a ruling): state unknown.
  if (httpStatus !== undefined && httpStatus >= 500) return "unknown"
  const c = typeof code === "string" ? code.trim() : ""
  if (c === "0000") return "success"
  if (c === "0001") return "pending"
  if (c === "" || c === "0005") return "unknown"
  if (c === "4075") return "float"
  // A definite failure must be a well-formed 4-digit code; anything else is unknown.
  if (!/^\d{4}$/.test(c)) return "unknown"
  return "failed"
}
```

- [ ] **Step 4: Run** `../../../node_modules/.bin/vitest run lib/hubtel-cs` → all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs/state-machine.ts lib/hubtel-cs/state-machine.test.ts
git commit -m "fix(hubtel-cs): any 5xx POST reply is unknown, even with a success code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Atomic config patch (pause can no longer be lost)

**Files:**
- Create: `migrations/0115_hubtel_cs_config_patch.sql`
- Modify: `lib/hubtel-cs/config.ts` (`setHubtelCsConfig`, `setHubtelCsPaused`; remove the private `save`)
- Test: `lib/hubtel-cs/config.test.ts`

**Interfaces:**
- Produces: `buildConfigPatch(patch: ConfigPatch): Record<string, unknown>` (pure, exported); `setHubtelCsConfig(db, patch)` and `setHubtelCsPaused(db, reason)` keep their signatures and return `HubtelCsConfig`; both call `db.rpc("hubtel_cs_config_patch", { p_patch })`.
- Stored config keys (unchanged, from `resolveConfig`): `enabled`, `mode`, `lowBalanceThreshold`, `services`, `paused`, `pausedReason`, `pausedAt`.

- [ ] **Step 1: Write the migration** `migrations/0115_hubtel_cs_config_patch.sql`:

```sql
-- 0115_hubtel_cs_config_patch.sql
-- Atomic merge into admin_settings['hubtel_cs_config'] so a 4075 auto-pause and an admin save
-- can never overwrite each other (previously both did read-modify-write). ADDITIVE.
-- Top-level keys in p_patch replace; "services" is merged key-by-key.

CREATE OR REPLACE FUNCTION hubtel_cs_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('hubtel_cs_config', '{}'::jsonb,
          'Hubtel Commission Services: master switch, transport mode, per-service switches, pause state, low-balance threshold.',
          now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'services'))
                 || CASE WHEN p_patch ? 'services'
                         THEN jsonb_build_object('services', COALESCE(value -> 'services', '{}'::jsonb) || (p_patch -> 'services'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'hubtel_cs_config'
  RETURNING value INTO v;

  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION hubtel_cs_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hubtel_cs_config_patch(jsonb) TO service_role;
```

Before relying on it, confirm `admin_settings.value` is `jsonb` and `key` is unique: `grep -rn "admin_settings" migrations/*.sql | grep -i -E "create table|value|unique"`. If `value` is `json` (not `jsonb`), cast: `COALESCE(value::jsonb, …)` and assign `::json` — note the finding in the report.

- [ ] **Step 2: Write failing tests** — append to `lib/hubtel-cs/config.test.ts`:

```ts
import { buildConfigPatch, setHubtelCsConfig, setHubtelCsPaused } from "./config"

function fakeRpcDb(returnValue: unknown = {}) {
  const calls: { fn: string; args: any }[] = []
  return {
    calls,
    db: { rpc: async (fn: string, args: any) => { calls.push({ fn, args }); return { data: returnValue, error: null } } } as any,
  }
}

describe("atomic config patch (phase 2a)", () => {
  it("never emits pause keys for a plain admin save", () => {
    const p = buildConfigPatch({ enabled: true, mode: "relay" })
    expect(p).toEqual({ enabled: true, mode: "relay" })
    expect("paused" in p).toBe(false)
  })
  it("emits all three pause keys only on an explicit resume", () => {
    expect(buildConfigPatch({ paused: false })).toEqual({ paused: false, pausedReason: null, pausedAt: null })
  })
  it("passes services and a null threshold through", () => {
    expect(buildConfigPatch({ services: { airtime_mtn: false }, lowBalanceThreshold: null }))
      .toEqual({ services: { airtime_mtn: false }, lowBalanceThreshold: null })
  })
  it("setHubtelCsConfig calls the patch RPC and resolves its result", async () => {
    const f = fakeRpcDb({ enabled: true, mode: "direct", services: {} })
    const cfg = await setHubtelCsConfig(f.db, { enabled: true })
    expect(f.calls).toEqual([{ fn: "hubtel_cs_config_patch", args: { p_patch: { enabled: true } } }])
    expect(cfg.enabled).toBe(true)
  })
  it("setHubtelCsPaused writes only pause keys", async () => {
    const f = fakeRpcDb({ paused: true, pausedReason: "4075" })
    await setHubtelCsPaused(f.db, "4075")
    const p = f.calls[0].args.p_patch
    expect(Object.keys(p).sort()).toEqual(["paused", "pausedAt", "pausedReason"])
    expect(p.paused).toBe(true)
    expect(p.pausedReason).toBe("4075")
  })
  it("setHubtelCsPaused(null) resumes", async () => {
    const f = fakeRpcDb({})
    await setHubtelCsPaused(f.db, null)
    expect(f.calls[0].args.p_patch).toEqual({ paused: false, pausedReason: null, pausedAt: null })
  })
  it("throws the RPC error", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "boom" } }) } as any
    await expect(setHubtelCsPaused(db, "x")).rejects.toMatchObject({ message: "boom" })
  })
})
```

- [ ] **Step 3: Run** `../../../node_modules/.bin/vitest run lib/hubtel-cs/config.test.ts` → fails (`buildConfigPatch` not exported).

- [ ] **Step 4: Implement** — in `lib/hubtel-cs/config.ts` replace `save`, `setHubtelCsConfig` and `setHubtelCsPaused` with:

```ts
/** Only the keys the admin actually changed; pause keys only on an explicit resume. Pure. */
export function buildConfigPatch(patch: ConfigPatch): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (patch.enabled !== undefined) p.enabled = patch.enabled
  if (patch.mode !== undefined) p.mode = patch.mode
  if (patch.lowBalanceThreshold !== undefined) p.lowBalanceThreshold = patch.lowBalanceThreshold
  if (patch.services !== undefined) p.services = patch.services
  if (patch.paused === false) { p.paused = false; p.pausedReason = null; p.pausedAt = null }
  return p
}

/** Atomic merge (migration 0115) — an admin save and a 4075 pause can no longer overwrite each other. */
async function patchConfig(db: SupabaseClient, p: Record<string, unknown>): Promise<HubtelCsConfig> {
  const { data, error } = await db.rpc("hubtel_cs_config_patch", { p_patch: p })
  if (error) throw error
  return resolveConfig(data)
}

export async function setHubtelCsConfig(db: SupabaseClient, patch: ConfigPatch): Promise<HubtelCsConfig> {
  return patchConfig(db, buildConfigPatch(patch))
}

/** reason=null resumes. */
export async function setHubtelCsPaused(db: SupabaseClient, reason: string | null): Promise<HubtelCsConfig> {
  return patchConfig(db, reason === null
    ? { paused: false, pausedReason: null, pausedAt: null }
    : { paused: true, pausedReason: reason, pausedAt: new Date().toISOString() })
}
```

Delete the now-unused `save` function. Keep `getHubtelCsConfig`, `resolveConfig`, `validateConfigPatch`, `hubtelCsEnvReady` unchanged.

- [ ] **Step 5: Run** `../../../node_modules/.bin/vitest run lib/hubtel-cs` and `tsc` → pass. If any existing test asserted the old upsert-based save, update it to the RPC fake and say so in the report.

- [ ] **Step 6: Commit**

```bash
git add migrations/0115_hubtel_cs_config_patch.sql lib/hubtel-cs/config.ts lib/hubtel-cs/config.test.ts
git commit -m "fix(hubtel-cs): atomic config patch RPC so a 4075 pause and an admin save cannot overwrite each other

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Order-sync tracking, single order hook and re-notify sweep

**Files:**
- Create: `migrations/0116_hubtel_cs_order_synced.sql`
- Create: `lib/hubtel-cs/order-hook.ts`
- Modify: `lib/hubtel-cs/types.ts` (add `order_synced_at`), `lib/hubtel-cs/testing/fixtures.ts` (default `order_synced_at: null`), `lib/hubtel-cs/store.ts` + `lib/hubtel-cs/testing/memory-store.ts` (`markOrderSynced`, `listUnsynced`), `lib/hubtel-cs/adapters.ts` (`notifyAdapter` returns a result), `lib/hubtel-cs/status-runner.ts` (phase 3), `lib/hubtel-cs/runtime.ts` (use the hook everywhere)
- Test: `lib/hubtel-cs/order-hook.test.ts`, `lib/hubtel-cs/status-runner.test.ts`, `lib/hubtel-cs/store.test.ts`

**Interfaces:**
- Produces:
  - `type NotifyResult = "synced" | "no_order" | "not_terminal" | "no_adapter" | "failed"`; `notifyAdapter(tx): Promise<NotifyResult>` (still never throws).
  - Store: `markOrderSynced(id: string): Promise<void>`; `listUnsynced(o: { olderThan: string; limit: number }): Promise<HubtelCsTx[]>` — terminal (`fulfilled`/`failed`) rows with `order_table` not null, `order_synced_at` null, `updated_at <= olderThan`, oldest first.
  - `makeOrderHook(deps: { store: Pick<HubtelCsStore, "markOrderSynced">; notify: (tx: HubtelCsTx) => Promise<NotifyResult>; alertReview: (tx: HubtelCsTx) => Promise<void> }): (tx: HubtelCsTx) => Promise<void>` — never throws.
  - `RESYNC_AFTER_MS = 2 * 60_000` exported from `status-runner.ts`; runner output gains `resynced: number`.
- Consumes: Task 4 supplies the real `alertReview`; until then runtime passes a no-op.

- [ ] **Step 1: Migration** `migrations/0116_hubtel_cs_order_synced.sql`:

```sql
-- 0116_hubtel_cs_order_synced.sql
-- Records when a settled ledger row's order hook succeeded, so the status cron can re-run
-- hooks that failed (adapter threw / not registered at the time). ADDITIVE.
ALTER TABLE hubtel_cs_transactions ADD COLUMN IF NOT EXISTS order_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS hubtel_cs_tx_unsynced_idx
  ON hubtel_cs_transactions (updated_at)
  WHERE order_table IS NOT NULL AND order_synced_at IS NULL AND state IN ('fulfilled', 'failed');
```

- [ ] **Step 2: Types and fixtures** — in `types.ts` add `order_synced_at: string | null` to `HubtelCsTx` (after `refund_claimed_by`). In `testing/fixtures.ts` `makeTx` default add `order_synced_at: null`.

- [ ] **Step 3: Failing tests** — create `lib/hubtel-cs/order-hook.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { makeOrderHook } from "./order-hook"
import { makeTx } from "./testing/fixtures"

const deps = (over: any = {}) => ({
  store: { markOrderSynced: vi.fn(async () => {}) },
  notify: vi.fn(async () => "synced" as const),
  alertReview: vi.fn(async () => {}),
  ...over,
})

describe("makeOrderHook", () => {
  it("marks the row synced only when the adapter succeeded", async () => {
    const d = deps()
    await makeOrderHook(d)(makeTx({ id: "a", state: "fulfilled", order_table: "airtime_orders", order_id: "o1" }))
    expect(d.notify).toHaveBeenCalledTimes(1)
    expect(d.store.markOrderSynced).toHaveBeenCalledWith("a")
  })
  it("does not mark synced when the adapter failed or is missing", async () => {
    for (const r of ["failed", "no_adapter", "no_order", "not_terminal"] as const) {
      const d = deps({ notify: vi.fn(async () => r) })
      await makeOrderHook(d)(makeTx({ state: "failed", order_table: "airtime_orders", order_id: "o1" }))
      expect(d.store.markOrderSynced).not.toHaveBeenCalled()
    }
  })
  it("alerts (and does not notify) when a row enters needs_review", async () => {
    const d = deps()
    await makeOrderHook(d)(makeTx({ state: "needs_review" }))
    expect(d.alertReview).toHaveBeenCalledTimes(1)
    expect(d.notify).not.toHaveBeenCalled()
  })
  it("never throws", async () => {
    const d = deps({ notify: vi.fn(async () => { throw new Error("x") }), store: { markOrderSynced: vi.fn(async () => { throw new Error("y") }) } })
    await expect(makeOrderHook(d)(makeTx({ state: "fulfilled" }))).resolves.toBeUndefined()
    const d2 = deps({ alertReview: vi.fn(async () => { throw new Error("z") }) })
    await expect(makeOrderHook(d2)(makeTx({ state: "needs_review" }))).resolves.toBeUndefined()
  })
})
```

Append to `lib/hubtel-cs/status-runner.test.ts` (reuse the file's existing memory-store/dep helpers; this shows the required shape):

```ts
describe("re-notify sweep (phase 2a)", () => {
  it("retries the order hook for settled rows never synced, older than 2 minutes", async () => {
    const store = createMemoryStore()
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    store.seed(makeTx({ id: "u1", client_reference: "HCS-a", state: "fulfilled", order_table: "airtime_orders", order_id: "o1", order_synced_at: null, updated_at: old }))
    store.seed(makeTx({ id: "u2", client_reference: "HCS-b", state: "failed", order_table: "airtime_orders", order_id: "o2", order_synced_at: old, updated_at: old }))
    store.seed(makeTx({ id: "u3", client_reference: "HCS-c", state: "fulfilled", order_table: null, order_id: null, updated_at: old }))
    store.seed(makeTx({ id: "u4", client_reference: "HCS-d", state: "fulfilled", order_table: "airtime_orders", order_id: "o4", order_synced_at: null, updated_at: new Date().toISOString() }))
    const onTransition = vi.fn(async () => {})
    const out = await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition, deadlineMs: Date.now() + 60_000 })
    expect(onTransition.mock.calls.map(c => (c[0] as any).id)).toEqual(["u1"])
    expect(out.resynced).toBe(1)
  })
  it("a missing column or table is skipped quietly, not counted as an error", async () => {
    const store = createMemoryStore()
    ;(store as any).listUnsynced = async () => { throw Object.assign(new Error("column missing"), { code: "42703" }) }
    const out = await runHubtelCsStatusChecks({ store, check: async () => ({ ok: true }), onTransition: async () => {}, deadlineMs: Date.now() + 60_000 })
    expect(out.errors).toBe(0)
  })
})
```

Append to `lib/hubtel-cs/store.test.ts` (memory-store contract):

```ts
it("markOrderSynced sets order_synced_at; listUnsynced only returns settled, linked, unsynced, old-enough rows", async () => {
  const store = createMemoryStore()
  const old = new Date(Date.now() - 5 * 60_000).toISOString()
  store.seed(makeTx({ id: "x", client_reference: "HCS-x", state: "failed", order_table: "t", order_id: "1", updated_at: old }))
  store.seed(makeTx({ id: "y", client_reference: "HCS-y", state: "pending", order_table: "t", order_id: "2", updated_at: old }))
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString()
  expect((await store.listUnsynced({ olderThan: cutoff, limit: 10 })).map(r => r.id)).toEqual(["x"])
  await store.markOrderSynced("x")
  expect(store.rows.find(r => r.id === "x")!.order_synced_at).not.toBeNull()
  expect(await store.listUnsynced({ olderThan: cutoff, limit: 10 })).toEqual([])
})
```

- [ ] **Step 4: Run** the three test files → fail (missing module/methods).

- [ ] **Step 5: Implement.**

`lib/hubtel-cs/adapters.ts` — change `notifyAdapter`:

```ts
export type NotifyResult = "synced" | "no_order" | "not_terminal" | "no_adapter" | "failed"

/** Route a terminal ledger row to its product. Never throws; the result says whether the order was updated. */
export async function notifyAdapter(tx: HubtelCsTx): Promise<NotifyResult> {
  if (!tx.order_table || !tx.order_id) return "no_order"
  if (tx.state !== "fulfilled" && tx.state !== "failed") return "not_terminal"
  const adapter = registry.get(tx.order_table)
  if (!adapter) {
    // The ledger row is terminal but its order will never be updated: this needs a human, so log loudly.
    console.error(`[hubtel-cs] no order adapter registered for order_table "${tx.order_table}" (ref ${tx.client_reference}, state ${tx.state}); order not updated`)
    return "no_adapter"
  }
  try {
    if (tx.state === "fulfilled") await adapter.onFulfilled(tx)
    else await adapter.onFailed(tx)
    return "synced"
  } catch (e: any) {
    console.error(`[hubtel-cs] order adapter ${tx.order_table} hook failed for ${tx.client_reference}:`, e?.message ?? e)
    return "failed"
  }
}
```

Create `lib/hubtel-cs/order-hook.ts`:

```ts
import type { NotifyResult } from "./adapters"
import type { HubtelCsStore } from "./store"
import type { HubtelCsTx } from "./types"

export interface OrderHookDeps {
  store: Pick<HubtelCsStore, "markOrderSynced">
  notify(tx: HubtelCsTx): Promise<NotifyResult>
  alertReview(tx: HubtelCsTx): Promise<void>
}

/**
 * The one hook every settle path uses (client, callback, cron, admin actions). Settled rows go to the
 * product's order adapter and are stamped synced only on success, so the cron's re-notify sweep can retry
 * the rest. Rows entering needs_review raise a (debounced) admin alert. Never throws.
 */
export function makeOrderHook(deps: OrderHookDeps): (tx: HubtelCsTx) => Promise<void> {
  return async tx => {
    try {
      if (tx.state === "needs_review") { await deps.alertReview(tx); return }
      const r = await deps.notify(tx)
      if (r === "synced") await deps.store.markOrderSynced(tx.id)
    } catch (e: any) {
      console.error(`[hubtel-cs] order hook failed for ${tx.client_reference}:`, e?.message ?? e)
    }
  }
}
```

`lib/hubtel-cs/store.ts` — add to the `HubtelCsStore` interface:

```ts
  /** Stamp a settled row whose order hook succeeded. */
  markOrderSynced(id: string): Promise<void>
  /** Settled rows linked to an order whose hook has not succeeded yet, oldest first. */
  listUnsynced(o: { olderThan: string; limit: number }): Promise<HubtelCsTx[]>
```

and to the Supabase implementation:

```ts
    async markOrderSynced(id) {
      const { error } = await db.from(T).update({ order_synced_at: new Date().toISOString() }).eq("id", id)
      if (error) throw error
    },
    async listUnsynced(o) {
      const { data, error } = await db.from(T).select("*")
        .in("state", ["fulfilled", "failed"]).not("order_table", "is", null).is("order_synced_at", null)
        .lte("updated_at", o.olderThan).order("updated_at", { ascending: true }).limit(o.limit)
      if (error) throw error
      return (data ?? []) as HubtelCsTx[]
    },
```

`lib/hubtel-cs/testing/memory-store.ts` — add:

```ts
    async markOrderSynced(id: string) {
      const r = rows.find(x => x.id === id)
      if (r) r.order_synced_at = nowIso()
    },
    async listUnsynced(o: { olderThan: string; limit: number }) {
      return rows
        .filter(r => (r.state === "fulfilled" || r.state === "failed") && r.order_table && !r.order_synced_at && r.updated_at <= o.olderThan)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .slice(0, o.limit)
        .map(r => ({ ...r }))
    },
```

`lib/hubtel-cs/status-runner.ts` — export `RESYNC_AFTER_MS = 2 * 60_000`; add `resynced: 0` to `out` (and its type); after phase 2 add:

```ts
  // 3. settled rows whose order hook never succeeded (adapter threw / missing at the time)
  try {
    const unsynced = await deps.store.listUnsynced({ olderThan: new Date(now().getTime() - RESYNC_AFTER_MS).toISOString(), limit: 50 })
    for (const tx of unsynced) {
      if (Date.now() >= deps.deadlineMs) break
      await safeHook(tx)
      out.resynced++
    }
  } catch (e: any) {
    // 42703 = column missing (0116 not applied yet): skip quietly like a missing table.
    if (isMissingTableError(e) || (e as any)?.code === "42703") warnLedgerNotMigrated()
    else { out.errors++; console.error("[hubtel-cs] re-notify sweep failed:", e?.message ?? e) }
  }
```

`lib/hubtel-cs/runtime.ts` — build the hook once and use it for the client, `adminDeps.onTransition` and the returned `onTransition` (replace every `notifyAdapter` reference there):

```ts
import { makeOrderHook } from "./order-hook"
// ...inside getHubtelCsRuntime, after `store`:
  const orderHook = makeOrderHook({ store, notify: notifyAdapter, alertReview: async () => {} })
// client: onTransition: orderHook
// adminDeps: { store, checkStatus: checkTransactionStatus, onTransition: orderHook }
// return: onTransition: orderHook
```

Then `grep -rn "notifyAdapter" app lib --include=*.ts` — every route/cron must use `rt.onTransition` (not `notifyAdapter` directly). Fix any that don't.

- [ ] **Step 6: Run** `../../../node_modules/.bin/vitest run lib/hubtel-cs` and `tsc` → pass. Report any existing test you had to adjust (e.g. one asserting `notifyAdapter` resolves `undefined`).

- [ ] **Step 7: Commit**

```bash
git add migrations/0116_hubtel_cs_order_synced.sql lib/hubtel-cs
git commit -m "feat(hubtel-cs): order-sync stamp, single order hook and cron re-notify sweep for failed hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Alert admins when a row enters the review queue

**Files:**
- Modify: `lib/hubtel-cs/apply.ts` (fire the hook on entering `needs_review` too)
- Modify: `lib/hubtel-cs/float-alert.ts` (`kind` adds `"needs_review"`, `opts.windowMs`)
- Create: `lib/hubtel-cs/review-alert.ts`
- Modify: `lib/hubtel-cs/runtime.ts` (real `alertReview`)
- Test: `lib/hubtel-cs/apply.test.ts`, `lib/hubtel-cs/review-alert.test.ts`

**Interfaces:**
- Consumes: `makeOrderHook` (Task 3) already routes `needs_review` to `alertReview`.
- Produces: `REVIEW_ALERT_DEBOUNCE_MS = 15 * 60_000`; `reviewAlertText(tx): { subject: string; message: string }` (pure); `sendFloatAlert(db, kind: "paused" | "low_balance" | "needs_review", subject, message, opts?: { force?; senders?; now?; windowMs? })`.

- [ ] **Step 1: Failing tests.** Append to `lib/hubtel-cs/apply.test.ts`:

```ts
it("fires the hook when a row enters needs_review", async () => {
  const store = createMemoryStore()
  const tx = store.seed(makeTx({ state: "created" }))
  const hook = vi.fn(async () => {})
  await applyAndCommit(store, tx, { next: "needs_review", patch: { state: "needs_review", review_reason: "x" } }, hook)
  expect(hook).toHaveBeenCalledTimes(1)
  expect((hook.mock.calls[0] as any)[0].state).toBe("needs_review")
})
it("does not fire again for a needs_review row staying in needs_review", async () => {
  const store = createMemoryStore()
  const tx = store.seed(makeTx({ state: "needs_review" }))
  const hook = vi.fn(async () => {})
  await applyAndCommit(store, tx, { next: "needs_review", patch: { state: "needs_review", status_check_attempts: 2 } }, hook)
  expect(hook).not.toHaveBeenCalled()
})
```

Create `lib/hubtel-cs/review-alert.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { REVIEW_ALERT_DEBOUNCE_MS, reviewAlertText } from "./review-alert"
import { makeTx } from "./testing/fixtures"

describe("review alert", () => {
  it("debounces 15 minutes", () => { expect(REVIEW_ALERT_DEBOUNCE_MS).toBe(15 * 60_000) })
  it("names the reference, service, amount and reason, and where to act", () => {
    const t = reviewAlertText(makeTx({ client_reference: "HCS-airtime_mtn-abc", service_key: "airtime_mtn", amount: 5, review_reason: "No response from Hubtel" }))
    expect(t.subject).toMatch(/review/i)
    expect(t.message).toContain("HCS-airtime_mtn-abc")
    expect(t.message).toContain("airtime_mtn")
    expect(t.message).toContain("GHS 5.00")
    expect(t.message).toContain("No response from Hubtel")
    expect(t.message).toContain("/admin/hubtel-commission")
  })
})
```

- [ ] **Step 2: Run** both files → fail.

- [ ] **Step 3: Implement.** In `lib/hubtel-cs/apply.ts` change the `entered` line and the doc comment:

```ts
  const entered = updated.state !== tx.state &&
    (updated.state === "fulfilled" || updated.state === "failed" || updated.state === "needs_review")
```

(Doc comment: "fire the hook when the row ENTERS fulfilled/failed/needs_review".)

In `lib/hubtel-cs/float-alert.ts`: change the `kind` parameter type to `"paused" | "low_balance" | "needs_review"`, add `windowMs?: number` to `opts`, and use it: `if (!opts.force && !shouldSendAlert(prev?.timestamp, now, opts.windowMs)) return`. Leave `lib/hubtel-cs/float.ts`'s `FloatDeps.alert` type as is (narrower kinds are still assignable).

Create `lib/hubtel-cs/review-alert.ts`:

```ts
import type { HubtelCsTx } from "./types"

/** At most one "needs review" alert per 15 minutes, however many rows enter the queue. */
export const REVIEW_ALERT_DEBOUNCE_MS = 15 * 60_000

export function reviewAlertText(tx: HubtelCsTx): { subject: string; message: string } {
  return {
    subject: "Hubtel transaction needs review",
    message: `${tx.client_reference} (${tx.service_key}, GHS ${Number(tx.amount).toFixed(2)}) needs review: ` +
      `${tx.review_reason ?? "no reason recorded"}. Open /admin/hubtel-commission → Review Queue. Do not resend; check status first.`,
  }
}
```

In `lib/hubtel-cs/runtime.ts` replace the no-op `alertReview`:

```ts
import { REVIEW_ALERT_DEBOUNCE_MS, reviewAlertText } from "./review-alert"
// ...
  const orderHook = makeOrderHook({
    store, notify: notifyAdapter,
    alertReview: async tx => {
      const t = reviewAlertText(tx)
      await sendFloatAlert(db, "needs_review", t.subject, t.message, { windowMs: REVIEW_ALERT_DEBOUNCE_MS })
    },
  })
```

- [ ] **Step 4: Run** `../../../node_modules/.bin/vitest run lib/hubtel-cs` + `tsc`. Existing tests in `client.test.ts`, `callback.test.ts`, `status-runner.test.ts` or `admin-actions.test.ts` that assert a hook is **not** called when a row enters `needs_review` are now wrong by design — update them to the new contract (hook called once with state `needs_review`) and list each change in the report.

- [ ] **Step 5: Commit**

```bash
git add lib/hubtel-cs
git commit -m "feat(hubtel-cs): debounced admin alert when a transaction enters the review queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Airtime provider setting (module, admin API, settings page)

**Files:**
- Create: `lib/airtime-provider.ts`, `lib/airtime-provider.test.ts`
- Modify: `app/api/admin/airtime/settings/route.ts`, `app/admin/airtime/settings/page.tsx`

**Interfaces:**
- Produces (`lib/airtime-provider.ts`):
  - `type AirtimeProvider = "digiwapy" | "hubtel" | "manual"`; `AIRTIME_PROVIDERS: readonly AirtimeProvider[]`
  - `type AirtimeNetId = "mtn" | "telecel" | "at"`; `airtimeNetId(network: string): AirtimeNetId | null`
  - `airtimeProviderKey(id: AirtimeNetId): string` → `airtime_provider_<id>`; `AIRTIME_PROVIDER_KEYS: string[]`
  - `parseAirtimeProvider(value: unknown): AirtimeProvider | null`
  - `getAirtimeProvider(db, network, legacyDigiwapyEnabled: (network: string) => Promise<boolean>): Promise<AirtimeProvider>` — explicit setting wins; absent/invalid ⇒ legacy (`digiwapy` if the legacy check is true, else `manual`); a DB read error ⇒ legacy.
- Consumes: `isDigiWapyEnabledForNetwork` from `lib/digiwapy-provider.ts` (passed in, keeps the module pure-testable).

- [ ] **Step 1: Failing tests** — `lib/airtime-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { AIRTIME_PROVIDER_KEYS, airtimeNetId, airtimeProviderKey, getAirtimeProvider, parseAirtimeProvider } from "./airtime-provider"

const dbWith = (value: unknown, error: unknown = null) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value }, error }) }) }) }),
}) as any

describe("airtime provider setting", () => {
  it("maps airtime_orders network values", () => {
    expect(airtimeNetId("MTN")).toBe("mtn")
    expect(airtimeNetId("Telecel")).toBe("telecel")
    expect(airtimeNetId("AT")).toBe("at")
    expect(airtimeNetId("AirtelTigo")).toBe("at")
    expect(airtimeNetId("Glo")).toBeNull()
  })
  it("keys", () => {
    expect(airtimeProviderKey("mtn")).toBe("airtime_provider_mtn")
    expect(AIRTIME_PROVIDER_KEYS).toEqual(["airtime_provider_mtn", "airtime_provider_telecel", "airtime_provider_at"])
  })
  it("parses only the three providers", () => {
    expect(parseAirtimeProvider({ provider: "hubtel" })).toBe("hubtel")
    expect(parseAirtimeProvider({ provider: "HUBTEL" })).toBeNull()
    expect(parseAirtimeProvider("hubtel")).toBeNull()
    expect(parseAirtimeProvider(null)).toBeNull()
  })
  it("explicit setting wins over the legacy toggle", async () => {
    expect(await getAirtimeProvider(dbWith({ provider: "hubtel" }), "MTN", async () => true)).toBe("hubtel")
    expect(await getAirtimeProvider(dbWith({ provider: "manual" }), "MTN", async () => true)).toBe("manual")
  })
  it("falls back to legacy when absent, invalid, or unreadable", async () => {
    expect(await getAirtimeProvider(dbWith(undefined), "MTN", async () => true)).toBe("digiwapy")
    expect(await getAirtimeProvider(dbWith(undefined), "MTN", async () => false)).toBe("manual")
    expect(await getAirtimeProvider(dbWith({ provider: "x" }), "MTN", async () => true)).toBe("digiwapy")
    expect(await getAirtimeProvider(dbWith(null, { message: "db down" }), "MTN", async () => true)).toBe("digiwapy")
  })
  it("unknown network is manual", async () => {
    expect(await getAirtimeProvider(dbWith({ provider: "hubtel" }), "Glo", async () => true)).toBe("manual")
  })
})
```

- [ ] **Step 2: Run** → fails (module missing).

- [ ] **Step 3: Implement** `lib/airtime-provider.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js"

export type AirtimeProvider = "digiwapy" | "hubtel" | "manual"
export const AIRTIME_PROVIDERS: readonly AirtimeProvider[] = ["digiwapy", "hubtel", "manual"]
export type AirtimeNetId = "mtn" | "telecel" | "at"
const NET_IDS: readonly AirtimeNetId[] = ["mtn", "telecel", "at"]

/** airtime_orders.network values are "MTN" | "Telecel" | "AT" (older rows may say AirtelTigo/Vodafone). */
export function airtimeNetId(network: string): AirtimeNetId | null {
  const n = network.trim().toLowerCase().replace(/[\s-]/g, "")
  if (n === "mtn") return "mtn"
  if (n === "telecel" || n === "vodafone") return "telecel"
  if (n === "at" || n === "airteltigo") return "at"
  return null
}

export const airtimeProviderKey = (id: AirtimeNetId) => `airtime_provider_${id}`
export const AIRTIME_PROVIDER_KEYS: string[] = NET_IDS.map(airtimeProviderKey)

export function parseAirtimeProvider(value: unknown): AirtimeProvider | null {
  const p = value && typeof value === "object" ? (value as any).provider : undefined
  return typeof p === "string" && (AIRTIME_PROVIDERS as readonly string[]).includes(p) ? (p as AirtimeProvider) : null
}

/**
 * Explicit per-network setting wins. With none (or an unreadable one) behaviour is exactly the
 * pre-Phase-2 path: the legacy airtime_digiwapy_enabled_<net> toggle decides Digiwapy vs manual.
 */
export async function getAirtimeProvider(
  db: SupabaseClient, network: string, legacyDigiwapyEnabled: (network: string) => Promise<boolean>,
): Promise<AirtimeProvider> {
  const id = airtimeNetId(network)
  if (!id) return "manual"
  try {
    const { data, error } = await db.from("admin_settings").select("value").eq("key", airtimeProviderKey(id)).maybeSingle()
    if (!error) {
      const explicit = parseAirtimeProvider(data?.value)
      if (explicit) return explicit
    } else {
      console.warn(`[AIRTIME-PROVIDER] read failed for ${id}, using legacy toggle:`, error.message ?? error)
    }
  } catch (e: any) {
    console.warn(`[AIRTIME-PROVIDER] read threw for ${id}, using legacy toggle:`, e?.message ?? e)
  }
  return (await legacyDigiwapyEnabled(network)) ? "digiwapy" : "manual"
}
```

- [ ] **Step 4: Run** → pass.

- [ ] **Step 5: Admin API** — `app/api/admin/airtime/settings/route.ts`:
  - `import { AIRTIME_PROVIDER_KEYS, parseAirtimeProvider } from "@/lib/airtime-provider"` and `import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"` and `import { hubtelCsEnvReady } from "@/lib/hubtel-cs/config"`.
  - Add `...AIRTIME_PROVIDER_KEYS` to `AIRTIME_SETTING_KEYS`.
  - In `PUT`, before the upserts: reject an invalid provider value —

```ts
    for (const [key, value] of Object.entries(settings)) {
      if (AIRTIME_PROVIDER_KEYS.includes(key) && !parseAirtimeProvider(value)) {
        return NextResponse.json({ error: `Invalid provider for ${key}. Use {"provider":"digiwapy"|"hubtel"|"manual"}` }, { status: 400 })
      }
    }
```

  - In `GET`, add Hubtel readiness to the JSON (never throws, never exposes secrets):

```ts
    let hubtel: { enabled: boolean; ready: boolean; paused: boolean; services: Record<string, boolean> } | null = null
    try {
      const cfg = await getHubtelCsRuntime().getConfig()
      hubtel = {
        enabled: cfg.enabled,
        ready: hubtelCsEnvReady(cfg.mode).ready,
        paused: cfg.paused,
        services: { mtn: !!cfg.services.airtime_mtn, telecel: !!cfg.services.airtime_telecel, at: !!cfg.services.airtime_at },
      }
    } catch { hubtel = null }
    // ...return NextResponse.json({ settings, digiwapy_configured: ..., hubtel })
```

- [ ] **Step 6: Settings page** — in `app/admin/airtime/settings/page.tsx`:
  - Add state `const [hubtel, setHubtel] = useState<null | { enabled: boolean; ready: boolean; paused: boolean; services: Record<string, boolean> }>(null)` and set it from the GET response (`setHubtel(data.hubtel ?? null)`) next to `setDigiwapyConfigured`.
  - Directly above the existing "Auto Fulfillment (Digiwapy)" card, add a "Fulfilment provider" card. One row per entry of the page's existing `NETWORKS` (`net.id` is `mtn|telecel|at`, `net.name` the label) with three buttons; the current value is `settings[\`airtime_provider_${net.id}\`]?.provider`, shown as "Default (Digiwapy toggle)" when unset:

```tsx
<div className="bg-card rounded-2xl border border-white/60 dark:border-white/5 overflow-hidden clay">
  <div className="p-6 border-b border-border">
    <h2 className="text-lg font-bold text-foreground">Fulfilment provider</h2>
    <p className="text-sm text-muted-foreground mt-1">
      Choose who delivers paid airtime on each network. Hubtel sends at most GHS 100 per order; larger orders go to manual.
      No automatic fallback between providers.
    </p>
    {hubtel && (!hubtel.enabled || !hubtel.ready || hubtel.paused) && (
      <p className="text-xs text-amber-600 mt-2">
        Hubtel is {hubtel.paused ? "paused (float empty)" : !hubtel.enabled ? "switched off" : "not configured"} — orders routed to Hubtel will wait for manual fulfilment.
      </p>
    )}
  </div>
  <div className="p-6 space-y-3">
    {NETWORKS.map(net => {
      const key = `airtime_provider_${net.id}`
      const current: string | undefined = settings[key]?.provider
      return (
        <div key={net.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-muted/40 rounded-xl">
          <div>
            <span className="font-semibold text-foreground">{net.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">{current ? "" : "Default (Digiwapy toggle)"}</span>
          </div>
          <div className="flex gap-2">
            {(["digiwapy", "hubtel", "manual"] as const).map(p => (
              <button
                key={p}
                onClick={() => handleUpdateSetting(key, { provider: p })}
                aria-pressed={current === p}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${current === p ? "bg-primary text-primary-foreground border-primary" : "bg-card text-foreground border-border"}`}
              >
                {p === "digiwapy" ? "Digiwapy" : p === "hubtel" ? "Hubtel" : "Manual"}
              </button>
            ))}
          </div>
        </div>
      )
    })}
  </div>
</div>
```

  (If `handleUpdateSetting` or `NETWORKS` have different names in the file, use the file's actual names; the existing Digiwapy toggle card shows both.)

- [ ] **Step 7: Run** `../../../node_modules/.bin/vitest run lib/airtime-provider.test.ts` and `tsc` (errors only in touched files).

- [ ] **Step 8: Commit**

```bash
git add lib/airtime-provider.ts lib/airtime-provider.test.ts app/api/admin/airtime/settings/route.ts app/admin/airtime/settings/page.tsx
git commit -m "feat(airtime): per-network fulfilment provider setting (Digiwapy / Hubtel / manual)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Airtime dispatcher, Hubtel path and the airtime_orders adapter

**Files:**
- Create: `lib/airtime-hubtel.ts`, `lib/airtime-hubtel.test.ts`
- Create: `lib/hubtel-cs/adapters/airtime-orders.ts`, `lib/hubtel-cs/adapters/airtime-orders.test.ts`
- Modify: `lib/airtime-service.ts` (dispatcher; callers), `lib/hubtel-cs/runtime.ts` (register adapter)

**Interfaces:**
- Consumes: `getAirtimeProvider`, `airtimeNetId` (Task 5); `createHubtelCsClient(...).purchase(input: PurchaseInput): Promise<HubtelCsTx>` and errors from `lib/hubtel-cs/errors.ts` (Phase 1); `registerOrderAdapter`, `OrderAdapter` (Phase 1); `getHubtelCsRuntime()` (Phase 1/Task 3).
- Produces:
  - `lib/airtime-hubtel.ts`: `interface AirtimeOrderMinimal { id; reference_code; network; beneficiary_phone; airtime_amount }` (moved here, re-used by airtime-service); `HUBTEL_AIRTIME_MAX = 100`; `interface AirtimeHubtelDeps { purchase(input: PurchaseInput): Promise<HubtelCsTx>; markOrder(orderId: string, patch: { status?: string; notes: string }): Promise<void>; alert(message: string): Promise<void> }`; `fulfillAirtimeViaHubtel(order, deps): Promise<boolean>` — `true` = handed to Hubtel (pending / fulfilled / outcome unknown / already live), `false` = not sent (manual needed; admin alerted).
  - `lib/airtime-service.ts`: `triggerAirtimeFulfillment(order): Promise<boolean>`; `triggerDigiwapyFulfillment` kept as a deprecated alias of it.
  - `lib/hubtel-cs/adapters/airtime-orders.ts`: `AIRTIME_ORDERS_TABLE = "airtime_orders"`; `createAirtimeOrdersAdapter(deps: { update(orderId: string, patch: { status: string; notes: string }): Promise<void>; alert(message: string): Promise<void> }): OrderAdapter`; `airtimeOrdersAdapterFor(db: SupabaseClient): OrderAdapter`.

- [ ] **Step 1: Failing tests** — `lib/airtime-hubtel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { fulfillAirtimeViaHubtel, HUBTEL_AIRTIME_MAX } from "./airtime-hubtel"
import { HubtelDuplicateOrderError, HubtelOutcomeUnknownError, HubtelPausedError, HubtelDisabledError } from "./hubtel-cs/errors"
import { makeTx } from "./hubtel-cs/testing/fixtures"

const order = (over: any = {}) => ({ id: "o1", reference_code: "AIR-1", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 5, ...over })
const deps = (purchase: any) => ({ purchase: vi.fn(purchase), markOrder: vi.fn(async () => {}), alert: vi.fn(async () => {}) })

describe("fulfillAirtimeViaHubtel", () => {
  it("sends the right purchase and marks the order processing on pending", async () => {
    const d = deps(async () => makeTx({ state: "pending", client_reference: "HCS-airtime_mtn-1" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.purchase).toHaveBeenCalledWith({ serviceKey: "airtime_mtn", destination: "0241234567", amount: 5, orderTable: "airtime_orders", orderId: "o1" })
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-1") })
    expect(d.alert).not.toHaveBeenCalled()
  })
  it("over the cap: nothing sent, order left pending, admin alerted", async () => {
    const d = deps(async () => makeTx())
    expect(HUBTEL_AIRTIME_MAX).toBe(100)
    expect(await fulfillAirtimeViaHubtel(order({ airtime_amount: 100.01 }), d)).toBe(false)
    expect(d.purchase).not.toHaveBeenCalled()
    expect(d.markOrder).toHaveBeenCalledWith("o1", { notes: expect.stringMatching(/GHS 100/) })
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("exactly 100 is sent", async () => {
    const d = deps(async () => makeTx({ state: "pending" }))
    expect(await fulfillAirtimeViaHubtel(order({ airtime_amount: 100 }), d)).toBe(true)
  })
  it("paused or disabled: nothing sent, admin alerted, order stays pending", async () => {
    for (const err of [new HubtelPausedError("4075"), new HubtelDisabledError()]) {
      const d = deps(async () => { throw err })
      expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(false)
      expect(d.alert).toHaveBeenCalledTimes(1)
      expect(d.markOrder).toHaveBeenCalledWith("o1", { notes: expect.stringMatching(/not sent/i) })
    }
  })
  it("outcome unknown: order processing, alert, reported as handed off (never retried elsewhere)", async () => {
    const d = deps(async () => { throw new HubtelOutcomeUnknownError("HCS-airtime_mtn-9", new Error("db")) })
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-airtime_mtn-9") })
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("needs_review result: processing + alert", async () => {
    const d = deps(async () => makeTx({ state: "needs_review", client_reference: "HCS-r" }))
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.markOrder).toHaveBeenCalledWith("o1", { status: "processing", notes: expect.stringContaining("HCS-r") })
    expect(d.alert).toHaveBeenCalledTimes(1)
  })
  it("a live Hubtel transaction already exists: no-op success", async () => {
    const d = deps(async () => { throw new HubtelDuplicateOrderError("airtime_orders", "o1") })
    expect(await fulfillAirtimeViaHubtel(order(), d)).toBe(true)
    expect(d.alert).not.toHaveBeenCalled()
  })
  it("unknown network: not sent", async () => {
    const d = deps(async () => makeTx())
    expect(await fulfillAirtimeViaHubtel(order({ network: "Glo" }), d)).toBe(false)
    expect(d.purchase).not.toHaveBeenCalled()
  })
  it("never throws even if markOrder/alert fail", async () => {
    const d = { purchase: vi.fn(async () => { throw new HubtelPausedError(null) }), markOrder: vi.fn(async () => { throw new Error("db") }), alert: vi.fn(async () => { throw new Error("sms") }) }
    await expect(fulfillAirtimeViaHubtel(order(), d)).resolves.toBe(false)
  })
})
```

`lib/hubtel-cs/adapters/airtime-orders.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { AIRTIME_ORDERS_TABLE, createAirtimeOrdersAdapter } from "./airtime-orders"
import { makeTx } from "../testing/fixtures"

describe("airtime_orders adapter", () => {
  it("owns airtime_orders", () => {
    expect(createAirtimeOrdersAdapter({ update: async () => {}, alert: async () => {} }).table).toBe(AIRTIME_ORDERS_TABLE)
  })
  it("fulfilled -> completed with the Hubtel references in the note", async () => {
    const update = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ update, alert: async () => {} })
      .onFulfilled(makeTx({ order_id: "o1", client_reference: "HCS-1", hubtel_transaction_id: "T9" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "completed", notes: expect.stringMatching(/HCS-1.*T9|T9.*HCS-1/) })
  })
  it("failed -> back to pending for manual fulfilment (existing Digiwapy convention) + alert", async () => {
    const update = vi.fn(async () => {}), alert = vi.fn(async () => {})
    await createAirtimeOrdersAdapter({ update, alert })
      .onFailed(makeTx({ order_id: "o1", client_reference: "HCS-1", failure_reason: "Invalid number" }))
    expect(update).toHaveBeenCalledWith("o1", { status: "pending", notes: expect.stringContaining("Invalid number") })
    expect(alert).toHaveBeenCalledTimes(1)
  })
  it("has no refundToWallet (airtime refunds use /admin/refunds)", () => {
    expect(createAirtimeOrdersAdapter({ update: async () => {}, alert: async () => {} }).refundToWallet).toBeUndefined()
  })
  it("propagates update errors so the hook is retried by the re-notify sweep", async () => {
    const a = createAirtimeOrdersAdapter({ update: async () => { throw new Error("db") }, alert: async () => {} })
    await expect(a.onFulfilled(makeTx({ order_id: "o1" }))).rejects.toThrow("db")
  })
})
```

- [ ] **Step 2: Run** both → fail.

- [ ] **Step 3: Implement** `lib/airtime-hubtel.ts`:

```ts
import { airtimeNetId } from "./airtime-provider"
import type { PurchaseInput } from "./hubtel-cs/client"
import {
  HubtelDuplicateOrderError, HubtelOutcomeUnknownError,
} from "./hubtel-cs/errors"
import type { HubtelCsServiceKey } from "./hubtel-cs/services"
import type { HubtelCsTx } from "./hubtel-cs/types"

export interface AirtimeOrderMinimal {
  id: string
  reference_code: string
  network: string
  beneficiary_phone: string
  airtime_amount: number
}

/** Hubtel's per-request airtime cap (docs: "maximum airtime top-up amount per request is 100 cedis"). */
export const HUBTEL_AIRTIME_MAX = 100

export interface AirtimeHubtelDeps {
  purchase(input: PurchaseInput): Promise<HubtelCsTx>
  markOrder(orderId: string, patch: { status?: string; notes: string }): Promise<void>
  alert(message: string): Promise<void>
}

const quiet = async (p: Promise<void>, what: string) => {
  try { await p } catch (e: any) { console.error(`[AIRTIME-HUBTEL] ${what} failed:`, e?.message ?? e) }
}

/**
 * Hand a paid airtime order to Hubtel. Returns true when Hubtel owns it now (pending, settled, outcome
 * unknown, or a live Hubtel transaction already exists) and false when nothing was sent (manual needed).
 * Never resends, never falls back to another provider, never throws.
 */
export async function fulfillAirtimeViaHubtel(order: AirtimeOrderMinimal, deps: AirtimeHubtelDeps): Promise<boolean> {
  const tag = `${order.reference_code} (${order.network} ${order.beneficiary_phone} GHS ${order.airtime_amount})`
  const notSent = async (why: string) => {
    await quiet(deps.markOrder(order.id, { notes: `Hubtel: not sent - ${why}. Fulfil manually.` }), "markOrder")
    await quiet(deps.alert(`Airtime ${tag} needs manual fulfilment: Hubtel not sent - ${why}`), "alert")
    return false
  }

  const id = airtimeNetId(order.network)
  if (!id) return notSent(`unsupported network "${order.network}"`)
  if (!(order.airtime_amount <= HUBTEL_AIRTIME_MAX)) return notSent(`amount over the Hubtel limit of GHS ${HUBTEL_AIRTIME_MAX}`)

  try {
    const tx = await deps.purchase({
      serviceKey: `airtime_${id}` as HubtelCsServiceKey,
      destination: order.beneficiary_phone,
      amount: order.airtime_amount,
      orderTable: "airtime_orders",
      orderId: order.id,
    })
    if (tx.state === "needs_review") {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown, in review [hcsRef:${tx.client_reference}]. Do not resend.` }), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel outcome unknown (ref ${tx.client_reference}) - check the Hubtel review queue, do not resend`), "alert")
      return true
    }
    if (tx.state === "pending" || tx.state === "created") {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Sent via Hubtel [hcsRef:${tx.client_reference}]` }), "markOrder")
    }
    // fulfilled / failed were already applied to the order by the adapter hook.
    return tx.state !== "failed"
  } catch (e: any) {
    if (e instanceof HubtelDuplicateOrderError) return true
    if (e instanceof HubtelOutcomeUnknownError) {
      await quiet(deps.markOrder(order.id, { status: "processing", notes: `Hubtel: outcome unknown [hcsRef:${e.clientReference}]. Do not resend.` }), "markOrder")
      await quiet(deps.alert(`Airtime ${tag}: Hubtel POST may have been sent (ref ${e.clientReference}) - check the Hubtel review queue, do not resend`), "alert")
      return true
    }
    // Every other error is raised before the POST (disabled, paused, not configured, validation, insert failure).
    return notSent(e?.message ?? "error")
  }
}
```

Create `lib/hubtel-cs/adapters/airtime-orders.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js"
import type { OrderAdapter } from "../adapters"
import type { HubtelCsTx } from "../types"

export const AIRTIME_ORDERS_TABLE = "airtime_orders"

export interface AirtimeOrdersAdapterDeps {
  /** Must be idempotent and must not downgrade a completed order. Throws on DB error (the sweep retries). */
  update(orderId: string, patch: { status: string; notes: string }): Promise<void>
  alert(message: string): Promise<void>
}

export function createAirtimeOrdersAdapter(deps: AirtimeOrdersAdapterDeps): OrderAdapter {
  return {
    table: AIRTIME_ORDERS_TABLE,
    async onFulfilled(tx: HubtelCsTx) {
      await deps.update(tx.order_id!, {
        status: "completed",
        notes: `Delivered via Hubtel [hcsRef:${tx.client_reference}]${tx.hubtel_transaction_id ? ` [txn:${tx.hubtel_transaction_id}]` : ""}`,
      })
    },
    async onFailed(tx: HubtelCsTx) {
      // Same convention as the Digiwapy webhook: a provider failure returns the order to pending for an admin.
      await deps.update(tx.order_id!, {
        status: "pending",
        notes: `Hubtel failed: ${tx.failure_reason ?? tx.response_code ?? "unknown reason"} [hcsRef:${tx.client_reference}]. Fulfil manually; not resent.`,
      })
      try { await deps.alert(`Airtime order ${tx.order_id} failed on Hubtel (${tx.failure_reason ?? tx.response_code ?? "?"}); needs manual fulfilment`) }
      catch (e: any) { console.error("[hubtel-cs] airtime failure alert error:", e?.message ?? e) }
    },
  }
}

export function airtimeOrdersAdapterFor(db: SupabaseClient): OrderAdapter {
  return createAirtimeOrdersAdapter({
    async update(orderId, patch) {
      const { error } = await db.from(AIRTIME_ORDERS_TABLE)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", orderId).neq("status", "completed")
      if (error) throw error
    },
    async alert(message) {
      const { notifyAdmins } = await import("@/lib/sms-service")
      await notifyAdmins(message, "airtime_manual_needed", undefined, true)
    },
  })
}
```

(Check `notifyAdmins`' real signature in `lib/sms-service.ts` (`notifyAdmins(message, type, reference?, skipEmailFallback?)`) and match it.)

- [ ] **Step 4: Wire it up.**

`lib/hubtel-cs/runtime.ts` — inside `getHubtelCsRuntime()` right after `const db = serviceRoleClient()`:

```ts
import { registerOrderAdapter } from "./adapters"
import { airtimeOrdersAdapterFor } from "./adapters/airtime-orders"
// ...
  // Static registration (every entry point builds the runtime, so every entry point has the adapters).
  registerOrderAdapter(airtimeOrdersAdapterFor(db))
```

`lib/airtime-service.ts`:
- Remove the local `interface AirtimeOrderMinimal` and `import { type AirtimeOrderMinimal, fulfillAirtimeViaHubtel } from "@/lib/airtime-hubtel"`; `import { getAirtimeProvider } from "@/lib/airtime-provider"`.
- Rename the body of today's `triggerDigiwapyFulfillment` into two private helpers without changing their behaviour: `alertManualAirtime(order)` (the `notifyAdmins(SMSTemplates.adminAirtimeManualRequired(...))` block, returns `false`) and `fulfillViaDigiwapy(order)` (the `sendAirtimeViaDigiwapy` try/catch block, returns its boolean). Then:

```ts
/**
 * Single fulfilment chokepoint for every airtime surface (wallet, storefront Paystack, API v1, USSD).
 * Provider per network: explicit admin setting, else the legacy Digiwapy toggle. Never falls back
 * between providers automatically.
 */
export async function triggerAirtimeFulfillment(order: AirtimeOrderMinimal): Promise<boolean> {
  try {
    const provider = await getAirtimeProvider(supabase, order.network, isDigiWapyEnabledForNetwork)
    console.log(`[AIRTIME-SVC] provider for ${order.network}: ${provider}`)
    if (provider === "digiwapy") return await fulfillViaDigiwapy(order)
    if (provider === "hubtel") {
      const { getHubtelCsRuntime } = await import("@/lib/hubtel-cs/runtime")
      const rt = getHubtelCsRuntime()
      return await fulfillAirtimeViaHubtel(order, {
        purchase: input => rt.client.purchase(input),
        markOrder: async (orderId, patch) => {
          const { error } = await supabase.from("airtime_orders")
            .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", orderId).neq("status", "completed")
          if (error) throw error
        },
        alert: async message => { await notifyAdmins(message, "airtime_manual_needed", order.id, true) },
      })
    }
    return await alertManualAirtime(order)
  } catch (err: any) {
    console.error(`[AIRTIME-SVC] fulfilment dispatch threw for order ${order.id}:`, err?.message ?? err)
    return false
  }
}

/** @deprecated use triggerAirtimeFulfillment */
export const triggerDigiwapyFulfillment = triggerAirtimeFulfillment
```

- Note: `fulfillViaDigiwapy` must **not** re-check `isDigiWapyEnabledForNetwork` (an explicit "digiwapy" setting means use it); but it must still guard `isDigiWapyConfigured()` and fall back to `alertManualAirtime` when Digiwapy env is missing.
- Replace both in-file calls `await triggerDigiwapyFulfillment({...})` with `await triggerAirtimeFulfillment({...})`.

- [ ] **Step 5: Run** `../../../node_modules/.bin/vitest run lib/airtime-hubtel.test.ts lib/hubtel-cs lib/airtime-service.test.ts lib/airtime-provider.test.ts` and `tsc`. `lib/airtime-service.test.ts` mocks Supabase; if the new provider read breaks a mock, the dispatcher falls back to the legacy path by design (Task 5 "unreadable ⇒ legacy") — extend the mock with an `admin_settings` `maybeSingle` returning `{ data: null, error: null }` rather than weakening any assertion, and report it.

- [ ] **Step 6: Commit**

```bash
git add lib/airtime-hubtel.ts lib/airtime-hubtel.test.ts lib/hubtel-cs/adapters lib/hubtel-cs/runtime.ts lib/airtime-service.ts lib/airtime-service.test.ts
git commit -m "feat(airtime): route airtime per network to Digiwapy, Hubtel or manual; airtime_orders Hubtel adapter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Verification, runbook and rollout gate

**Files:**
- Modify: `docs/hubtel-commission-services/runbook.md` (new "Phase 2a" section)

- [ ] **Step 1:** Full suite: `../../../node_modules/.bin/vitest run` — all `lib/hubtel-cs`, `lib/airtime*` pass. The 9 known pre-existing failures in `lib/order-health-service.test.ts` (fail on main too) are the only allowed failures; report the exact counts.
- [ ] **Step 2:** `../../../node_modules/.bin/tsc --noEmit -p .` → 0 errors.
- [ ] **Step 3:** Real build (route-export violations are invisible to tsc/vitest):
  `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder ../../../node_modules/.bin/next build` → exit 0 and "Generating static pages (N/N)".
- [ ] **Step 4:** Append to `docs/hubtel-commission-services/runbook.md`:

```markdown
## Phase 2a — airtime provider switch (rollout)

1. Apply `migrations/0115_hubtel_cs_config_patch.sql` and `migrations/0116_hubtel_cs_order_synced.sql` to production
   BEFORE merging (the runtime calls the new RPC and the cron reads the new column). Verify:
   `select to_regprocedure('hubtel_cs_config_patch(jsonb)')` is not null and
   `select column_name from information_schema.columns where table_name='hubtel_cs_transactions' and column_name='order_synced_at'` returns a row.
2. Merge + deploy. Nothing changes until an admin picks a provider: with no `airtime_provider_<net>` setting the legacy
   Digiwapy toggle still decides.
3. Hubtel must be enabled and ready on `/admin/hubtel-commission` (credential + account are set in Vercel since 2026-10-13).
4. On `/admin/airtime/settings` → "Fulfilment provider", set ONE network to Hubtel. Buy GHS 0.50 airtime to your own number
   on that network from the dashboard. Expect: order `processing` with `[hcsRef:HCS-…]`, then `completed` within ~1 min;
   the ledger row on `/admin/hubtel-commission` shows `fulfilled` and a commission.
5. Roll back any time by choosing Digiwapy or Manual for that network. In-flight Hubtel orders still settle (cron runs regardless).

Behaviour to know:
- Orders over GHS 100 on a Hubtel network are NOT split: they stay `pending` with an admin alert for manual fulfilment.
- Hubtel off / paused / not configured ⇒ orders stay `pending` + alert; no silent switch to Digiwapy.
- A definite Hubtel failure returns the order to `pending` (same as Digiwapy failures) for an admin; never auto-resent.
- Outcome unknown ⇒ order `processing`, alert, Hubtel review queue owns it. Airtime refunds use `/admin/refunds`.
- Admins get one "transaction needs review" alert per 15 min when rows enter the review queue.
- If an order hook fails, the 2-minute cron re-runs it (rows with `order_synced_at` null).
```

- [ ] **Step 5: Commit**

```bash
git add docs/hubtel-commission-services/runbook.md
git commit -m "docs(hubtel-cs): phase 2a rollout runbook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: STOP.** Do not apply migrations, push or merge. Report test counts, tsc result and build exit code; the controller asks the user for the production go-ahead.

---

## Self-review (against the spec)

- §4.1 static adapter registration → Task 6 (runtime registers `airtime_orders`); hook is the single `makeOrderHook` (Task 3).
- §4.2 re-notify sweep with `order_synced_at` → Task 3.
- §4.3 atomic 4075 pause → Task 2 (broadened to the admin save too).
- §4.4 5xx carrying 0000/0001 → Task 1.
- §4.5 review-queue alert, 15-min debounce, never throws → Task 4.
- §5 setting keys, legacy default, single chokepoint, Hubtel dispatch, >100 cap, disabled/paused, outcome unknown, adapter, settings UI → Tasks 5–6. Deltas (failure ⇒ pending; no airtime `refundToWallet`) recorded at the top.
- §12 rollout (dark, migrations before merge) → Task 7.
- Types: `NotifyResult`, `makeOrderHook`, `markOrderSynced`, `listUnsynced`, `AirtimeOrderMinimal`, `fulfillAirtimeViaHubtel`, `createAirtimeOrdersAdapter`, `getAirtimeProvider` are each defined once and used with the same names in later tasks.
