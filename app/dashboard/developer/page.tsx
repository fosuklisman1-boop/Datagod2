// app/dashboard/developer/page.tsx
"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertTriangle } from "lucide-react"
import { DeveloperKeysCard } from "@/components/developer/DeveloperKeysCard"
import { EndpointDoc } from "@/components/developer/EndpointDoc"
import { apiDocsRegistry, BASE_URL } from "@/lib/api-docs-registry"

export default function DeveloperPage() {
  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-foreground">Developer / API</h1>
          <p className="mt-1 text-sm text-muted-foreground">Integrate and automate with the Datagod API.</p>
        </div>

        {/* There is no sandbox environment -- every key is live from the
            moment it's generated, so this says that plainly instead of
            showing a fake environment toggle. */}
        <div className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
          <p>
            <span className="font-bold">Live only.</span> There's no sandbox — every request below spends your
            real wallet balance and places a real order. Test with a small amount first.
          </p>
        </div>

        <DeveloperKeysCard />

        {/* What you can call -- a compact index over the real endpoints
            documented in full below. */}
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
                    <span className="font-mono text-[11px] font-bold text-primary mr-1.5">{op.method}</span>
                    {op.description}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Full documentation -- request/response examples per endpoint */}
        <div>
          <p className="mb-2 text-sm font-bold text-foreground">Full documentation</p>
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
        </div>
      </div>
    </DashboardLayout>
  )
}
