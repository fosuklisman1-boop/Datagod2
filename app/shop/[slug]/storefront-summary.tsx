import { MessageCircle, Store } from "lucide-react"
import { formatShopPrice, type PriceTable } from "@/lib/shop-commerce/price-table"

// Server-rendered storefront summary: what crawlers and no-JS visitors get in
// the HTML. ShopStorefront (storefront-client.tsx) renders it in place of its
// loading screen, then swaps in the interactive UI once its own data has
// loaded, so a visitor never sees this list and the interactive one together.
export function StorefrontSummary({
  shopName,
  description,
  logoUrl,
  table,
  showPrices,
  whatsappLink,
  accentColor,
  footer,
}: {
  shopName: string
  description: string | null
  logoUrl: string | null
  table: PriceTable | null
  /** False when this storefront can't sell data here (e.g. a custom domain without data). */
  showPrices: boolean
  whatsappLink: string | null
  /** The shop's own brand colour (custom_color), as the interactive storefront uses. */
  accentColor: string | null
  footer?: React.ReactNode
}) {
  const networks = showPrices && table ? table.networks.filter((n) => n.rows.length > 0) : []
  return (
    <div className="min-h-screen bg-card" style={{ "--shop-accent": accentColor || "#1b388b" } as React.CSSProperties}>
      <header className="bg-card rounded-b-[1.75rem] clay-bar" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Store className="w-6 h-6 text-[var(--shop-accent)] hidden sm:block" aria-hidden />
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">{shopName}</h1>
          </div>
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- shop logos are arbitrary remote URLs
            <img
              src={logoUrl}
              alt={shopName}
              width={48}
              height={48}
              className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover border-2 border-border flex-shrink-0"
            />
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-8">
        {description && <p className="text-muted-foreground">{description}</p>}

        {networks.length > 0 && (
          <section aria-labelledby="shop-prices-heading">
            <h2 id="shop-prices-heading" className="text-lg font-bold text-foreground">
              Data bundle prices
            </h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {networks.map((n) => (
                <div key={n.network} className="rounded-2xl bg-card p-4 clay">
                  <h3 className="font-bold text-foreground">{n.network}</h3>
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th scope="col" className="py-1 font-medium">Bundle</th>
                        {table!.priced && <th scope="col" className="py-1 text-right font-medium">Price</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {n.rows.map((r) => (
                        <tr key={r.id} className="border-t border-border">
                          <td className="py-1.5 text-foreground">{r.label}</td>
                          {table!.priced && (
                            <td className="py-1.5 text-right font-semibold text-foreground">
                              {r.price != null ? formatShopPrice(r.price) : ""}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>
        )}

        {whatsappLink && (
          <section aria-labelledby="shop-contact-heading">
            <h2 id="shop-contact-heading" className="text-lg font-bold text-foreground">
              Contact
            </h2>
            <a
              href={whatsappLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-[var(--shop-accent)] hover:underline"
            >
              <MessageCircle className="h-4 w-4" aria-hidden /> Chat with {shopName} on WhatsApp
            </a>
          </section>
        )}
      </main>
      {footer}
    </div>
  )
}
