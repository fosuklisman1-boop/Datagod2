import { describe, expect, it } from "vitest"
import { aiTools } from "@/lib/ai-tools"
import { adminBackgroundTools, withoutPrepareTools } from "@/lib/ai-scheduled/tools"

// Pins the ordered tool NAMES offered per AI context, captured from the hand-maintained arrays BEFORE the registry refactor.
// Literal on purpose (no auto-snapshot file): changing a tool list must be a deliberate edit to this file.
const names = (tools: { name: string }[]) => tools.map((t) => t.name)

const EXPECTED = {
  home: ["get_available_packages", "search_order_status", "get_subscription_plans", "get_knowledge_base", "show_action_buttons"],
  dashboard: ["get_available_packages", "search_order_status", "get_wallet_balance", "get_wallet_transactions", "get_order_history", "get_my_sales", "prepare_wallet_order", "get_subscription", "get_subscription_plans", "get_my_shop", "manage_my_ussd_shop", "schedule_task", "notify_self", "get_knowledge_base", "show_action_buttons"],
  admin: ["get_available_packages", "get_all_orders", "update_order_status", "prepare_bulk_status_update", "retry_failed_order", "list_users", "get_user_info", "prepare_user_suspension", "prepare_role_change", "prepare_wallet_adjustment", "list_shops", "manage_shop", "list_withdrawals", "prepare_withdrawal_action", "manage_ussd_shop", "manage_packages", "manage_blacklist", "bulk_blacklist", "list_pending_fulfillment", "manual_fulfill_order", "bulk_manual_fulfill", "sync_fulfillment_status", "retry_blacklisted_order", "toggle_ordering", "toggle_auto_fulfillment", "toggle_mtn_auto_fulfillment", "toggle_afa_auto_fulfillment", "set_mtn_provider", "get_mtn_balance", "manage_rate_limits", "get_admin_stats", "manage_subscription_plans", "manage_scheduled_task", "send_notification", "get_knowledge_base", "show_action_buttons"],
  whatsapp: ["get_available_packages", "search_order_status", "get_wallet_balance", "get_order_history", "get_knowledge_base", "start_ordering_bot", "place_whatsapp_order", "request_human_handoff", "file_complaint", "reverify_payment", "start_account_verification", "verify_account_code"],
  whatsapp_shop: ["resolve_shop_code", "get_shop_packages", "place_shop_order"],
} as const

// key = sellsData/sellsAirtime/sellsResultsChecker
const STOREFRONT: Record<string, string[]> = {
  "true/true/true": ["get_available_packages", "prepare_checkout", "search_order_status", "get_airtime_availability", "get_results_checker_availability", "get_knowledge_base", "show_action_buttons"],
  "true/true/false": ["get_available_packages", "prepare_checkout", "search_order_status", "get_airtime_availability", "get_knowledge_base", "show_action_buttons"],
  "true/false/true": ["get_available_packages", "prepare_checkout", "search_order_status", "get_results_checker_availability", "get_knowledge_base", "show_action_buttons"],
  "true/false/false": ["get_available_packages", "prepare_checkout", "search_order_status", "get_knowledge_base", "show_action_buttons"],
  "false/true/true": ["search_order_status", "get_airtime_availability", "get_results_checker_availability", "get_knowledge_base", "show_action_buttons"],
  "false/true/false": ["search_order_status", "get_airtime_availability", "get_knowledge_base", "show_action_buttons"],
  "false/false/true": ["get_results_checker_availability", "get_knowledge_base", "show_action_buttons"],
  "false/false/false": ["get_knowledge_base", "show_action_buttons"],
}

const BG_DASHBOARD = ["get_available_packages", "search_order_status", "get_wallet_balance", "get_wallet_transactions", "get_order_history", "get_my_sales", "get_subscription", "get_subscription_plans", "get_my_shop", "manage_my_ussd_shop", "schedule_task", "notify_self", "get_knowledge_base", "show_action_buttons"]
const BG_ADMIN = ["get_available_packages", "get_all_orders", "update_order_status", "prepare_bulk_status_update", "retry_failed_order", "list_users", "get_user_info", "prepare_user_suspension", "prepare_role_change", "prepare_wallet_adjustment", "list_shops", "manage_shop", "list_withdrawals", "prepare_withdrawal_action", "manage_ussd_shop", "manage_packages", "manage_blacklist", "bulk_blacklist", "list_pending_fulfillment", "manual_fulfill_order", "bulk_manual_fulfill", "sync_fulfillment_status", "retry_blacklisted_order", "toggle_ordering", "toggle_auto_fulfillment", "toggle_mtn_auto_fulfillment", "toggle_afa_auto_fulfillment", "set_mtn_provider", "get_mtn_balance", "manage_rate_limits", "get_admin_stats", "manage_subscription_plans", "manage_scheduled_task", "send_notification", "get_knowledge_base", "show_action_buttons"]

// Admin list with the catalog switch ON: today's admin list minus every ops/money/account tool, plus the three catalog tools.
const ADMIN_CATALOG_ON = ["get_available_packages", "get_all_orders", "prepare_bulk_status_update", "list_users", "get_user_info", "prepare_user_suspension", "prepare_role_change", "prepare_wallet_adjustment", "list_shops", "list_withdrawals", "prepare_withdrawal_action", "list_pending_fulfillment", "get_mtn_balance", "get_admin_stats", "find_admin_actions", "admin_lookup", "prepare_admin_change", "get_knowledge_base", "show_action_buttons"]

describe("admin tool list with the catalog switch on", () => {
  it("adminCatalogOn", () => {
    expect(names(aiTools("admin", undefined, true))).toEqual(ADMIN_CATALOG_ON)
  })
  it("the cron background filter drops every catalog tool", () => {
    const bg = names(adminBackgroundTools(aiTools("admin", undefined, true)))
    for (const n of ["find_admin_actions", "admin_lookup", "prepare_admin_change"]) expect(bg).not.toContain(n)
  })
})

describe("tool lists are pinned", () => {
  for (const ctx of ["home", "dashboard", "admin", "whatsapp", "whatsapp_shop"] as const) {
    it(ctx, () => expect(names(aiTools(ctx))).toEqual([...EXPECTED[ctx]]))
  }
  for (const [key, expected] of Object.entries(STOREFRONT)) {
    it("storefront " + key, () => {
      const [d, a, r] = key.split("/").map((x) => x === "true")
      expect(names(aiTools("storefront", { sellsData: d, sellsAirtime: a, sellsResultsChecker: r }))).toEqual(expected)
    })
  }
  it("storefront with no flags keeps every tool", () => {
    expect(names(aiTools("storefront"))).toEqual(STOREFRONT["true/true/true"])
  })
  it("background filters", () => {
    expect(names(withoutPrepareTools(aiTools("dashboard")))).toEqual(BG_DASHBOARD)
    expect(names(adminBackgroundTools(aiTools("admin")))).toEqual(BG_ADMIN)
  })
})
