// lib/sandbox.ts
//
// Shared helpers for the Developer API's sandbox (test-key) environment.
// A test key never touches real orders/airtime_orders/afa_orders/
// results_checker_orders, the real `wallets` table, or real provider
// dispatch. Everything here reads/writes only sandbox_wallets and
// sandbox_orders (both service-role-only, see migrations/20260929_api_sandbox_keys.sql).

import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const SANDBOX_STARTING_BALANCE = 100
// How long a simulated order stays "pending" before it's considered
// "completed". No cron needed -- status is derived at read time from
// `resolves_at` on both the placement response and the status-check route.
const SANDBOX_RESOLVE_DELAY_MS = 20_000

export type SandboxAction = "data_order" | "airtime" | "afa" | "results_checker"

export async function getSandboxBalance(userId: string): Promise<number> {
  const { data } = await supabase
    .from("sandbox_wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle()

  if (data) return Number(data.balance)

  // First touch -- create the wallet with the starting credit.
  const { data: created } = await supabase
    .from("sandbox_wallets")
    .insert({ user_id: userId, balance: SANDBOX_STARTING_BALANCE })
    .select("balance")
    .single()

  return created ? Number(created.balance) : SANDBOX_STARTING_BALANCE
}

export async function resetSandboxBalance(userId: string): Promise<number> {
  const { data } = await supabase
    .from("sandbox_wallets")
    .upsert({ user_id: userId, balance: SANDBOX_STARTING_BALANCE, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select("balance")
    .single()

  return data ? Number(data.balance) : SANDBOX_STARTING_BALANCE
}

export function deriveSandboxStatus(resolvesAt: string): "pending" | "completed" {
  return new Date(resolvesAt).getTime() <= Date.now() ? "completed" : "pending"
}

/**
 * Deducts `price` from the caller's test balance and inserts a sandbox_orders
 * row. Returns the same {success, error, status} shape the real v1 routes use
 * so each route's response-building code barely has to branch.
 */
export async function placeSandboxOrder(params: {
  userId: string
  apiKeyId: string
  action: SandboxAction
  reference: string
  request: Record<string, unknown>
  price: number
  orderFields: Record<string, unknown>
  /** Results-checker vouchers are issued synchronously in the real system --
   *  no pending window to simulate, so the row resolves immediately. */
  instant?: boolean
}): Promise<
  | { success: true; order: Record<string, unknown>; newBalance: number }
  | { success: false; error: string; status: number }
> {
  const balance = await getSandboxBalance(params.userId)
  if (balance < params.price) {
    return { success: false, error: "Insufficient test balance", status: 402 }
  }

  const resolvesAt = new Date(params.instant ? Date.now() : Date.now() + SANDBOX_RESOLVE_DELAY_MS).toISOString()
  const initialStatus = params.instant ? "completed" : "pending"
  const response = { ...params.orderFields, reference: params.reference, status: initialStatus }

  const { error: insertError } = await supabase.from("sandbox_orders").insert({
    user_id: params.userId,
    api_key_id: params.apiKeyId,
    action: params.action,
    reference: params.reference,
    request: params.request,
    response,
    price: params.price,
    resolves_at: resolvesAt,
  })

  if (insertError) {
    // 23505 = unique_violation on (user_id, reference)
    if (insertError.code === "23505") {
      return { success: false, error: "Duplicate reference", status: 409 }
    }
    return { success: false, error: "Failed to place sandbox order", status: 500 }
  }

  const newBalance = Number((balance - params.price).toFixed(2))
  await supabase.from("sandbox_wallets").update({ balance: newBalance, updated_at: new Date().toISOString() }).eq("user_id", params.userId)

  return {
    success: true,
    order: { ...params.orderFields, reference: params.reference, status: initialStatus, created_at: new Date().toISOString() },
    newBalance,
  }
}

export async function getSandboxOrder(userId: string, reference: string) {
  const { data } = await supabase
    .from("sandbox_orders")
    .select("reference, action, response, price, resolves_at, created_at")
    .eq("user_id", userId)
    .eq("reference", reference)
    .maybeSingle()

  if (!data) return null

  return {
    ...data,
    status: deriveSandboxStatus(data.resolves_at),
  }
}
