// lib/roles/capabilities.ts
// Pure capability registry and rights rules for custom roles. Keep ALL_CAPABILITIES in step with the
// role_permissions seed in migrations/0187_roles_hub.sql (a test compares them).
import type { RoleRow } from "./ladder"
import type { NavItem } from "../dashboard-nav-items"

export type CapabilityGroupId = "buy" | "shop" | "account"

export type Capability =
  | "buy.data" | "buy.airtime" | "buy.afa" | "buy.bills" | "buy.results"
  | "shop.storefront" | "shop.subagents" | "shop.bots" | "shop.sms" | "shop.text_orders"
  | "account.wallet" | "account.api" | "account.leaderboard" | "account.upgrade"

export const CAPABILITY_GROUPS: readonly { id: CapabilityGroupId; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "shop", label: "Shop" },
  { id: "account", label: "Account" },
]

export const CAPABILITIES: readonly { key: Capability; group: CapabilityGroupId; label: string; hint?: string }[] = [
  { key: "buy.data", group: "buy", label: "Buy data bundles" },
  { key: "buy.airtime", group: "buy", label: "Buy airtime" },
  { key: "buy.afa", group: "buy", label: "AFA registration orders" },
  { key: "buy.bills", group: "buy", label: "Pay utility bills and broadband" },
  { key: "buy.results", group: "buy", label: "Results checkers" },
  { key: "shop.storefront", group: "shop", label: "Run a storefront" },
  { key: "shop.subagents", group: "shop", label: "Manage sub-agents" },
  { key: "shop.bots", group: "shop", label: "USSD and WhatsApp bot" },
  { key: "shop.sms", group: "shop", label: "Bulk SMS" },
  { key: "shop.text_orders", group: "shop", label: "Text-to-buy orders" },
  { key: "account.wallet", group: "account", label: "Wallet", hint: "Most purchases are paid from the wallet." },
  { key: "account.api", group: "account", label: "Developer API" },
  { key: "account.leaderboard", group: "account", label: "Leaderboard" },
  { key: "account.upgrade", group: "account", label: "Upgrade to dealer" },
]

export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES.map((c) => c.key)

const CAPABILITY_SET: ReadonlySet<string> = new Set(ALL_CAPABILITIES)

export function isCapability(x: unknown): x is Capability {
  return typeof x === "string" && CAPABILITY_SET.has(x)
}

export type RoleRights =
  | { kind: "all" }
  | { kind: "sub_agent" }
  | { kind: "set"; caps: ReadonlySet<Capability> }

const EMPTY: ReadonlySet<Capability> = new Set()

/** Rights for a role slug. null slug is "user"; unknown or archived roles get the empty set. */
export function rightsFor(
  slug: string | null,
  roles: readonly RoleRow[],
  perms: ReadonlyMap<string, ReadonlySet<Capability>>,
): RoleRights {
  const s = slug ?? "user"
  if (s === "admin") return { kind: "all" }
  if (s === "sub_agent") return { kind: "sub_agent" }
  const row = roles.find((r) => r.slug === s)
  if (!row || row.archived_at) return { kind: "set", caps: EMPTY }
  return { kind: "set", caps: perms.get(row.id) ?? EMPTY }
}

/** Server never newly blocks admin or sub_agent; a set must contain the capability. */
export function canWith(rights: RoleRights, cap: Capability): boolean {
  if (rights.kind === "all" || rights.kind === "sub_agent") return true
  return rights.caps.has(cap)
}

export function navVisible(item: NavItem, slug: string, rights: RoleRights): boolean {
  if (item.subAgentOnly) return slug === "sub_agent"
  if (slug === "sub_agent") return item.subAgent === true
  if (rights.kind === "all") return true
  if (!item.cap) return true
  return rights.kind === "set" && rights.caps.has(item.cap)
}
