// Hubtel collection readiness. Returns env var NAMES only, never values.
//
// Nothing goes to Hubtel until the owner sets HUBTEL_COLLECTIONS_ENABLED to exactly "true" and every other variable
// is present. Until then the admin page can't select Hubtel and every wired surface stays on Paystack.

const REQUIRED_ENV = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_PAYMENTS_CALLBACK_SECRET"] as const
const ENABLE_SWITCH = "HUBTEL_COLLECTIONS_ENABLED"

export function hubtelReadinessReport(): { ready: boolean; missing: string[] } {
  const missing: string[] = REQUIRED_ENV.filter((name) => !process.env[name])
  if (process.env[ENABLE_SWITCH] !== "true") missing.push(ENABLE_SWITCH)
  return { ready: missing.length === 0, missing }
}

export function isHubtelCollectionReady(): boolean {
  return hubtelReadinessReport().ready
}
