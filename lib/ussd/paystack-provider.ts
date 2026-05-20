/**
 * Derives the Paystack mobile-money provider from the dialing phone number.
 * The dialing phone is always the payer, so this must be based on the payer's
 * network — not the data bundle network they selected for the recipient.
 */
export function paystackProviderFromPhone(phone: string): 'mtn' | 'vod' | 'tgo' | null {
  const local = phone.startsWith('+233')
    ? '0' + phone.slice(4)
    : phone.startsWith('233')
      ? '0' + phone.slice(3)
      : phone

  const prefix = local.slice(0, 3)

  if (['024', '054', '025', '059', '053', '055'].includes(prefix)) return 'mtn'
  if (['020', '050'].includes(prefix)) return 'vod'
  if (['027', '057', '026', '056'].includes(prefix)) return 'tgo'

  return null
}
