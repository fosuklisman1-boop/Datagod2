import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type AIChatContext = "storefront" | "dashboard" | "admin" | "home" | "whatsapp"

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
      status: { type: "string", enum: ["pending", "processing", "completed", "failed"], description: "Filter by order status" },
      network: { type: "string", description: "Filter by network" },
      phone: { type: "string", description: "Filter by customer phone number" },
      date_from: { type: "string", description: "ISO timestamp start e.g. 2026-05-21T00:00:00" },
      date_to: { type: "string", description: "ISO timestamp end e.g. 2026-05-21T16:00:00" },
      limit: { type: "number", description: "Max results per table (default 10). If the response has truncated:true, the actual matching total is higher — pass the same filters to bulk_update_order_status to act on all of them." },
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
      status: { type: "string", enum: ["pending", "processing", "completed", "failed"], description: "New status to set" },
    },
    required: ["order_id", "status"],
  },
}

const bulkUpdateOrderStatusTool: Anthropic.Tool = {
  name: "bulk_update_order_status",
  description: "Admin only: update the status of ALL orders matching the given filters in one operation. Use this instead of calling update_order_status one-by-one. Always confirm scope with the user before calling.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["pending", "processing", "completed", "failed"], description: "The new status to set on all matched orders" },
      filter_status: { type: "string", enum: ["pending", "processing", "completed", "failed"], description: "Only update orders currently in this status" },
      filter_network: { type: "string", description: "Only update orders for this network e.g. MTN" },
      date_from: { type: "string", description: "Only update orders created after this ISO timestamp e.g. 2026-05-21T00:00:00" },
      date_to: { type: "string", description: "Only update orders created before this ISO timestamp e.g. 2026-05-21T16:00:00" },
    },
    required: ["status"],
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
      action: { type: "string", enum: ["add", "remove"] },
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
      period: { type: "string", enum: ["today", "week", "month"], description: "Time period (default: today)" },
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
      order_type: { type: "string", enum: ["shop", "bulk", "ussd", "ussd_shop"], description: "Derived from the 'table' field in get_all_orders: shop_orders→shop, orders→bulk, ussd_orders→ussd, ussd_shop_orders→ussd_shop" },
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
            type: { type: "string", enum: ["shop", "bulk", "ussd", "ussd_shop"] },
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
      action: { type: "string", enum: ["suspend", "unsuspend"] },
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
      role: { type: "string", enum: ["user", "dealer", "sub_agent", "admin"], description: "New role to assign" },
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
      type: { type: "string", enum: ["credit", "debit"], description: "credit to add funds, debit to remove funds" },
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
      status: { type: "string", enum: ["pending", "active", "all"], description: "Filter by shop status (default: all)" },
      search: { type: "string", description: "Search by shop name (partial match)" },
      limit: { type: "number", description: "Max results to return (default 20)" },
    },
    required: [],
  },
}

const manageShopTool: Anthropic.Tool = {
  name: "manage_shop",
  description: "Admin only: get details of, approve, or reject a dealer shop. Action guide: 'get' requires shop_id OR slug (not both); 'approve' requires shop_id; 'reject' requires shop_id AND reason.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["get", "approve", "reject"], description: "get: fetch shop details (needs shop_id or slug). approve: approve pending shop (needs shop_id). reject: reject shop (needs shop_id + reason)." },
      shop_id: { type: "string", description: "The shop UUID. Required for approve/reject; used by get when slug is not provided." },
      slug: { type: "string", description: "The shop slug. Used by get to look up by slug instead of ID." },
      reason: { type: "string", description: "Required for reject — explain why the shop is being rejected." },
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
      status: { type: "string", enum: ["pending", "approved", "rejected", "completed", "all"], description: "Filter by withdrawal status (default: pending)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: [],
  },
}

const manageWithdrawalTool: Anthropic.Tool = {
  name: "manage_withdrawal",
  description: "Admin only: get details of, approve, reject, or complete withdrawals. For a single withdrawal use withdrawal_id. For bulk approve/reject/complete pass withdrawal_ids (array of IDs) — the server processes all in one call without needing multiple tool invocations. Always list withdrawals first so the admin can confirm the scope before acting. Action guide: 'reject' requires reason; 'approve' triggers automatic Moolre payout per withdrawal.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["get", "approve", "reject", "complete"], description: "get: fetch full details (single only). approve: approve and trigger payout. reject: decline (requires reason). complete: mark as paid." },
      withdrawal_id: { type: "string", description: "Single withdrawal ID. Use for 'get' or when acting on one withdrawal." },
      withdrawal_ids: { type: "array", items: { type: "string" }, description: "Array of withdrawal IDs for bulk approve/reject/complete. Use this instead of calling the tool once per ID — the server processes all of them." },
      reason: { type: "string", description: "Required for reject action — explain why the withdrawal is being declined." },
    },
    required: ["action"],
  },
}

