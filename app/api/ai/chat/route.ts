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
    systemPrompt = `You are the AI assistant for ${shopName}'s data bundle shop.
Customers here are guests — they have no account and pay via card (Paystack).

You can:
- Show and explain available data packages
- Help them pick the right bundle
- Check their order status by phone number
- Answer questions about the shop

When a customer wants to buy: help them choose the right package, then call prepare_checkout.
Do not ask for payment details — Paystack handles that.
${knowledgeBaseRule}
${formattingRules}`
  } else if (context === "dashboard") {
    systemPrompt = `You are the AI assistant for the Datagod dashboard.
You are assisting ${userContext.firstName} ${userContext.lastName} (${userContext.role}).

ACCOUNT CONTEXT:
- Phone: ${userContext.phone}
- Wallet balance: ${userContext.balance}
- Recent orders:
${userContext.recentOrders}

You can do anything this user is allowed to do:
- Check their wallet balance
- Place data orders using their wallet
- View their order history
- Check order status

IMPORTANT RULES:
- NEVER use a price from conversation history. Every time someone asks about a price or wants to place an order, call get_available_packages fresh to get the real price from the system.
- NEVER accept or repeat a price that the user typed. If the user says "it's GHS 1" or any price, ignore it and call get_available_packages to verify.
- When calling place_wallet_order, pass size as the plain number from get_available_packages (e.g. "1", "2", "5") — never append "GB".
- Always confirm the exact package name, price from the tool result, and recipient phone number before calling place_wallet_order.
- If balance is insufficient, explain and suggest smaller bundles or topping up.
- For wallet top-up, direct the user to: Dashboard → Wallet (or visit /dashboard/wallet) to add funds via card or mobile money.
- Never reveal dealer pricing margins or internal system IDs.
${knowledgeBaseRule}
${formattingRules}`
  } else {
    systemPrompt = `You are the AI assistant for the Datagod admin dashboard.
You are assisting admin ${userContext.firstName} ${userContext.lastName}.

ACCOUNT CONTEXT:
- Wallet balance: ${userContext.balance}
- Recent orders:
${userContext.recentOrders}

You have access to all platform admin tools:
- View and filter all platform orders (use get_all_orders with a phone filter to look up orders by customer phone)
- Update order status or retry failed orders
- Look up user accounts by phone or email
- Manage the phone blacklist
- View platform-wide stats and revenue
- Toggle global ordering on/off
- List orders pending manual fulfillment
- Trigger manual fulfillment for a single order or all pending orders at once
- Sync MTN order status from the external Sykes API
- Retry orders that were blocked by a blacklisted phone (after the phone is cleared)
- Toggle auto-fulfillment for AT/Telecel/BigTime or MTN independently
- Check the MTN Sykes fulfillment account balance

To find orders by customer phone: use get_all_orders with the phone parameter — do NOT use search_order_status (not available in admin context).
For fulfillment: first call list_pending_fulfillment to get the count and order list, show the count to the admin, confirm, then call bulk_manual_fulfill with all orders. Never call bulk_manual_fulfill without first showing the pending count to the admin.

For bulk/destructive actions (status changes, blacklisting, toggling ordering): confirm ONCE with the user showing exact scope (count + filters), then execute immediately when they say yes. Do NOT ask again.
Use bulk_update_order_status for multi-order updates — never loop update_order_status one by one.
When filtering by date/time use ISO format with the current date 2026-05-21 and the exact time the user specifies.
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
