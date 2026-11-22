import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {}, supabase: {} }))

import { getProviderOptionsForNetwork } from "./supplier-capability"
import { isValidMtnProviderName, isProviderCapableForNetwork } from "@/lib/mtn-providers/factory"
import { normalizeNetworkKey } from "@/lib/non-mtn-fulfillment"
import { BULK_SEND_NETWORKS } from "./enqueue"

// The enqueue route accepts an explicit supplier only when getProviderOptionsForNetwork offers it.
// If the fulfilment code then refused that name it would SILENTLY re-route to the admin default
// (createMTNOrder: invalid override -> default; createNonMTNOrder: not capable -> default).
// These tests pin the two lists together so an admin's pick is always the supplier actually called.
describe("supplier lists agree with the fulfilment code (no silent re-route of an explicit pick)", () => {
  it("every MTN option is a valid MTN provider override", () => {
    for (const o of getProviderOptionsForNetwork("MTN")) expect(isValidMtnProviderName(o.value), o.value).toBe(true)
  })

  it("every non-MTN option is capable for its network in the factory", () => {
    for (const n of BULK_SEND_NETWORKS.filter((n) => n !== "MTN")) {
      for (const o of getProviderOptionsForNetwork(n)) {
        expect(isProviderCapableForNetwork(normalizeNetworkKey(n), o.value as any), `${o.value} @ ${n}`).toBe(true)
      }
    }
  })
})