// ─── Admin: USSD shop codes ───────────────────────────────────────────────────

const manageUssdShopTool: Anthropic.Tool = {
  name: "manage_ussd_shop",
  description: "Admin only: list, get, create, activate, or add tokens to USSD shop codes. Action guide: 'get' needs ussd_shop_code_id OR code (4-digit); 'create' needs shop_id (code is auto-generated if omitted); 'activate' needs ussd_shop_code_id; 'add_tokens' needs ussd_shop_code_id + tokens.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "get", "create", "activate", "add_tokens"], description: "list: view all codes. get: fetch one by UUID or 4-digit code. create: new code for a shop (needs shop_id). activate: activate a pending code (needs ussd_shop_code_id). add_tokens: credit sessions (needs ussd_shop_code_id + tokens)." },
      ussd_shop_code_id: { type: "string", description: "UUID of the USSD shop code. Required for activate and add_tokens; used by get when not looking up by 4-digit code." },
      code: { type: "string", description: "4-digit USSD code e.g. '1234'. Used by get to look up by code number; optional for create (auto-generated if omitted)." },
      shop_id: { type: "string", description: "Required for create — the shop to associate this code with." },
      initial_tokens: { type: "number", description: "Optional for activate — initial session tokens to credit on activation." },
      tokens: { type: "number", description: "Required for add_tokens — number of session tokens to add." },
    },
    required: ["action"],
  },
}

// ─── Admin: packages ─────────────────────────────────────────────────────────

const managePackagesTool: Anthropic.Tool = {
  name: "manage_packages",
  description: "Admin only: list, create, update, or toggle data packages. WORKFLOW: always call list with network filter first to get the exact package_id UUID, then call update/toggle with that UUID. Never guess a package_id. Action guide: 'update' and 'toggle' require package_id; 'create' requires network, name, size, price, dealer_price; 'toggle' requires is_available.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "update", "toggle"], description: "list: view packages (filter by network). create: add new package (needs network, name, size, price, dealer_price). update: edit existing (needs package_id). toggle: enable/disable (needs package_id + is_available)." },
      package_id: { type: "string", description: "The package UUID from list results. Required for update and toggle." },
      network: { type: "string", description: "Network name: MTN, AirtelTigo, or Telecel. Always pass when filtering list or creating." },
      name: { type: "string", description: "Package display name. Required for create." },
      size: { type: "number", description: "Package size as a plain number (e.g. 1, 2, 5) — no 'GB'. Required for create." },
      price: { type: "number", description: "Customer price in GHS. Required for create." },
      dealer_price: { type: "number", description: "Dealer wholesale price in GHS — must be lower than price. Required for create." },
      is_available: { type: "boolean", description: "Required for toggle — true to enable, false to disable." },
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
  description: "Admin only: view MTN-specific fulfillment tracking logs from the MTN provider (Sykes, DataKazina, Xpress, or EazyGhData).",
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
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata"], description: "Provider to switch to. Omit to just read current setting." },
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
      action: { type: "string", enum: ["list", "reset"], description: "list: view current blocks. reset: clear a specific block (requires endpoint + identifier)." },
      endpoint: { type: "string", description: "Endpoint name e.g. 'ai_chat', 'purchase'. Required for reset; optional filter for list." },
      identifier: { type: "string", description: "User ID or IP address. Required for reset." },
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
  description: "Admin only: list, create, update, or delete dealer subscription plans. Action guide: 'update' and 'delete' require plan_id; 'create' requires name, price, duration_days.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "update", "delete"], description: "list: view all plans. create: add new plan (needs name, price, duration_days). update: edit plan (needs plan_id). delete: remove plan (needs plan_id)." },
      plan_id: { type: "string", description: "Plan UUID. Required for update and delete." },
      name: { type: "string", description: "Plan display name. Required for create." },
      price: { type: "number", description: "Plan price in GHS. Required for create." },
      duration_days: { type: "number", description: "How many days the plan lasts. Required for create." },
      is_active: { type: "boolean", description: "Whether the plan is active (optional for update)." },
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
      date_range: { type: "string", enum: ["today", "week", "month", "3months"], description: "Time period to filter by (default: month)" },
      type: { type: "string", description: "Transaction type filter if applicable" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: [],
  },
}

