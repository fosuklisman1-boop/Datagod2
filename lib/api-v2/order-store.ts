import type { SupabaseLike } from "./store"
import type { PackageRow } from "./data-orders"

/** The real service-role client satisfies this; tests inject a fake. */
export type RpcClient = SupabaseLike & {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
}

export type PlaceFailCode = "INSUFFICIENT_BALANCE" | "REFERENCE_REUSED" | "WALLET_NOT_FOUND" | "FAILED"

export type PlaceResult =
  | { ok: true; replayed: boolean; orderId: string; createdAt: string; status?: string; newBalance?: number }
  | { ok: false; code: PlaceFailCode; required?: number; balance?: number }

export interface PlaceParams {
  userId: string
  apiV2KeyId: string
  packageId: string
  dbNetwork: string
  gb: number
  price: number
  /** MUST be the LOCAL 0XXXXXXXXX form (see storageRecipient). Never the 233... msisdn. */
  recipientPhone: string
  reference: string
  description: string
}

const FAILED: PlaceResult = { ok: false, code: "FAILED" }

const STORAGE_RECIPIENT_RE = /^0[235][0-9]{8}$/

/**
 * The ONE storage form for api_orders.recipient_phone on v2 orders: LOCAL
 * 0XXXXXXXXX. The SQL replay check compares this string exactly, so every
 * call site (single and bulk) must go through here.
 */
