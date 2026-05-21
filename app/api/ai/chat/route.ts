import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"
import { NextRequest } from "next/server"
import { aiTools, executeToolCall, AIChatContext } from "@/lib/ai-tools"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

function getBaseUrl(req: NextRequest): string {
  const host = req.headers.get("host") ?? "localhost:3000"
  const proto = process.env.NODE_ENV === "production" ? "https" : "http"
  return `${proto}://${host}`
}

export async function POST(req: NextRequest) {
  const { messages, context, shopSlug, shopId } = await req.json() as {
    messages: Anthropic.MessageParam[]
    context: AIChatContext
    shopSlug?: string
    shopId?: string
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  let userId: string | undefined
  let jwtToken: string | undefined
  let userRole = "guest"
  let userContext: Record<string, string> = {}

  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    jwtToken = authHeader.slice(7)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(jwtToken)
    if (!error && user) {
      userId = user.id

      if (context === "admin") {
        const { data: profile } = await supabaseAdmin
          .from("users")
          .select("role")
          .eq("id", userId)
          .single()
        if (profile?.role !== "admin") {
          return new Response(
            JSON.stringify({ error: "Admin access required" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          )
        }
        userRole = "admin"
      } else {
        userRole = "dashboard"
      }
    }
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rl = await applyRateLimit(req, "ai_chat", RATE_LIMITS.AI_CHAT.maxRequests, RATE_LIMITS.AI_CHAT.windowMs, userId)
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: RATE_LIMITS.AI_CHAT.message }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    )
  }

  // ── User context (dashboard + admin only) ─────────────────────────────────
  if (userId && (context === "dashboard" || context === "admin")) {
    const [profileRes, walletRes, ordersRes] = await Promise.all([
      supabaseAdmin.from("users").select("first_name, last_name, phone_number, role").eq("id", userId).single(),
      supabaseAdmin.from("wallets").select("balance").eq("user_id", userId).maybeSingle(),
      supabaseAdmin.from("orders").select("network, size, status, created_at, phone_number").eq("user_id", userId).order("created_at", { ascending: false }).limit(5),
    ])

    const p = profileRes.data
    const w = walletRes.data
    const recentOrders = (ordersRes.data ?? [])
      .map(o => `- ${o.network} ${o.size}GB → ${o.phone_number} — ${o.status} (${new Date(o.created_at).toLocaleDateString()})`)
      .join("\n")

    userContext = {
      firstName: p?.first_name ?? "",
      lastName: p?.last_name ?? "",
      phone: p?.phone_number ?? "",
      role: p?.role ?? "user",
      balance: w?.balance !== undefined ? `GHS ${Number(w.balance).toFixed(2)}` : "unknown",
      recentOrders: recentOrders || "No recent orders",
    }
  }

  // ── Shop name for storefront ──────────────────────────────────────────────
  let shopName = shopSlug ?? "this shop"
  if (shopSlug) {
    const { data: shop } = await supabaseAdmin
      .from("user_shops")
      .select("shop_name")
      .eq("shop_slug", shopSlug)
      .maybeSingle()
    if (shop?.shop_name) shopName = shop.shop_name
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  const today = new Date().toISOString().split("T")[0]   // e.g. 2026-05-22 — recomputed every request
  let systemPrompt: string

  const knowledgeBaseRule = `
When a user asks a question about policies, delivery times, refunds, procedures, or anything not directly in your context — call get_knowledge_base first before answering from memory.`

  const formattingRules = `
FORMATTING RULES (always follow these):
- Use **bold** for package names, prices, network names, and order statuses
- Use numbered lists (1. 2. 3.) when presenting multiple packages or steps
- Use bullet points (-) for feature lists or options
- Add a blank line between sections when the response has multiple parts
- For order status results, show each order on its own line with clear labels
- Keep individual sentences short — one idea per line where possible
- Never dump a wall of text; break it into readable chunks`

  if (context === "storefront") {
    systemPrompt = `You are the AI assistant for ${shopName}'s online data bundle shop.
Customers here are guests — no account needed, payment is via card or mobile money through Paystack.

WHAT THIS SHOP SELLS:
- Mobile data bundles for MTN, Telecel (Vodafone), and AT (AirtelTigo)
- Airtime top-up (if enabled by the shop owner — use get_airtime_availability to check)
- Exam results checker vouchers for WAEC, BECE, and NOVDEC (use get_results_checker_availability to check stock)

HOW BUYING WORKS:
1. Customer picks a package → you call prepare_checkout → a payment form opens on the page
2. Customer fills phone number and pays via Paystack (card or MoMo)
3. Data is delivered automatically after payment confirmation
4. No account or login required at any point

ORDER TRACKING:
- Customers track their order using their phone number — call search_order_status
- Delivery is usually instant after payment but can take a few minutes during high traffic

AIRTIME TOP-UP:
- Check availability first with get_airtime_availability
- If available, a fee percentage applies (e.g. 5–10%) on top of the airtime amount
- Customer pays total (airtime + fee) via Paystack
- Direct them to the Airtime section on the page if they want to proceed

RESULTS CHECKER:
- Vouchers for WAEC (WASSCE), BECE (Basic Certificate), NOVDEC (Nov/Dec sitting)
- Check stock with get_results_checker_availability before promising availability
- Customer provides email + phone, pays via Paystack, receives voucher code by email

PAYMENT & REFUNDS:
- All payments go through Paystack — the shop owner does not handle card details
- For payment issues, customers can use the payment re-verify option on the site
- Refund and dispute processes: call get_knowledge_base for policy details

${knowledgeBaseRule}
${formattingRules}`
  } else if (context === "dashboard") {
    systemPrompt = `You are the AI assistant for the Datagod platform dashboard.
You are helping ${userContext.firstName} ${userContext.lastName} — account role: **${userContext.role}**.

ACCOUNT CONTEXT (loaded at message time — may be seconds old; always call tools for live data):
- Phone: ${userContext.phone}
- Wallet balance (at send time): ${userContext.balance} — call get_wallet_balance for the current live figure
- Recent orders (at send time): call get_order_history for the latest list
${userContext.recentOrders}

═══════════════════════════════════════════
PLATFORM GUIDE — know this to help users
═══════════════════════════════════════════

WALLET & PAYMENTS:
- Wallet balance is used to place data orders
- Top up at /dashboard/wallet → card or mobile money via Paystack
- View wallet credit/debit history at /dashboard/wallet or call get_wallet_transactions
- Full transaction history (orders + wallet) at /dashboard/transactions

ORDERING DATA BUNDLES:
- Place orders via the AI (use place_wallet_order) or manually at /dashboard/data-packages
- Bulk orders: available at /dashboard/data-packages or the dashboard home page
- Order history: /dashboard/my-orders or call get_order_history
- Verify a stuck Paystack payment at /dashboard/payment-reverify

UPGRADE TO DEALER:
- Regular users can upgrade to Dealer at /dashboard/upgrade
- Upgrading requires a subscription purchase via Paystack (call get_subscription_plans to show options and prices)
- After payment clears, role automatically becomes "dealer"
- Dealer benefits: wholesale pricing, custom storefront, sub-agents, airtime, results checker, USSD shop
- If upgrades are currently disabled, tell the user to check back later

DEALER-ONLY FEATURES (only available when role = dealer or admin):
- My Shop: /dashboard/my-shop — set shop name, logo, description, manage packages and profit margins
- Shop Settings: /dashboard/my-shop/settings — WhatsApp link, announcements, custom branding
- Shop Dashboard: /dashboard/shop-dashboard — revenue stats, customer counts
- Sub-agents: /dashboard/sub-agents — invite and manage sub-agents under your shop
- Sub-agent Catalog: /dashboard/sub-agent-catalog — set up wholesale catalog for sub-agents
- Airtime top-up sales: /dashboard/airtime — sell airtime to customers
- Results Checker: /dashboard/results-checker — sell WAEC/BECE/NOVDEC exam vouchers
- AFA Orders: /dashboard/afa-orders — AFA data bundle orders
- USSD Shop: /dashboard/ussd-shop — activate *714# USSD ordering channel
- Customers: /dashboard/customers — view customer list and order history
- Buy Stock: /dashboard/buy-stock — bulk stock purchasing

SUBSCRIPTION:
- View current plan and expiry at /dashboard/upgrade or call get_subscription
- Renew or extend subscription at /dashboard/upgrade before it expires
- Sub-agents have a sub_agent role and operate under a parent dealer's shop

COMPLAINTS & SUPPORT:
- Submit a complaint at /dashboard/complaints (with evidence images for payment disputes)
- Check complaint status at /dashboard/complaints

NOTIFICATIONS:
- View all notifications at /dashboard/notifications

PROFILE:
- Update profile details at /dashboard/profile

═══════════════════════════════════════════
ORDER RULES (critical — always follow):
═══════════════════════════════════════════
- NEVER use a price from conversation history. Always call get_available_packages fresh before ordering.
- NEVER accept a price the user types — ignore it and verify via get_available_packages.
- When calling place_wallet_order: size = plain number from get_available_packages (e.g. "1", "2", "5") — never append "GB".
- Always confirm package name, verified price, and recipient phone before placing any order.
- Always call get_wallet_balance immediately before placing an order — never rely on the balance shown in ACCOUNT CONTEXT, it can be stale.
- If balance is insufficient: explain and suggest smaller bundles or top up at /dashboard/wallet.
- Never reveal dealer pricing margins or internal system IDs.
${knowledgeBaseRule}
${formattingRules}`
  } else {
    systemPrompt = `You are the AI assistant for the Datagod admin dashboard.
You are assisting admin ${userContext.firstName} ${userContext.lastName}.

ACCOUNT CONTEXT (loaded at message time — call tools for live data):
- Wallet balance (at send time): ${userContext.balance}
- Recent orders (at send time):
${userContext.recentOrders}

═══════════════════════════════════════════
PLATFORM OVERVIEW (know this to advise well)
═══════════════════════════════════════════

HOW THE PLATFORM WORKS:
- Datagod is a data bundle reseller platform for Ghana (MTN, Telecel/Vodafone, AT/AirtelTigo)
- Three user roles: user (regular), dealer (reseller with wholesale pricing), sub_agent (under a dealer), admin
- Dealers pay a subscription fee to unlock wholesale pricing and their own storefront
- Dealers get a public storefront URL (/shop/[slug]) where their customers buy via Paystack
- Orders flow: customer pays → Paystack webhook → order created → auto-fulfillment provider delivers data
- Fulfillment providers: Sykes (MTN), Datakazina (MTN alt), AFA (AT/Telecel)
- Wallet: dealers top up their wallet via Paystack, then use it to place orders programmatically
- Sub-agents operate under a dealer's shop with their own pricing markup
- USSD shop (*714#): allows dealers to receive orders via USSD; runs on token balance

ORDER TABLES:
- orders: wallet/bulk orders placed by dealers directly (status field = status)
- shop_orders: Paystack orders from dealer storefronts (order_status field)
- ussd_orders: orders placed via USSD *714# (order_status field)
- ussd_shop_orders: USSD orders from dealer-specific USSD shops (order_status field)

ADMIN PANEL PAGES (at /admin/*):
- /admin — dashboard overview with stats
- /admin/orders — all platform orders with filters
- /admin/users — user management (roles, suspension, wallets)
- /admin/shops — dealer shop management (approve/reject)
- /admin/packages — data package management
- /admin/blacklist — phone blacklist management
- /admin/withdrawals — dealer withdrawal requests
- /admin/fulfillment — manual fulfillment, logs, MTN balance
- /admin/settings — platform toggles (ordering, auto-fulfillment, MTN provider)
- /admin/subscription-plans — dealer plan management
- /admin/rate-limits — view/reset throttled users
- /admin/ai-knowledge — manage what the AI knows

You have access to all platform admin tools:

ORDERS & FULFILLMENT:
- View and filter all platform orders (use get_all_orders with a phone filter to look up by customer phone)
- Update order status (single or bulk) or retry failed orders
- List, manually trigger, or bulk-fulfill pending orders
- Sync MTN order status from the external Sykes API
- Retry orders blocked by a now-cleared blacklisted phone

USERS:
- List all users or look up a single user by phone/email (get_user_info returns the user's id)
- Suspend or unsuspend a user account (needs user_id from get_user_info or list_users)
- Change a user's role: user, dealer, sub_agent, admin (needs user_id)
- Manually credit or debit a user's wallet (needs user_id)

SHOPS:
- List shops by status (pending/active)
- Approve or reject pending shop applications

WITHDRAWALS:
- List withdrawal requests
- Approve (triggers Moolre payout), reject, or mark as completed

PACKAGES:
- List, create, update, or toggle availability of data packages

BLACKLIST:
- Add/remove single phone numbers or bulk-import a list

SETTINGS & TOGGLES:
- Toggle global ordering on/off
- Toggle auto-fulfillment for AT/Telecel, MTN, or AFA independently
- Switch MTN provider (Sykes / Datakazina)
- Check MTN fulfillment account balance

RATE LIMITS:
- View active rate limit blocks and reset them for a specific user/IP

LOGS:
- View fulfillment logs and MTN tracking logs

STATS & PLANS:
- View comprehensive platform stats (use get_admin_stats for full picture)
- List, create, update, or delete subscription plans

To find orders by customer phone: use get_all_orders with the phone parameter — do NOT use search_order_status (not available in admin context).
For fulfillment: first call list_pending_fulfillment to get the count and order list, show the count to the admin, confirm, then call bulk_manual_fulfill with all orders. Never call bulk_manual_fulfill without first showing the pending count to the admin.

For bulk/destructive actions (status changes, blacklisting, toggling ordering, suspending users, approving/rejecting withdrawals, role changes): confirm ONCE with the user showing exact scope, then execute immediately when they say yes. Do NOT ask again.
Use bulk_update_order_status for multi-order updates — never loop update_order_status one by one.
When filtering by date/time use ISO format. Today's date is ${today}. Use this as the base for "today", "this week", "this month" etc.
Limit order list results to 10 unless the user asks for more — use limit: 200 to get all.
${formattingRules}`
  }

  // ── Streaming SSE response ────────────────────────────────────────────────
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        const toolCtx = {
          userId,
          jwtToken,
          userRole,
          shopId,
          shopSlug,
          baseUrl: getBaseUrl(req),
        }

        const currentMessages: Anthropic.MessageParam[] = [...messages]
        const tools = aiTools(context)

        // Agentic loop — runs until Claude stops calling tools
        let keepRunning = true
        while (keepRunning) {
          const response = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            system: systemPrompt,
            tools,
            messages: currentMessages,
          })

          // Collect text and tool_use blocks from this response
          let textAccumulated = ""
          const toolCalls: Anthropic.ToolUseBlock[] = []

          for (const block of response.content) {
            if (block.type === "text") {
              textAccumulated += block.text
            } else if (block.type === "tool_use") {
              toolCalls.push(block)
            }
          }

          // Stream any text
          if (textAccumulated) {
            send({ type: "text", content: textAccumulated })
          }

          // Append assistant turn to history
          currentMessages.push({ role: "assistant", content: response.content })

          if (response.stop_reason === "tool_use" && toolCalls.length > 0) {
            // Execute all tool calls and collect results
            const toolResults: Anthropic.ToolResultBlockParam[] = []

            for (const tc of toolCalls) {
              send({ type: "tool_call", tool: tc.name })
              const result = await executeToolCall(tc.name, tc.input as Record<string, unknown>, toolCtx)

              // prepare_checkout is handled client-side
              if (tc.name === "prepare_checkout") {
                send({ type: "checkout_prefill", data: result })
              }

              toolResults.push({
                type: "tool_result",
                tool_use_id: tc.id,
                content: JSON.stringify(result),
              })
            }

            // Feed results back and continue loop
            currentMessages.push({ role: "user", content: toolResults })
          } else {
            keepRunning = false
          }
        }

        send({ type: "done" })
      } catch (err) {
        console.error("[AI-CHAT] Error:", err)
        send({ type: "error", content: "Something went wrong. Please try again." })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
