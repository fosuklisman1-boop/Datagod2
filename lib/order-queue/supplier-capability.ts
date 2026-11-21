export type SupplierOption = { value: string; label: string }

// Moved unchanged from app/admin/order-payment-status/page.tsx.
// Mirrors lib/mtn-providers/factory.ts's provider-capability rules: MTN accepts all 9
// providers; non-MTN (Telecel/AT-iShare/AT-BigTime) accepts only the non-MTN-capable
// ones, with agentportalgh/apexprime further excluded from AT-BigTime specifically
// (business decision — neither provider's API distinguishes AT-iShare from AT-BigTime,
// so this exclusion is enforced here rather than by the provider itself), spfastit
// offered only for AT-iShare (it's AirtelTigo-only — not capable for Telecel or MTN,
// per NON_MTN_CAPABLE.at_ishare_provider_selection in factory.ts), spfastit_telecel
// offered only for plain Telecel (a separate account/API from spfastit, Telecel-only —
// per NON_MTN_CAPABLE.telecel_provider_selection in factory.ts), and bundleportal
// offered on every branch, including AT-BigTime — it's a full member capable on all
// networks (see NON_MTN_CAPABLE.at_bigtime_provider_selection in factory.ts).
export function getProviderOptionsForNetwork(network: string): SupplierOption[] {
  const upper = (network || "").toUpperCase()
  const isMTN = upper === "MTN"
  if (isMTN) {
    return [
      { value: "xpress", label: "Xpress" },
      { value: "codecraft", label: "Codecraft" },
      { value: "sykes", label: "Sykes" },
      { value: "datakazina", label: "Datakazina" },
      { value: "eazyghdata", label: "EazyGhData" },
      { value: "bisdel", label: "Bisdel" },
      { value: "agentportalgh", label: "AgentPortalGH" },
      { value: "apexprime", label: "Apex Prime" },
      { value: "bundleportal", label: "Bundle Portal" },
      { value: "kuntanii", label: "Kuntanii" },
      { value: "hubnet", label: "Hubnet" },
    ]
  }
  const isBigTime = upper.includes("BIGTIME") || upper.includes("BIG TIME")
  const isIshare = upper.includes("ISHARE")
  return [
    { value: "xpress", label: "Xpress" },
    { value: "codecraft", label: "Codecraft" },
    { value: "datakazina", label: "Datakazina" },
    { value: "eazyghdata", label: "EazyGhData" },
    ...(isBigTime ? [] : [{ value: "agentportalgh", label: "AgentPortalGH" }, { value: "apexprime", label: "Apex Prime" }]),
    ...(isIshare ? [{ value: "spfastit", label: "SPFastIT" }] : []),
    ...(isBigTime || isIshare ? [] : [{ value: "spfastit_telecel", label: "SPFastIT (Telecel)" }]),
    { value: "bundleportal", label: "Bundle Portal" },
    { value: "hubnet", label: "Hubnet" },
  ]
}

const KNOWN_NETWORKS = ["MTN", "Telecel", "AT - iShare", "AT - BigTime"]

/** Every supplier that serves at least one network, once each (for the "Last supplier" filter). */
export function allSuppliers(): SupplierOption[] {
  const seen = new Map<string, SupplierOption>()
  for (const n of KNOWN_NETWORKS) {
    for (const o of getProviderOptionsForNetwork(n)) if (!seen.has(o.value)) seen.set(o.value, o)
  }
  return [...seen.values()]
}

/** Suppliers that can serve EVERY given network (intersection), in the first network's order. */
export function suppliersForNetworks(networks: string[]): SupplierOption[] {
  if (networks.length === 0) return []
  const [first, ...rest] = networks
  const restSets = rest.map((n) => new Set(getProviderOptionsForNetwork(n).map((o) => o.value)))
  return getProviderOptionsForNetwork(first).filter((o) => restSets.every((s) => s.has(o.value)))
}
