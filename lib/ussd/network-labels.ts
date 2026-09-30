//
// Shared network-nickname map for the "Browse Services" rebrand — both the
// main USSD (lib/ussd) and the shop USSD (lib/ussd-shop) show customers a
// nickname instead of the raw carrier/packages.network value, so the mapping
// lives in exactly one place and the two channels can never drift apart.

export const NETWORK_NICKNAMES: Record<string, string> = {
  'MTN': 'Yellow Plans',
  'Telecel': 'Tele',
  'AT-iShare': 'Instant Blue',
  'AT-BigTime': 'Delay Blue',
}

/**
 * Returns the customer-facing nickname for a packages.network value, or the
 * raw value itself if it has no nickname (e.g. a legacy generic "AirtelTigo"
 * row still present in some shop's stocked-network list) — never throws, and
 * never hides a network the caller can otherwise sell.
 */
export function networkNickname(network: string): string {
  return NETWORK_NICKNAMES[network] ?? network
}
