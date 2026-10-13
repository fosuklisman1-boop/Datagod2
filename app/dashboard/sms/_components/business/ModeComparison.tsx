import { Check } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { SmsMode } from "../../_lib/api"

const PLATFORM = [
  "Send with the platform sender name",
  "One free sender ID of your own",
  "Lower per-send and daily limits",
  "Messages are checked for scam and link rules",
]
const BUSINESS = [
  "Up to 200 sender IDs, including shared pool names",
  "Much higher send and daily limits",
  "Your verified business name builds trust",
  "Same safety checks, fewer restrictions",
]

export function ModeComparison({ mode }: { mode: SmsMode | null }) {
  const cols: { key: SmsMode; title: string; items: string[] }[] = [
    { key: "platform", title: "Platform", items: PLATFORM },
    { key: "business", title: "Business", items: BUSINESS },
  ]
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Platform vs Business</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
        {cols.map((c) => (
          <section key={c.key} className={"rounded-lg border p-3 " + (mode === c.key ? "border-primary/40 bg-primary/5" : "")}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{c.title}</h3>
              {mode === c.key && <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Your mode</Badge>}
            </div>
            <ul className="space-y-1.5">
              {c.items.map((t) => (
                <li key={t} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden /> {t}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  )
}
