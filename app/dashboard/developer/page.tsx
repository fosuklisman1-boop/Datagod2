// app/dashboard/developer/page.tsx
"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ShieldCheck, KeyRound, BookOpen } from "lucide-react"
import { DeveloperKeysCard } from "@/components/developer/DeveloperKeysCard"
import { EndpointDoc } from "@/components/developer/EndpointDoc"
import { apiDocsRegistry, BASE_URL } from "@/lib/api-docs-registry"

const PAGE_TABS = [
  { id: "keys", label: "Keys & Test", icon: KeyRound },
  { id: "docs", label: "Full Documentation", icon: BookOpen },
] as const

export default function DeveloperPage() {
  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Developer / API</h1>
          <p className="mt-1 text-sm text-muted-foreground">Integrate and automate with the Datagod API.</p>
        </div>

        <div className="flex items-start gap-3 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-[#1b388b]" />
          <p>
            <span className="font-bold">Two keys, one account.</span> Your test key (<code className="bg-background px-1 py-0.5 rounded border font-mono text-xs">dg_test_</code>) is sandboxed
            — it spends a fake test balance and never touches real orders, inventory, or SMS credits. Your live key (<code className="bg-background px-1 py-0.5 rounded border font-mono text-xs">dg_live_</code>) is real. Going live
            is just switching which key you send.
          </p>
        </div>

        <Tabs defaultValue="keys">
          <div className="-mx-2 overflow-x-auto px-2 sm:mx-0 sm:px-0">
            <TabsList className="inline-flex min-w-full gap-1 rounded-2xl bg-muted p-1 h-auto sm:min-w-0">
              {PAGE_TABS.map(({ id, label, icon: Icon }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-bold data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  <Icon className="h-4 w-4" /> {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="keys" className="mt-4 space-y-5">
            <DeveloperKeysCard />

            {/* What you can call -- a compact index over the endpoints
                documented in full under "Full Documentation". */}
            <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
              <p className="text-sm font-bold text-foreground">What you can call</p>
              <p className="mb-3 text-xs text-muted-foreground">
                All requests go to <code className="bg-muted/50 px-1.5 py-0.5 rounded font-mono">{BASE_URL}/api/v1/...</code> with your key in the <code className="bg-muted/50 px-1.5 py-0.5 rounded font-mono">X-API-Key</code> header.
              </p>
              <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {apiDocsRegistry.map((section) => (
                  <div key={section.id} className="p-3">
                    <p className="text-sm font-semibold text-foreground">{section.label}</p>
                    {section.operations.map((op) => (
                      <p key={`${op.method}-${op.path}`} className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono text-[11px] font-bold text-[#1b388b] mr-1.5">{op.method}</span>
                        {op.description}
                      </p>
                    ))}
                  </div>
                ))}
                <div className="p-3">
                  <p className="text-sm font-semibold text-foreground">Sandbox</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-mono text-[11px] font-bold text-[#1b388b] mr-1.5">POST</span>
                    Refill your test balance when a test suite has drained it. Test key only.
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="docs" className="mt-4">
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
                  <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
                    <EndpointDoc section={section} />
                  </div>
                </TabsContent>
              ))}
            </Tabs>

            <div className="mt-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
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
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
