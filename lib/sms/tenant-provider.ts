import { getRoutingConfig } from "./routing"
import { resolveSendProvider } from "./provider-pick"

/** Whether tenants may pick a provider per send. Fails closed (false) on any error. */
export async function isTenantProviderChoiceEnabled(): Promise<boolean> {
  try {
    return (await getRoutingConfig()).tenantProviderChoice === true
  } catch {
    return false
  }
}

/**
 * Provider override for a tenant-facing send. Only reads routing config when a valid provider
 * was actually requested, so a request without one behaves (and costs) exactly as before.
 */
export async function resolveTenantSendProvider(requested: unknown): Promise<"moolre" | "hubtel" | undefined> {
  if (requested !== "moolre" && requested !== "hubtel") return undefined
  return resolveSendProvider({ requested, isAdmin: false, tenantChoiceEnabled: await isTenantProviderChoiceEnabled() })
}
