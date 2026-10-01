export interface ToggleablePage {
  key: string
  label: string
  group: "auth" | "core" | "tools"
  // Present only for entries with one or more dedicated routes — drives
  // uniform middleware blocking + nav filtering (see getServiceRedirect /
  // isPathAllowedForService in lib/custom-domains.ts). Absent for the 3
  // entries gated at a specific render site instead of a whole route. An
  // array (not a single string) so one key can bundle sibling routes as
  // one unit — e.g. my_shop's 7 pages all hide/show together.
  paths?: string[]
}

export const TOGGLEABLE_PAGES: ToggleablePage[] = [
  { key: "landing_page",   label: "Landing Page",        group: "auth" },
  { key: "guest_purchase", label: "Buy as Guest Button",  group: "auth" },
  { key: "join_channel",   label: "Join Channel Button",  group: "auth" },

  { key: "dashboard_home", label: "Dashboard Home",  group: "core", paths: ["/dashboard"] },
  { key: "my_orders",      label: "My Orders",       group: "core", paths: ["/dashboard/my-orders"] },
  { key: "transactions",   label: "Transactions",    group: "core", paths: ["/dashboard/transactions"] },
  { key: "profile",        label: "Profile",         group: "core", paths: ["/dashboard/profile"] },
  { key: "complaints",     label: "My Complaints",   group: "core", paths: ["/dashboard/complaints"] },
  { key: "wallet",         label: "Wallet & Top-Up", group: "core", paths: ["/dashboard/wallet"] },

  { key: "developer",          label: "Developer / API",        group: "tools", paths: ["/dashboard/developer"] },
  { key: "afa_orders",         label: "AFA Registration",       group: "tools", paths: ["/dashboard/afa-orders"] },
  { key: "upgrade",            label: "Upgrade / Dealer Plans", group: "tools", paths: ["/dashboard/upgrade"] },
  { key: "my_shop",            label: "My Shop",                group: "tools", paths: [
    "/dashboard/my-shop", "/dashboard/shop-orders", "/dashboard/customers",
    "/dashboard/shop-profit-logs", "/dashboard/shop-pricing",
    "/dashboard/shop-withdraw", "/dashboard/shop-profile",
  ] },
  { key: "shop_dashboard",     label: "Shop Dashboard",         group: "tools", paths: ["/dashboard/shop-dashboard"] },
  { key: "sub_agents",         label: "Sub-Agents",             group: "tools", paths: ["/dashboard/sub-agents"] },
  { key: "sub_agent_catalog",  label: "Sub-Agent Catalog",      group: "tools", paths: ["/dashboard/sub-agent-catalog"] },
  { key: "ussd_shop",          label: "USSD Shop",              group: "tools", paths: ["/dashboard/ussd-shop"] },
  { key: "payment_reverify",   label: "Payment Re-verify",      group: "tools", paths: ["/dashboard/payment-reverify"] },
  { key: "buy_stock",          label: "Buy Stock",              group: "tools", paths: ["/dashboard/buy-stock"] },
]
