// Typed wrappers around the Datagod backend, mirroring the web dashboard's
// request/response shapes exactly (see app/dashboard/* in the web app).
import { apiFetch } from "./api"
import { supabase } from "./supabase"

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletBalance {
  balance: number
  totalCredited: number
  totalDebited: number
}

export interface WalletTransaction {
  id: string
  type: string // credit | debit
  source?: string
  amount: number
  description?: string
  status?: string
  created_at: string
}

export interface DataPackage {
  id: string
  network: string
  size: string
  price: number
  dealer_price?: number | null
  is_available?: boolean
}

export interface Order {
  id: string
  network?: string
  size?: string
  phone_number?: string
  status?: string
  order_status?: string
  price?: number
  created_at: string
  reference_code?: string
}

// ── Wallet ────────────────────────────────────────────────────────────────────

export function getWalletBalance() {
  return apiFetch<WalletBalance>("/api/wallet/balance")
}

export async function getTransactions(page = 1, limit = 20): Promise<WalletTransaction[]> {
  const data = await apiFetch<any>(`/api/wallet/transactions?page=${page}&limit=${limit}`)
  return data.transactions ?? data.data ?? []
}

// Top-up via hosted Paystack checkout: returns the URL to open in a browser.
export function initializeTopup(amount: number, email: string, userId: string) {
  return apiFetch<{ authorizationUrl: string; reference: string }>(
    "/api/payments/initialize",
    { method: "POST", body: JSON.stringify({ amount, email, userId }) },
  )
}

export function verifyPayment(reference: string) {
  return apiFetch<{ status: string; amount?: number; message?: string }>(
    "/api/payments/verify",
    { method: "POST", body: JSON.stringify({ reference }) },
  )
}

// ── Packages & orders ─────────────────────────────────────────────────────────

// Same source as the web dashboard: anon-readable packages table, with
// dealer_price substituted for dealers.
export async function listPackages(): Promise<DataPackage[]> {
  const { data: auth } = await supabase.auth.getUser()
  let role = "user"
  if (auth.user) {
    const { data: userRow } = await supabase
      .from("users")
      .select("role")
      .eq("id", auth.user.id)
      .single()
    role = userRow?.role || "user"
  }

  const { data, error } = await supabase
    .from("packages")
    .select("*, dealer_price")
    .eq("is_available", true)
    .order("network, size")
  if (error) throw error

  let pkgs = (data ?? []) as DataPackage[]
  if (role === "dealer") {
    pkgs = pkgs.map((p) => ({
      ...p,
      price: p.dealer_price && p.dealer_price > 0 ? p.dealer_price : p.price,
    }))
  }
  return pkgs
}

export function purchaseData(pkg: DataPackage, phoneNumber: string) {
  return apiFetch<{ newBalance: number }>("/api/orders/purchase", {
    method: "POST",
    body: JSON.stringify({
      packageId: pkg.id,
      network: pkg.network,
      size: pkg.size,
      price: pkg.price,
      phoneNumber,
    }),
  })
}

export async function getOrders(page = 1, limit = 20): Promise<Order[]> {
  const data = await apiFetch<{ orders: Order[] }>(`/api/orders/list?page=${page}&limit=${limit}`)
  return data.orders ?? []
}

// ── Airtime ───────────────────────────────────────────────────────────────────

// Wallet-paid airtime (paySeparately=false is the server default).
export function purchaseAirtime(network: string, beneficiaryPhone: string, airtimeAmount: number) {
  return apiFetch<{ newBalance?: number; success?: boolean }>("/api/airtime/purchase", {
    method: "POST",
    body: JSON.stringify({ network, beneficiaryPhone, airtimeAmount }),
  })
}
