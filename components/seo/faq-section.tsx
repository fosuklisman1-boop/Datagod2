import { ChevronDown } from "lucide-react"
import type { Faq } from "@/lib/seo/products"

/** FAQ list as native <details>; no client JS. Pair with FAQPage JSON-LD built from the same faqs. */
export function FaqSection({ faqs, title = "Frequently asked questions" }: { faqs: readonly Faq[]; title?: string }) {
  if (faqs.length === 0) return null
  return (
    <section aria-labelledby="faq-heading" className="mt-16">
      <h2 id="faq-heading" className="font-display text-2xl sm:text-3xl font-bold text-foreground">
        {title}
      </h2>
      <div className="mt-6 divide-y divide-border rounded-xl border border-white/60 dark:border-white/5 bg-card clay">
        {faqs.map((f) => (
          <details key={f.question} className="group px-5 py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span>{f.question}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-primary transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
