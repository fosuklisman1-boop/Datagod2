// The one pure access rule (design section 9). A per-person grant satisfies both the allowed-role
// check and the account.api capability check; it never overrides disabled, suspended or SMS access.

/** May this person use the API? Grant OR their role is in the allowed list. */
export function isEligible(i: { hasGrant: boolean; role: string; allowedRoles: string[] }): boolean {
  return i.hasGrant || i.allowedRoles.includes(i.role)
}

/** May this person create a key? Eligible, and (grant OR the account.api capability). */
export function canRequestKey(i: {
  hasGrant: boolean
  role: string
  allowedRoles: string[]
  hasApiCapability: boolean
}): boolean {
  return isEligible(i) && (i.hasGrant || i.hasApiCapability)
}
