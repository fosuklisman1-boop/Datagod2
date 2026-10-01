export interface ToggleablePage {
  key: string
  label: string
  group: "auth" | "dashboard"
  // Present only for entries with a dedicated route — drives uniform
  // middleware blocking + nav filtering (see getServiceRedirect /
  // isPathAllowedForService in lib/custom-domains.ts). Absent for the 3
  // entries gated at a specific render site instead of a whole route.
  path?: string
}

export const TOGGLEABLE_PAGES: ToggleablePage[] = [
  { key: "landing_page",   label: "Landing Page",       group: "auth" },
  { key: "guest_purchase", label: "Buy as Guest Button", group: "auth" },
  { key: "join_channel",   label: "Join Channel Button", group: "auth" },
  { key: "wallet",             label: "Wallet & Top-Up",        group: "dashboard", path: "/dashboard/wallet" },
  { key: "afa_orders",         label: "AFA Registration",       group: "dashboard", path: "/dashboard/afa-orders" },
  { key: "upgrade",            label: "Upgrade / Dealer Plans", group: "dashboard", path: "/dashboard/upgrade" },
  { key: "my_shop",            label: "My Shop",                group: "dashboard", path: "/dashboard/my-shop" },
  { key: "shop_dashboard",     label: "Shop Dashboard",         group: "dashboard", path: "/dashboard/shop-dashboard" },
  { key: "sub_agents",         label: "Sub-Agents",             group: "dashboard", path: "/dashboard/sub-agents" },
  { key: "sub_agent_catalog",  label: "Sub-Agent Catalog",      group: "dashboard", path: "/dashboard/sub-agent-catalog" },
  { key: "ussd_shop",          label: "USSD Shop",              group: "dashboard", path: "/dashboard/ussd-shop" },
  { key: "payment_reverify",   label: "Payment Re-verify",      group: "dashboard", path: "/dashboard/payment-reverify" },
  { key: "buy_stock",          label: "Buy Stock",              group: "dashboard", path: "/dashboard/buy-stock" },
]
