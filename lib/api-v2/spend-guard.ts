/**
 * Release 5 request-path guard: pure and browser-safe. The docs registry (client components) imports values from
 * endpoints/data.ts, so nothing here may import server-only modules (database clients, hashing). The server side
 * (settings snapshot, ledger RPC wrappers, the default hook) lives in ./spend.ts.
 */
import type { V2Context } from "./handler"
import { MSG_DAILY_LIMIT, MSG_DAILY_LIMIT_ADMIN } from "./access"

export type SpendKind = "data" | "data_bulk" | "airtime" | "bill" | "bundle" | "results" | "afa"

export interface MoneySettings {
  capsEnabled: boolean
  alertsEnabled: boolean
  at: number
}

/**
 * `reserved`: this request owns the ledger row and MUST settle it (spent or released).
 * `existing`: another request already owns a reserved/spent row for this reference: proceed, but NEVER settle it
 * (settling would release or overwrite someone else's reservation).
 */
export type ReserveResult =
  | { kind: "skipped" }
  | { kind: "reserved" }
  | { kind: "existing"; state: "reserved" | "spent"; ageSeconds?: number }
  | { kind: "cap"; scope: "key" | "user" }
  | { kind: "error" }

/** What an endpoint needs; injected through each endpoint's Deps so tests never touch the database. */
export interface SpendHook {
  settings(): Promise<MoneySettings>
  reserve(p: { userId: string; keyId: string; kind: SpendKind; reference: string; amount: number }): Promise<ReserveResult>
  settle(p: { keyId: string; kind: SpendKind; reference: string; state: "spent" | "released"; amount?: number }): Promise<void>
}

export type GuardResult = { proceed: true; owned: boolean } | { proceed: false; result: { status: 402 | 409 | 503; error: { status: 402 | 409 | 503; message: string } } }

const SPEND_UNAVAILABLE = "UNAVAILABLE: the daily spending limit could not be checked; nothing was charged. Retry with the same reference"
/**
 * A reservation older than this (seconds) is stale. It must exceed the longest v2 route maxDuration (300 s): only then
 * is the owning request certainly dead, so a later request proceeding past it can never race the owner's settle.
 */
export const STALE_RESERVATION_SECONDS = 360
export const MSG_SPEND_IN_PROGRESS =
  "REQUEST_IN_PROGRESS: a request with this reference is still being processed; nothing was charged by this one. Retry the same reference shortly"

export function capMessage(scope: "key" | "user"): string {
  return scope === "user" ? MSG_DAILY_LIMIT_ADMIN : MSG_DAILY_LIMIT
}

/** True only for live keys while caps are switched on. Test keys never reserve. */
export function spendGuard(ctx: V2Context, settings: MoneySettings): boolean {
  return ctx.environment === "live" && settings.capsEnabled
}

/**
 * Before anything that can charge. `owned: true` means this request holds the reservation and MUST settle it.
 * Live keys only, caps on only; a settings failure reads as caps off (never blocks). A refused request has charged
 * nothing; the caller releases its claim (commission) before returning the result.
 */
export async function guardSpend(
  hook: SpendHook | undefined,
  ctx: V2Context,
  kind: SpendKind,
  reference: string,
  /** A number, or a reader called only when caps are on for a live key (so caps-off adds no query). */
  amountOrRead: number | (() => Promise<number>),
  /**
   * refuseInFlight: for products WITHOUT a claim (data, data_bulk) another request holding a still-reserved row for the
   * same reference means two requests are racing: answer 409 and never place (review C2). Commission products keep
   * proceeding: their claim already makes the reference exclusive.
   */
  opts: { refuseInFlight?: boolean } = {},
): Promise<GuardResult> {
  if (!hook || ctx.environment !== "live") return { proceed: true, owned: false }
  let settings: MoneySettings
  try {
    settings = await hook.settings()
  } catch {
    return { proceed: true, owned: false }
  }
  if (!spendGuard(ctx, settings)) return { proceed: true, owned: false }
  let amount: number
  try {
    amount = typeof amountOrRead === "number" ? amountOrRead : await amountOrRead()
  } catch {
    amount = NaN
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { proceed: false, result: { status: 503, error: { status: 503, message: SPEND_UNAVAILABLE } } }
  }
  let r: ReserveResult
  try {
    r = await hook.reserve({ userId: ctx.userId, keyId: ctx.keyId, kind, reference, amount })
  } catch {
    r = { kind: "error" }
  }
  switch (r.kind) {
    case "reserved":
      return { proceed: true, owned: true }
    case "existing":
      // Only a reservation still inside the in-flight window is refused. An older one is stale (lost response, unknown
      // outcome): proceed without owning it, so the reference is never blocked for good. The stale row already counts
      // the amount, and the order engine allows one order per person and reference.
      if (opts.refuseInFlight && r.state === "reserved" && !(typeof r.ageSeconds === "number" && r.ageSeconds > STALE_RESERVATION_SECONDS)) {
        return { proceed: false, result: { status: 409, error: { status: 409, message: MSG_SPEND_IN_PROGRESS } } }
      }
      return { proceed: true, owned: false }
    case "skipped":
      return { proceed: true, owned: false }
    case "cap": {
      const message = capMessage(r.scope)
      return { proceed: false, result: { status: 402, error: { status: 402, message } } }
    }
    default:
      return { proceed: false, result: { status: 503, error: { status: 503, message: SPEND_UNAVAILABLE } } }
  }
}

/** Settles only a reservation this request owns (never someone else's `existing` row). Never throws. */
export async function settleOwned(
  hook: SpendHook | undefined,
  owned: boolean,
  ctx: V2Context,
  kind: SpendKind,
  reference: string,
  state: "spent" | "released",
  amount?: number,
): Promise<void> {
  if (!hook || !owned) return
  try {
    await hook.settle({ keyId: ctx.keyId, kind, reference, state, ...(amount !== undefined ? { amount } : {}) })
  } catch {
    // a failed settle leaves the row reserved (counted): the safe side
  }
}

/** The raw bulk reference: the server hashes it (sha256) before it reaches the ledger, so its length never matters. */
export function bulkReference(newReferences: string[]): string {
  return "bulk:" + [...newReferences].sort().join("\n")
}
