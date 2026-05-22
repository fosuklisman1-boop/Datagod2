import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type AIChatContext = "storefront" | "dashboard" | "admin" | "home"

// ─── Tool schemas ────────────────────────────────────────────────────────────

const getAvailablePackagesTool: Anthropic.Tool = {
  name: "get_available_packages",
  description: "Get available data packages. Pass network= to filter by a specific network (MTN, Telecel, AT) and keep results small. Results are sorted by size ascending.",
  input_schema: {
    type: "object" as const,
    properties: {
      network: {
        type: "string",
        description: "Optional: filter by network name e.g. MTN, Telecel, AT",
      },
    },
    required: [],
  },
}

const searchOrderStatusTool: Anthropic.Tool = {
  name: "search_order_status",
  description: "Check the status of an order by phone number, order ID (UUID), or reference code. Use when a customer asks about their order.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone_number: { type: "string", description: "The customer phone number to search orders for" },
      order_id: { type: "string", description: "A specific order UUID to look up directly" },
      reference_code: { type: "string", description: "A specific order reference code to look up directly" },
    },
    required: [],
  },
}

const prepareCheckoutTool: Anthropic.Tool = {
  name: "prepare_checkout",
  description: "Open the checkout/payment form pre-filled with a selected package. Use this when a customer has decided what to buy on the storefront. Use the 'id' field from get_available_packages as shop_package_id.",
  input_schema: {
    type: "object" as const,
    properties: {
      shop_package_id: {
        type: "string",
        description: "The 'id' value from get_available_packages for the package the customer chose",
      },
      network: { type: "string", description: "Network name e.g. MTN, Telecel, AT" },
      volume_gb: { type: "number", description: "Package size in GB (the 'size' field from get_available_packages)" },
      price: { type: "number", description: "Price in GHS (the 'price' field from get_available_packages)" },
    },
    required: ["shop_package_id", "network", "volume_gb", "price"],
  },
}

const getWalletBalanceTool: Anthropic.Tool = {
  name: "get_wallet_balance",
  description: "Get the current wallet balance for the logged-in user.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const getOrderHistoryTool: Anthropic.Tool = {
  name: "get_order_history",
  description: "Get the logged-in user's recent data bundle orders, or look up a single order by ID. For wallet transaction credits/debits use get_wallet_transactions. For a full filtered history use get_transaction_history.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "Look up a single specific order by its UUID instead of listing recent orders" },
      limit: { type: "number", description: "Number of recent orders to fetch (default 5, max 10)" },
    },
    required: [],
  },
}

const placeWalletOrderTool: Anthropic.Tool = {
  name: "place_wallet_order",
  description: "Place a data bundle order using the user's wallet balance. ALWAYS confirm the package and recipient phone number with the user before calling this.",
  input_schema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "Network name exactly as returned by get_available_packages e.g. MTN, Telecel, AT" },
      size: { type: "string", description: "Package size exactly as returned by get_available_packages e.g. 1, 2, 5, 10" },
      phone_number: { type: "string", description: "Recipient phone number for the data bundle" },
    },
    required: ["network", "size", "phone_number"],
  },
}

const getAllOrdersTool: Anthropic.Tool = {
  name: "get_all_orders",
  description: "Admin only: get platform-wide orders across all order types (wallet, shop, USSD, USSD-shop, API). Pass order_id to look up a single specific order across all tables. Results include a 'table' field and 'id' — both needed for update_order_status or manual_fulfill_order.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "Look up a single specific order by UUID across all order tables" },
      status: { type: "string", description: "Filter by status: pending, processing, completed, failed" },
      network: { type: "string", description: "Filter by network" },
      phone: { type: "string", description: "Filter by customer phone number" },
      date_from: { type: "string", description: "ISO timestamp start e.g. 2026-05-21T00:00:00" },
      date_to: { type: "string", description: "ISO timestamp end e.g. 2026-05-21T16:00:00" },
      limit: { type: "number", description: "Max results (default 10, use 200 to get all)" },
    },
    required: [],
  },
}

const updateOrderStatusTool: Anthropic.Tool = {
  name: "update_order_status",
  description: "Admin only: update the status of a single order by ID. The order ID comes from get_all_orders. Works across all order tables automatically.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The order ID (from get_all_orders)" },
      status: { type: "string", description: "New status: pending, processing, completed, failed" },
    },
    required: ["order_id", "status"],
  },
}

const bulkUpdateOrderStatusTool: Anthropic.Tool = {
  name: "bulk_update_order_status",
  description: "Admin only: update the status of ALL orders matching the given filters in one operation. Use this instead of calling update_order_status one-by-one. Always confirm with the user before calling.",
  input_schema: {
    type: "object" as const,
    properties: {
      new_status: { type: "string", description: "Status to set: completed, failed, processing, pending" },
      filter_status: { type: "string", description: "Only update orders currently in this status e.g. processing" },
      filter_network: { type: "string", description: "Only update orders for this network e.g. MTN" },
      date_from: { type: "string", description: "Only update orders created after this ISO timestamp e.g. 2026-05-21T00:00:00" },
      date_to: { type: "string", description: "Only update orders created before this ISO timestamp e.g. 2026-05-21T16:00:00" },
    },
    required: ["new_status"],
  },
}

const retryFailedOrderTool: Anthropic.Tool = {
  name: "retry_failed_order",
  description: "Admin only: fix a Paystack storefront order (shop_orders table only) that was paid but got stuck as 'failed' — resets status to pending and creates any missing profit record. This does NOT send a data bundle. After calling this, call manual_fulfill_order to actually deliver the bundle. Do NOT use this for orders from the orders, ussd_orders, or ussd_shop_orders tables — those will return 'Order not found'.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The shop_order ID to fix (must be from shop_orders / table: shop_orders in get_all_orders)" },
    },
    required: ["order_id"],
  },
}

const getUserInfoTool: Anthropic.Tool = {
  name: "get_user_info",
  description: "Admin only: look up a user account by user ID, phone number, or email.",
  input_schema: {
    type: "object" as const,
    properties: {
      user_id: { type: "string", description: "User UUID — fastest lookup when you already have the ID" },
      phone: { type: "string", description: "User phone number to search" },
      email: { type: "string", description: "User email to search" },
    },
    required: [],
  },
}

const manageBlacklistTool: Anthropic.Tool = {
  name: "manage_blacklist",
  description: "Admin only: add or remove a phone number from the order blacklist.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone_number: { type: "string", description: "The phone number to add or remove" },
      action: { type: "string", description: "Either 'add' or 'remove'" },
      reason: { type: "string", description: "Reason for adding to blacklist" },
    },
    required: ["phone_number", "action"],
  },
}

const getPlatformStatsTool: Anthropic.Tool = {
  name: "get_platform_stats",
  description: "Admin only: get order counts and revenue summary for today/week/month, calculated live across all order tables. For a full dashboard summary including airtime use get_admin_stats instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      period: { type: "string", description: "Time period: today, week, or month (default: today)" },
    },
    required: [],
  },
}

const toggleOrderingTool: Anthropic.Tool = {
  name: "toggle_ordering",
  description: "Admin only: enable or disable global order placement across the platform.",
  input_schema: {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean", description: "true to enable ordering, false to disable" },
    },
    required: ["enabled"],
  },
}

const listPendingFulfillmentTool: Anthropic.Tool = {
  name: "list_pending_fulfillment",
  description: "Admin only: list all paid orders that are pending manual fulfillment across shop, bulk, USSD, and USSD-shop order types. Returns id and type for each order needed by fulfill tools.",
  input_schema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max orders to return (default 100)" },
    },
    required: [],
  },
}

const manualFulfillOrderTool: Anthropic.Tool = {
  name: "manual_fulfill_order",
  description: "Admin only: trigger manual fulfillment (actually send the data bundle) for a single order. Works for shop, bulk, and USSD order types. Use this to retry delivery for failed or stuck orders. The order_type comes from get_all_orders 'table' field: shop_orders→shop, orders→bulk, ussd_orders→ussd, ussd_shop_orders→ussd_shop. NOTE: api_orders (table: api_orders) are NOT supported here — for API orders you can only update_order_status. The order must be set to pending/processing status first.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The order ID to fulfill (from get_all_orders)" },
      order_type: { type: "string", description: "Order type derived from the 'table' field in get_all_orders: shop (shop_orders), bulk (orders), ussd (ussd_orders), ussd_shop (ussd_shop_orders)" },
    },
    required: ["order_id", "order_type"],
  },
}

