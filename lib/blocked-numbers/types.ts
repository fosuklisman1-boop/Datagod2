/**
 * Shared types for blocked MTN number tracking.
 * BLOCK_SURFACES must equal the surface CHECK list in migrations/0182_mtn_blocked_numbers.sql
 * (settings.test.ts enforces this).
 */

export const BLOCK_SURFACES = [
  "storefront",
  "storefront_preview",
  "dashboard",
  "dashboard_preview",
  "dashboard_bulk",
  "dashboard_bulk_preview",
  "api_v1",
  "api_v2",
  "ussd_hubtel",
  "ussd_hubtel_shop",
  "ussd_uzo",
  "ussd_uzo_shop",
  "whatsapp_shop",
  "whatsapp_ai",
  "text_to_buy",
  "text_to_buy_airtime",
  "unknown",
] as const

export type BlockSurface = (typeof BLOCK_SURFACES)[number]

export const PREVIEW_SURFACES: readonly BlockSurface[] = [
  "storefront_preview",
  "dashboard_preview",
  "dashboard_bulk_preview",
]

export const DEALER_SURFACES: readonly BlockSurface[] = [
  "dashboard",
  "dashboard_preview",
  "dashboard_bulk",
  "dashboard_bulk_preview",
  "api_v1",
  "api_v2",
]

/** Surfaces where the buyer is a customer reachable by SMS. */
export const SMS_SURFACES: readonly BlockSurface[] = [
  "storefront",
  "storefront_preview",
  "ussd_hubtel",
  "ussd_hubtel_shop",
  "ussd_uzo",
  "ussd_uzo_shop",
  "whatsapp_shop",
  "whatsapp_ai",
  "text_to_buy",
  "text_to_buy_airtime",
]

export type BlockContext = {
  surface: BlockSurface
  shopId?: string | null
  userId?: string | null
  purchaserPhone?: string | null
  product?: string | null
  amount?: number | null
}

/**
 * Allowlist: surfaces whose purchaserPhone comes from a server-verified source (carrier-supplied dialler number,
 * Meta-supplied WhatsApp sender, SMS-forwarder sender). Every other surface drops it (fails closed).
 */
export const TRUSTED_PURCHASER_SURFACES: readonly BlockSurface[] = [
  "ussd_hubtel",
  "ussd_hubtel_shop",
  "ussd_uzo",
  "ussd_uzo_shop",
  "whatsapp_shop",
  "whatsapp_ai",
  "text_to_buy",
  "text_to_buy_airtime",
]
