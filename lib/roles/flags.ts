/**
 * Stays false until Phase 2 has moved every price reader onto lib/roles (spec §6).
 * Flipping it earlier reprices custom-role owners' shops.
 */
export const CUSTOM_ROLE_ASSIGNMENT_ENABLED = false
