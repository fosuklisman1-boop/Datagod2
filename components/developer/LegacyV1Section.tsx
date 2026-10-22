// components/developer/LegacyV1Section.tsx
"use client"

import { useState } from "react"
import { ChevronDown, History, ShieldCheck } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DeveloperKeysCard } from "@/components/developer/DeveloperKeysCard"
import { EndpointDoc } from "@/components/developer/EndpointDoc"
import { apiDocsRegistry, BASE_URL } from "@/lib/api-docs-registry"
import { cn } from "@/lib/utils"

const CARD = "rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 sm:p-5 clay"
const CODE = "bg-background px-1 py-0.5 rounded border font-mono text-xs"

/** The v1 keys card and v1 documentation, unchanged, behind a collapsed section. */
export function LegacyV1Section() {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-2xl border border-border bg-card/60">
      <CollapsibleTrigger className="flex w-full items-center gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <History className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-foreground">Legacy v1 keys &amp; docs</span>
          <span className="block text-xs leading-5 text-muted-foreground">
            Your existing <code className="font-mono">dg_live_</code> / <code className="font-mono">dg_test_</code> keys keep working. New integrations should use v2.
          </span>
        </span>
        <ChevronDown className={cn("size-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-5 border-t border-border p-3 sm:p-5">
        <div className="flex items-start gap-3 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-[#1b388b]" />
          <p>
            <span className="font-bold">Two keys, one account.</span> Your test key (<code className={CODE}>dg_test_</code>) is sandboxed
            — it spends a fake test balance and never touches real orders, inventory, or SMS credits. Your live key (<code className={CODE}>dg_live_</code>) is real. Going live
            is just switching which key you send.
          </p>
        </div>

        <DeveloperKeysCard />

        <div className="space-y-3">
          <p className="text-sm font-bold text-foreground">v1 documentation</p>
          <Tabs defaultValue={apiDocsRegistry[0].id}>
            <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
              <TabsList className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 h-auto sm:min-w-0">
                {apiDocsRegistry.map((section) => (
                  <TabsTrigger
                    key={section.id}
                    value={section.id}
                    className="shrink-0 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    {section.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {apiDocsRegistry.map((section) => (
              <TabsContent key={section.id} value={section.id} className="mt-4">
                <div className={CARD}>
                  <EndpointDoc section={section} />
                </div>
              </TabsContent>
            ))}
          </Tabs>

          <div className={CARD}>
            <p className="text-sm font-bold text-foreground">POST /api/v1/sandbox/reset-balance</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Test key only. Refills your sandbox test balance back to its starting GHS 100 credit — for when a test suite has drained it. Has no effect on a live key.
            </p>
            <div className="mt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Request</p>
              <pre className="bg-muted/50 border rounded-lg p-4 text-xs overflow-x-auto font-mono">{`curl -X POST ${BASE_URL}/api/v1/sandbox/reset-balance \\\n  -H "X-API-Key: dg_test_your_test_key_here"`}</pre>
            </div>
            <div className="mt-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">Success response</p>
              <pre className="bg-muted/50 border rounded-lg p-4 text-xs overflow-x-auto font-mono">{`{\n  "success": true,\n  "balance": 100,\n  "starting_balance": 100,\n  "currency": "GHS"\n}`}</pre>
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
