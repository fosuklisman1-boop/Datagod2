//
// Bulk, reversible "mark a network out of stock" admin feature.
//
// This does NOT introduce a new availability gate. Purchase availability is
// controlled entirely by packages.is_available (already checked correctly by
// every purchase surface — dashboard, v1 API, shop, USSD, WhatsApp, AI
// ordering). This module is purely a bulk read-modify-write helper on top of
// that existing column: "out of stock" = set is_available=false on every
// currently-available package of a network, snapshotting which ones were
// touched so "restock" can flip only those back to true (not every package
// of the network — a package disabled for unrelated reasons stays disabled).
//
// The snapshot itself lives in admin_settings under NETWORK_STOCK_KEY, as a
// single JSON blob keyed by network — same read-modify-write-whole-blob
// convention as network_prefix_map (see lib/network-prefix-config.ts).
//
// Caller owns the Supabase client (passed in, never created here) so this
// module is testable with a plain fake object — no @supabase/supabase-js
// mocking required.

import type { SupabaseClient } from "@supabase/supabase-js"

export const STOCK_TRACKED_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"] as const
export type TrackedNetwork = (typeof STOCK_TRACKED_NETWORKS)[number]

export const NETWORK_STOCK_KEY = "network_stock_status"

export interface NetworkStockEntry {
  outOfStock: boolean
  restoreIds?: string[] // package ids to re-enable on restock; only meaningful when outOfStock is true
}
export type NetworkStockMap = Record<string, NetworkStockEntry>

/**
 * Reads the whole network-stock map from admin_settings. Returns {} if the
 * row has never been seeded (nothing has ever been marked out of stock).
 */
export async function getNetworkStockMap(supabase: SupabaseClient): Promise<NetworkStockMap> {
  const { data, error } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", NETWORK_STOCK_KEY)
    .maybeSingle()
  if (error) throw error
  const value = data?.value
  return value && typeof value === "object" ? (value as NetworkStockMap) : {}
}

async function writeNetworkStockMap(supabase: SupabaseClient, map: NetworkStockMap): Promise<void> {
  const { error } = await supabase.from("admin_settings").upsert(
    {
      key: NETWORK_STOCK_KEY,
      value: map,
      description: "Per-network out-of-stock status + snapshot of package ids disabled by the last out-of-stock toggle, for restock to re-enable.",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  )
  if (error) throw error
}

/**
 * Marks `network` out of stock: disables every currently-available package
 * of that network and snapshots their ids so restockNetwork() can restore
 * exactly those (and only those) later.
 *
 * Idempotent while already out of stock: a second call is a true no-op and
 * returns immediately WITHOUT re-reading packages or re-writing the map.
 * This guard is critical — without it, a double-click (or a retried
 * request) would overwrite the original restoreIds snapshot with an empty
 * one (since by the second call every package is already disabled),
 * permanently losing which packages should be restored on restock.
 */
export async function setNetworkOutOfStock(
  supabase: SupabaseClient,
  network: string
): Promise<{ affected: number; alreadyOutOfStock: boolean }> {
  const map = await getNetworkStockMap(supabase)
  if (map[network]?.outOfStock === true) {
    return { affected: 0, alreadyOutOfStock: true }
  }

  const { data: rows, error: fetchError } = await supabase
    .from("packages")
    .select("id, is_available")
    .eq("network", network)
  if (fetchError) throw fetchError

  // Same "available" semantics as the admin frontend (pkg.is_available !==
  // false): treat null/undefined as available. A Postgres .eq("is_available",
  // true) filter would silently exclude NULL rows from the snapshot, they'd
  // never get disabled, and the whole point of "out of stock" would be
  // defeated for those rows.
  const restoreIds = (rows ?? [])
    .filter((p: { id: string; is_available: boolean | null }) => p.is_available !== false)
    .map((p: { id: string }) => p.id)

  if (restoreIds.length > 0) {
    const { error: updateError } = await supabase
      .from("packages")
      .update({ is_available: false })
      .in("id", restoreIds)
    if (updateError) throw updateError
  }

  map[network] = { outOfStock: true, restoreIds }
  await writeNetworkStockMap(supabase, map)

  return { affected: restoreIds.length, alreadyOutOfStock: false }
}

/**
 * Restocks `network`: re-enables exactly the packages snapshotted by the
 * out-of-stock toggle (not every package of the network — a package that
 * was individually disabled before the network-wide disable stays
 * disabled). No-op if the network isn't currently marked out of stock.
 */
export async function restockNetwork(
  supabase: SupabaseClient,
  network: string
): Promise<{ affected: number; alreadyInStock: boolean }> {
  const map = await getNetworkStockMap(supabase)
  if (map[network]?.outOfStock !== true) {
    return { affected: 0, alreadyInStock: true }
  }

  const restoreIds = map[network].restoreIds ?? []

  if (restoreIds.length > 0) {
    const { error: updateError } = await supabase
      .from("packages")
      .update({ is_available: true })
      .in("id", restoreIds)
    if (updateError) throw updateError
  }

  // No restoreIds key on the in-stock entry — it's stale/no-op once
  // restocked; drop it so the map doesn't accumulate garbage.
  map[network] = { outOfStock: false }
  await writeNetworkStockMap(supabase, map)

  return { affected: restoreIds.length, alreadyInStock: false }
}
