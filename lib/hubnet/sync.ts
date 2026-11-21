// Per-row apply step for the Hubnet status-sync cron (and any Hubnet webhook sync).
//
// applyKuntaniiStatusChange has no Kuntanii-specific logic: it is a guarded
// tracking write (.eq("status", oldStatus)), a mirror to the order table with
// failed => "pending", and a phone-free notification. Re-exported under a
// provider-neutral name rather than copied so the money-path semantics cannot drift.
import { applyKuntaniiStatusChange, type KuntaniiSyncRow, type KuntaniiStatusResult, type KuntaniiSyncDeps } from "@/lib/mtn-providers/kuntanii-sync"
import type { HubnetStatus } from "./core"

export type HubnetSyncRow = KuntaniiSyncRow
export type HubnetStatusResult = KuntaniiStatusResult
export type HubnetSyncDeps = KuntaniiSyncDeps

/** Returns true when this call moved the tracking row (and mirrored + notified); false when another run got there first. */
export function applyHubnetStatusChange(
  db: any,
  row: HubnetSyncRow,
  newStatus: HubnetStatus,
  result: HubnetStatusResult,
  deps: HubnetSyncDeps = {},
): Promise<boolean> {
  return applyKuntaniiStatusChange(db, row, newStatus, result, deps)
}
