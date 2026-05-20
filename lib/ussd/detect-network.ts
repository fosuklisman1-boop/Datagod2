// Ghana MNC codes → network name and Paystack mobile money provider
// MCC for Ghana is 620; the `network` field from Uzo is the MNC portion only.

interface NetworkInfo {
  name: string
  paystackProvider: 'mtn' | 'vod' | 'atl'
}

const MNC_MAP: Record<string, NetworkInfo> = {
  '01': { name: 'MTN', paystackProvider: 'mtn' },
  '24': { name: 'MTN', paystackProvider: 'mtn' },
  '20': { name: 'Telecel', paystackProvider: 'vod' },
  '06': { name: 'AirtelTigo', paystackProvider: 'atl' },
  '27': { name: 'AirtelTigo', paystackProvider: 'atl' },
}

export function detectNetwork(mnc: string): NetworkInfo | null {
  return MNC_MAP[mnc] ?? null
}

// Detect Paystack provider from a Ghana phone number prefix (fallback when MNC is unknown)
const PREFIX_MAP: Record<string, 'mtn' | 'vod' | 'atl'> = {
  '024': 'mtn', '054': 'mtn', '055': 'mtn', '059': 'mtn',
  '025': 'mtn', '053': 'mtn', '056': 'mtn',
  '020': 'vod', '050': 'vod',
  '026': 'atl', '027': 'atl', '057': 'atl', '028': 'atl',
}

export function detectProviderFromPhone(phone: string): 'mtn' | 'vod' | 'atl' | null {
  // Normalise to local format (0XXXXXXXXX)
  let local = phone
  if (local.startsWith('+233')) local = '0' + local.slice(4)
  else if (local.startsWith('233')) local = '0' + local.slice(3)

  const prefix = local.slice(0, 3)
  return PREFIX_MAP[prefix] ?? null
}