const bulkManualFulfillTool: Anthropic.Tool = {
  name: "bulk_manual_fulfill",
  description: "Admin only: trigger manual fulfillment for multiple pending orders at once. First call list_pending_fulfillment to get the list of orders with their ids and types, then pass them here. Confirm count with the user before executing.",
  input_schema: {
    type: "object" as const,
    properties: {
      orders: {
        type: "array",
        description: "Array of orders to fulfill, each with id and type",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", description: "shop, bulk, ussd, or ussd_shop" },
          },
          required: ["id", "type"],
        },
      },
    },
    required: ["orders"],
  },
}

// ─── Admin: user management ──────────────────────────────────────────────────

const listUsersTool: Anthropic.Tool = {
  name: "list_users",
  description: "Admin only: list platform users with their wallet balances and suspension status. Use get_user_info for a single lookup by phone/email.",
  input_schema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max users to return (default 20)" },
    },
    required: [],
  },
}

const suspendUserTool: Anthropic.Tool = {
  name: "suspend_user",
  description: "Admin only: suspend or unsuspend a user account. Always confirm user details before acting.",
  input_schema: {
    type: "object" as const,
    properties: {
      user_id: { type: "string", description: "The user ID to suspend or unsuspend" },
      action: { type: "string", description: "'suspend' or 'unsuspend'" },
      reason: { type: "string", description: "Reason for suspension (required for suspend)" },
    },
    required: ["user_id", "action"],
  },
}

const updateUserRoleTool: Anthropic.Tool = {
  name: "update_user_role",
  description: "Admin only: change a user's role. Valid roles: user, admin, sub_agent, dealer. Sub-agents cannot be promoted to dealer.",
  input_schema: {
    type: "object" as const,
    properties: {
      user_id: { type: "string", description: "The user ID to update" },
      role: { type: "string", description: "New role: user, admin, sub_agent, or dealer" },
    },
    required: ["user_id", "role"],
  },
}

const adjustWalletBalanceTool: Anthropic.Tool = {
  name: "adjust_wallet_balance",
  description: "Admin only: manually credit or debit a user's wallet balance. Always confirm amount, direction, and user before calling.",
  input_schema: {
    type: "object" as const,
    properties: {
      user_id: { type: "string", description: "The user ID whose wallet to adjust" },
      amount: { type: "number", description: "Amount in GHS (positive number)" },
      type: { type: "string", description: "'credit' to add funds or 'debit' to remove funds" },
    },
    required: ["user_id", "amount", "type"],
  },
}

// ─── Admin: shop management ──────────────────────────────────────────────────

const listShopsTool: Anthropic.Tool = {
  name: "list_shops",
  description: "Admin only: list dealer shops. Filter by status and/or search by shop name or owner name to keep results small. The 'id' in each result is used as shop_id in manage_shop.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "Filter by status: pending, active, or all (default: all)" },
      search: { type: "string", description: "Search by shop name (partial match)" },
      limit: { type: "number", description: "Max results to return (default 20)" },
    },
    required: [],
  },
}

const manageShopTool: Anthropic.Tool = {
  name: "manage_shop",
  description: "Admin only: get details of, approve, or reject a dealer shop. Use 'get' to look up a specific shop by its ID or slug.",
  input_schema: {
    type: "object" as const,
    properties: {
      shop_id: { type: "string", description: "The shop UUID. Required for approve/reject; used by get if no slug provided." },
      action: { type: "string", description: "'get' to fetch a single shop's details, 'approve' to approve a pending shop, 'reject' to reject it" },
      slug: { type: "string", description: "The shop slug (URL-friendly name). Used by get to look up by slug instead of ID." },
      reason: { type: "string", description: "Reason for rejection (required for reject)" },
    },
    required: ["action"],
  },
}

// ─── Admin: withdrawals ──────────────────────────────────────────────────────

const listWithdrawalsTool: Anthropic.Tool = {
  name: "list_withdrawals",
  description: "Admin only: list withdrawal requests with their current status and amounts.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "Filter: pending, approved, rejected, completed, or all (default: pending)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: [],
  },
}

const manageWithdrawalTool: Anthropic.Tool = {
  name: "manage_withdrawal",
  description: "Admin only: get details of, approve, reject, or complete a withdrawal. Use 'get' to look up a specific withdrawal by ID before acting on it.",
  input_schema: {
    type: "object" as const,
    properties: {
      withdrawal_id: { type: "string", description: "The withdrawal request ID. Required for get, approve, reject, and complete." },
      action: { type: "string", description: "'get' to fetch a single withdrawal's full details, 'approve' to approve and trigger payout, 'reject' to decline, 'complete' to mark an approved withdrawal as paid" },
      reason: { type: "string", description: "Reason (required for reject)" },
    },
    required: ["withdrawal_id", "action"],
  },
}

// ─── Admin: USSD shop codes ───────────────────────────────────────────────────

const manageUssdShopTool: Anthropic.Tool = {
  name: "manage_ussd_shop",
  description: "Admin only: list, get, create, activate, or add tokens to USSD shop codes. Use 'get' to look up a specific code by its UUID or 4-digit code number. Use 'list' to browse all codes.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", description: "'list' to view all USSD shop codes, 'get' to fetch a single code by ID or 4-digit code, 'create' to create a new code for a shop, 'activate' to activate a pending code, 'add_tokens' to credit sessions to an active code" },
      ussd_shop_code_id: { type: "string", description: "The USSD shop code UUID. Used by get (if no code provided), activate, and add_tokens." },
      code: { type: "string", description: "The 4-digit USSD code number (e.g. '1234'). Used by get to look up by code number; optional for create (auto-generated if omitted)." },
      shop_id: { type: "string", description: "The shop ID to associate the code with. Required for create." },
      initial_tokens: { type: "number", description: "Initial session tokens to credit when activating. Optional for activate." },
      tokens: { type: "number", description: "Number of session tokens to add. Required for add_tokens." },
    },
    required: ["action"],
  },
}

// ─── Admin: packages ─────────────────────────────────────────────────────────

const managePackagesTool: Anthropic.Tool = {
  name: "manage_packages",
  description: "Admin only: list, create, update, or toggle data packages. WORKFLOW: (1) always call action='list' with network filter first to get the exact package_id UUID, (2) then call action='update' or 'toggle' with that UUID. Never guess a package_id.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", description: "'list' to view packages (filter by network to keep results small), 'create' to add a new one, 'update' to edit an existing one, 'toggle' to enable/disable" },
      package_id: { type: "string", description: "The package UUID from action='list'. Required for update and toggle." },
      network: { type: "string", description: "Network name: MTN, AirtelTigo, or Telecel. Use this to filter list results — always pass it when you know the network." },
      name: { type: "string", description: "Package display name" },
      size: { type: "number", description: "Package size as a plain number (e.g. 1, 2, 5, 10) — no 'GB' suffix" },
      price: { type: "number", description: "Customer price in GHS (e.g. 5.00)" },
      dealer_price: { type: "number", description: "Dealer price in GHS — must be lower than price" },
      is_available: { type: "boolean", description: "For toggle: true to enable, false to disable" },
    },
    required: ["action"],
  },
}

// ─── Admin: logs ─────────────────────────────────────────────────────────────

const getFulfillmentLogsTool: Anthropic.Tool = {
  name: "get_fulfillment_logs",
  description: "Admin only: view fulfillment processing logs to debug stuck or failed orders.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "Filter by status e.g. failed, success, pending" },
      limit: { type: "number", description: "Max results (default 20)" },
      page: { type: "number", description: "Page number (default 1)" },
    },
    required: [],
  },
}

const getMtnLogsTool: Anthropic.Tool = {
  name: "get_mtn_logs",
  description: "Admin only: view MTN-specific fulfillment tracking logs from the Sykes/Datakazina provider.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", description: "Filter by status" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: [],
  },
}

// ─── Admin: blacklist ────────────────────────────────────────────────────────

const bulkBlacklistTool: Anthropic.Tool = {
  name: "bulk_blacklist",
  description: "Admin only: add multiple phone numbers to the blacklist at once. Always confirm the list and reason before calling.",
  input_schema: {
    type: "object" as const,
    properties: {
      phones: {
        type: "array",
        description: "Array of phone numbers to blacklist",
        items: { type: "string" },
      },
      reason: { type: "string", description: "Reason for blacklisting these numbers" },
    },
    required: ["phones"],
  },
}

// ─── Admin: settings ─────────────────────────────────────────────────────────

const setMtnProviderTool: Anthropic.Tool = {
  name: "set_mtn_provider",
  description: "Admin only: get or set the active MTN fulfillment provider. Call with no arguments to read current provider.",
  input_schema: {
    type: "object" as const,
    properties: {
      provider: { type: "string", description: "Provider to switch to: 'sykes' or 'datakazina'. Omit to just read current setting." },
    },
    required: [],
  },
}