const getMySalesTool: Anthropic.Tool = {
  name: "get_my_sales",
  description: "Get the dealer's sales summary and order list for a specific time period. Covers wallet orders (placed directly) and storefront shop orders (customers buying from their shop). Use when the user asks about their sales, revenue, or orders for a specific time — today, yesterday, this week, this month, or a custom date range.",
  input_schema: {
    type: "object" as const,
    properties: {
      date_range: { type: "string", enum: ["today", "yesterday", "this_week", "last_7_days", "this_month", "last_30_days"], description: "Preset time range. Leave blank if using date_from/date_to." },
      date_from: { type: "string", description: "Custom start ISO datetime e.g. '2026-05-01T00:00:00Z'. Use with date_to." },
      date_to: { type: "string", description: "Custom end ISO datetime e.g. '2026-05-15T23:59:59Z'. Defaults to now if omitted." },
      source: { type: "string", enum: ["all", "wallet_orders", "shop_orders"], description: "all = both (default). wallet_orders = own wallet purchases. shop_orders = storefront customer purchases." },
      network: { type: "string", description: "Filter by network e.g. MTN, Telecel, AT" },
      limit: { type: "number", description: "Max orders to show per source (default 10, max 50)" },
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

const manageMyUssdShopTool: Anthropic.Tool = {
  name: "manage_my_ussd_shop",
  description: "Manage the logged-in dealer's own USSD shop code. Use 'activate' to activate it (may deduct an activation fee from wallet). Use 'buy_sessions' to purchase session tokens.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["activate", "buy_sessions"], description: "activate: activate the USSD shop code (show activation fee and confirm first). buy_sessions: purchase session tokens." },
      sessions: { type: "number", description: "Number of sessions to buy. Required for buy_sessions." },
    },
    required: ["action"],
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
      network: { type: "string", enum: ["MTN", "Telecel", "AT"], description: "Network to check" },
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
      tracking_id: { type: "string", description: "Provider tracking ID — get this from get_mtn_logs" },
      mtn_order_id: { type: "string", description: "MTN order ID — get this from get_mtn_logs" },
      sync_all_pending: { type: "boolean", description: "true to sync all pending MTN orders at once (no tracking_id needed)" },
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata"], description: "Provider to sync from" },
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
      order_type: { type: "string", enum: ["shop", "bulk"], description: "shop = storefront/Paystack order, bulk = wallet/dealer order. Defaults to shop if omitted." },
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
  description: "Display clickable buttons to the user for confirmations, multi-choice selections, or page navigation. Use this INSTEAD of asking the user to type 'yes', 'no', or choose an option — buttons are faster and clearer. Call this right before or after presenting a choice. Max 4 buttons. For navigation buttons (e.g. Sign Up, Log In, Buy as Guest), set url to the page path instead of value — clicking the button will navigate to that page.",
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
            value: { type: "string", description: "Text sent as the user's reply when this button is clicked. Not needed if url is set." },
            url: { type: "string", description: "If set, clicking this button navigates to this page path (e.g. '/auth/signup', '/auth/login', '/shop/my-shop-slug'). Use for page navigation instead of sending a message." },
            style: { type: "string", enum: ["primary", "danger", "secondary"], description: "primary = blue (main action), danger = red (destructive), secondary = gray (cancel/alternative)" },
          },
          required: ["label"],
        },
      },
    },
    required: ["buttons"],
  },
}

// ─── Admin: scheduled tasks ──────────────────────────────────────────────────

const manageScheduledTaskTool: Anthropic.Tool = {
  name: "manage_scheduled_task",
  description: "Admin only: create, list, get, delete, or toggle scheduled AI tasks. A scheduled task stores a prompt that the AI cron engine runs automatically at the configured time — the stored prompt is sent to the AI exactly as written. Action guide: 'create' needs name, prompt, schedule_type (and run_at_time HH:MM UTC for daily/weekly, run_on_days [0-6] for weekly, run_at_timestamp ISO for once). 'toggle' needs task_id + is_active. 'delete' needs task_id.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["create", "list", "get", "delete", "toggle"], description: "create: add new task. list: show all tasks. get: fetch details of one task (needs task_id). delete: remove a task (needs task_id). toggle: activate/deactivate (needs task_id + is_active)." },
      task_id: { type: "string", description: "Task UUID. Required for get, delete, and toggle." },
      name: { type: "string", description: "Short descriptive name for the task. Required for create." },
      prompt: { type: "string", description: "The exact prompt that will be sent to the AI each time the task runs. Write it as a clear instruction. Required for create." },
      schedule_type: { type: "string", enum: ["once", "hourly", "daily", "weekly"], description: "How often the task runs. Required for create." },
      run_at_time: { type: "string", description: "HH:MM in GMT+0 — required for daily and weekly schedule types. Example: '18:00' = 6pm GMT+0." },
      run_on_days: { type: "array", items: { type: "number" }, description: "Days of the week to run — 0=Sun, 1=Mon … 6=Sat. Required for weekly. Example: [1,2,3,4,5] for Mon–Fri." },
      run_at_timestamp: { type: "string", description: "ISO datetime string — required for schedule_type=once. Example: '2026-06-01T18:00:00Z'." },
      is_active: { type: "boolean", description: "Required for toggle — true to activate, false to deactivate." },
      notify_channels: { type: "array", items: { type: "string", enum: ["push", "sms", "email", "whatsapp"] }, description: "Which channels to notify the task owner after each run. Defaults to ['push']." },
    },
    required: ["action"],
  },
}

