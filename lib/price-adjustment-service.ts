import { supabase } from "./supabase"

interface PriceAdjustments {
  price_adjustment_mtn: number
  price_adjustment_telecel: number
  price_adjustment_at_ishare: number
  price_adjustment_at_bigtime: number
}

interface Package {
  id: string
  network: string
  size: string
  price: number
  description?: string
  is_available?: boolean
  active?: boolean
  created_at?: string
}

// Cache for price adjustments to avoid repeated fetches
let cachedAdjustments: PriceAdjustments | null = null
let cacheTimestamp: number = 0
const CACHE_DURATION_MS = 60000 // 1 minute cache

/**
 * Get price adjustments from app_settings
 * Uses caching to minimize database calls
 */
export async function getPriceAdjustments(): Promise<PriceAdjustments> {
  const now = Date.now()
  
  // Return cached data if still valid
  if (cachedAdjustments && (now - cacheTimestamp) < CACHE_DURATION_MS) {
    return cachedAdjustments
  }

  try {
    const { data, error } = await supabase
      .from("app_settings")
      .select("price_adjustment_mtn, price_adjustment_telecel, price_adjustment_at_ishare, price_adjustment_at_bigtime")
      .single()

    if (error || !data) {
      console.warn("[PRICE-ADJUST] No app_settings found, using defaults")
      return {
        price_adjustment_mtn: 0,
        price_adjustment_telecel: 0,
        price_adjustment_at_ishare: 0,
        price_adjustment_at_bigtime: 0
      }
    }

    cachedAdjustments = {
      price_adjustment_mtn: data.price_adjustment_mtn || 0,
      price_adjustment_telecel: data.price_adjustment_telecel || 0,
      price_adjustment_at_ishare: data.price_adjustment_at_ishare || 0,
      price_adjustment_at_bigtime: data.price_adjustment_at_bigtime || 0
    }
    cacheTimestamp = now

    return cachedAdjustments
  } catch (error) {
    console.error("[PRICE-ADJUST] Error fetching price adjustments:", error)
    return {
      price_adjustment_mtn: 0,
      price_adjustment_telecel: 0,
      price_adjustment_at_ishare: 0,
      price_adjustment_at_bigtime: 0
    }
  }
}

/**
 * Clear the price adjustments cache
 * Call this when admin updates settings
 */
export function clearPriceAdjustmentCache(): void {
  cachedAdjustments = null
  cacheTimestamp = 0
}

/**
 * Get the adjustment percentage for a specific network
 */
export function getAdjustmentForNetwork(network: string, adjustments: PriceAdjustments): number {
  const networkLower = network.toLowerCase()
  
  if (networkLower.includes("mtn")) {
    return adjustments.price_adjustment_mtn
  } else if (networkLower.includes("telecel") || networkLower.includes("vodafone")) {
    return adjustments.price_adjustment_telecel
  } else if (networkLower.includes("bigtime") || networkLower.includes("big time")) {
    return adjustments.price_adjustment_at_bigtime
  } else if (networkLower.includes("at") || networkLower.includes("airtel") || networkLower.includes("ishare") || networkLower.includes("i-share")) {
    return adjustments.price_adjustment_at_ishare
  }
  
  return 0 // No adjustment for unknown networks
}

/**
 * Apply price adjustment to a single price
 * Rounds to nearest 0.01 (2 decimal places)
 */
export function applyPriceAdjustment(price: number, adjustmentPercentage: number): number {
  if (adjustmentPercentage === 0) return price
  
  const adjustedPrice = price * (1 + adjustmentPercentage / 100)
  return Math.round(adjustedPrice * 100) / 100 // Round to nearest 0.01
}

/**
 * Apply price adjustments to an array of packages
 * Returns new array with adjusted prices
 */
export async function applyPriceAdjustmentsToPackages<T extends { network: string; price: number }>(
  packages: T[]
): Promise<T[]> {
  const adjustments = await getPriceAdjustments()
  
  return packages.map(pkg => {
    const adjustmentPercentage = getAdjustmentForNetwork(pkg.network, adjustments)
    return {
      ...pkg,
      price: applyPriceAdjustment(pkg.price, adjustmentPercentage)
    }
  })
}

/**
 * Fetch all available packages with price adjustments applied
 */
export async function getPackagesWithAdjustments(): Promise<Package[]> {
  const { data, error } = await supabase
    .from("packages")
    .select("*")
    .eq("is_available", true)
    .order("network")
    .order("size")

  if (error) {
    console.error("[PRICE-ADJUST] Error fetching packages:", error)
    throw error
  }

  if (!data || data.length === 0) {
    return []
  }

  return applyPriceAdjustmentsToPackages(data)
}

/**
 * Fetch packages by network with price adjustments applied
 */
export async function getPackagesByNetworkWithAdjustments(network: string): Promise<Package[]> {
  const { data, error } = await supabase
    .from("packages")
    .select("*")
    .eq("network", network)
    .eq("is_available", true)
    .order("size")

  if (error) {
    console.error("[PRICE-ADJUST] Error fetching packages for network:", error)
    throw error
  }

  if (!data || data.length === 0) {
    return []
  }

  return applyPriceAdjustmentsToPackages(data)
}