const toggleAfaAutoFulfillmentTool: Anthropic.Tool = {
  name: "toggle_afa_auto_fulfillment",
  description: "Admin only: get or set the AFA (AirtelTigo/Telecel/BigTime via AFA) auto-fulfillment toggle. Call with no arguments to read current state.",
  input_schema: {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean", description: "true to enable, false to disable. Omit to just read current state." },
    },
    required: [],
  },
}

const manageRateLimitsTool: Anthropic.Tool = {
  name: "manage_rate_limits",
  description: "Admin only: view active rate limit blocks or reset a specific block for a user/IP that was incorrectly throttled.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", description: "'list' to view current blocks, 'reset' to clear a specific block" },
      endpoint: { type: "string", description: "Endpoint name to filter or reset e.g. 'ai_chat', 'purchase'" },
      identifier: { type: "string", description: "User ID or IP to reset the limit for (required for reset)" },
      limit: { type: "number", description: "Max results for list (default 20)" },
    },
    required: ["action"],
  },
}

// ─── Admin: stats & plans ────────────────────────────────────────────────────

const getAdminStatsTool: Anthropic.Tool = {
  name: "get_admin_stats",
  description: "Admin only: get the full admin dashboard statistics — total orders, revenue, success rate, airtime stats, and more. Prefer this over get_platform_stats when the admin asks for a general overview.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const manageSubscriptionPlansTool: Anthropic.Tool = {
  name: "manage_subscription_plans",
  description: "Admin only: list, create, update, or deactivate dealer subscription plans.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", description: "'list' to view all plans, 'create' to add one, 'update' to edit, 'delete' to remove" },
      plan_id: { type: "string", description: "Plan ID (required for update and delete)" },
      name: { type: "string", description: "Plan name" },
      price: { type: "number", description: "Plan price in GHS" },
      duration_days: { type: "number", description: "How many days the plan lasts" },
      is_active: { type: "boolean", description: "Whether the plan is active" },
    },
    required: ["action"],
  },
}

// ─── Dashboard: transaction & stats tools ────────────────────────────────────

const getWalletTransactionsTool: Anthropic.Tool = {
  name: "get_wallet_transactions",
  description: "Get the logged-in user's wallet credit/debit history — top-ups, manual credits, and wallet deductions. For the list of data orders placed use get_order_history. For a combined filtered view use get_transaction_history.",
  input_schema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Number of transactions to fetch (default 10)" },
      page: { type: "number", description: "Page number (default 1)" },
    },
    required: [],
  },
}

const getTransactionHistoryTool: Anthropic.Tool = {
  name: "get_transaction_history",
  description: "Get the logged-in user's combined transaction history (orders + wallet activity) with date-range filtering. Use when the user asks what they spent over a time period. For wallet credits/debits only use get_wallet_transactions; for recent orders only use get_order_history.",
  input_schema: {
    type: "object" as const,
    properties: {
      date_range: { type: "string", description: "Time filter: today, week, month, or 3months (default: month)" },
      type: { type: "string", description: "Transaction type filter if applicable" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: [],
  },
}

const getOrderStatsTool: Anthropic.Tool = {
  name: "get_order_stats",
  description: "Get the logged-in user's personal order statistics: total, completed, failed, processing counts and success rate.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const getSubscriptionTool: Anthropic.Tool = {
  name: "get_subscription",
  description: "Get the logged-in user's current active subscription plan, including plan name, expiry date, and features.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const getMyShopTool: Anthropic.Tool = {
  name: "get_my_shop",
  description: "Get the logged-in dealer's shop details: shop name, storefront URL slug, USSD shop code (the short code customers dial), USSD token balance, and active sub-agent invite codes. Use when a user asks about their shop code, shop URL, USSD code, or invite link.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const getSubscriptionPlansTool: Anthropic.Tool = {
  name: "get_subscription_plans",
  description: "Get all available dealer upgrade plans with names, prices, and durations. Use this when a user asks about upgrading to dealer, becoming a dealer, subscription costs, or plan options.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

// ─── Storefront: airtime & results checker ───────────────────────────────────

const getAirtimeAvailabilityTool: Anthropic.Tool = {
  name: "get_airtime_availability",
  description: "Check whether airtime top-up is available in this shop for a specific network, and what fee applies.",
  input_schema: {
    type: "object" as const,
    properties: {
      network: { type: "string", description: "Network to check: MTN, Telecel, or AT" },
    },
    required: ["network"],
  },
}

const getResultsCheckerAvailabilityTool: Anthropic.Tool = {
  name: "get_results_checker_availability",
  description: "Check how many exam results checker vouchers are currently in stock (WAEC, BECE, NOVDEC).",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const syncFulfillmentStatusTool: Anthropic.Tool = {
  name: "sync_fulfillment_status",
  description: "Admin only: sync an MTN order's status from the external provider. Use get_mtn_logs first to find the tracking_id or mtn_order_id for a specific order. Set sync_all_pending=true to refresh all pending MTN orders at once without needing individual IDs.",
  input_schema: {
    type: "object" as const,
    properties: {
      tracking_id: { type: "string", description: "Sykes tracking ID — get this from get_mtn_logs" },
      mtn_order_id: { type: "string", description: "MTN order ID — get this from get_mtn_logs" },
      sync_all_pending: { type: "boolean", description: "true to sync all pending MTN orders at once (no tracking_id needed)" },
      provider: { type: "string", description: "Provider name: 'mtn' or 'datakazina'" },
    },
    required: [],
  },
}

const retryBlacklistedOrderTool: Anthropic.Tool = {
  name: "retry_blacklisted_order",
  description: "Admin only: retry an order that was blocked because the recipient phone was blacklisted. Only works if the phone has since been removed from the blacklist. Always check the blacklist status first before calling.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The ID of the blocked order to retry" },
      order_type: { type: "string", description: "Order type: 'shop' (storefront/Paystack) or 'bulk' (wallet/dealer). Defaults to shop." },
    },
    required: ["order_id"],
  },
}

const toggleAutoFulfillmentTool: Anthropic.Tool = {
  name: "toggle_auto_fulfillment",
  description: "Admin only: get or set the auto-fulfillment setting for AT/Telecel/BigTime. Call with no arguments to see the current state. Pass enabled=true/false to change it.",
  input_schema: {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean", description: "true to enable auto-fulfillment, false to disable. Omit to just read the current status." },
    },
    required: [],
  },
}

const toggleMtnAutoFulfillmentTool: Anthropic.Tool = {
  name: "toggle_mtn_auto_fulfillment",
  description: "Admin only: get or set the MTN-specific auto-fulfillment toggle. Call with no arguments to see the current state. Pass enabled=true/false to change it.",
  input_schema: {
    type: "object" as const,
    properties: {
      enabled: { type: "boolean", description: "true to enable MTN auto-fulfillment, false to disable. Omit to just read the current status." },
    },
    required: [],
  },
}

const getMtnBalanceTool: Anthropic.Tool = {
  name: "get_mtn_balance",
  description: "Admin only: check the current balance in the MTN Sykes fulfillment account used to send data bundles.",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
}

const getKnowledgeBaseTool: Anthropic.Tool = {
  name: "get_knowledge_base",
  description: "Search the business knowledge base for answers about policies, FAQs, products, delivery times, refunds, and support procedures. Use this whenever a user asks a question you don't have direct context for.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "The question or topic to look up" },
    },
    required: ["query"],
  },
}

const showActionButtonsTool: Anthropic.Tool = {
  name: "show_action_buttons",
  description: "Display clickable buttons to the user for confirmations or multi-choice selections. Use this INSTEAD of asking the user to type 'yes', 'no', or choose an option — buttons are faster and clearer. Call this right before or after presenting a choice. Max 4 buttons. Example: before placing an order, call show_action_buttons with [{label:'Confirm order', value:'Yes, confirm', style:'primary'}, {label:'Cancel', value:'Cancel', style:'secondary'}].",
  input_schema: {
    type: "object" as const,
    properties: {
      buttons: {
        type: "array",
        description: "List of buttons to display (1–4 buttons)",
        items: {
          type: "object" as const,
          properties: {
            label: { type: "string", description: "Text shown on the button" },
            value: { type: "string", description: "Text sent as the user's reply when this button is clicked" },
            style: { type: "string", description: "Visual style: primary (violet, for the main action), danger (red, for destructive actions), secondary (gray, for cancel/alternatives)" },
          },
          required: ["label", "value"],
        },
      },
    },
    required: ["buttons"],
  },
}