// ─── Dashboard: scheduled tasks ───────────────────────────────────────────────

const scheduleTaskTool: Anthropic.Tool = {
  name: "schedule_task",
  description: "Dashboard: create, list, or delete your own scheduled AI tasks. A scheduled task runs a stored prompt through the AI automatically at the configured time — the result is delivered to you via your configured channels. Action guide: 'create' needs name, prompt, schedule_type. 'delete' needs task_id.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["create", "list", "delete"], description: "create: schedule a new task. list: view your scheduled tasks. delete: remove a task (needs task_id)." },
      task_id: { type: "string", description: "Task UUID. Required for delete." },
      name: { type: "string", description: "Short name for the task. Required for create." },
      prompt: { type: "string", description: "The instruction the AI will execute each time this task runs (e.g. 'Buy 5GB MTN for 0241234567'). Required for create." },
      schedule_type: { type: "string", enum: ["once", "hourly", "daily", "weekly"], description: "How often the task runs. Required for create." },
      run_at_time: { type: "string", description: "HH:MM in UTC — required for daily and weekly." },
      run_on_days: { type: "array", items: { type: "number" }, description: "Days to run — 0=Sun … 6=Sat. Required for weekly." },
      run_at_timestamp: { type: "string", description: "ISO datetime — required for schedule_type=once." },
      notify_channels: { type: "array", items: { type: "string", enum: ["push", "sms", "email", "whatsapp"] }, description: "How to be notified after each run. Defaults to ['push']." },
    },
    required: ["action"],
  },
}

// ─── Admin: send notifications ────────────────────────────────────────────────

const sendNotificationTool: Anthropic.Tool = {
  name: "send_notification",
  description: "Admin only: send push, SMS, WhatsApp, and/or email notifications to users or dealers. Use for announcements, alerts, or direct messages. Confirm the target and message with the admin before sending.",
  input_schema: {
    type: "object" as const,
    properties: {
      target: { type: "string", enum: ["specific_user", "all_dealers", "all_users", "all_admins"], description: "Who to notify. specific_user requires user_id." },
      user_id: { type: "string", description: "Target user UUID. Required when target=specific_user." },
      channels: { type: "array", items: { type: "string", enum: ["push", "sms", "email", "whatsapp"] }, description: "Which channels to send on. Defaults to ['push']." },
      title: { type: "string", description: "Notification title (used for push and email subject). Required." },
      body: { type: "string", description: "Notification body text (push body, SMS text, email plain text). Required." },
      email_html: { type: "string", description: "Optional HTML email body. Falls back to body as plain text if omitted." },
    },
    required: ["target", "title", "body"],
  },
}

const notifySelfTool: Anthropic.Tool = {
  name: "notify_self",
  description: "Send a push notification and/or SMS to yourself (the current user). Use this to deliver reminders, confirmations, or any message the user should receive on their device. For REMINDER ONLY scheduled tasks, always call this tool to deliver the reminder — do not just return text.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Notification title. Keep it short (< 60 chars)." },
      message: { type: "string", description: "Notification body / SMS text. Keep under 160 chars for SMS." },
      channels: { type: "array", items: { type: "string", enum: ["push", "sms", "whatsapp"] }, description: "Which channels to use. Defaults to ['push']." },
    },
    required: ["title", "message"],
  },
}

