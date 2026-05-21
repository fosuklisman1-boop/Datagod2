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

// ─── Tool list by context ────────────────────────────────────────────────────

export function aiTools(context: AIChatContext): Anthropic.Tool[] {
  const storefront = [getAvailablePackagesTool, searchOrderStatusTool, prepareCheckoutTool]
  const dashboard = [...storefront, getWalletBalanceTool, getOrderHistoryTool, placeWalletOrderTool]
  const admin = [...dashboard, getAllOrdersTool, updateOrderStatusTool, bulkUpdateOrderStatusTool, retryFailedOrderTool, getUserInfoTool, manageBlacklistTool, getPlatformStatsTool, toggleOrderingTool]

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
        let query = supabaseAdmin
          .from("orders")
          .select("id, network, size, status, phone_number, created_at")
          .order("created_at", { ascending: false })
          .limit(limit)
        if (input.status) query = query.eq("status", input.status as string)
        if (input.network) query = query.ilike("network", input.network as string)
        if (input.phone) query = query.eq("phone_number", input.phone as string)
        if (input.date_from) query = query.gte("created_at", input.date_from as string)
        if (input.date_to) query = query.lte("created_at", input.date_to as string)
        const { data, error } = await query
        if (error) return { error: error.message }
        return sanitize({ count: data?.length ?? 0, orders: data })
      }

      case "update_order_status": {
        const { error } = await supabaseAdmin
          .from("orders")
          .update({ status: input.status as string, updated_at: new Date().toISOString() })
          .eq("id", input.order_id as string)
        return { success: !error, error: error?.message }
      }

      case "bulk_update_order_status": {
        let query = supabaseAdmin
          .from("orders")
          .update({ status: input.new_status as string, updated_at: new Date().toISOString() })
        if (input.filter_status) query = query.eq("status", input.filter_status as string)
        if (input.filter_network) query = query.ilike("network", input.filter_network as string)
        if (input.date_from) query = query.gte("created_at", input.date_from as string)
        if (input.date_to) query = query.lte("created_at", input.date_to as string)
        // Safety: require at least one filter so we never accidentally update ALL orders
        if (!input.filter_status && !input.filter_network && !input.date_from && !input.date_to) {
          return { error: "At least one filter is required for bulk update to prevent accidental mass changes." }
        }
        const { error: updateError } = await query
        if (updateError) return { error: updateError.message }
        return { success: true, message: `Orders updated to "${input.new_status}" successfully.` }
      }

      case "retry_failed_order": {
        const res = await fetch(`${ctx.baseUrl}/api/admin/fix-failed-orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.jwtToken}`,
          },
          body: JSON.stringify({ order_id: input.order_id }),
        })
        const data = await res.json()
        return { success: res.ok, message: data.message ?? data.error }
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
          const { error } = await supabaseAdmin
            .from("blacklisted_phone_numbers")
            .upsert({ phone_number: input.phone_number, reason: input.reason ?? "Admin action", created_at: new Date().toISOString() })
          return { success: !error, action: "added", error: error?.message }
        } else {
          const { error } = await supabaseAdmin
            .from("blacklisted_phone_numbers")
            .delete()
            .eq("phone_number", input.phone_number as string)
          return { success: !error, action: "removed", error: error?.message }
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

        const { data, error } = await supabaseAdmin
          .from("orders")
          .select("status, price")
          .gte("created_at", since)
        if (error) return { error: error.message }

        const total = data.length
        const completed = data.filter(o => o.status === "completed").length
        const failed = data.filter(o => o.status === "failed").length
        const processing = data.filter(o => o.status === "processing" || o.status === "pending").length
        const revenue = data.filter(o => o.status === "completed").reduce((s, o) => s + Number(o.price ?? 0), 0)

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
        const { error } = await supabaseAdmin
          .from("app_settings")
          .update({ ordering_enabled: input.enabled })
          .not("id", "is", null)
        return { success: !error, ordering_enabled: input.enabled, error: error?.message }
      }

      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    console.error(`[AI-TOOLS] Error executing ${name}:`, err)
    return { error: "Tool execution failed" }
  }
}
