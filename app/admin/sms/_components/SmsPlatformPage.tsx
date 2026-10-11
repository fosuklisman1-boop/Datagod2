"use client"
import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type OverviewData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { tabFromParam, type TabId } from "../_lib/view"
import { ConfirmDialog, ErrorBox, LoadingRows } from "./ui-bits"
import StatCards from "./StatCards"
import SupplyStrip from "./SupplyStrip"
import StatusBanner from "./StatusBanner"
import BusinessReviewsTab from "./BusinessReviewsTab"
import SenderIdsTab from "./SenderIdsTab"
import FlaggedTab from "./FlaggedTab"
import MessagesTab from "./MessagesTab"
import AccountsTab from "./AccountsTab"
import BundlesTab from "./BundlesTab"
import SettingsTab from "./SettingsTab"

const TAB_LABELS: Record<TabId, string> = {
  "business-reviews": "Business Reviews", "sender-ids": "Sender IDs", flagged: "Flagged", messages: "Messages",
  accounts: "Accounts", bundles: "Bundles", settings: "Settings",
}

export default function SmsPlatformPage() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const tab = tabFromParam(sp.get("tab"))
  const { data: overview, error, loading, reload } = useLoad<OverviewData>(() => api<OverviewData>("/api/admin/sms-platform/overview"), [])
  const [confirmOff, setConfirmOff] = useState(false)
  const [switching, setSwitching] = useState(false)

  function selectTab(next: string) {
    const p = new URLSearchParams(sp.toString())
    p.set("tab", next)
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }

  async function setEnabled(featureEnabled: boolean) {
    setSwitching(true)
    try {
      // success:true with data:null is a success (the route returns no body data).
      const res = await api("/api/admin/sms-platform/settings", { method: "PATCH", body: JSON.stringify({ section: "switch", values: { featureEnabled } }) })
      if (res.success) toast.success(featureEnabled ? "SMS is live" : "SMS paused — takes effect within a minute")
      else toast.error(res.error ?? "Could not change the switch")
    } catch {
      toast.error("Could not change the switch")
    } finally {
      setSwitching(false)
      setConfirmOff(false)
      void reload()
    }
  }

  const counts: Partial<Record<TabId, number>> = overview
    ? { "business-reviews": overview.tabCounts.businessReviews, "sender-ids": overview.tabCounts.senderIds, flagged: overview.tabCounts.flagged }
    : {}

  return (
    <div className="space-y-5 p-4 md:p-6 lg:mx-auto lg:max-w-7xl">
      <PageHeaderBanner title="SMS Platform" subtitle="Reviews, sender IDs, messages, accounts, bundles and rules for the SMS product.">
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={overview?.featureEnabled === false ? "bg-red-500/90 text-white" : "bg-emerald-500/90 text-white"}>{overview?.featureEnabled === false ? "PAUSED" : "LIVE"}</Badge>
          <label className="flex items-center gap-2 text-sm text-white">
            <Switch checked={overview?.featureEnabled ?? true} disabled={!overview || switching}
              onCheckedChange={(on) => (on ? void setEnabled(true) : setConfirmOff(true))} />
            Accepting SMS
          </label>
          <Button size="sm" variant="secondary" className="ml-auto" disabled={loading} onClick={() => void reload()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Refresh
          </Button>
        </div>
      </PageHeaderBanner>

      {error && !overview ? <ErrorBox message={error} onRetry={reload} /> : !overview ? <LoadingRows rows={2} /> : (
        <>
          {error && <ErrorBox message={`Could not refresh the overview: ${error}`} onRetry={reload} />}
          <StatusBanner overview={overview} />
          <StatCards overview={overview} />
          <SupplyStrip overview={overview} />
        </>
      )}

      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start">
          {(Object.keys(TAB_LABELS) as TabId[]).map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none">
              {TAB_LABELS[id]}
              {!!counts[id] && <Badge variant="secondary" className="ml-1.5 px-1.5">{counts[id]}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {/* Only the active tab is mounted; each loads its own data, so a failed overview never blanks the page. */}
      <div className="pt-1">
        {tab === "business-reviews" && <BusinessReviewsTab onChanged={() => void reload()} />}
        {tab === "sender-ids" && <SenderIdsTab provider={overview?.provider ?? ""} onChanged={() => void reload()} />}
        {tab === "flagged" && overview && <FlaggedTab overview={overview} onChanged={() => void reload()} />}
        {tab === "messages" && <MessagesTab />}
        {tab === "accounts" && <AccountsTab onChanged={() => void reload()} />}
        {tab === "bundles" && <BundlesTab />}
        {tab === "settings" && <SettingsTab provider={overview?.provider ?? ""} />}
      </div>

      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} busy={switching} destructive
        title="Pause SMS for all customers?" confirmLabel="Pause SMS"
        description="New sends and credit purchases are refused with a friendly message. Payments already made are still credited, queued messages still go out, and OTP/transactional messages are unaffected. Takes effect within a minute."
        onConfirm={() => setEnabled(false)} />
    </div>
  )
}
