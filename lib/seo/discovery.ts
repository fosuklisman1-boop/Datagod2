/**
 * Pure builders for the crawler/AI discovery surfaces: the sitemap entries and
 * llms.txt. No I/O. Everything is driven by the product registry plus live
 * facts, so a dark product never shows up in either.
 */
import type { MetadataRoute } from "next"
import { absoluteUrl } from "./site"
import { PRODUCTS, getProduct, REFUND_LINE, SPEED_LINE, type ProductEntry } from "./products"
import { formatCedis, type LiveFacts } from "./live-facts"

type Entry = MetadataRoute.Sitemap[number]

const isAvailable = (facts: LiveFacts, p: ProductEntry): boolean => facts.products[p.key]?.available === true

export function buildSitemapEntries(facts: LiveFacts, now: Date): MetadataRoute.Sitemap {
  const entry = (path: string, priority: number, changeFrequency: Entry["changeFrequency"]): Entry => ({
    url: absoluteUrl(path),
    lastModified: now,
    changeFrequency,
    priority,
  })

  return [
    entry("/", 1, "daily"),
    entry("/services", 0.9, "weekly"),
    ...PRODUCTS.filter((p) => isAvailable(facts, p)).map((p) => entry(p.path, p.priority, "weekly")),
    entry("/vouchers", 0.5, "monthly"),
    entry("/ai", 0.6, "monthly"),
    entry("/terms", 0.3, "yearly"),
    entry("/privacy", 0.3, "yearly"),
  ]
}

const SUMMARY_LINE =
  "Ghana's all-in-one platform for data bundles, airtime, bill payments, results checkers, bulk SMS and reselling."

function productLine(p: ProductEntry, facts: LiveFacts): string {
  const summary = p.summary.trim().replace(/\.+$/, "")
  const price = formatCedis(facts.products[p.key]?.fromPrice ?? 0)
  return `- [${p.name}](${absoluteUrl(p.path)}): ${summary}.${price ? ` From ${price}.` : ""}`
}

export function buildLlmsTxt(facts: LiveFacts): string {
  const lines: string[] = ["# DATAGOD", "", `> ${SUMMARY_LINE}`, ""]

  // Products: everything customers buy. Business tools and channels have their own sections.
  const products = PRODUCTS.filter(
    (p) => isAvailable(facts, p) && (p.group === "data" || p.group === "airtime" || p.group === "bills" || p.group === "education" || p.key === "bulk-sms"),
  )
  lines.push("## Products", "", ...products.map((p) => productLine(p, facts)), "")

  // Ways to order
  lines.push("## Ways to order", "")
  lines.push(`- Web: browse everything at ${absoluteUrl("/services")} and fund your wallet with Mobile Money or card.`)
  if (isAvailable(facts, getProduct("whatsapp"))) {
    lines.push(`- WhatsApp: chat with DATAGOD to order data, airtime and results checkers (${absoluteUrl("/whatsapp")}).`)
  }
  if (facts.ussd.main) {
    let ussd = `- USSD: dial ${facts.ussd.main} on any phone, with no internet needed (${absoluteUrl("/ussd")}). Reseller shops can also have their own shop code`
    ussd += facts.ussd.shop ? `, in the format ${facts.ussd.shop}.` : "."
    lines.push(ussd)
  }
  lines.push("")

  // Resellers
  if (isAvailable(facts, getProduct("join"))) {
    const join = getProduct("join")
    lines.push(
      "## For resellers",
      "",
      `- [${join.name}](${absoluteUrl(join.path)}): open a branded shop, set your own prices, recruit sub-agents and withdraw your profit to Mobile Money.`,
      "",
    )
  }

  // Developers (only when the API is on)
  const dev = getProduct("developers")
  if (isAvailable(facts, dev)) {
    lines.push("## For developers", "", `- [${dev.name}](${absoluteUrl(dev.path)}): sell data and airtime from your own app or website with simple API calls.`, "")
  }

  lines.push(
    "## Trust",
    "",
    `- ${REFUND_LINE}`,
    `- ${SPEED_LINE}`,
    "- Fund your DATAGOD wallet with Mobile Money (MoMo) or card through Paystack, then pay from your wallet.",
  )

  return lines.join("\n") + "\n"
}