// ─── Tool list by context ────────────────────────────────────────────────────

export function aiTools(context: AIChatContext): Anthropic.Tool[] {
  // Home: public receptionist — no auth required, visitors may be guests
  if (context === "home") return [
    getAvailablePackagesTool,
    searchOrderStatusTool,      // lookup by order_id or reference_code — no login needed
    getSubscriptionPlansTool,   // "how much does dealer cost?" — public endpoint
    getKnowledgeBaseTool,
    showActionButtonsTool,
  ]

  // Storefront: guest-facing, Paystack checkout flow
  if (context === "storefront") return [
    getAvailablePackagesTool,
    searchOrderStatusTool,
    prepareCheckoutTool,
    getAirtimeAvailabilityTool,
    getResultsCheckerAvailabilityTool,
    getKnowledgeBaseTool,
    showActionButtonsTool,
  ]

  // Dashboard: authenticated dealer/user, wallet-based ordering
  if (context === "dashboard") return [
    getAvailablePackagesTool,
    searchOrderStatusTool,
    getWalletBalanceTool,
    getWalletTransactionsTool,
    getOrderHistoryTool,
    placeWalletOrderTool,
    getSubscriptionTool,
    getSubscriptionPlansTool,
    getMyShopTool,
    getKnowledgeBaseTool,
    showActionButtonsTool,
  ]

  // Admin: platform management — full suite
  return [
    // Orders
    getAvailablePackagesTool,
    getAllOrdersTool,
    updateOrderStatusTool,
    bulkUpdateOrderStatusTool,
    retryFailedOrderTool,
    // Users
    listUsersTool,
    getUserInfoTool,
    suspendUserTool,
    updateUserRoleTool,
    adjustWalletBalanceTool,
    // Shops
    listShopsTool,
    manageShopTool,
    // Withdrawals
    listWithdrawalsTool,
    manageWithdrawalTool,
    // USSD shops
    manageUssdShopTool,
    // Packages
    managePackagesTool,
    // Blacklist
    manageBlacklistTool,
    bulkBlacklistTool,
    // Fulfillment
    listPendingFulfillmentTool,
    manualFulfillOrderTool,
    bulkManualFulfillTool,
    syncFulfillmentStatusTool,
    retryBlacklistedOrderTool,
    // Settings & toggles
    toggleOrderingTool,
    toggleAutoFulfillmentTool,
    toggleMtnAutoFulfillmentTool,
    toggleAfaAutoFulfillmentTool,
    setMtnProviderTool,
    getMtnBalanceTool,
    // Rate limits
    manageRateLimitsTool,
    // Stats & plans
    getAdminStatsTool,
    manageSubscriptionPlansTool,
    // Knowledge & UI
    getKnowledgeBaseTool,
    showActionButtonsTool,
  ]
}

// ─── Sanitize tool results ───────────────────────────────────────────────────

function sanitize(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitize)
  if (obj && typeof obj === "object") {
    const clean: Record<string, unknown> = {}
    const sensitiveFields = new Set(["dealer_price", "wholesale_margin", "parent_profit_amount", "profit_amount", "base_price"])
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (sensitiveFields.has(k)) continue
      if (typeof v === "string" && v.length > 2000) {
        clean[k] = v.slice(0, 2000) + "…"
      } else {
        clean[k] = sanitize(v)
      }
    }
    return clean
  }
  return obj
}

// ─── Tool dispatch context ───────────────────────────────────────────────────

export interface ToolContext {
  userId?: string
  jwtToken?: string
  userRole?: string
  shopId?: string
  shopSlug?: string
  baseUrl: string
}

