"use client"

import { useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MessageSquare, Send, Users, FileText, Network, History } from "lucide-react"
import BroadcastTab from "./_components/BroadcastTab"
import ContactsTab from "./_components/ContactsTab"
import TemplatesTab from "./_components/TemplatesTab"
import ProvidersTab from "./_components/ProvidersTab"
import HistoryTab from "./_components/HistoryTab"

export default function SmsCentrePage() {
  const [tab, setTab] = useState("broadcast")

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SMS Centre</h1>
            <p className="text-sm text-muted-foreground">
              Broadcast to platform users or address-book groups, and manage contacts, templates and providers.
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="broadcast"><Send className="h-4 w-4" /> Broadcast</TabsTrigger>
            <TabsTrigger value="contacts"><Users className="h-4 w-4" /> Contacts &amp; Groups</TabsTrigger>
            <TabsTrigger value="templates"><FileText className="h-4 w-4" /> Templates</TabsTrigger>
            <TabsTrigger value="providers"><Network className="h-4 w-4" /> Providers</TabsTrigger>
            <TabsTrigger value="history"><History className="h-4 w-4" /> History</TabsTrigger>
          </TabsList>

          <TabsContent value="broadcast" className="pt-4">
            <BroadcastTab />
          </TabsContent>
          <TabsContent value="contacts" className="pt-4">
            <ContactsTab />
          </TabsContent>
          <TabsContent value="templates" className="pt-4">
            <TemplatesTab />
          </TabsContent>
          <TabsContent value="providers" className="pt-4">
            <ProvidersTab />
          </TabsContent>
          <TabsContent value="history" className="pt-4">
            {tab === "history" && <HistoryTab />}
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
