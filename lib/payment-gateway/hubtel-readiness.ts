// Hubtel collection readiness. Returns env var NAMES only, never values.

const REQUIRED_ENV = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_PAYMENTS_CALLBACK_SECRET"] as const

// Plan 4 flips this to a real check once Hubtel collections are implemented.
export function isHubtelCollectionReady(): boolean {
  return false
}

export function hubtelReadinessReport(): { ready: boolean; missing: string[] } {
  const missing: string[] = REQUIRED_ENV.filter((name) => !process.env[name])
  const ready = isHubtelCollectionReady()
  if (!ready) missing.push("collections not enabled yet")
  return { ready, missing }
}
