import { createClient } from "@supabase/supabase-js"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { resolveProviderForContext, DEFAULT_CONFIG, AIProviderConfig } from "@/lib/ai-providers"
import { getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import { resolveShopCode } from "@/lib/shop-commerce/shop-code"
import { getSession as getShopSession } from "@/lib/whatsapp-bot/shop-session"
import { shopConfirmMenu, shopAirtimeConfirmMenu, shopRcConfirmMenu } from "@/lib/whatsapp-bot/shop-menus"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function loadAiConfig(): Promise<AIProviderConfig> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "ai_provider_config")
      .maybeSingle()
    if (data?.value) return data.value as AIProviderConfig
  } catch { /* fall through to default */ }
  return DEFAULT_CONFIG
}

// handleShopWithAI mirrors app/api/whatsapp/webhook/route.ts's handleWithAI for
// the main bot, but scoped to a single shop: same runAgenticLoop pattern, same
// provider resolution (reuses the "whatsapp" provider/model config — no separate
// admin toggle for the shop bot), different (narrower) tool set and system prompt.
export async function handleShopWithAI(phone: string, text: string, _messageId: string | null): Promise<string> {
  const aiConfig = await loadAiConfig()
  const { provider, model } = resolveProviderForContext("whatsapp", aiConfig)

  const pref = await getShopPref(phone)
  let shopName: string | null = null
  let shopSystemBlock = ""

  if (pref) {
    const { data: codeRow } = await supabase
      .from("ussd_shop_codes")
      .select("code")
      .eq("id", pref.shopCodeId)
      .maybeSingle()
    if (codeRow?.code) {
      const shop = await resolveShopCode(codeRow.code)
      if (shop && shop.status === "active" && shop.whatsappActivated) {
        shopName = shop.shopName
        shopSystemBlock = `\nThe customer's shop is *${shop.shopName}* — you are speaking AS this shop's assistant. Greet returning customers by name (e.g. "Welcome back to ${shop.shopName} 👋"). Always call get_shop_packages before quoting any price — never invent one.\n`
      }
    }
  }

  const { data: history } = await supabase
    .from("whatsapp_messages")
    .select("direction, message")
    .eq("phone_number", phone)
    .in("direction", ["inbound", "outbound"])
    .order("created_at", { ascending: false })
    .limit(20)

  const messages: Array<{ role: "user" | "assistant"; content: string }> = (history ?? [])
    .reverse()
    .filter(m => m.message)
    .map(m => ({ role: m.direction === "inbound" ? "user" : "assistant", content: m.message! }))
  messages.push({ role: "user", content: text })

  const system = `You are a friendly WhatsApp ordering assistant for a Datagod shop storefront. This is a dedicated shop number — every customer here is shopping at ONE specific shop.
${shopSystemBlock}
IF NO SHOP IS KNOWN YET: warmly explain this is a shop ordering line and ask for their shop code. The moment they send something that looks like a code, call resolve_shop_code with it.

ORDERING: use get_shop_packages to see real prices/availability (data bundles by network, airtime limits, results-checker boards) — NEVER invent a price. Once you have everything needed (service, network/board, size/qty, recipient number where relevant, and the MoMo number to charge), and the customer has confirmed, call place_shop_order. It stages a confirm screen where THEY tap to pay or cancel — never say an order is paid before that.

STYLE: short, warm, WhatsApp-appropriate replies. Currency is always GHS. One idea per line, *bold* sparingly for prices. Never mention tools or internal details. Don't ask for details the customer already gave.`

  let result: { text: string; toolsUsed: string[] }
  try {
    result = await runAgenticLoop({
      provider,
      model,
      system,
      context: "whatsapp_shop",
      messages,
      toolCtx: { baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", phone, userRole: "guest" },
      maxIterations: 5,
      maxTokens: 600,
    })
  } catch (e) {
    console.error("[WA-SHOP-AI] runAgenticLoop error:", e)
    return "Sorry, I'm having trouble right now — please try again in a moment, or send your shop code to start over."
  }

  if (result.toolsUsed.includes("place_shop_order")) {
    const staged = await getShopSession(phone)
    if (staged?.step === "CONFIRM") {
      return shopConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.network!, staged.bundleSize!, staged.bundlePrice!, staged.recipientPhone!, staged.paymentPhone!)
    }
    if (staged?.step === "AIRTIME_CONFIRM") {
      return shopAirtimeConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.airtimeNetwork!, staged.airtimeRecipient!, staged.airtimeAmount!, staged.airtimeToDeliver!, staged.paymentPhone!)
    }
    if (staged?.step === "RC_CONFIRM") {
      return shopRcConfirmMenu(staged.shopName ?? shopName ?? "Shop", staged.rcBoard!, staged.rcQty!, staged.rcTotal!, staged.paymentPhone!)
    }
  }

  return result.text || "How can I help — data, airtime, or a results checker?"
}
