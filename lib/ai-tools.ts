import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export type AIChatContext = "storefront" | "dashboard" | "admin"

// ─── Tool schemas ────────────────────────────────────────────────────────────

const getAvailablePackagesTool: Anthropic.Tool = {
  name: "get_available_packages",
  description: "Get the list of data packages available in this shop. Use this to show options to customers or confirm prices before ordering.",
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
  description: "Check the status of orders by customer phone number. Use when a customer asks about their order.",
  input_schema: {
    type: "object" as const,
    properties: {
      phone_number: {
        type: "string",
        description: "The customer phone number to search orders for",
      },
    },
    required: ["phone_number"],
  },
}

const prepareCheckoutTool: Anthropic.Tool = {
  name: "prepare_checkout",
  description: "Open the checkout/payment form pre-filled with a selected package. Use this when a customer has decided what to buy on the storefront.",
  input_schema: {
    type: "object" as const,
    properties: {
      shop_package_id: {
        type: "string",
        description: "The shop package ID to pre-fill in the checkout form",
      },
      network: { type: "string", description: "Network name" },
      volume_gb: { type: "number", description: "Package size in GB" },
      price: { type: "number", description: "Price in GHS as shown to the customer" },
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
  description: "Get the recent order history for the logged-in user.",
  input_schema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "Number of recent orders to fetch (default 5, max 10)",
      },
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
  description: "Admin only: get platform-wide orders with optional filters including date/time range.",
  input_schema: {
    type: "object" as const,
    properties: {
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
  description: "Admin only: update the status of a single order by ID.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The order ID to update" },
      status: { type: "string", description: "New status: completed, failed, refunded, processing" },
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
  description: "Admin only: retry fulfillment for a failed or stuck order.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The order ID to retry" },
    },
    required: ["order_id"],
  },
}