const startOrderingBotTool: Anthropic.Tool = {
  name: "start_ordering_bot",
  description: "Switch the conversation to the structured ordering menu. Call this when the user expresses intent to buy a data bundle, airtime, AFA registration, or results checker vouchers. Do not call this for general queries about pricing or services.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone: {
        type: "string",
        description: "The user's WhatsApp phone number as received from Meta webhook (e.g. '233559919037').",
      },
    },
    required: ["phone"],
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
    getMySalesTool,
    placeWalletOrderTool,
    getSubscriptionTool,
    getSubscriptionPlansTool,
    getMyShopTool,
    manageMyUssdShopTool,
    scheduleTaskTool,
    notifySelfTool,
    getKnowledgeBaseTool,
    showActionButtonsTool,
  ]

  // WhatsApp: platform support with account actions when the sender phone is matched.
  if (context === "whatsapp") return [
    getAvailablePackagesTool,
    searchOrderStatusTool,
    getWalletBalanceTool,
    getWalletTransactionsTool,
    getOrderHistoryTool,
    placeWalletOrderTool,
    getSubscriptionPlansTool,
    notifySelfTool,
    getKnowledgeBaseTool,
    startOrderingBotTool,
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
    // Scheduled tasks & notifications
    manageScheduledTaskTool,
    sendNotificationTool,
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

// Admin-only tool names. These either mutate platform state or read data via the
// service-role client. Tool-list gating (aiTools("admin")) and downstream HTTP
// auth are NOT sufficient on their own: a context-confusion bug can surface the
// admin toolset to a non-admin, and the direct service-role read tools never hit
// an HTTP auth check. Every one of these is gated on ctx.userRole === "admin" below.
const ADMIN_ONLY_TOOLS = new Set<string>([
  "get_all_orders", "update_order_status", "bulk_update_order_status", "retry_failed_order",
  "list_users", "get_user_info", "suspend_user", "update_user_role", "adjust_wallet_balance",
  "list_shops", "manage_shop", "list_withdrawals", "manage_withdrawal",
  "manage_ussd_shop", "manage_packages", "manage_blacklist", "bulk_blacklist",
  "list_pending_fulfillment", "manual_fulfill_order", "bulk_manual_fulfill",
  "sync_fulfillment_status", "retry_blacklisted_order",
  "toggle_ordering", "toggle_auto_fulfillment", "toggle_mtn_auto_fulfillment",
  "toggle_afa_auto_fulfillment", "set_mtn_provider", "get_mtn_balance",
  "manage_rate_limits", "get_platform_stats", "get_admin_stats", "manage_subscription_plans",
  "get_fulfillment_logs", "get_mtn_logs", "manage_scheduled_task", "send_notification",
])

// ─── executeToolCall ─────────────────────────────────────────────────────────

export async function executeToolCall(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  try {
    // Defense in depth: never execute an admin-only tool for a non-admin caller,
    // regardless of which tool list was offered or how the context was resolved.
    if (ADMIN_ONLY_TOOLS.has(name) && ctx.userRole !== "admin") {
      return { error: "Not authorized" }
    }

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

        // Home/public context — no shop, no user; show base catalog at retail price
        if (!ctx.userId) {
          let query = supabaseAdmin
            .from("packages")
            .select("id, network, size, price")
            .eq("active", true)
            .order("network")
          if (input.network) query = query.ilike("network", `%${String(input.network)}%`)
          const { data, error } = await query
          if (error) return { error: error.message }
          return sanitize(
            (data ?? [])
              .sort((a, b) => Number(a.size) - Number(b.size))
              .map((p: Record<string, unknown>) => ({ id: p.id, network: p.network, size: p.size, price: p.price }))
          )
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

        // Home context with no auth: phone lookups are not allowed (prevents enumeration)
        if (!ctx.userId && !ctx.shopId) return { error: "Phone number lookup requires logging in. Use order ID or reference code to check your order." }

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
        // CRON_SECRET path: no valid user JWT — query DB directly
        if (process.env.CRON_SECRET && ctx.jwtToken === process.env.CRON_SECRET && ctx.userId) {
          const { data, error } = await supabaseAdmin
            .from("wallets")
            .select("balance")
            .eq("user_id", ctx.userId)
            .maybeSingle()
          if (error) return { error: error.message }
          return { balance: data?.balance ?? 0 }
        }
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
        if (process.env.CRON_SECRET && ctx.jwtToken === process.env.CRON_SECRET && ctx.userId) {
          const { data, error } = await supabaseAdmin
            .from("combined_orders_view")
            .select("id, network, volume_gb, status, phone_number, created_at, type, price, order_code")
            .eq("user_id", ctx.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
          if (error) return { error: error.message }
          return sanitize({ orders: data ?? [], total: data?.length ?? 0 })
        }
        const res = await fetch(
          `${ctx.baseUrl}/api/orders/list?limit=${limit}&page=1`,
          { headers: { Authorization: `Bearer ${ctx.jwtToken}` } }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Failed to fetch orders" }
        return sanitize({ orders: data.orders, total: data.pagination?.total })
      }

      case "place_wallet_order": {
        if (!ctx.userId) {
          return { error: "A matched Datagod account is required before placing wallet orders from WhatsApp." }
        }

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
            // Required when jwtToken is CRON_SECRET — purchase route reads userId from body
            ...(ctx.userId ? { userId: ctx.userId } : {}),
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

      case "start_ordering_bot": {
        const { setWaSession } = await import("@/lib/whatsapp-bot/session")
        const { mainMenu } = await import("@/lib/ussd/menus")
        const phone = String(input.phone ?? "").trim()
        if (!phone) return { error: "phone is required" }
        await setWaSession(phone, { step: "MAIN", dialingPhone: phone })
        return { message: mainMenu() }
      }

      case "get_all_orders": {
        if (ctx.userRole !== "admin") return { error: "Not authorized" }
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
          if (r1.data) return sanitize({ ...r1.data, table: "orders" })
          if (r2.data) return sanitize({ ...r2.data, table: "shop_orders" })
          if (r3.data) return sanitize({ ...r3.data, table: "ussd_orders" })
          if (r4.data) return sanitize({ ...r4.data, table: "ussd_shop_orders" })
          if (r5.data) return sanitize({ ...r5.data, table: "api_orders" })
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

        const allRows = [
          ...(ordersData ?? []).map(o => ({ id: o.id, table: "orders", network: o.network, size: o.size, status: o.status, phone: o.phone_number, created_at: o.created_at })),
          ...(shopData ?? []).map(o => ({ id: o.id, table: "shop_orders", network: o.network, size: `${o.volume_gb}`, status: o.order_status, phone: o.customer_phone, created_at: o.created_at })),
          ...(ussdData ?? []).map(o => ({ id: o.id, table: "ussd_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
          ...(ussdShopData ?? []).map(o => ({ id: o.id, table: "ussd_shop_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
          ...(apiData ?? []).map(o => ({ id: o.id, table: "api_orders", network: o.network, size: `${o.volume_gb}`, status: o.status, phone: o.recipient_phone, created_at: o.created_at })),
        ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

        // truncated=true means the per-table limit was hit on at least one table — the true total may be higher
        const truncated = (ordersData?.length ?? 0) === limit || (shopData?.length ?? 0) === limit ||
          (ussdData?.length ?? 0) === limit || (ussdShopData?.length ?? 0) === limit || (apiData?.length ?? 0) === limit
        const combined = allRows.slice(0, limit)

        return sanitize({
          count: combined.length,
          truncated,
          note: truncated ? "Results are capped — the true total matching orders may be higher. Use bulk_update_order_status with the same filters to act on all of them, or narrow filters for an accurate count." : undefined,
          orders: combined,
        })
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

        const newStatus = (input.status ?? input.new_status) as string
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
            .select("id, shop_name, shop_slug, is_active, created_at, user_id")
          if (input.shop_id) query = query.eq("id", input.shop_id as string)
          else if (input.slug) query = query.or(shopHandleOrFilter(input.slug as string))
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
        const action = input.action as string

        if (action === "get") {
          if (!input.withdrawal_id) return { error: "withdrawal_id is required for get" }
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
        const url = endpoints[action]
        if (!url) return { error: `Invalid action: ${action}. Use get, approve, reject, or complete.` }

        // Bulk mode — process all IDs sequentially, collect results
        const bulkIds = Array.isArray(input.withdrawal_ids) && (input.withdrawal_ids as string[]).length > 0
          ? (input.withdrawal_ids as string[])
          : input.withdrawal_id ? [input.withdrawal_id as string] : null
        if (!bulkIds) return { error: "withdrawal_id or withdrawal_ids is required" }

        const results: Array<{ id: string; success: boolean; message: string }> = []
        for (const id of bulkIds) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
              body: JSON.stringify({ withdrawalId: id, reason: input.reason }),
            })
            const data = await res.json()
            results.push({ id, success: res.ok, message: data.message ?? data.error ?? (res.ok ? "OK" : "Failed") })
          } catch {
            results.push({ id, success: false, message: "Request error" })
          }
        }

        if (results.length === 1) {
          return { success: results[0].success, action, message: results[0].message }
        }
        const succeeded = results.filter(r => r.success).length
        const failures = results.filter(r => !r.success)
        return {
          action,
          total: results.length,
          succeeded,
          failed_count: failures.length,
          ...(failures.length > 0 ? { failures } : {}),
          message: `${succeeded} of ${results.length} ${action}d successfully${failures.length > 0 ? ` — ${failures.length} failed` : ""}`,
        }
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
        if (process.env.CRON_SECRET && ctx.jwtToken === process.env.CRON_SECRET && ctx.userId) {
          const limit = Math.min(Number(input.limit ?? 10), 20)
          const { data, error } = await supabaseAdmin
            .from("transactions")
            .select("id, type, amount, description, reference_id, source, created_at")
            .eq("user_id", ctx.userId)
            .order("created_at", { ascending: false })
            .limit(limit)
          if (error) return { error: error.message }
          return sanitize({ transactions: data ?? [], total: data?.length ?? 0 })
        }
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

      case "get_my_sales": {
        if (!ctx.userId) return { error: "Not authenticated" }

        // Resolve date range to ISO timestamps
        const now = new Date()
        let fromDate: string
        let toDate: string = now.toISOString()

        if (input.date_from) {
          fromDate = input.date_from as string
          toDate = (input.date_to as string) || toDate
        } else {
          const range = (input.date_range as string) || "today"
          const d = new Date(now)
          if (range === "today") {
            d.setUTCHours(0, 0, 0, 0)
          } else if (range === "yesterday") {
            d.setUTCDate(d.getUTCDate() - 1); d.setUTCHours(0, 0, 0, 0)
            const end = new Date(d); end.setUTCHours(23, 59, 59, 999); toDate = end.toISOString()
          } else if (range === "this_week") {
            const day = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1)); d.setUTCHours(0, 0, 0, 0)
          } else if (range === "last_7_days") {
            d.setUTCDate(d.getUTCDate() - 7)
          } else if (range === "this_month") {
            d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
          } else if (range === "last_30_days") {
            d.setUTCDate(d.getUTCDate() - 30)
          }
          fromDate = d.toISOString()
        }

        const limit = Math.min(Number(input.limit ?? 10), 50)
        const source = (input.source as string) || "all"
        const networkFilter = input.network as string | undefined

        const results: Record<string, unknown> = { period: { from: fromDate, to: toDate } }

        // Wallet orders (dealer's own purchases)
        if (source === "all" || source === "wallet_orders") {
          let q = supabaseAdmin
            .from("combined_orders_view")
            .select("id, network, volume_gb, status, phone_number, created_at, price, order_code")
            .eq("user_id", ctx.userId)
            .gte("created_at", fromDate)
            .lte("created_at", toDate)
            .order("created_at", { ascending: false })
            .limit(limit)
          if (networkFilter) q = q.ilike("network", networkFilter)
          const { data: walletOrders } = await q
          const orders = walletOrders ?? []
          results.wallet_orders = {
            total: orders.length,
            completed: orders.filter(o => o.status === "completed").length,
            failed: orders.filter(o => o.status === "failed").length,
            orders: orders.map(o => ({
              id: o.id, network: o.network, size: `${o.volume_gb}GB`,
              status: o.status, phone: o.phone_number,
              price: o.price, order_code: o.order_code, date: o.created_at,
            })),
          }
        }

        // Storefront shop orders (customers buying from dealer's shop)
        if (source === "all" || source === "shop_orders") {
          const { data: shop } = await supabaseAdmin
            .from("user_shops").select("id").eq("user_id", ctx.userId).maybeSingle()

          if (shop) {
            let q = supabaseAdmin
              .from("shop_orders")
              .select("id, network, volume_gb, order_status, customer_phone, created_at, total_price, reference_code, payment_status")
              .eq("shop_id", shop.id)
              .eq("payment_status", "completed")
              .gte("created_at", fromDate)
              .lte("created_at", toDate)
              .order("created_at", { ascending: false })
              .limit(limit)
            if (networkFilter) q = q.ilike("network", networkFilter)
            const { data: shopOrders } = await q
            const orders = shopOrders ?? []
            const revenue = orders.filter(o => o.order_status === "completed").reduce((s, o) => s + Number(o.total_price ?? 0), 0)
            results.shop_orders = {
              total: orders.length,
              completed: orders.filter(o => o.order_status === "completed").length,
              failed: orders.filter(o => o.order_status === "failed").length,
              total_revenue: `GHS ${revenue.toFixed(2)}`,
              orders: orders.map(o => ({
                id: o.id, network: o.network, size: `${o.volume_gb}GB`,
                status: o.order_status, customer_phone: o.customer_phone,
                total_price: o.total_price, reference_code: o.reference_code, date: o.created_at,
              })),
            }
          } else {
            results.shop_orders = { note: "No shop found for this account." }
          }
        }

        return results
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
          .select("id, shop_name, shop_slug, subdomain, is_active, parent_shop_id")
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

        const rootDomain = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()
        return {
          shop_name: shop.shop_name,
          shop_slug: shop.shop_slug,
          subdomain: shop.subdomain,
          storefront_url: shop.subdomain ? `https://${shop.subdomain}.${rootDomain}` : `/shop/${shop.shop_slug}`,
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

      case "manage_my_ussd_shop": {
        const action = input.action as string

        if (action === "activate") {
          const res = await fetch(`${ctx.baseUrl}/api/dashboard/ussd-shop/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({}),
          })
          const data = await res.json()
          if (!res.ok) return { error: data.error ?? "Activation failed" }
          return { success: true, message: "Your USSD shop code is now active! Customers can use it right away." }
        }

        if (action === "buy_sessions") {
          if (!input.sessions || Number(input.sessions) < 1) return { error: "sessions must be a positive number" }
          const res = await fetch(`${ctx.baseUrl}/api/dashboard/ussd-shop/buy-sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ sessions: Number(input.sessions) }),
          })
          const data = await res.json()
          if (!res.ok) return { error: data.error ?? "Failed to purchase sessions" }
          return { success: true, new_token_balance: data.new_token_balance }
        }

        return { error: `Unknown action: ${action}. Use activate or buy_sessions.` }
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
        // Escape ilike wildcards to prevent full-table dumps via % or _ injection
        const q = String(input.query ?? "").replace(/[%_\\]/g, "\\$&").slice(0, 200)
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

      case "manage_scheduled_task": {
        const action = input.action as string

        if (action === "list") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          if (!res.ok) return { error: data.error ?? "Failed to fetch tasks" }
          return data.tasks ?? data
        }

        if (action === "get") {
          if (!input.task_id) return { error: "task_id is required for get" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks/${input.task_id}`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          if (!res.ok) return { error: data.error ?? "Task not found" }
          return data.task ?? data
        }

        if (action === "delete") {
          if (!input.task_id) return { error: "task_id is required for delete" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks/${input.task_id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { success: res.ok, message: data.message ?? data.error }
        }

        if (action === "toggle") {
          if (!input.task_id || input.is_active === undefined) {
            return { error: "task_id and is_active are required for toggle" }
          }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks/${input.task_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({ is_active: input.is_active }),
          })
          const data = await res.json()
          return { success: res.ok, message: data.message ?? data.error }
        }

        if (action === "create") {
          if (!input.name || !input.prompt || !input.schedule_type) {
            return { error: "name, prompt, and schedule_type are required for create" }
          }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({
              name: input.name,
              prompt: input.prompt,
              context: "admin",
              schedule_type: input.schedule_type,
              run_at_time: input.run_at_time,
              run_on_days: input.run_on_days,
              run_at_timestamp: input.run_at_timestamp,
              notify_channels: input.notify_channels ?? ["push"],
            }),
          })
          const data = await res.json()
          return { success: res.ok, task: data.task, message: data.error }
        }

        return { error: `Unknown action: ${action}. Use create, list, get, delete, or toggle.` }
      }

      case "schedule_task": {
        const action = input.action as string

        if (action === "list") {
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks?scope=own`, {
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          if (!res.ok) return { error: data.error ?? "Failed to fetch tasks" }
          return data.tasks ?? data
        }

        if (action === "delete") {
          if (!input.task_id) return { error: "task_id is required for delete" }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks/${input.task_id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${ctx.jwtToken}` },
          })
          const data = await res.json()
          return { success: res.ok, message: data.message ?? data.error }
        }

        if (action === "create") {
          if (!input.name || !input.prompt || !input.schedule_type) {
            return { error: "name, prompt, and schedule_type are required" }
          }
          const res = await fetch(`${ctx.baseUrl}/api/admin/scheduled-tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
            body: JSON.stringify({
              name: input.name,
              prompt: input.prompt,
              context: "dashboard",
              schedule_type: input.schedule_type,
              run_at_time: input.run_at_time,
              run_on_days: input.run_on_days,
              run_at_timestamp: input.run_at_timestamp,
              notify_channels: input.notify_channels ?? ["push"],
            }),
          })
          const data = await res.json()
          return { success: res.ok, task: data.task, message: data.error }
        }

        return { error: `Unknown action: ${action}. Use create, list, or delete.` }
      }

      case "send_notification": {
        if (!input.title || !input.body) return { error: "title and body are required" }
        const res = await fetch(`${ctx.baseUrl}/api/admin/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({
            target: input.target,
            user_id: input.user_id,
            channels: input.channels ?? ["push"],
            title: input.title,
            body: input.body,
            email_html: input.email_html,
          }),
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Notification failed" }
        return data
      }

      case "notify_self": {
        if (!input.title || !input.message) return { error: "title and message are required" }
        const res = await fetch(`${ctx.baseUrl}/api/user/notify-self`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.jwtToken}` },
          body: JSON.stringify({
            title: input.title,
            message: input.message,
            channels: input.channels ?? ["push"],
            ...(ctx.userId ? { userId: ctx.userId } : {}),
          }),
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error ?? "Notification failed" }
        return data
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    console.error(`[AI-TOOLS] Error executing ${name}:`, err)
    return { error: "Tool execution failed" }
  }
}
