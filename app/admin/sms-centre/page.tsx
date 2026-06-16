"use client"

import { useState } from "react"
import BroadcastTab from "./_components/BroadcastTab"
import ContactsTab from "./_components/ContactsTab"
import TemplatesTab from "./_components/TemplatesTab"
import ProvidersTab from "./_components/ProvidersTab"

type Tab = "broadcast" | "contacts" | "templates" | "providers"

const TABS: { id: Tab; label: string }[] = [
  { id: "broadcast", label: "Broadcast" },
  { id: "contacts", label: "Contacts & Groups" },
  { id: "templates", label: "Templates" },
  { id: "providers", label: "Providers" },
]

export default function SmsCentrePage() {
  const [tab, setTab] = useState<Tab>("broadcast")

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">SMS Centre</h1>
        <p className="text-sm text-muted-foreground">
          Broadcast to platform users or address-book groups, manage contacts, templates and providers.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-2 border-b pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-t text-sm font-medium ${
              tab === t.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "broadcast" && <BroadcastTab />}
      {tab === "contacts" && <ContactsTab />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "providers" && <ProvidersTab />}
    </div>
  )
}
