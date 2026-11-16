import type { MomoClaimCtx } from "./contexts"
import { alertAdminsOfRequest } from "./index"

export type MomoAdminAlert = MomoClaimCtx

/** Push + email every admin about a Send & Claim event. Never throws: a failed alert must not fail the webhook. */
export async function notifyMomoAdmins(alert: MomoAdminAlert): Promise<void> {
  try {
    await alertAdminsOfRequest("momo_claim", alert)
  } catch {
    // swallowed on purpose
  }
}
