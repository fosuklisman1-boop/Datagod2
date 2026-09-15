import type { Metadata } from "next"
import Link from "next/link"
import { FileCheck2, Search, Zap, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import { supabaseAdmin } from "@/lib/supabase"

export const metadata: Metadata = {
  title: "Check WASSCE, BECE & NOVDEC Results Online | DATAGOD",
  description: "Buy WASSCE, BECE, and NOVDEC results-checker voucher PINs instantly, or let DATAGOD check your results for you if you don't have a voucher. Instant delivery.",
  openGraph: {
    title: "Check WASSCE, BECE & NOVDEC Results Online",
    description: "Buy results-checker voucher PINs instantly, or have DATAGOD check your results for you.",
    type: "website",
    url: "https://www.datagod.store/results-checker",
  },
}

// Live pricing pulled from the same admin_settings keys the signed-in dashboard
// reads (app/dashboard/results-check/page.tsx) — see that file's comment for the
// exact formula: own_voucher total = results_check_settings.fee, combo total =
// fee + results_checker_price_{board}.
export const revalidate = 300

const BOARDS = ["WASSCE", "BECE", "NOVDEC"] as const

async function getBoardPricing() {
  const { data } = await supabaseAdmin
    .from("admin_settings")
    .select("key, value")
    .or(["results_checker_", "results_check_"].map((p) => `key.like.${p}%`).join(","))

  const settingsMap: Record<string, any> = {}
  for (const row of (data ?? []) as { key: string; value: any }[]) settingsMap[row.key] = row.value

  const rcSettings = settingsMap["results_check_settings"]
  const serviceEnabled = rcSettings?.enabled !== false
  const baseCheckFee = parseFloat(rcSettings?.fee ?? 0) || 0

  const boards = BOARDS.map((board) => {
    const bk = board.toLowerCase()
    const enabled = settingsMap[`results_checker_enabled_${bk}`]?.enabled !== false
    const voucherBase = parseFloat(settingsMap[`results_checker_price_${bk}`]?.price ?? 0) || 0
    return {
      board,
      enabled,
      checkFee: parseFloat(baseCheckFee.toFixed(2)),
      comboPrice: parseFloat((baseCheckFee + voucherBase).toFixed(2)),
    }
  })

  return { serviceEnabled, boards }
}

export default async function ResultsCheckerPage() {
  const { serviceEnabled, boards } = await getBoardPricing()

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-16 sm:py-24">
        <div className="text-center max-w-2xl mx-auto">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">
            Results Checker
          </span>
          <h1 className="mt-4 font-display text-3xl sm:text-5xl font-bold text-foreground text-balance">
            Check your WASSCE, BECE & NOVDEC results
          </h1>
          <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
            Buy a voucher PIN instantly, or if you don't have one, let DATAGOD check your results for you.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <GuestPurchaseButton variant="primary" className="w-full sm:w-auto" />
            <Link href="/vouchers">
              <Button size="lg" variant="outline" className="gap-2 w-full sm:w-auto">
                Retrieve a voucher <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10">
              <FileCheck2 className="h-[18px] w-[18px] text-primary" />
            </div>
            <h3 className="font-display font-semibold text-foreground mb-1">Buy a voucher</h3>
            <p className="text-sm text-muted-foreground">Get a fresh PIN and serial number delivered instantly — use it yourself, whenever you're ready.</p>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10">
              <Search className="h-[18px] w-[18px] text-primary" />
            </div>
            <h3 className="font-display font-semibold text-foreground mb-1">Results Check Service</h3>
            <p className="text-sm text-muted-foreground">No PIN to spare? Give us your index number and we'll check your results for you.</p>
          </div>
        </div>

        {serviceEnabled ? (
          <div className="mt-6 rounded-xl border border-border bg-card p-6">
            <h2 className="font-display font-semibold text-foreground mb-4">Pricing</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {boards.filter((b) => b.enabled).map((b) => (
                <div key={b.board}>
                  <div className="font-display text-lg font-bold text-foreground">{b.board}</div>
                  <div className="text-sm text-muted-foreground mt-1">Check only: GHS {b.checkFee.toFixed(2)}</div>
                  <div className="text-sm text-muted-foreground">Voucher + check: GHS {b.comboPrice.toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground flex items-start gap-2">
            <Zap className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
            <span>Results checking is temporarily unavailable — check back soon.</span>
          </div>
        )}

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/" className="text-primary hover:underline">Back to Home</Link>
          {" · "}
          <Link href="/vouchers" className="text-primary hover:underline">Retrieve Vouchers</Link>
        </div>
      </div>
    </div>
  )
}