// ─── executeToolCall ─────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  try {
    switch (name) {
      case "get_available_packages": {
        // Storefront (shopSlug set, guest user): fetch only what this shop has configured
        if (ctx.shopSlug) {
          const url = new URL(`${ctx.baseUrl}/api/shop/public-packages`)
          url.searchParams.set("slug", ctx.shopSlug)
          const res = await fetch(url.toString())
          const data = await res.json()
          let packages = data.packages ?? []
          if (input.network) {
            packages = packages.filter((p: Record<string, unknown>) => {
              const network = (p.packages as Record<string, unknown>)?.network ?? p.network
              return String(network).toLowerCase() === String(input.network).toLowerCase()
            })
          }
          return sanitize(packages.map((p: Record<string, unknown>) => ({
            id: p.id,   // pass this as shop_package_id to prepare_checkout
            network: (p.packages as Record<string, unknown>)?.network ?? p.network,
            size: (p.packages as Record<string, unknown>)?.size ?? p.size,
            price: p.selling_price ?? (p.packages as Record<string, unknown>)?.price,
          })))
        }

        // Guest with no shopSlug — should never happen in storefront context; refuse rather than leaking the full catalog
        if (!ctx.userId) {
          console.warn("[AI-TOOLS] get_available_packages called with no shopSlug and no userId")
          return { error: "Shop context is missing. Please refresh the page and try again." }
        }

        // Dashboard / admin: base packages table
        const isAdmin = ctx.userRole === "admin"
        const isDealer = ctx.userRole === "dealer"
        let query = supabaseAdmin
          .from("packages")
          .select("id, network, size, price, dealer_price")
          .eq("active", true)
          .order("network")
        if (input.network) {
          query = query.ilike("network", `%${String(input.network)}%`)
        }
        const { data, error } = await query
        if (error) return { error: error.message }

        // Sort by size numerically (DB sorts "10" before "2" alphabetically)
        const rows = (data ?? []).sort((a, b) => Number(a.size) - Number(b.size))

        if (isAdmin) {
          return rows.map((p: Record<string, unknown>) => ({
            id: p.id,
            network: p.network,
            size: p.size,
            customer_price: p.price,
            dealer_price: p.dealer_price,
          }))
        }

        return sanitize(rows.map((p: Record<string, unknown>) => ({
          id: p.id,
          network: p.network,
          size: p.size,
          price: isDealer && p.dealer_price && Number(p.dealer_price) > 0 ? p.dealer_price : p.price,
        })))
      }

      case "search_order_status": {
        // Single lookup by order UUID
        if (input.order_id) {
          const res = await fetch(`${ctx.baseUrl}/api/shop/orders/${input.order_id}`, {
            headers: { Authorization: ctx.jwtToken ? `Bearer ${ctx.jwtToken}` : "" },
          })
          if (res.ok) {
            const data = await res.json()
            return sanitize(data.order ?? data)
          }
          // Fallback: wallet order
          const { data, error } = await supabaseAdmin
            .from("orders")
            .select("id, network, size, status, phone_number, created_at, order_code")
            .eq("id", input.order_id as string)
            .maybeSingle()
          if (error || !data) return { error: "Order not found" }
          return sanitize(data)
        }

        // Single lookup by reference code
        if (input.reference_code) {
          const { data, error } = await supabaseAdmin
            .from("shop_orders")
            .select("id, reference_code, network, volume_gb, order_status, payment_status, customer_phone, created_at")
            .eq("reference_code", input.reference_code as string)
            .maybeSingle()
          if (error || !data) return { error: `No order found with reference code ${input.reference_code}` }
          return sanitize(data)
        }

        if (!input.phone_number) return { error: "Provide phone_number, order_id, or reference_code" }

        // Storefront: search within the shop by phone
        if (ctx.shopId) {
          const res = await fetch(`${ctx.baseUrl}/api/shop/orders/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: input.phone_number, shopId: ctx.shopId }),
          })
          const data = await res.json()
          return sanitize({
            found: data.count ?? 0,
            orders: (data.orders ?? []).map((o: Record<string, unknown>) => ({
              reference: o.reference_code ?? o.id,
              type: o.type,
              network: o.network,
              volume_gb: o.volume_gb,
              price: o.total_price,
              order_status: o.order_status ?? o.status,
              payment_status: o.payment_status,
              date: o.created_at,
            })),
          })
        }

        // Dashboard: search the user's own orders in combined_orders_view by recipient phone
        const { data, error } = await supabaseAdmin
          .from("combined_orders_view")
          .select("id, network, volume_gb, status, phone_number, created_at, type, price")
          .eq("shop_owner_id", ctx.userId!)
          .eq("phone_number", input.phone_number as string)
          .order("created_at", { ascending: false })
          .limit(10)
        if (error) return { error: error.message }
        return sanitize({
          found: data?.length ?? 0,
          orders: (data ?? []).map(o => ({
            id: o.id,
            network: o.network,
            size: o.volume_gb,
            status: o.status,
            phone: o.phone_number,
            price: o.price,
            type: o.type,
            date: o.created_at,
          })),
        })
      }

      case "prepare_checkout": {
        // Signals the widget to open the checkout modal — handled client-side
        return { action: "open_checkout", ...input }
      }

      case "get_wallet_balance": {
        const res = await fetch(`${ctx.baseUrl}/api/wallet/balance`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        return await res.json()
      }

      case "get_order_history": {
        if (input.order_id) {
          const { data, error } = await supabaseAdmin
            .from("combined_orders_view")
            .select("id, network, volume_gb, status, phone_number, created_at, type, price, order_code")
            .eq("user_id", ctx.userId!)
            .eq("id", input.order_id as string)
            .maybeSingle()
          if (error || !data) return { error: "Order not found" }
          return sanitize(data)
        }
        const limit = Math.min(Number(input.limit ?? 5), 10)
        const res = await fetch(
          `${ctx.baseUrl}/api/orders/list?limit=${limit}&page=1`,
          { headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to fetch orders" }
        return sanitize({ orders: data.orders, total: data.pagination?.total })
      }

      case "place_wallet_order": {
        // Look up the real package ID by network + size — never trust Claude to carry a UUID
        const { data: pkg, error: pkgErr } = await supabaseAdmin
          .from("packages")
          .select("id, size, price, dealer_price")
          .ilike("network", String(input.network))
          .eq("size", String(input.size))
          .eq("active", true)
          .maybeSingle()

        if (pkgErr || !pkg) {
          return { error: `Package not found: ${input.network} ${input.size}GB. Please call get_available_packages to see what is available.` }
        }

        const res = await fetch(`${ctx.baseUrl}/api/orders/purchase`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.jwtToken}`,
          },
          body: JSON.stringify({
            packageId: pkg.id,
            phoneNumber: input.phone_number,
            network: input.network,
          }),
        })
        const data = await res.json()
        return sanitize({
          success: res.ok,
          message: data.message ?? data.error,
          order_code: data.order?.order_code,
          new_balance: data.newBalance,
        })
      }

      case "get_all_orders": {
        // Single order lookup — try each table in parallel and return the match
        if (input.order_id) {
          const id = input.order_id as string
          const [r1, r2, r3, r4, r5] = await Promise.all([
            supabaseAdmin.from("orders").select("id, network, size, status, phone_number, created_at").eq("id", id).maybeSingle(),
            supabaseAdmin.from("shop_orders").select("id, network, volume_gb, order_status, customer_phone, created_at, reference_code").eq("id", id).maybeSingle(),
            supabaseAdmin.from("ussd_orders").select("id, network, package_size, order_status, recipient_phone, created_at").eq("id", id).maybeSingle(),
            supabaseAdmin.from("ussd_shop_orders").select("id, network, package_size, order_status, recipient_phone, created_at").eq("id", id).maybeSingle(),
            supabaseAdmin.from("api_orders").select("id, network, volume_gb, status, recipient_phone, created_at").eq("id", id).maybeSingle(),
          ])
          if (r1.data) return { ...r1.data, table: "orders" }
          if (r2.data) return { ...r2.data, table: "shop_orders" }
          if (r3.data) return { ...r3.data, table: "ussd_orders" }
          if (r4.data) return { ...r4.data, table: "ussd_shop_orders" }
          if (r5.data) return { ...r5.data, table: "api_orders" }
          return { error: "Order not found" }
        }

        const limit = Number(input.limit ?? 10)
        const status = input.status as string | undefined
        const network = input.network as string | undefined
        const phone = input.phone as string | undefined
        const dateFrom = input.date_from as string | undefined
        const dateTo = input.date_to as string | undefined

        let ordersQ = supabaseAdmin.from("orders").select("id, network, size, status, phone_number, created_at").order("created_at", { ascending: false }).limit(limit)
        if (status) ordersQ = ordersQ.eq("status", status)
        if (network) ordersQ = ordersQ.ilike("network", network)
        if (phone) ordersQ = ordersQ.eq("phone_number", phone)
        if (dateFrom) ordersQ = ordersQ.gte("created_at", dateFrom)
        if (dateTo) ordersQ = ordersQ.lte("created_at", dateTo)

        let shopQ = supabaseAdmin.from("shop_orders").select("id, network, volume_gb, order_status, customer_phone, created_at").eq("payment_status", "completed").order("created_at", { ascending: false }).limit(limit)
        if (status) shopQ = shopQ.eq("order_status", status)
        if (network) shopQ = shopQ.ilike("network", network)
        if (phone) shopQ = shopQ.eq("customer_phone", phone)
        if (dateFrom) shopQ = shopQ.gte("created_at", dateFrom)
        if (dateTo) shopQ = shopQ.lte("created_at", dateTo)

        let ussdQ = supabaseAdmin.from("ussd_orders").select("id, network, package_size, order_status, recipient_phone, created_at").eq("payment_status", "completed").order("created_at", { ascending: false }).limit(limit)
        if (status) ussdQ = ussdQ.eq("order_status", status)
        if (network) ussdQ = ussdQ.ilike("network", network)
        if (phone) ussdQ = ussdQ.eq("recipient_phone", phone)
        if (dateFrom) ussdQ = ussdQ.gte("created_at", dateFrom)
        if (dateTo) ussdQ = ussdQ.lte("created_at", dateTo)

        let ussdShopQ = supabaseAdmin.from("ussd_shop_orders").select("id, network, package_size, order_status, recipient_phone, created_at").eq("payment_status", "completed").order("created_at", { ascending: false }).limit(limit)
        if (status) ussdShopQ = ussdShopQ.eq("order_status", status)
        if (network) ussdShopQ = ussdShopQ.ilike("network", network)
        if (phone) ussdShopQ = ussdShopQ.eq("recipient_phone", phone)
        if (dateFrom) ussdShopQ = ussdShopQ.gte("created_at", dateFrom)
        if (dateTo) ussdShopQ = ussdShopQ.lte("created_at", dateTo)

        // api_orders: no payment_status column — all rows are valid orders
        let apiQ = supabaseAdmin.from("api_orders").select("id, network, volume_gb, status, recipient_phone, created_at").order("created_at", { ascending: false }).limit(limit)
        if (status) apiQ = apiQ.eq("status", status)
        if (network) apiQ = apiQ.ilike("network", network)
        if (phone) apiQ = apiQ.eq("recipient_phone", phone)
        if (dateFrom) apiQ = apiQ.gte("created_at", dateFrom)
        if (dateTo) apiQ = apiQ.lte("created_at", dateTo)

        const [{ data: ordersData, error: e1 }, { data: shopData, error: e2 }, { data: ussdData, error: e3 }, { data: ussdShopData, error: e4 }, { data: apiData, error: e5 }] = await Promise.all([ordersQ, shopQ, ussdQ, ussdShopQ, apiQ])
        if (e1) return { error: e1.message }
        if (e2) return { error: e2.message }
        if (e3) return { error: e3.message }
        if (e4) return { error: e4.message }
        if (e5) return { error: e5.message }

        const combined = [
          ...(ordersData ?? []).map(o => ({ id: o.id, table: "orders", network: o.network, size: o.size, status: o.status, phone: o.phone_number, created_at: o.created_at })),
          ...(shopData ?? []).map(o => ({ id: o.id, table: "shop_orders", network: o.network, size: `${o.volume_gb}`, status: o.order_status, phone: o.customer_phone, created_at: o.created_at })),
          ...(ussdData ?? []).map(o => ({ id: o.id, table: "ussd_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
          ...(ussdShopData ?? []).map(o => ({ id: o.id, table: "ussd_shop_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
          ...(apiData ?? []).map(o => ({ id: o.id, table: "api_orders", network: o.network, size: `${o.volume_gb}`, status: o.status, phone: o.recipient_phone, created_at: o.created_at })),
        ]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, limit)

        return sanitize({ count: combined.length, orders: combined })
      }

      case "update_order_status": {
        // Route through the bulk-update endpoint — it handles notifications,
        // profit crediting, and MTN tracking for all order table types.
        const res = await fetch(`${ctx.baseUrl}/api/admin/orders/bulk-update-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ orderIds: [input.order_id], status: input.status }),
        })
        const data = await res.json()
        if (!res.ok) return { success: false, error: data.error ?? "Update failed" }
        return { success: true }
      }

      case "bulk_update_order_status": {
        if (!input.filter_status && !input.filter_network && !input.date_from && !input.date_to) {
          return { error: "At least one filter is required for bulk update to prevent accidental mass changes." }
        }

        const newStatus = input.new_status as string
        const fs = input.filter_status as string | undefined
        const fn = input.filter_network as string | undefined
        const df = input.date_from as string | undefined
        const dt = input.date_to as string | undefined

        // Collect matching IDs from all five order tables in parallel
        function applyFilters(q: any, statusField: "status" | "order_status", paymentFilter?: string) {
          if (paymentFilter) q = q.eq("payment_status", paymentFilter)
          if (fs) q = q.eq(statusField, fs)
          if (fn) q = q.ilike("network", fn)
          if (df) q = q.gte("created_at", df)
          if (dt) q = q.lte("created_at", dt)
          return q
        }

        const [r1, r2, r3, r4, r5] = await Promise.all([
          applyFilters(supabaseAdmin.from("orders").select("id"), "status"),
          applyFilters(supabaseAdmin.from("shop_orders").select("id"), "order_status", "completed"),
          applyFilters(supabaseAdmin.from("ussd_orders").select("id"), "order_status", "completed"),
          applyFilters(supabaseAdmin.from("ussd_shop_orders").select("id"), "order_status", "completed"),
          applyFilters(supabaseAdmin.from("api_orders").select("id"), "status"),
        ])

        const err = [r1.error, r2.error, r3.error, r4.error, r5.error].find(Boolean)
        if (err) return { error: err.message }

        const allIds = [
          ...(r1.data ?? []), ...(r2.data ?? []), ...(r3.data ?? []),
          ...(r4.data ?? []), ...(r5.data ?? []),
        ].map(o => o.id)

        if (allIds.length === 0) return { success: true, count: 0, message: "No matching orders found." }

        // Pass all IDs to the bulk-update endpoint — it handles notifications,
        // profit crediting, and MTN tracking for every order type.
        const res = await fetch(`${ctx.baseUrl}/api/admin/orders/bulk-update-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ orderIds: allIds, status: newStatus }),
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Bulk update failed" }
        return { success: true, count: allIds.length, message: `${allIds.length} orders updated to "${newStatus}".` }
      }

      case "retry_failed_order": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fix-failed-orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.jwtToken}`,
          },
          body: JSON.stringify({ orderId: input.order_id }),
        })
        const data = await res.json()
        return sanitize({ success: res.ok, summary: data.summary, results: data.results, error: data.error })
      }

      case "get_user_info": {
        if (!input.user_id && !input.phone && !input.email) return { error: "Provide user_id, phone, or email" }
        let query = supabaseAdmin
          .from("users")
          .select("id, first_name, last_name, email, phone_number, role, created_at")
        if (input.user_id) query = query.eq("id", input.user_id as string)
        else if (input.phone) query = query.eq("phone_number", input.phone as string)
        else if (input.email) query = query.eq("email", input.email as string)
        const { data, error } = await query.maybeSingle()
        if (error || !data) return { error: "User not found" }

        const { data: wallet } = await supabaseAdmin
          .from("wallets")
          .select("balance, total_credited, total_spent")
          .eq("user_id", data.id)
          .maybeSingle()

        return sanitize({ ...data, wallet })
      }

      case "manage_blacklist": {
        if (input.action === "add") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/blacklist`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ phone_number: input.phone_number, reason: input.reason ?? "Admin action" }),
          })
          const data = await res.json()
          return { success: res.ok, action: "added", message: data.message, error: data.error }
        } else {
          const res = await fetch(
            `${ctx.baseUrl}/api/admin/blacklist?phone=${encodeURIComponent(input.phone_number as string)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
          )
          const data = await res.json()
          return { success: res.ok, action: "removed", message: data.message, error: data.error }
        }
      }

      case "get_platform_stats": {
        const period = (input.period as string) ?? "today"
        const now = new Date()
        let since: string
        if (period === "week") {
          since = new Date(now.getTime() - 7 * 86400000).toISOString()
        } else if (period === "month") {
          since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
        } else {
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
        }

        // Count across all 4 order tables in parallel
        const [
          { data: ordersData },
          { data: shopData },
          { data: ussdData },
          { data: ussdShopData },
        ] = await Promise.all([
          supabaseAdmin.from("orders").select("status, price").gte("created_at", since),
          supabaseAdmin.from("shop_orders").select("order_status, total_price").eq("payment_status", "completed").gte("created_at", since),
          supabaseAdmin.from("ussd_orders").select("order_status, amount").eq("payment_status", "completed").gte("created_at", since),
          supabaseAdmin.from("ussd_shop_orders").select("order_status, amount").eq("payment_status", "completed").gte("created_at", since),
        ])

        const all = [
          ...(ordersData ?? []).map(o => ({ status: o.status, price: Number(o.price ?? 0) })),
          ...(shopData ?? []).map(o => ({ status: o.order_status, price: Number(o.total_price ?? 0) })),
          ...(ussdData ?? []).map(o => ({ status: o.order_status, price: Number(o.amount ?? 0) })),
          ...(ussdShopData ?? []).map(o => ({ status: o.order_status, price: Number(o.amount ?? 0) })),
        ]

        const total = all.length
        const completed = all.filter(o => o.status === "completed").length
        const failed = all.filter(o => o.status === "failed").length
        const processing = all.filter(o => o.status === "processing" || o.status === "pending").length
        const revenue = all.filter(o => o.status === "completed").reduce((s, o) => s + o.price, 0)

        return {
          period,
          total_orders: total,
          completed,
          failed,
          processing,
          success_rate: total > 0 ? `${((completed / total) * 100).toFixed(1)}%` : "0%",
          revenue: `GHS ${revenue.toFixed(2)}`,
        }
      }

      case "toggle_ordering": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ ordering_enabled: input.enabled }),
        })
        const data = await res.json()
        return { success: res.ok, ordering_enabled: data.settings?.ordering_enabled, error: data.error }
      }

      case "list_pending_fulfillment": {
        const limit = Math.min(Number(input.limit ?? 100), 500)
        const res = await fetch(
          `${ctx.baseUrl}/api/admin/fulfillment/manual-fulfill?limit=${limit}`,
          { headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
        )
        const data = await res.json()
        if (!res.ok || !data.success) return { error: data.error ?? "Failed to fetch pending orders" }
        return sanitize({
          total: data.pagination?.total ?? data.orders?.length ?? 0,
          orders: (data.orders ?? []).map((o: Record<string, unknown>) => ({
            id: o.id,
            type: o.type,
            network: o.network,
            size: o.volume_gb,
            phone: o.customer_phone,
            name: o.customer_name,
            status: o.order_status,
            amount: o.amount,
            date: o.created_at,
          })),
        })
      }

      case "manual_fulfill_order": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/manual-fulfill`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.jwtToken}`,
          },
          body: JSON.stringify({ shop_order_id: input.order_id, order_type: input.order_type }),
        })
        const data = await res.json()
        return { success: res.ok, message: data.message ?? data.error, tracking_id: data.tracking_id }
      }

      case "bulk_manual_fulfill": {
        const orders = input.orders as Array<{ id: string; type: string }>
        if (!orders?.length) return { error: "No orders provided" }
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/bulk-manual-fulfill`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.jwtToken}`,
          },
          body: JSON.stringify({ orders }),
        })
        const data = await res.json()
        return sanitize({
          success: res.ok,
          message: data.message ?? data.error,
          summary: data.summary,
        })
      }

      case "list_users": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/users`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to fetch users" }
        const users = (data.users ?? data ?? []).slice(0, Number(input.limit ?? 20))
        return sanitize(users.map((u: Record<string, unknown>) => ({
          id: u.id,
          name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim(),
          email: u.email,
          phone: u.phone_number,
          role: u.role,
          suspended: u.is_suspended,
          balance: u.wallet_balance ?? u.balance,
        })))
      }

      case "suspend_user": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/users/suspend`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ userId: input.user_id, action: input.action, reason: input.reason }),
        })
        const data = await res.json()
        return { success: res.ok, message: data.message ?? data.error }
      }

      case "update_user_role": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/users/update-role`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ userId: input.user_id, role: input.role }),
        })
        const data = await res.json()
        return { success: res.ok, message: data.message ?? data.error, new_role: data.newRole }
      }

      case "adjust_wallet_balance": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/update-balance`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ userId: input.user_id, amount: input.amount, type: input.type }),
        })
        const data = await res.json()
        return sanitize({ success: res.ok, message: data.message ?? data.error, new_balance: data.balance ?? data.newBalance })
      }

      case "list_shops": {
        const status = (input.status as string) ?? "all"
        const search = (input.search as string | undefined) ?? ""
        const limit = Number(input.limit ?? 20)
        const params = new URLSearchParams()
        if (status !== "all") params.set("status", status)
        if (search) params.set("search", search)
        params.set("limit", String(limit))
        const qs = params.toString()
        const res = await fetch(
          `${ctx.baseUrl}/api/admin/shops${qs ? `?${qs}` : ""}`,
          { headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to fetch shops" }
        const shops: Record<string, unknown>[] = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : []
        return sanitize(shops.map((s) => ({
          id: s.id,
          name: s.shop_name,
          slug: s.shop_slug,
          owner: s.owner_name ?? s.user_id,
          is_active: s.is_active,
          created_at: s.created_at,
        })))
      }

      case "manage_shop": {
        if (input.action === "get") {
          let query = supabaseAdmin
            .from("user_shops")
            .select("id, shop_name, shop_slug, is_active, created_at, user_id, bank_name, account_number, momo_number, momo_network")
          if (input.shop_id) query = query.eq("id", input.shop_id as string)
          else if (input.slug) query = query.eq("shop_slug", input.slug as string)
          else return { error: "Provide shop_id or slug for get" }
          const { data, error } = await query.maybeSingle()
          if (error || !data) return { error: "Shop not found" }
          return sanitize(data)
        }

        if (!input.shop_id) return { error: "shop_id is required for approve/reject" }
        const endpoint = input.action === "approve"
          ? `${ctx.baseUrl}/api/admin/shops/approve`
          : `${ctx.baseUrl}/api/admin/shops/reject`
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ shopId: input.shop_id, reason: input.reason }),
        })
        const data = await res.json()
        return { success: res.ok, action: input.action, message: data.message ?? data.error }
      }

      case "list_withdrawals": {
        const status = (input.status as string) ?? "pending"
        const limit = Number(input.limit ?? 20)
        const res = await fetch(
          `${ctx.baseUrl}/api/admin/withdrawals/list?status=${status}&limit=${limit}`,
          { headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to fetch withdrawals" }
        const items = data.withdrawals ?? data.data ?? data ?? []
        return sanitize(items.map((w: Record<string, unknown>) => ({
          id: w.id,
          shop: w.shop_name ?? w.shop_id,
          amount: w.amount,
          status: w.status,
          requested_at: w.created_at,
          bank: w.bank_name,
          account: w.account_number,
        })))
      }

      case "manage_withdrawal": {
        if (!input.withdrawal_id) return { error: "withdrawal_id is required" }

        if (input.action === "get") {
          const { data, error } = await supabaseAdmin
            .from("withdrawal_requests")
            .select("id, shop_id, amount, status, bank_name, account_number, account_name, created_at, updated_at, rejection_reason")
            .eq("id", input.withdrawal_id as string)
            .maybeSingle()
          if (error || !data) return { error: "Withdrawal not found" }
          return sanitize(data)
        }

        const endpoints: Record<string, string> = {
          approve: `${ctx.baseUrl}/api/admin/withdrawals/approve`,
          reject: `${ctx.baseUrl}/api/admin/withdrawals/reject`,
          complete: `${ctx.baseUrl}/api/admin/withdrawals/complete`,
        }
        const url = endpoints[input.action as string]
        if (!url) return { error: `Invalid action: ${input.action}. Use get, approve, reject, or complete.` }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ withdrawalId: input.withdrawal_id, reason: input.reason }),
        })
        const data = await res.json()
        return { success: res.ok, action: input.action, message: data.message ?? data.error }
      }

      case "manage_packages": {
        const action = input.action as string

        if (action === "list") {
          let q = supabaseAdmin
            .from("packages")
            .select("id, network, name, size, price, dealer_price, active")
            .order("network")
          // Apply network filter when provided — keeps result small and avoids truncation
          if (input.network) q = q.ilike("network", `%${input.network}%`)
          const { data, error } = await q
          if (error) return { error: error.message }
          // Sort by size numerically so AI sees correct ordering (1, 2, 5, 10 not 1, 10, 2, 5)
          const sorted = (data ?? []).sort((a, b) => Number(a.size) - Number(b.size))
          return sorted  // admin-only — no sanitize, dealer_price must be visible
        }

        if (action === "toggle") {
          if (!input.package_id || input.is_available === undefined) {
            return { error: "package_id and is_available are required for toggle" }
          }
          const res = await fetch(`${ctx.baseUrl}/api/admin/packages/toggle-availability`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ packageId: input.package_id, isAvailable: input.is_available }),
          })
          const data = await res.json()
          return sanitize({ success: res.ok, message: data.message ?? data.error })
        }

        if (action === "create" || action === "update") {
          const packageData: Record<string, unknown> = {}
          if (input.network) packageData.network = input.network
          if (input.name) packageData.name = input.name
          if (input.size !== undefined) packageData.size = input.size
          if (input.price !== undefined) packageData.price = input.price
          if (input.dealer_price !== undefined) packageData.dealer_price = input.dealer_price
          const res = await fetch(`${ctx.baseUrl}/api/admin/packages`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({
              packageData,
              packageId: input.package_id,
              isUpdate: action === "update",
            }),
          })
          const data = await res.json()
          return { success: res.ok, package: data.package, message: data.error }  // admin-only, no sanitize
        }

        return { error: `Unknown action: ${action}. Use list, create, update, or toggle.` }
      }

      case "manage_ussd_shop": {
        const action = input.action as string

        if (action === "list") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return Array.isArray(data.data) ? data.data : data
        }

        if (action === "get") {
          // Lookup by UUID — direct endpoint
          if (input.ussd_shop_code_id) {
            const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops/${input.ussd_shop_code_id}`, {
              headers: { Authorization: `Bearer ${ctx.jwtToken}` },
            })
            const data = await res.json()
            return res.ok ? (data.data ?? data) : { error: data.error ?? "Not found" }
          }
          // Lookup by 4-digit code — fetch list and filter
          if (input.code) {
            const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops`, {
              headers: { Authorization: `Bearer ${ctx.jwtToken}` },
            })
            const data = await res.json()
            const all = Array.isArray(data.data) ? data.data : []
            const match = all.find((c: Record<string, unknown>) => String(c.code) === String(input.code))
            return match ?? { error: `No USSD shop code found with code ${input.code}` }
          }
          return { error: "Provide either ussd_shop_code_id (UUID) or code (4-digit number) for get" }
        }

        if (action === "create") {
          if (!input.shop_id) return { error: "shop_id is required for create" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ shop_id: input.shop_id, code: input.code }),
          })
          const data = await res.json()
          return { success: res.ok, ...data }
        }

        if (action === "activate") {
          if (!input.ussd_shop_code_id) return { error: "ussd_shop_code_id is required for activate" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops/${input.ussd_shop_code_id}/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ initial_tokens: input.initial_tokens }),
          })
          const data = await res.json()
          return { success: res.ok, ...data }
        }

        if (action === "add_tokens") {
          if (!input.ussd_shop_code_id) return { error: "ussd_shop_code_id is required for add_tokens" }
          if (!input.tokens) return { error: "tokens is required for add_tokens" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/ussd-shops/${input.ussd_shop_code_id}/tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ tokens: input.tokens }),
          })
          const data = await res.json()
          return { success: res.ok, ...data }
        }

        return { error: `Unknown action: ${action}. Use list, get, create, activate, or add_tokens.` }
      }

      case "get_fulfillment_logs": {
        const params = new URLSearchParams()
        if (input.status) params.set("status", input.status as string)
        if (input.page) params.set("page", String(input.page))
        params.set("limit", String(input.limit ?? 20))
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/logs?${params}`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "get_mtn_logs": {
        const params = new URLSearchParams()
        if (input.status) params.set("status", input.status as string)
        params.set("limit", String(input.limit ?? 20))
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/mtn-logs?${params}`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "bulk_blacklist": {
        const phones = input.phones as string[]
        if (!phones?.length) return { error: "phones array is required" }
        const res = await fetch(`${ctx.baseUrl}/api/admin/blacklist/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ phones, reason: input.reason ?? "Admin bulk import" }),
        })
        const data = await res.json()
        return { success: res.ok, imported: data.count ?? data.imported, message: data.message ?? data.error }
      }

      case "set_mtn_provider": {
        if (input.provider === undefined) {
          const res = await fetch(`${ctx.baseUrl}/api/admin/settings/mtn-provider`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { provider: data.provider ?? data.value }
        }
        const res = await fetch(`${ctx.baseUrl}/api/admin/settings/mtn-provider`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ provider: input.provider }),
        })
        const data = await res.json()
        return { success: res.ok, provider: data.provider ?? data.value, error: data.error }
      }

      case "toggle_afa_auto_fulfillment": {
        if (input.enabled === undefined) {
          const res = await fetch(`${ctx.baseUrl}/api/admin/settings/afa-auto-fulfillment`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { enabled: data.setting?.enabled ?? data.enabled }
        }
        const res = await fetch(`${ctx.baseUrl}/api/admin/settings/afa-auto-fulfillment`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ enabled: input.enabled }),
        })
        const data = await res.json()
        return { success: res.ok, enabled: data.setting?.enabled ?? data.enabled, error: data.error }
      }

      case "manage_rate_limits": {
        if (input.action === "reset") {
          if (!input.endpoint || !input.identifier) {
            return { error: "endpoint and identifier are required for reset" }
          }
          const res = await fetch(`${ctx.baseUrl}/api/admin/rate-limits/reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ endpoint: input.endpoint, identifier: input.identifier }),
          })
          const data = await res.json()
          return { success: res.ok, message: data.message ?? data.error }
        }
        // list
        const params = new URLSearchParams()
        if (input.endpoint) params.set("endpoint", input.endpoint as string)
        if (input.identifier) params.set("identifier", input.identifier as string)
        params.set("limit", String(input.limit ?? 20))
        const res = await fetch(`${ctx.baseUrl}/api/admin/rate-limits?${params}`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "get_admin_stats": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/dashboard-stats`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "manage_subscription_plans": {
        const action = input.action as string

        if (action === "list") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/subscription-plans`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return sanitize(data.plans ?? data)
        }

        if (action === "delete") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/subscription-plans?id=${input.plan_id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { success: res.ok, message: data.message ?? data.error }
        }

        // create or update
        const body: Record<string, unknown> = {}
        if (input.plan_id) body.id = input.plan_id
        if (input.name) body.name = input.name
        if (input.price !== undefined) body.price = input.price
        if (input.duration_days !== undefined) body.duration_days = input.duration_days
        if (input.is_active !== undefined) body.is_active = input.is_active
        const res = await fetch(`${ctx.baseUrl}/api/admin/subscription-plans`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        return sanitize({ success: res.ok, plan: data.plan ?? data, error: data.error })
      }

      case "get_wallet_transactions": {
        const params = new URLSearchParams()
        params.set("page", String(input.page ?? 1))
        params.set("limit", String(input.limit ?? 10))
        const res = await fetch(`${ctx.baseUrl}/api/wallet/transactions?${params}`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize({ transactions: data.transactions ?? data.data ?? data, total: data.total })
      }

      case "get_transaction_history": {
        const params = new URLSearchParams()
        if (input.date_range) params.set("dateRange", input.date_range as string)
        if (input.type) params.set("type", input.type as string)
        params.set("limit", String(input.limit ?? 10))
        params.set("page", "1")
        const res = await fetch(`${ctx.baseUrl}/api/transactions/list?${params}`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize({ transactions: data.transactions ?? data.data ?? data, total: data.total })
      }

      case "get_order_stats": {
        const res = await fetch(`${ctx.baseUrl}/api/orders/stats`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        return await res.json()
      }

      case "get_subscription": {
        const res = await fetch(`${ctx.baseUrl}/api/subscriptions/current`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "get_my_shop": {
        if (!ctx.userId) return { error: "Not authenticated" }

        // Fetch the user's shop
        const { data: shop, error: shopErr } = await supabaseAdmin
          .from("user_shops")
          .select("id, shop_name, shop_slug, is_active, parent_shop_id")
          .eq("user_id", ctx.userId)
          .maybeSingle()

        if (shopErr || !shop) return { error: "No shop found for this account. Dealers get a shop after upgrading at /dashboard/upgrade." }

        // Fetch USSD code and invite codes in parallel
        const [ussdRes, invitesRes] = await Promise.all([
          supabaseAdmin
            .from("ussd_shop_codes")
            .select("code, status, token_balance, activation_fee_paid")
            .eq("shop_id", shop.id)
            .maybeSingle(),
          supabaseAdmin
            .from("shop_invites")
            .select("code, status, created_at")
            .eq("shop_id", shop.id)
            .eq("status", "active")
            .order("created_at", { ascending: false })
            .limit(3),
        ])

        return {
          shop_name: shop.shop_name,
          shop_slug: shop.shop_slug,
          storefront_url: `/shop/${shop.shop_slug}`,
          is_active: shop.is_active,
          is_sub_agent_shop: !!shop.parent_shop_id,
          ussd_shop: ussdRes.data
            ? {
                code: ussdRes.data.code,
                status: ussdRes.data.status,
                token_balance: ussdRes.data.token_balance,
                activated: ussdRes.data.activation_fee_paid,
              }
            : null,
          invite_codes: (invitesRes.data ?? []).map(i => i.code),
        }
      }

      case "get_subscription_plans": {
        const res = await fetch(`${ctx.baseUrl}/api/subscriptions/plans`)
        const data = await res.json()
        return sanitize(data.plans ?? data)
      }

      case "get_airtime_availability": {
        if (!ctx.shopSlug) return { error: "No shop context" }
        const network = input.network as string
        const res = await fetch(
          `${ctx.baseUrl}/api/shop/airtime/public-constraints?slug=${ctx.shopSlug}&network=${encodeURIComponent(network)}`
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to check availability" }
        return {
          network,
          is_available: data.isAvailable,
          all_networks_available: data.allAvailability,
          fee_percent: data.totalFeePercent,
          note: data.isAvailable
            ? `A ${data.totalFeePercent}% fee applies to airtime top-ups for ${network}.`
            : `Airtime top-up for ${network} is currently unavailable.`,
        }
      }

      case "get_results_checker_availability": {
        const res = await fetch(`${ctx.baseUrl}/api/shop/results-checker/availability`)
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to check availability" }
        return {
          available_vouchers: data.counts,
          note: "WAEC = West African Senior School Certificate, BECE = Basic Education Certificate, NOVDEC = November/December exam",
        }
      }

      case "sync_fulfillment_status": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/sync-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({
            tracking_id: input.tracking_id,
            mtn_order_id: input.mtn_order_id,
            sync_all_pending: input.sync_all_pending,
            provider: input.provider,
          }),
        })
        const data = await res.json()
        if (!res.ok) return { success: false, error: data.error ?? data.message }
        // sync_all_pending returns { updated, unchanged, failed }; single returns { success, message, newStatus }
        return sanitize(data)
      }

      case "retry_blacklisted_order": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/retry-blacklisted`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ order_id: input.order_id, order_type: input.order_type ?? "shop" }),
        })
        const data = await res.json()
        return { success: res.ok, message: data.message ?? data.error }
      }

      case "toggle_auto_fulfillment": {
        if (input.enabled === undefined) {
          // Read current status
          const res = await fetch(`${ctx.baseUrl}/api/admin/settings/auto-fulfillment`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { enabled: data.setting?.enabled ?? data.enabled, networks: data.setting?.networks }
        }
        const res = await fetch(`${ctx.baseUrl}/api/admin/settings/auto-fulfillment`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ enabled: input.enabled }),
        })
        const data = await res.json()
        return { success: res.ok, enabled: data.setting?.enabled ?? data.enabled, error: data.error }
      }

      case "toggle_mtn_auto_fulfillment": {
        if (input.enabled === undefined) {
          // Read current status
          const res = await fetch(`${ctx.baseUrl}/api/admin/settings/mtn-auto-fulfillment`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { enabled: data.enabled, updated_at: data.updated_at }
        }
        const res = await fetch(`${ctx.baseUrl}/api/admin/settings/mtn-auto-fulfillment`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({ enabled: input.enabled }),
        })
        const data = await res.json()
        return { success: res.ok, enabled: data.enabled, error: data.error }
      }

      case "get_mtn_balance": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fulfillment/mtn-balance`, {
          headers: { Authorization: `Bearer ${ctx.jwtToken}` },
        })
        const data = await res.json()
        return sanitize(data)
      }

      case "get_knowledge_base": {
        const contextLabel = ctx.userRole === "admin" ? "admin" : ctx.userId ? "dashboard" : "storefront"
        const q = String(input.query ?? "")
        const { data, error } = await supabaseAdmin
          .from("ai_knowledge")
          .select("category, question, answer")
          .eq("is_active", true)
          .contains("contexts", [contextLabel])
          .or(`question.ilike.%${q}%,answer.ilike.%${q}%,category.ilike.%${q}%`)
          .limit(5)
        if (error) return { error: error.message }
        if (!data?.length) return { found: 0, message: "No relevant entries found in the knowledge base." }
        return { found: data.length, entries: data }
      }

      case "show_action_buttons": {
        const buttons = Array.isArray(input.buttons) ? input.buttons : []
        return { __action_buttons: true, buttons, displayed: true, button_count: buttons.length }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    console.error(`[AI-TOOLS] Error executing ${name}:`, err)
    return { error: "Tool execution failed" }
  }
}
