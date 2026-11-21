import { joinServiceLabels, type DomainService } from "@/lib/custom-domains"
import { appendKnowledge } from "./knowledge"
import { formattingRules, knowledgeBaseRule, type PromptParts } from "./shared"

export interface StorefrontPromptInput {
  /** Rendered "## Knowledge base" section for this label (or ""); appended to the end of stable. */
  knowledge?: string
  shopName: string
  /** null = unrestricted (the shop offers everything). */
  storefrontServices: DomainService[] | null
  ussdDialCode: string
  /** The shop's own active USSD code, if any. */
  shopUssdCode: string | null
}

/**
 * Guest storefront prompt. Everything derives from the shop's configuration (name, services, USSD code), so it is
 * stable for that shop; there is no per-visitor value, so volatile is empty.
 */
export function buildStorefrontPrompt({ shopName, storefrontServices, ussdDialCode, shopUssdCode, knowledge }: StorefrontPromptInput): PromptParts {
  const sellsData = !storefrontServices || storefrontServices.includes("data_bundles")
  const sellsAirtime = !storefrontServices || storefrontServices.includes("airtime")
  const sellsRC = !storefrontServices || storefrontServices.includes("results_checker")

  // Scoped to whichever services this storefront actually offers — a custom
  // domain or shop can be restricted to a subset (e.g. results-checker-only),
  // and the AI must never offer, price, or promise a service that isn't
  // actually sold here.
  const soldLabels = [
    sellsData ? "data bundles" : null,
    sellsAirtime ? "airtime" : null,
    sellsRC ? "results checker vouchers" : null,
  ].filter((l): l is string => Boolean(l))
  const shopKindPhrase = storefrontServices ? `online shop for ${joinServiceLabels(soldLabels)}` : "online data bundle shop"

  const sellsSection = [
    sellsData ? "- Mobile data bundles for MTN, Telecel (Vodafone), and AT (AirtelTigo)" : null,
    sellsAirtime ? "- Airtime top-up (if enabled by the shop owner — use get_airtime_availability to check)" : null,
    sellsRC ? "- Exam results checker vouchers for WAEC, BECE, and NOVDEC (use get_results_checker_availability to check stock)" : null,
  ].filter(Boolean).join("\n")

  const orderTrackingSection = (sellsData || sellsAirtime) ? `

ORDER TRACKING:
- Customers track their order using their phone number — call search_order_status
- Delivery is usually instant after payment but can take a few minutes during high traffic` : ""

  const airtimeSection = sellsAirtime ? `

AIRTIME TOP-UP:
- Check availability first with get_airtime_availability
- If available, a fee percentage applies (e.g. 5–10%) on top of the airtime amount
- Customer pays total (airtime + fee) via Paystack
- Direct them to the Airtime section on the page if they want to proceed` : ""

  const rcSection = sellsRC ? `

RESULTS CHECKER VOUCHERS:
- Buy WASSCE/BECE/NOVDEC voucher codes — customer uses them on the WAEC portal to check results themselves
- Check stock with get_results_checker_availability before promising availability
- Customer provides email + phone, pays via Paystack, receives voucher code by email

RESULTS CHECK SERVICE ("Check My Results" tab):
- Datagod checks exam results on the customer's behalf — no need for the customer to log into any portal
- Customer provides: exam board, candidate type (school/private), index number, date of birth, exam year, WhatsApp number, and payment
- Two modes: "Combo" — Datagod supplies the voucher + checks (higher fee); "Own Voucher" — customer already has a PIN and serial number (lower fee)
- Results delivered by email (with file attachment if available) and WhatsApp
- Customer should check spam folder if email doesn't arrive in inbox` : ""

  const unavailableServiceRule = storefrontServices ? `

SCOPE: This storefront ONLY sells ${joinServiceLabels(soldLabels)} — nothing else, even if you know Datagod offers it elsewhere. If a customer asks about a service not in that list, tell them politely it isn't available on this shop — never say you'll check, never imply it might be available.` : ""

  const storefrontUssdSection = shopUssdCode
    ? `

ORDER BY USSD (no internet needed — works on any phone):
- This shop has a USSD code. To order by phone: dial ${ussdDialCode}, and when it asks "Enter shop code:", enter ${shopUssdCode}.
- Important: they ENTER ${shopUssdCode} at the prompt — they do NOT append it to the dial string.`
    : ""

  const stable = `You are the AI assistant for ${shopName}'s ${shopKindPhrase}.
Customers here are guests — no account needed, payment is via card or mobile money through Paystack.

WHAT THIS SHOP SELLS:
${sellsSection}

HOW BUYING WORKS:
1. ${sellsData ? "Customer picks what they want → you call prepare_checkout → a payment form opens on the page" : "Customer picks what they want from the sections on the page and a payment form opens there"}
2. Customer fills phone number and pays via Paystack (card or MoMo)
3. Delivery happens automatically after payment confirmation
4. No account or login required at any point
${orderTrackingSection}${airtimeSection}${rcSection}

PAYMENT & REFUNDS:
- All payments go through Paystack — the shop owner does not handle card details
- For payment issues, customers can use the payment re-verify option on the site
- Refund and dispute processes: call get_knowledge_base for policy details
${storefrontUssdSection}${unavailableServiceRule}

${knowledgeBaseRule}
${formattingRules}`
  return { stable: appendKnowledge(stable, knowledge), volatile: "" }
}