export function storageRecipient(input: { local: string }): string {
  return input.local
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Atomic, replay-aware placement via place_api_v2_order (migration 0130).
 * Never throws. Anything unexpected is FAILED (the RPC is the only thing
 * that moves money, and it either commits fully or not at all).
 */
export async function placeV2Order(client: RpcClient, p: PlaceParams): Promise<PlaceResult> {
  try {
    // Refuse anything but the local form (e.g. a 233... msisdn) before money can move.
    if (typeof p.recipientPhone !== "string" || !STORAGE_RECIPIENT_RE.test(p.recipientPhone)) return FAILED
    const { data, error } = await client.rpc("place_api_v2_order", {
      p_user_id: p.userId,
      p_api_v2_key_id: p.apiV2KeyId,
      p_package_id: p.packageId,
      p_network: p.dbNetwork,
      p_volume_gb: p.gb,
      p_price: p.price,
      p_recipient_phone: p.recipientPhone,
      p_api_reference: p.reference,
      p_description: p.description,
    })
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return FAILED
    const r = data as Record<string, unknown>

    if (r.success === true) {
      if (typeof r.order_id !== "string" || !r.order_id) return FAILED
      if (typeof r.created_at !== "string" || !r.created_at) return FAILED
      if (r.replayed === true) {
        return {
          ok: true,
          replayed: true,
          orderId: r.order_id,
          createdAt: r.created_at,
          ...(typeof r.status === "string" ? { status: r.status } : {}),
        }
      }
      const newBalance = num(r.new_balance)
      return {
        ok: true,
        replayed: false,
        orderId: r.order_id,
        createdAt: r.created_at,
        ...(newBalance !== undefined ? { newBalance } : {}),
      }
    }

    if (r.success === false) {
      if (r.code === "REFERENCE_REUSED") return { ok: false, code: "REFERENCE_REUSED" }
      if (r.error === "Insufficient balance") {
        const required = num(r.required)
        const balance = num(r.balance)
        return {
          ok: false,
          code: "INSUFFICIENT_BALANCE",
          ...(required !== undefined ? { required } : {}),
          ...(balance !== undefined ? { balance } : {}),
        }
      }
      if (r.error === "Wallet not found") return { ok: false, code: "WALLET_NOT_FOUND" }
    }
    return FAILED
  } catch {
    return FAILED
  }
}

export interface OrderRow {
  api_reference: string
  network: string
  volume_gb: number | string
  price: number | string
  recipient_phone: string
  status: string
  created_at: string
}

const ORDER_COLUMNS = ["api_reference", "network", "volume_gb", "price", "recipient_phone", "status", "created_at"] as const

/** Scoped to the owner: both user_id and api_reference must match. */
export async function getOrderByReference(
  client: SupabaseLike,
  userId: string,
  reference: string
): Promise<OrderRow | null> {
  try {
    const { data, error } = await client
      .from("api_orders")
      .select(ORDER_COLUMNS.join(", "))
      .eq("user_id", userId)
      .eq("api_reference", reference)
      .maybeSingle()
    if (error || !data) return null
    const out: Record<string, unknown> = {}
    for (const c of ORDER_COLUMNS) out[c] = (data as Record<string, unknown>)[c]
    return out as unknown as OrderRow
  } catch {
    return null
  }
}

const REFERENCE_CHUNK = 200

function pickOrderColumns(data: unknown): OrderRow {
  const out: Record<string, unknown> = {}
  for (const c of ORDER_COLUMNS) out[c] = (data as Record<string, unknown>)[c]
  return out as unknown as OrderRow
}

/**
 * Bulk replay lookup: the caller's orders for many references, one query per
 * chunk of 200 (`.in()` stays small, see bulk-order-ops-chunking). Scoped to
 * user_id. Returns null on ANY error so the caller fails closed (no charge).
 */
export async function getOrdersByReferences(
  client: SupabaseLike,
  userId: string,
  references: string[]
): Promise<Map<string, OrderRow> | null> {
  const out = new Map<string, OrderRow>()
  try {
    for (let i = 0; i < references.length; i += REFERENCE_CHUNK) {
      const chunk = references.slice(i, i + REFERENCE_CHUNK)
      const { data, error } = await client
        .from("api_orders")
        .select(ORDER_COLUMNS.join(", "))
        .eq("user_id", userId)
        .in("api_reference", chunk)
      if (error || !Array.isArray(data)) return null
      for (const r of data) {
        const row = pickOrderColumns(r)
        if (typeof row.api_reference === "string") out.set(row.api_reference, row)
      }
    }
    return out
  } catch {
    return null
  }
}

export async function getWalletBalance(client: SupabaseLike, userId: string): Promise<number | null> {
  try {
    const { data, error } = await client.from("wallets").select("balance").eq("user_id", userId).maybeSingle()
    if (error || !data) return null
    const n = num((data as { balance?: unknown }).balance)
    return n === undefined ? null : n
  } catch {
    return null
  }
}

function sizeKey(size: string): number {
  return /^[0-9]+(\.[0-9]+)?$/.test(size) ? Number(size) : Number.POSITIVE_INFINITY
}

/**
 * Available packages only, ordered by network then numeric size. Returns null
 * on a read error (distinct from an empty catalog) so callers answer 503
 * instead of a misleading "not found".
 */
export async function listAvailablePackages(client: SupabaseLike, dbNetwork?: string): Promise<PackageRow[] | null> {
  try {
    const { data, error } = await client
      .from("packages")
      .select("id, network, size, price, dealer_price")
      .eq("is_available", true)
    if (error || !Array.isArray(data)) return null
    // Network filter in code, case-insensitive, to match findPackage.
    const want = dbNetwork?.toLowerCase()
    const filtered = (data as Array<Record<string, unknown>>).filter(
      (r) => !want || String(r.network).toLowerCase() === want
    )
    const rows: PackageRow[] = filtered.map((r) => ({
      id: String(r.id),
      network: String(r.network),
      size: String(r.size),
      price: Number(r.price),
      dealer_price: r.dealer_price === null || r.dealer_price === undefined ? null : Number(r.dealer_price),
    }))
    return rows.sort((a, b) => {
      if (a.network !== b.network) return a.network < b.network ? -1 : 1
      const d = sizeKey(a.size) - sizeKey(b.size)
      if (d !== 0 && !Number.isNaN(d)) return d
      return a.size < b.size ? -1 : a.size > b.size ? 1 : 0
    })
  } catch {
    return null
  }
}

/**
 * Ledger description for the wallet debit. Deliberately carries no recipient
 * phone number: only network, size and the caller's reference.
 */
export function purchaseDescription(network: string, gb: number, reference: string): string {
  return `API data purchase: ${network} ${gb}GB (ref ${reference})`
}
