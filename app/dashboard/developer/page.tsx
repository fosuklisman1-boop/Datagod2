// app/dashboard/developer/page.tsx
"use client"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Code2 } from "lucide-react"
import { DeveloperKeysCard } from "@/components/developer/DeveloperKeysCard"
import { EndpointDoc } from "@/components/developer/EndpointDoc"
import { apiDocsRegistry, BASE_URL } from "@/lib/api-docs-registry"

export default function DeveloperPage() {
  return (
    <DashboardLayout>
      <div className="px-2 sm:px-4 space-y-6 max-w-5xl mx-auto">
        <header className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
            <Code2 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Developer / API</h1>
            <p className="text-sm text-muted-foreground">Integrate and automate with the Datagod API.</p>
          </div>
        </header>

        <DeveloperKeysCard />

        <Card>
          <CardHeader>
            <CardTitle>API Configuration</CardTitle>
            <CardDescription>Every request needs a valid key.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Base URL:</span> <code className="bg-muted/50 px-1.5 py-0.5 rounded">{BASE_URL}/api/v1</code></p>
            <p><span className="text-muted-foreground">Auth:</span> send your key as the <code className="bg-muted/50 px-1.5 py-0.5 rounded">X-API-Key</code> header on every request.</p>
          </CardContent>
        </Card>

        <Tabs defaultValue={apiDocsRegistry[0].id}>
          <TabsList className="flex-wrap h-auto">
            {apiDocsRegistry.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>{section.label}</TabsTrigger>
            ))}
          </TabsList>
          {apiDocsRegistry.map((section) => (
            <TabsContent key={section.id} value={section.id} className="mt-6">
              <EndpointDoc section={section} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