const getUserInfoTool: Anthropic.Tool = {
  name: "get_user_info",
  description: "Admin only: look up a user account by phone number or email.",
  input_schema: {
    type: "object" as const,
    properties: {
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
  description: "Admin only: get platform-wide order statistics and revenue summary.",
  input_schema: {
    type: "object" as const,
    properties: {
      period: { type: "string", description: "Time period: today, week, month (default: today)" },
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
  description: "Admin only: trigger manual fulfillment for a single pending order by ID. Use list_pending_fulfillment first to get the correct id and type.",
  input_schema: {
    type: "object" as const,
    properties: {
      order_id: { type: "string", description: "The order ID to fulfill" },
      order_type: { type: "string", description: "Order type: shop, bulk, ussd, or ussd_shop" },
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

// ─── Tool list by context ────────────────────────────────────────────────────

export function aiTools(context: AIChatContext): Anthropic.Tool[] {
  const storefront = [getAvailablePackagesTool, searchOrderStatusTool, prepareCheckoutTool]
  const dashboard = [...storefront, getWalletBalanceTool, getOrderHistoryTool, placeWalletOrderTool]
  const admin = [...dashboard, getAllOrdersTool, updateOrderStatusTool, bulkUpdateOrderStatusTool, retryFailedOrderTool, getUserInfoTool, manageBlacklistTool, getPlatformStatsTool, toggleOrderingTool, listPendingFulfillmentTool, manualFulfillOrderTool, bulkManualFulfillTool]

  if (context === "admin") return admin
  if (context === "dashboard") return dashboard
  return storefront
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
        // Storefront: shop-specific packages with markup
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
            id: p.id,
            network: (p.packages as Record<string, unknown>)?.network ?? p.network,
            size: (p.packages as Record<string, unknown>)?.size ?? p.size,
            price: p.selling_price ?? (p.packages as Record<string, unknown>)?.price,
            package_id: p.package_id,
          })))
        }

        // Dashboard / admin: base packages table, dealer pricing applied
        const isDealer = ctx.userRole === "dealer" || ctx.userRole === "admin"
        let query = supabaseAdmin
          .from("packages")
          .select("id, network, size, price, dealer_price")
          .eq("is_available", true)
          .order("network")
          .order("size")
        if (input.network) {
          query = query.ilike("network", String(input.network))
        }
        const { data, error } = await query
        if (error) return { error: error.message }
        return sanitize((data ?? []).map((p: Record<string, unknown>) => ({
          id: p.id,
          network: p.network,
          size: p.size,
          price: isDealer && p.dealer_price && Number(p.dealer_price) > 0 ? p.dealer_price : p.price,
          package_id: p.id,
        })))
      }

      case "search_order_status": {
        if (!ctx.shopId) return { error: "Shop context required" }
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
        const limit = Math.min(Number(input.limit ?? 5), 10)
        const { data, error } = await supabaseAdmin
          .from("orders")
          .select("id, network, size, status, created_at, phone_number")
          .eq("user_id", ctx.userId!)
          .order("created_at", { ascending: false })
          .limit(limit)
        if (error) return { error: error.message }
        return sanitize(data)
      }

      case "place_wallet_order": {
        // Look up the real package ID by network + size — never trust Claude to carry a UUID
        const { data: pkg, error: pkgErr } = await supabaseAdmin
          .from("packages")
          .select("id, size, price, dealer_price")
          .ilike("network", String(input.network))
          .eq("size", String(input.size))
          .eq("is_available", true)
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

        const [{ data: ordersData, error: e1 }, { data: shopData, error: e2 }, { data: ussdData, error: e3 }, { data: ussdShopData, error: e4 }] = await Promise.all([ordersQ, shopQ, ussdQ, ussdShopQ])
        if (e1) return { error: e1.message }
        if (e2) return { error: e2.message }
        if (e3) return { error: e3.message }
        if (e4) return { error: e4.message }

        const combined = [
          ...(ordersData ?? []).map(o => ({ id: o.id, table: "orders", network: o.network, size: o.size, status: o.status, phone: o.phone_number, created_at: o.created_at })),
          ...(shopData ?? []).map(o => ({ id: o.id, table: "shop_orders", network: o.network, size: `${o.volume_gb}`, status: o.order_status, phone: o.customer_phone, created_at: o.created_at })),
          ...(ussdData ?? []).map(o => ({ id: o.id, table: "ussd_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
          ...(ussdShopData ?? []).map(o => ({ id: o.id, table: "ussd_shop_orders", network: o.network, size: o.package_size, status: o.order_status, phone: o.recipient_phone, created_at: o.created_at })),
        ]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, limit)

        return sanitize({ count: combined.length, orders: combined })
      }

      case "update_order_status": {
        const id = input.order_id as string
        const newStatus = input.status as string
        const now = new Date().toISOString()

        // orders uses status field; the other three use order_status
        const attempts = [
          supabaseAdmin.from("orders").update({ status: newStatus, updated_at: now }).eq("id", id).select("id"),
          supabaseAdmin.from("shop_orders").update({ order_status: newStatus }).eq("id", id).select("id"),
          supabaseAdmin.from("ussd_orders").update({ order_status: newStatus }).eq("id", id).select("id"),
          supabaseAdmin.from("ussd_shop_orders").update({ order_status: newStatus }).eq("id", id).select("id"),
        ]

        for (const attempt of attempts) {
          const { data, error } = await attempt
          if (error) return { success: false, error: error.message }
          if (data?.length) return { success: true }
        }

        return { success: false, error: "Order not found" }
      }

      case "bulk_update_order_status": {
        if (!input.filter_status && !input.filter_network && !input.date_from && !input.date_to) {
          return { error: "At least one filter is required for bulk update to prevent accidental mass changes." }
        }

        const newStatus = input.new_status as string

        function buildBulkQ(
          table: "orders" | "shop_orders" | "ussd_orders" | "ussd_shop_orders",
          statusField: "status" | "order_status",
          extraFilter?: { field: string; value: string }
        ) {
          let q = supabaseAdmin.from(table).update(
            statusField === "status"
              ? { status: newStatus, updated_at: new Date().toISOString() }
              : { order_status: newStatus }
          )
          if (extraFilter) q = q.eq(extraFilter.field, extraFilter.value)
          if (input.filter_status) q = q.eq(statusField, input.filter_status as string)
          if (input.filter_network) q = q.ilike("network", input.filter_network as string)
          if (input.date_from) q = q.gte("created_at", input.date_from as string)
          if (input.date_to) q = q.lte("created_at", input.date_to as string)
          return q
        }

        const [{ error: e1 }, { error: e2 }, { error: e3 }, { error: e4 }] = await Promise.all([
          buildBulkQ("orders", "status"),
          buildBulkQ("shop_orders", "order_status", { field: "payment_status", value: "completed" }),
          buildBulkQ("ussd_orders", "order_status", { field: "payment_status", value: "completed" }),
          buildBulkQ("ussd_shop_orders", "order_status", { field: "payment_status", value: "completed" }),
        ])

        const errs = [e1, e2, e3, e4].filter(Boolean)
        if (errs.length) return { error: errs.map(e => e!.message).join("; ") }
        return { success: true, message: `Orders updated to "${newStatus}" across all order types.` }
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
        if (!input.phone && !input.email) return { error: "Provide phone or email" }
        let query = supabaseAdmin
          .from("users")
          .select("id, first_name, last_name, email, phone_number, role, created_at")
        if (input.phone) query = query.eq("phone_number", input.phone as string)
        if (input.email) query = query.eq("email", input.email as string)
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

      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    console.error(`[AI-TOOLS] Error executing ${name}:`, err)
    return { error: "Tool execution failed" }
  }
}
