"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Settings, Loader2, AlertCircle, CheckCircle, Zap, WifiOff, Wallet, FileText, ToggleLeft, ToggleRight, ShieldCheck, Bell, ArrowUp, ArrowDown, X, Plus, Download } from "lucide-react"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import Link from "next/link"

interface MTNSettings {
  enabled: boolean
  updated_at: string
}

interface ProviderBalance {
  balance: number | null
  currency: string
  is_low: boolean
  is_active: boolean
  alert: string | null
}

interface MTNBalance {
  balances: {
    sykes: ProviderBalance
    datakazina: ProviderBalance
    xpress: ProviderBalance
    eazyghdata: ProviderBalance
    bisdel: ProviderBalance
    codecraft: ProviderBalance
    agentportalgh: ProviderBalance
  }
  threshold: number
  active_provider: string
  timestamp: string
}

export default function MTNSettingsPage() {
  const router = useRouter()
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  const [settings, setSettings] = useState<MTNSettings | null>(null)
  const [balance, setBalance] = useState<MTNBalance | null>(null)
  const [loadingSettings, setLoadingSettings] = useState(true)
  const [loadingBalance, setLoadingBalance] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [gateSettings, setGateSettings] = useState<{ enabled: boolean; updated_at?: string } | null>(null)
  const [gateToggling, setGateToggling] = useState(false)
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh">("sykes")
  const [syncingPackages, setSyncingPackages] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [bisdelCategories, setBisdelCategories] = useState<string[]>([])
  const [bisdelCategory, setBisdelCategory] = useState<string>("")
  const [syncingBisdel, setSyncingBisdel] = useState(false)
  const [savingBisdelCategory, setSavingBisdelCategory] = useState(false)
  const [activeTab, setActiveTab] = useState("overview")

  const [atFulfillmentEnabled, setAtFulfillmentEnabled] = useState(true)
  const [loadingAtFulfillment, setLoadingAtFulfillment] = useState(true)
  const [togglingAtFulfillment, setTogglingAtFulfillment] = useState(false)

  const [whitelistEnabled, setWhitelistEnabled] = useState(true)
  const [loadingWhitelist, setLoadingWhitelist] = useState(true)
  const [togglingWhitelist, setTogglingWhitelist] = useState(false)

  const [threshold, setThreshold] = useState<number>(500)
  const [thresholdInput, setThresholdInput] = useState<string>("500")
  const [savingThreshold, setSavingThreshold] = useState(false)

  const [apgIdentity, setApgIdentity] = useState<any>(null)
  const [apgBalance, setApgBalance] = useState<number | null>(null)
  const [apgBalanceLoading, setApgBalanceLoading] = useState(false)
  const [apgSummary, setApgSummary] = useState<any>(null)
  const [apgSummaryFrom, setApgSummaryFrom] = useState("")
  const [apgSummaryTo, setApgSummaryTo] = useState("")
  const [apgSummaryLoading, setApgSummaryLoading] = useState(false)
  const [apgServices, setApgServices] = useState<any[]>([])
  const [apgTopupAmount, setApgTopupAmount] = useState("")
  const [apgTopupPhone, setApgTopupPhone] = useState("")
  const [apgTopupNetwork, setApgTopupNetwork] = useState("MTN")
  const [apgTopupLoading, setApgTopupLoading] = useState(false)
  const [apgTopupResult, setApgTopupResult] = useState<string | null>(null)
  const [apgTransactions, setApgTransactions] = useState<any[]>([])
  const [apgTransactionsPage, setApgTransactionsPage] = useState(1)
  const [apgTopups, setApgTopups] = useState<any[]>([])
  const [apgTopupsPage, setApgTopupsPage] = useState(1)
  const [apgWebhookConfig, setApgWebhookConfig] = useState<any>(null)
  const [apgWebhookUrl, setApgWebhookUrl] = useState("")
  const [apgWebhookEnabled, setApgWebhookEnabled] = useState(true)
  const [apgWebhookSaving, setApgWebhookSaving] = useState(false)
  const [apgDeliveries, setApgDeliveries] = useState<any[]>([])
  const [apgDeliveriesPage, setApgDeliveriesPage] = useState(1)
  const [apgExpandedDelivery, setApgExpandedDelivery] = useState<number | null>(null)
  const [apgWhitelistInput, setApgWhitelistInput] = useState("")
  const [apgWhitelistResult, setApgWhitelistResult] = useState<any[]>([])
  const [apgWhitelistLoading, setApgWhitelistLoading] = useState(false)
  const [apgOrders, setApgOrders] = useState<any[]>([])
  const [apgOrdersSearch, setApgOrdersSearch] = useState("")
  const [apgOrdersLoading, setApgOrdersLoading] = useState(false)
  const [apgExpandedOrder, setApgExpandedOrder] = useState<string | number | null>(null)
  const [apgOrderItems, setApgOrderItems] = useState<Record<string | number, any[]>>({})
  const [apgSubTab, setApgSubTab] = useState("overview")

  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh"
  const [retrySequenceEnabled, setRetrySequenceEnabled] = useState(false)
  const [retrySequence, setRetrySequence] = useState<MTNProviderName[]>([])
  const [savingRetrySequence, setSavingRetrySequence] = useState(false)

  const [disabledProviders, setDisabledProviders] = useState<MTNProviderName[]>([])
  const [togglingDisabled, setTogglingDisabled] = useState<MTNProviderName | null>(null)

  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
  const [savingNetworkProvider, setSavingNetworkProvider] = useState<string | null>(null)

  useEffect(() => {
    if (adminLoading) return
    if (!isAdmin) return
    loadSettings()
    loadGateSettings()
    loadBalance()
    loadProvider()
    loadBisdelCatalog()
    loadAtFulfillmentSetting()
    loadWhitelistSetting()
    loadNetworkProvider("telecel", setTelecelProvider)
    loadNetworkProvider("at_ishare", setAtIshareProvider)
    loadNetworkProvider("at_bigtime", setAtBigtimeProvider)
    loadThreshold()
    loadRetrySequence()
    loadDisabledProviders()
    const balanceInterval = setInterval(loadBalance, 30000)
    return () => clearInterval(balanceInterval)
  }, [isAdmin, adminLoading])

  useEffect(() => {
    if (activeTab === "agentportalgh") {
      loadApgIdentityAndServices()
      loadApgBalance()
      loadApgWebhookConfig()
      loadApgDeliveries()
      loadApgTransactions()
      loadApgTopups()
      loadApgOrders()
    }
  }, [activeTab])

  useEffect(() => {
    if (activeTab === "agentportalgh") loadApgTransactions()
  }, [apgTransactionsPage])

  useEffect(() => {
    if (activeTab === "agentportalgh") loadApgTopups()
  }, [apgTopupsPage])

  useEffect(() => {
    if (activeTab === "agentportalgh") loadApgDeliveries()
  }, [apgDeliveriesPage])

  const loadSettings = async () => {
    try {
      setLoadingSettings(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); router.push("/login"); return }
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setSettings({ enabled: data.enabled, updated_at: data.updated_at })
      } else {
        toast.error("Failed to load MTN settings")
      }
    } catch (error) {
      console.error("Error loading settings:", error)
      toast.error("Error loading MTN settings")
    } finally {
      setLoadingSettings(false)
    }
  }

  const loadGateSettings = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); router.push("/login"); return }
      const response = await fetch("/api/admin/settings/mtn-registration-gate", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setGateSettings({ enabled: data.enabled, updated_at: data.updated_at })
      } else {
        toast.error("Failed to load registration gate settings")
      }
    } catch (error) {
      console.error("Error loading gate settings:", error)
      toast.error("Error loading registration gate settings")
    }
  }

  const loadBalance = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/fulfillment/mtn-balance", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBalance(data)
      }
    } catch (error) {
      console.error("Error loading balance:", error)
    } finally {
      setLoadingBalance(false)
    }
  }

  const handleToggle = async () => {
    if (!settings) return
    try {
      setToggling(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/settings/mtn-auto-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !settings.enabled }),
      })
      if (response.ok) {
        const data = await response.json()
        setSettings({ enabled: data.enabled, updated_at: new Date().toISOString() })
        toast.success(data.message)
      } else {
        toast.error("Failed to update setting")
      }
    } catch (error) {
      console.error("Error updating setting:", error)
      toast.error("Error updating MTN setting")
    } finally {
      setToggling(false)
    }
  }

  const handleGateToggle = async () => {
    if (!gateSettings) return
    try {
      setGateToggling(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/settings/mtn-registration-gate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !gateSettings.enabled }),
      })
      if (response.ok) {
        const data = await response.json()
        setGateSettings({ enabled: data.enabled, updated_at: new Date().toISOString() })
        toast.success(data.message)
      } else {
        toast.error("Failed to update setting")
      }
    } catch (error) {
      console.error("Error updating gate setting:", error)
      toast.error("Error updating registration gate setting")
    } finally {
      setGateToggling(false)
    }
  }

  const loadProvider = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/settings/mtn-provider", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setMtnProvider(data.provider || "sykes")
      }
    } catch (error) {
      console.error("Error loading provider:", error)
    }
  }

  const loadBisdelCatalog = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        setBisdelCategory(data.selected_category || "")
      }
    } catch (error) {
      console.error("Error loading Bisdel catalog:", error)
    }
  }

  const handleSyncEazyGhDataPackages = async () => {
    setSyncingPackages(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/eazyghdata-packages", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        toast.success(`Synced ${data.count} EazyGhData packages`)
      } else {
        const err = await response.json()
        toast.error(err.error || "Failed to sync packages")
      }
    } catch (error) {
      console.error("Error syncing packages:", error)
      toast.error("Error syncing EazyGhData packages")
    } finally {
      setSyncingPackages(false)
    }
  }

  const handleSyncBisdelProducts = async () => {
    setSyncingBisdel(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        toast.success(`Synced ${data.count} Bisdel products`)
      } else {
        const err = await response.json()
        toast.error(err.error || "Failed to sync products")
      }
    } catch (error) {
      console.error("Error syncing Bisdel products:", error)
      toast.error("Error syncing Bisdel products")
    } finally {
      setSyncingBisdel(false)
    }
  }

  const handleSelectBisdelCategory = async (category: string) => {
    setSavingBisdelCategory(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ category }),
      })
      if (response.ok) {
        setBisdelCategory(category)
        toast.success(`Bisdel category set to ${category}`)
      } else {
        toast.error("Failed to set category")
      }
    } catch (error) {
      console.error("Error setting Bisdel category:", error)
      toast.error("Error setting Bisdel category")
    } finally {
      setSavingBisdelCategory(false)
    }
  }

  const loadRetrySequence = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/settings/mtn-retry-sequence", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const d = await res.json()
        setRetrySequenceEnabled(d.enabled)
        setRetrySequence(d.providers || [])
      }
    } catch (e) { console.error("Error loading retry sequence:", e) }
  }

  const handleSaveRetrySequence = async (enabled: boolean, providers: MTNProviderName[]) => {
    setSavingRetrySequence(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/settings/mtn-retry-sequence", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled, providers }),
      })
      if (res.ok) {
        setRetrySequenceEnabled(enabled)
        setRetrySequence(providers)
        toast.success("Retry sequence updated")
      } else {
        toast.error("Failed to save retry sequence")
      }
    } catch (e) {
      console.error("Error saving retry sequence:", e)
      toast.error("Error saving retry sequence")
    } finally {
      setSavingRetrySequence(false)
    }
  }

  const addToRetrySequence = (p: MTNProviderName) => {
    if (retrySequence.includes(p)) return
    handleSaveRetrySequence(true, [...retrySequence, p])
  }

  const removeFromRetrySequence = (p: MTNProviderName) => {
    handleSaveRetrySequence(retrySequenceEnabled, retrySequence.filter(x => x !== p))
  }

  const moveInRetrySequence = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= retrySequence.length) return
    const next = [...retrySequence]
    ;[next[index], next[target]] = [next[target], next[index]]
    handleSaveRetrySequence(retrySequenceEnabled, next)
  }

  const loadDisabledProviders = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/settings/mtn-disabled-providers", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const d = await res.json()
        setDisabledProviders(d.disabled || [])
      }
    } catch (e) { console.error("Error loading disabled providers:", e) }
  }

  const toggleProviderDisabled = async (p: MTNProviderName) => {
    setTogglingDisabled(p)
    const next = disabledProviders.includes(p)
      ? disabledProviders.filter(x => x !== p)
      : [...disabledProviders, p]
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/mtn-disabled-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ disabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to update")
      setDisabledProviders(next)
      toast.success(`${PROVIDER_LABELS[p]} ${next.includes(p) ? "deactivated" : "activated"}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update provider status")
    } finally {
      setTogglingDisabled(null)
    }
  }

  const handleMTNProviderChange = async (provider: MTNProviderName) => {
    setSavingProvider(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/settings/mtn-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ provider }),
      })
      if (response.ok) {
        const data = await response.json()
        setMtnProvider(provider)
        toast.success(data.message)
        loadBalance()
      } else {
        toast.error("Failed to update provider")
      }
    } catch (error) {
      console.error("Error updating provider:", error)
      toast.error("Error updating MTN provider")
    } finally {
      setSavingProvider(false)
    }
  }

  const loadThreshold = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/balance-threshold", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) {
        const d = await res.json()
        setThreshold(d.threshold)
        setThresholdInput(String(d.threshold))
      }
    } catch (e) { console.error("Error loading threshold:", e) }
  }

  const handleSaveThreshold = async () => {
    const value = parseInt(thresholdInput, 10)
    if (isNaN(value) || value < 0) { toast.error("Enter a valid number"); return }
    setSavingThreshold(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/balance-threshold", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ threshold: value }),
      })
      if (!res.ok) throw new Error("Failed to save")
      setThreshold(value)
      toast.success(`Alert threshold set to ₵${value}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setSavingThreshold(false) }
  }

  const loadNetworkProvider = async (network: string, setter: (v: any) => void) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`/api/admin/settings/network-provider?network=${network}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setter(d.provider || "codecraft") }
    } catch (e) { console.error(`Error loading ${network} provider:`, e) }
  }

  const handleNetworkProviderChange = async (network: string, provider: string, setter: (v: any) => void) => {
    setSavingNetworkProvider(network)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/network-provider", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ network, provider }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      setter(provider)
      toast.success("Provider updated")
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setSavingNetworkProvider(null) }
  }

  const loadAtFulfillmentSetting = async () => {
    try {
      setLoadingAtFulfillment(true)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/auto-fulfillment", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setAtFulfillmentEnabled(d.setting?.enabled ?? true) }
    } catch (e) { console.error("Error loading AT fulfillment setting:", e) }
    finally { setLoadingAtFulfillment(false) }
  }

  const toggleAtFulfillment = async () => {
    try {
      setTogglingAtFulfillment(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/auto-fulfillment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !atFulfillmentEnabled }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      const d = await res.json()
      setAtFulfillmentEnabled(d.setting.enabled)
      toast.success(d.message)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setTogglingAtFulfillment(false) }
  }

  const loadWhitelistSetting = async () => {
    try {
      setLoadingWhitelist(true)
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/admin/settings/mtn-whitelist", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) { const d = await res.json(); setWhitelistEnabled(d.setting?.enabled ?? true) }
    } catch (e) { console.error("Error loading whitelist setting:", e) }
    finally { setLoadingWhitelist(false) }
  }

  const toggleWhitelist = async () => {
    try {
      setTogglingWhitelist(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/settings/mtn-whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ enabled: !whitelistEnabled }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      const d = await res.json()
      setWhitelistEnabled(d.setting.enabled)
      toast.success(d.message)
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to update") }
    finally { setTogglingWhitelist(false) }
  }

  async function apgAuthHeaders(): Promise<Record<string, string>> {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  async function loadApgIdentityAndServices() {
    const hdrs = await apgAuthHeaders()
    const [identRes, servRes] = await Promise.all([
      fetch("/api/admin/agentportalgh?action=identity", { headers: hdrs }).then(r => r.json()),
      fetch("/api/admin/agentportalgh?action=services", { headers: hdrs }).then(r => r.json()),
    ])
    setApgIdentity(identRes)
    setApgServices(servRes.data ?? servRes.services ?? [])
  }

  async function loadApgBalance() {
    setApgBalanceLoading(true)
    const hdrs = await apgAuthHeaders()
    const res = await fetch("/api/admin/agentportalgh?action=balance", { headers: hdrs }).then(r => r.json())
    setApgBalance(res.balance)
    setApgBalanceLoading(false)
  }

  async function loadApgSummary() {
    setApgSummaryLoading(true)
    const params = new URLSearchParams({ action: "summary" })
    if (apgSummaryFrom) params.set("from", apgSummaryFrom)
    if (apgSummaryTo) params.set("to", apgSummaryTo)
    const hdrs = await apgAuthHeaders()
    const res = await fetch(`/api/admin/agentportalgh?${params}`, { headers: hdrs }).then(r => r.json())
    setApgSummary(res.data ?? res)
    setApgSummaryLoading(false)
  }

  async function loadApgTransactions() {
    const hdrs = await apgAuthHeaders()
    const res = await fetch(`/api/admin/agentportalgh?action=transactions&page=${apgTransactionsPage}&page_size=25`, { headers: hdrs }).then(r => r.json())
    setApgTransactions(res.data ?? [])
  }

  async function loadApgTopups() {
    const hdrs = await apgAuthHeaders()
    const res = await fetch(`/api/admin/agentportalgh?action=topups&page=${apgTopupsPage}&page_size=25`, { headers: hdrs }).then(r => r.json())
    setApgTopups(res.data ?? [])
  }

  async function handleApgTopup() {
    setApgTopupLoading(true)
    setApgTopupResult(null)
    const hdrs = await apgAuthHeaders()
    const res = await fetch("/api/admin/agentportalgh?action=topup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hdrs },
      body: JSON.stringify({ amount: parseFloat(apgTopupAmount), phone: apgTopupPhone, network: apgTopupNetwork }),
    }).then(r => r.json())
    // Confirmed error shape is { error: "..." } — success has no confirmed shape
    // beyond "the wallet is not credited immediately" (MoMo prompt, async confirm).
    setApgTopupResult(res.error ?? res.message ?? "MoMo prompt sent — check Top-up History for confirmation")
    setApgTopupLoading(false)
  }

  async function loadApgWebhookConfig() {
    const hdrs = await apgAuthHeaders()
    const res = await fetch("/api/admin/agentportalgh?action=webhook-config", { headers: hdrs }).then(r => r.json())
    setApgWebhookConfig(res.data ?? res)
    setApgWebhookUrl(res.data?.url ?? res.url ?? "")
    setApgWebhookEnabled(res.data?.enabled ?? res.enabled ?? true)
  }

  async function saveApgWebhookConfig(regenerate = false) {
    setApgWebhookSaving(true)
    const hdrs = await apgAuthHeaders()
    const res = await fetch("/api/admin/agentportalgh?action=webhook-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...hdrs },
      body: JSON.stringify({ url: apgWebhookUrl, enabled: apgWebhookEnabled, regenerate_secret: regenerate }),
    }).then(r => r.json())
    toast(res.message ?? "Webhook config saved")
    setApgWebhookSaving(false)
    loadApgWebhookConfig()
  }

  async function loadApgDeliveries() {
    const hdrs = await apgAuthHeaders()
    const res = await fetch(`/api/admin/agentportalgh?action=webhook-deliveries&page=${apgDeliveriesPage}&page_size=50`, { headers: hdrs }).then(r => r.json())
    setApgDeliveries(res.data ?? [])
  }

  async function resendApgDelivery(id: string | number) {
    const hdrs = await apgAuthHeaders()
    await fetch("/api/admin/agentportalgh?action=webhook-resend", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hdrs },
      body: JSON.stringify({ id }),
    })
    toast("Resend queued")
    loadApgDeliveries()
  }

  async function checkApgWhitelist() {
    setApgWhitelistLoading(true)
    setApgWhitelistResult([])
    try {
      const msisdns = apgWhitelistInput.split("\n").map(s => s.trim()).filter(Boolean)
      const hdrs = await apgAuthHeaders()
      const res = await fetch("/api/admin/agentportalgh?action=whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...hdrs },
        body: JSON.stringify({ msisdns }),
      })
      const json = await res.json()
      if (!res.ok || json.error) {
        toast.error(json.error ?? "Whitelist check failed")
        return
      }
      // Confirmed response shape (AgentPortalGH docs §5):
      // { network, results: [{ input, normalized, allowed }], allowed_count, total }
      const rawList: any[] = Array.isArray(json.results) ? json.results : Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []
      const normalized = rawList.map((r: any, i: number) => ({
        msisdn: r.normalized ?? r.input ?? r.msisdn ?? msisdns[i] ?? "—",
        allowed: r.allowed === true,
        reason: r.reason,
      }))
      setApgWhitelistResult(normalized)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Whitelist check failed")
    } finally {
      setApgWhitelistLoading(false)
    }
  }

  function downloadWhitelistExport(allowed: boolean) {
    const numbers = apgWhitelistResult.filter(r => r.allowed === allowed).map(r => r.msisdn)
    if (numbers.length === 0) {
      toast.error(`No ${allowed ? "allowed" : "blocked"} numbers to export`)
      return
    }
    const blob = new Blob([numbers.join("\n")], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `agentportalgh-whitelist-${allowed ? "allowed" : "blocked"}-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadApgOrders() {
    setApgOrdersLoading(true)
    const params = new URLSearchParams({ action: "orders" })
    if (apgOrdersSearch) params.set("search", apgOrdersSearch)
    const hdrs = await apgAuthHeaders()
    const res = await fetch(`/api/admin/agentportalgh?${params}`, { headers: hdrs }).then(r => r.json())
    setApgOrders(res.data ?? res.orders ?? [])
    setApgOrdersLoading(false)
  }

  async function expandApgOrder(orderId: string | number) {
    if (apgExpandedOrder === orderId) { setApgExpandedOrder(null); return }
    setApgExpandedOrder(orderId)
    if (!apgOrderItems[orderId]) {
      const hdrs = await apgAuthHeaders()
      const res = await fetch(`/api/admin/agentportalgh?action=order-items&order_id=${orderId}`, { headers: hdrs }).then(r => r.json())
      setApgOrderItems(prev => ({ ...prev, [orderId]: res.data ?? res.items ?? [] }))
    }
  }

  if (!isAdmin || adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  function ProviderBal({ pb }: { pb?: ProviderBalance }) {
    if (!pb) return <p className="text-sm text-muted-foreground">—</p>
    return (
      <div className="space-y-1">
        {pb.balance !== null ? (
          <>
            <p className={`text-3xl font-bold ${pb.is_low ? "text-warning" : "text-success"}`}>
              ₵{pb.balance.toFixed(2)}<span className="text-sm font-normal text-muted-foreground ml-2">GHS</span>
            </p>
            {pb.is_low && <p className="text-xs text-warning">⚠️ Low balance — consider topping up</p>}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to fetch balance</p>
        )}
      </div>
    )
  }

  function ActivationCard({ providerKey, label }: { providerKey: MTNProviderName; label: string }) {
    const isActive = mtnProvider === providerKey
    const isDisabled = disabledProviders.includes(providerKey)
    const isToggling = togglingDisabled === providerKey
    return (
      <Card>
        <CardContent className="pt-5 space-y-3">
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">{isDisabled ? "Deactivated" : "Active"}</p>
              <p className="text-xs text-muted-foreground">Deactivated providers are skipped in primary selection and the retry sequence.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isToggling && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              <Switch checked={!isDisabled} onCheckedChange={() => toggleProviderDisabled(providerKey)} disabled={isToggling} />
            </div>
          </div>

          {isActive && isDisabled && (
            <Alert className="border-warning/30 bg-warning/10">
              <AlertCircle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-xs">
                <strong>{label}</strong> is set as primary but deactivated — new orders automatically fall back to the next active provider instead.
              </AlertDescription>
            </Alert>
          )}

          {isActive ? (
            <Alert className="border-success/30 bg-success/10">
              <CheckCircle className="h-4 w-4 text-success" />
              <AlertDescription className="text-success">
                <strong>{label}</strong> is the active MTN fulfillment provider. New orders are sent here.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Not currently active. Click below to route new MTN orders to this provider.</p>
              <Button onClick={() => handleMTNProviderChange(providerKey)} disabled={savingProvider || isDisabled} className="w-full">
                {savingProvider ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
                Set {label} as Primary MTN Provider
              </Button>
              {isDisabled ? (
                <Alert className="border-border bg-muted/40">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">Deactivated — reactivate it above before setting it as primary.</AlertDescription>
                </Alert>
              ) : (
                <Alert className="border-border bg-warning/10">
                  <AlertCircle className="h-4 w-4 text-warning" />
                  <AlertDescription className="text-warning text-xs">Only affects new orders. In-flight orders continue with their original provider.</AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  const PROVIDER_LABELS: Record<MTNProviderName, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft", agentportalgh: "AgentPortalGH",
  }

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6 p-6">
        <div className="flex items-center gap-2 mb-2">
          <Settings className="h-6 w-6" />
          <h1 className="text-3xl font-bold">MTN Fulfillment Settings</h1>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="overflow-x-auto pb-1">
            <TabsList className="inline-flex w-max h-auto p-1 gap-0.5">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {(Object.keys(PROVIDER_LABELS) as MTNProviderName[]).map(p => (
                <TabsTrigger key={p} value={p} className="gap-1.5">
                  {PROVIDER_LABELS[p]}
                  {mtnProvider === p && <span className="h-2 w-2 rounded-full bg-green-500 shrink-0" />}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* ─── Overview ─── */}
          <TabsContent value="overview" className="space-y-6 mt-6">

            {/* MTN Auto-Fulfillment */}
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />Auto-Fulfillment Mode</CardTitle>
                <CardDescription>Control whether MTN orders are automatically fulfilled or queued for manual download</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {loadingSettings ? (
                  <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
                ) : (
                  <>
                    <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
                      <div className="space-y-1">
                        <p className="font-medium text-foreground">{settings?.enabled ? "🟢 ENABLED" : "⚪ DISABLED"}</p>
                        <p className="text-sm text-muted-foreground">
                          {settings?.enabled ? "Orders are automatically fulfilled via MTN API" : "Orders appear in admin download queue for manual fulfillment"}
                        </p>
                      </div>
                      <Button onClick={handleToggle} disabled={toggling} variant={settings?.enabled ? "destructive" : "default"} className="min-w-[120px]">
                        {toggling ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Updating…</> : settings?.enabled ? <><WifiOff className="h-4 w-4 mr-2" />Turn Off</> : <><Zap className="h-4 w-4 mr-2" />Turn On</>}
                      </Button>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4 text-sm">
                      <div className="p-4 bg-primary/5 rounded-lg border border-primary/20">
                        <p className="font-medium text-foreground mb-2">🟢 When Enabled</p>
                        <ul className="space-y-1 text-primary text-xs">
                          <li>✓ Orders auto-fulfill immediately</li>
                          <li>✓ Faster customer delivery</li>
                          <li>✓ MTN API handles all requests</li>
                          <li>✓ Tracked in MTN Fulfillment tab</li>
                        </ul>
                      </div>
                      <div className="p-4 bg-warning/10 rounded-lg border border-border">
                        <p className="font-medium text-warning mb-2">⚪ When Disabled</p>
                        <ul className="space-y-1 text-warning text-xs">
                          <li>✓ Orders go to Downloads tab</li>
                          <li>✓ Admin controls fulfillment</li>
                          <li>✓ Manual review before execution</li>
                          <li>✓ Extra layer of safety</li>
                        </ul>
                      </div>
                    </div>
                    {settings?.updated_at && <p className="text-xs text-muted-foreground">Last updated: {new Date(settings.updated_at).toLocaleString()}</p>}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Registration Gate */}
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><CheckCircle className="h-5 w-5" />Registration Gate</CardTitle>
                <CardDescription>Hold MTN orders for numbers not yet registered with MTN. Enable ONLY after the registry back-catalog has been marked registered.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg">
                  <p className="font-medium text-foreground">{gateSettings?.enabled ? "🟢 ENABLED — unregistered numbers are held" : "⚪ DISABLED — orders flow as before"}</p>
                  <Button onClick={handleGateToggle} disabled={gateToggling || !gateSettings} variant={gateSettings?.enabled ? "destructive" : "default"} className="min-w-[120px]">
                    {gateToggling ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Updating…</> : gateSettings?.enabled ? <><WifiOff className="h-4 w-4 mr-2" />Turn Off</> : <><Zap className="h-4 w-4 mr-2" />Turn On</>}
                  </Button>
                </div>
                {gateSettings?.updated_at && <p className="text-xs text-muted-foreground">Last updated: {new Date(gateSettings.updated_at).toLocaleString()}</p>}
              </CardContent>
            </Card>

            {/* Wallet Balances */}
            <Card className="border-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5" />MTN Wallet Balances</CardTitle>
                <CardDescription>Real-time wallet balances across all providers — click a card to open that provider's tab</CardDescription>
              </CardHeader>
              <CardContent>
                {loadingBalance ? (
                  <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
                ) : balance ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                      {(Object.keys(PROVIDER_LABELS) as MTNProviderName[]).map(key => {
                        const pb = balance.balances[key as keyof typeof balance.balances]
                        if (!pb) return null
                        return (
                          <div
                            key={key}
                            className={`p-3 rounded-lg border-2 cursor-pointer transition-all hover:shadow-sm ${pb.is_active ? "bg-primary/5 border-primary shadow-sm" : "bg-muted/40 border-border"}`}
                            onClick={() => setActiveTab(key)}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-medium text-foreground truncate">{PROVIDER_LABELS[key]}</span>
                              {pb.is_active && <Badge className="bg-primary text-[10px] px-1 py-0 shrink-0">Active</Badge>}
                            </div>
                            {pb.balance !== null ? (
                              <p className={`text-lg font-bold ${pb.is_low ? "text-warning" : "text-success"}`}>₵{pb.balance.toFixed(0)}</p>
                            ) : (
                              <p className="text-xs text-muted-foreground">—</p>
                            )}
                            {pb.is_low && <p className="text-[10px] text-warning mt-0.5">⚠️ Low</p>}
                          </div>
                        )
                      })}
                    </div>

                    {Object.values(balance.balances).some(pb => pb?.is_low) && (
                      <Alert className="border-border bg-warning/10">
                        <AlertCircle className="h-4 w-4 text-warning" />
                        <AlertDescription className="text-warning">
                          {Object.entries(balance.balances).filter(([, pb]) => pb?.alert).map(([k, pb]) => (
                            <p key={k}>• {pb!.alert}</p>
                          ))}
                          <p className="mt-1 font-medium">SMS alert has been sent to admin.</p>
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="p-3 bg-muted/40 rounded space-y-2">
                      <div className="flex items-center gap-2">
                        <Bell className="h-4 w-4 text-muted-foreground" />
                        <Label className="text-sm font-medium">Alert Threshold</Label>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-muted-foreground">₵</span>
                        <Input type="number" min={0} value={thresholdInput} onChange={e => setThresholdInput(e.target.value)} className="w-32 h-8 text-sm" />
                        <Button size="sm" variant="outline" onClick={handleSaveThreshold} disabled={savingThreshold || thresholdInput === String(threshold)}>
                          {savingThreshold ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                        </Button>
                        <span className="text-xs text-muted-foreground">SMS + email alert fires when any balance drops below this</span>
                      </div>
                    </div>

                    <Button onClick={loadBalance} variant="outline" className="w-full">Refresh Balances</Button>
                  </div>
                ) : (
                  <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>Unable to fetch balances. Check MTN API connections.</AlertDescription></Alert>
                )}
              </CardContent>
            </Card>

            {/* Retry Sequence */}
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />Retry Sequence</CardTitle>
                    <CardDescription>Ordered list of providers to try, in order, when the primary provider fails</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {savingRetrySequence && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <Switch checked={retrySequenceEnabled} onCheckedChange={v => handleSaveRetrySequence(v, retrySequence)} disabled={savingRetrySequence} />
                  </div>
                </div>
              </CardHeader>
              {retrySequenceEnabled && (
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    When <strong>{PROVIDER_LABELS[mtnProvider]}</strong> (primary) fails, orders are retried through this sequence, in order, until one succeeds.
                  </p>

                  {retrySequence.length === 0 ? (
                    <Alert className="border-border bg-muted/40">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-sm">No retry providers configured — a failed primary attempt will not be retried automatically.</AlertDescription>
                    </Alert>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 flex-wrap text-sm">
                        <Badge variant="outline">{PROVIDER_LABELS[mtnProvider]}</Badge>
                        <span className="text-xs text-muted-foreground">(primary)</span>
                        {retrySequence.map(p => (
                          <span key={p} className="inline-flex items-center gap-2">
                            <span className="text-muted-foreground">→</span>
                            <Badge className="bg-primary">{PROVIDER_LABELS[p]}</Badge>
                          </span>
                        ))}
                      </div>
                      <div className="space-y-1.5">
                        {retrySequence.map((p, i) => (
                          <div key={p} className="flex items-center gap-2 p-2 rounded-lg border border-border bg-card">
                            <span className="text-xs text-muted-foreground w-5 text-center shrink-0">{i + 1}</span>
                            <span className="flex-1 text-sm font-medium">{PROVIDER_LABELS[p]}</span>
                            {disabledProviders.includes(p) && (
                              <Badge variant="outline" className="text-xs text-muted-foreground">deactivated — skipped</Badge>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => moveInRetrySequence(i, -1)} disabled={savingRetrySequence || i === 0}>
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => moveInRetrySequence(i, 1)} disabled={savingRetrySequence || i === retrySequence.length - 1}>
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => removeFromRetrySequence(p)} disabled={savingRetrySequence}>
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-muted-foreground">Add provider:</span>
                    {(Object.keys(PROVIDER_LABELS) as MTNProviderName[])
                      .filter(p => p !== mtnProvider && !retrySequence.includes(p) && !disabledProviders.includes(p))
                      .map(p => (
                        <Button key={p} size="sm" variant="outline" onClick={() => addToRetrySequence(p)} disabled={savingRetrySequence}>
                          <Plus className="h-3 w-3 mr-1" />{PROVIDER_LABELS[p]}
                        </Button>
                      ))}
                  </div>

                  <Alert className="border-border bg-warning/10">
                    <AlertCircle className="h-4 w-4 text-warning" />
                    <AlertDescription className="text-warning text-xs">
                      Retries only trigger on API-level failures. Registration holds are never retried (no provider can bypass MTN's registration requirement).
                      Whitelist holds try this sequence directly (bypassing the whitelist check) before falling back to the 24h whitelist-retry cron.
                    </AlertDescription>
                  </Alert>
                </CardContent>
              )}
            </Card>

            {/* Per-Network Provider Selectors */}
            {(["telecel", "at_ishare", "at_bigtime"] as const).map(netKey => {
              const networkLabel = netKey === "telecel" ? "Telecel" : netKey === "at_ishare" ? "AT - iShare" : "AT - BigTime"
              const current = netKey === "telecel" ? telecelProvider : netKey === "at_ishare" ? atIshareProvider : atBigtimeProvider
              const setter = netKey === "telecel" ? setTelecelProvider : netKey === "at_ishare" ? setAtIshareProvider : setAtBigtimeProvider
              const isSaving = savingNetworkProvider === netKey
              const providers: { value: NonMTNProvider; label: string; sub: string }[] = [
                { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
                { value: "datakazina", label: "DataKazina", sub: "Multi-network" },
                { value: "xpress", label: "Xpress", sub: "Batch-enabled" },
                { value: "eazyghdata", label: "EazyGhData", sub: "Package-based" },
              ]
              return (
                <Card key={netKey} className="border-2">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2"><Settings className="h-5 w-5" />{networkLabel} Fulfillment Provider</CardTitle>
                    <CardDescription>Select which provider fulfills <strong>{networkLabel}</strong> orders</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {providers.map(p => {
                        const isProviderDisabled = disabledProviders.includes(p.value)
                        return (
                          <button
                            key={p.value}
                            onClick={() => handleNetworkProviderChange(netKey, p.value, setter)}
                            disabled={isSaving || current === p.value}
                            className={`p-4 rounded-lg border-2 transition-all text-left ${
                              current === p.value ? "bg-primary/5 border-primary shadow-md" : "bg-card border-border hover:border-border"
                            } ${isSaving ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-semibold text-foreground text-sm">{p.label}</span>
                              {current === p.value && <Badge className="bg-primary text-xs">Active</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">{p.sub}</p>
                            {isProviderDisabled && (
                              <p className="text-xs text-warning mt-1">Deactivated in Provider Selection</p>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    {isSaving && <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Updating…</div>}
                    {disabledProviders.includes(current) && (
                      <Alert className="mt-3 border-warning/30 bg-warning/10">
                        <AlertCircle className="h-4 w-4 text-warning" />
                        <AlertDescription className="text-warning text-xs">
                          <strong>{PROVIDER_LABELS[current]}</strong> is selected here but deactivated — new {networkLabel} orders automatically fall back to the next active non-MTN-capable provider instead.
                        </AlertDescription>
                      </Alert>
                    )}
                    <Alert className="mt-3 border-border bg-warning/10">
                      <AlertCircle className="h-4 w-4 text-warning" />
                      <AlertDescription className="text-warning text-xs">Only affects new orders.</AlertDescription>
                    </Alert>
                  </CardContent>
                </Card>
              )
            })}

            {/* AT Networks Auto-Fulfillment */}
            <Card className="border-2">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {atFulfillmentEnabled ? <ToggleRight className="h-5 w-5 text-success" /> : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                      AT Networks Auto-Fulfillment
                    </CardTitle>
                    <CardDescription className="mt-1">Automatically fulfill AT-iShare, Telecel, and AT-BigTime orders via Code Craft API</CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    {loadingAtFulfillment ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
                      <>
                        {togglingAtFulfillment && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        <span className={`text-sm font-medium ${atFulfillmentEnabled ? "text-success" : "text-muted-foreground"}`}>{atFulfillmentEnabled ? "Enabled" : "Disabled"}</span>
                        <Switch checked={atFulfillmentEnabled} onCheckedChange={toggleAtFulfillment} disabled={togglingAtFulfillment} />
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2 mb-3">
                  <span className="text-sm text-muted-foreground">Affected networks:</span>
                  <Badge className="bg-primary/10 text-primary border border-primary">AT - iShare</Badge>
                  <Badge className="bg-red-100 text-red-800 border border-red-200">Telecel</Badge>
                  <Badge className="bg-primary/10 text-primary border border-primary">AT - BigTime</Badge>
                </div>
                <Alert className={atFulfillmentEnabled ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}>
                  <AlertCircle className={`h-4 w-4 ${atFulfillmentEnabled ? "text-success" : "text-warning"}`} />
                  <AlertDescription className={atFulfillmentEnabled ? "text-success" : "text-warning"}>
                    {atFulfillmentEnabled
                      ? <><strong>ON:</strong> Orders are automatically fulfilled via Code Craft API on payment confirmation.</>
                      : <><strong>OFF:</strong> Orders are queued in the admin download queue for manual processing.</>}
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            {/* MTN Whitelist Verification */}
            <Card className="border-2">
              <CardHeader>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheck className={`h-5 w-5 ${whitelistEnabled ? "text-success" : "text-muted-foreground"}`} />
                      MTN Whitelist Verification
                    </CardTitle>
                    <CardDescription className="mt-1">Check Xpress, Codecraft &amp; AgentPortalGH whitelists before fulfilling MTN orders</CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    {loadingWhitelist ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : (
                      <>
                        {togglingWhitelist && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                        <span className={`text-sm font-medium ${whitelistEnabled ? "text-success" : "text-muted-foreground"}`}>{whitelistEnabled ? "Enabled" : "Disabled"}</span>
                        <Switch checked={whitelistEnabled} onCheckedChange={toggleWhitelist} disabled={togglingWhitelist} />
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Alert className={whitelistEnabled ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}>
                  <ShieldCheck className={`h-4 w-4 ${whitelistEnabled ? "text-success" : "text-warning"}`} />
                  <AlertDescription className={whitelistEnabled ? "text-success" : "text-warning"}>
                    {whitelistEnabled
                      ? <><strong>ON:</strong> MTN orders are verified against Xpress → Codecraft → AgentPortalGH. Numbers not enabled are held and retried every 24h for up to 72h.</>
                      : <><strong>OFF:</strong> MTN orders skip whitelist verification and go straight to the active fulfillment provider.</>}
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            {/* Info cards */}
            <div className="grid md:grid-cols-2 gap-4">
              <Card className="bg-primary/10 border-border">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2"><FileText className="h-5 w-5 text-primary" />Fulfillment Logs</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-3 text-primary">
                  <p>View all MTN orders sent to the API, their status, and retry failed orders.</p>
                  <Link href="/admin/mtn-logs">
                    <Button className="w-full bg-primary hover:bg-primary"><FileText className="h-4 w-4 mr-2" />View MTN Fulfillment Logs</Button>
                  </Link>
                </CardContent>
              </Card>
              <Card className="bg-primary/5 border-primary/20">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2"><CheckCircle className="h-5 w-5 text-primary" />How It Works</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2 text-foreground">
                  <p><strong>Enabled:</strong> Orders bypass the download queue and are sent directly to MTN API for instant fulfillment.</p>
                  <p><strong>Disabled:</strong> Orders appear in your Download queue for review and manual fulfillment through the admin panel.</p>
                </CardContent>
              </Card>
            </div>
            <Card className="bg-warning/10 border-border">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2"><AlertCircle className="h-5 w-5 text-warning" />Pro Tip</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2 text-warning">
                <p>Start with <strong>Disabled</strong> to test your setup. Once confident, enable auto-fulfillment for faster order processing.</p>
                <p>Monitor balance to avoid failed orders due to insufficient funds.</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── Sykes ─── */}
          <TabsContent value="sykes" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>Sykes API</CardTitle><CardDescription>Current/legacy MTN data provider</CardDescription></div>
                  {mtnProvider === "sykes" && <Badge className="bg-primary">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {balance?.balances.sykes && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.sykes} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="sykes" label="Sykes API" />
          </TabsContent>

          {/* ─── DataKazina ─── */}
          <TabsContent value="datakazina" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>DataKazina API</CardTitle><CardDescription>Alternative MTN data provider</CardDescription></div>
                  {mtnProvider === "datakazina" && <Badge className="bg-primary">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {balance?.balances.datakazina && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.datakazina} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="datakazina" label="DataKazina API" />
          </TabsContent>

          {/* ─── Xpress ─── */}
          <TabsContent value="xpress" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>Xpress API</CardTitle><CardDescription>Batch-enabled MTN data provider</CardDescription></div>
                  {mtnProvider === "xpress" && <Badge className="bg-primary">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {balance?.balances.xpress && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.xpress} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="xpress" label="Xpress API" />
          </TabsContent>

          {/* ─── EazyGhData ─── */}
          <TabsContent value="eazyghdata" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>EazyGhData</CardTitle><CardDescription>Package-based MTN data provider</CardDescription></div>
                  {mtnProvider === "eazyghdata" && <Badge className="bg-primary">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {balance?.balances.eazyghdata && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.eazyghdata} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="eazyghdata" label="EazyGhData" />
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Package Sync</CardTitle>
                <CardDescription>Keep local EazyGhData package catalog in sync with the live API</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={handleSyncEazyGhDataPackages} disabled={syncingPackages} variant="outline">
                  {syncingPackages ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing…</> : "Sync EazyGhData Packages"}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── Bisdel ─── */}
          <TabsContent value="bisdel" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>Bisdel</CardTitle><CardDescription>Category-based MTN data provider</CardDescription></div>
                  {mtnProvider === "bisdel" && <Badge className="bg-indigo-600">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {balance?.balances.bisdel && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.bisdel} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="bisdel" label="Bisdel" />
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Products &amp; Category</CardTitle>
                <CardDescription>Bisdel matches each order by GB within a single category. Sync first, then choose the category orders fulfill from.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={handleSyncBisdelProducts} disabled={syncingBisdel} variant="outline" size="sm">
                    {syncingBisdel ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing…</> : "Sync Bisdel Products"}
                  </Button>
                  <select
                    value={bisdelCategory}
                    onChange={e => handleSelectBisdelCategory(e.target.value)}
                    disabled={savingBisdelCategory || bisdelCategories.length === 0}
                    className="px-3 py-2 text-sm rounded-md border border-border bg-background text-foreground disabled:opacity-50"
                  >
                    <option value="" disabled>{bisdelCategories.length === 0 ? "Sync products first" : "Select a category"}</option>
                    {bisdelCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {bisdelCategory && <span className="text-xs text-muted-foreground">Active: <strong>{bisdelCategory}</strong></span>}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── CodeCraft ─── */}
          <TabsContent value="codecraft" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>CodeCraft</CardTitle><CardDescription>AT/Telecel/MTN multi-network provider</CardDescription></div>
                  {mtnProvider === "codecraft" && <Badge className="bg-violet-600">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {balance?.balances.codecraft && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance</p>
                    <ProviderBal pb={balance.balances.codecraft} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="codecraft" label="CodeCraft" />
          </TabsContent>

          {/* ─── AgentPortalGH ─── */}
          <TabsContent value="agentportalgh" className="space-y-4 mt-6">
            <Card className="border-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div><CardTitle>AgentPortalGH</CardTitle><CardDescription>Webhook-first MTN provider — orders confirmed asynchronously</CardDescription></div>
                  {mtnProvider === "agentportalgh" && <Badge className="bg-primary">Active Provider</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {balance?.balances.agentportalgh && (
                  <div className="p-4 bg-muted/40 rounded-lg">
                    <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wide">Wallet Balance (from balance cron)</p>
                    <ProviderBal pb={balance.balances.agentportalgh} />
                  </div>
                )}
              </CardContent>
            </Card>
            <ActivationCard providerKey="agentportalgh" label="AgentPortalGH" />

            <Tabs value={apgSubTab} onValueChange={setApgSubTab}>
              <div className="overflow-x-auto pb-1">
                <TabsList className="inline-flex w-max h-auto p-1 gap-0.5">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="wallet">Wallet</TabsTrigger>
                  <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
                  <TabsTrigger value="whitelist">Whitelist</TabsTrigger>
                  <TabsTrigger value="orders">Orders</TabsTrigger>
                </TabsList>
              </div>

              {/* ─── APG: Overview ─── */}
              <TabsContent value="overview" className="space-y-4 mt-4">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
                  <CardContent>
                    {apgIdentity ? (
                      <div className="space-y-1 text-sm">
                        <div><span className="text-muted-foreground">Name:</span> {apgIdentity.data?.name ?? apgIdentity.name ?? "—"}</div>
                        <div><span className="text-muted-foreground">Email:</span> {apgIdentity.data?.email ?? apgIdentity.email ?? "—"}</div>
                        <div><span className="text-muted-foreground">Role:</span> <Badge variant="outline">{apgIdentity.data?.role ?? apgIdentity.role ?? "—"}</Badge></div>
                      </div>
                    ) : <p className="text-sm text-muted-foreground">Loading identity…</p>}
                    <Button size="sm" variant="outline" className="mt-3" onClick={loadApgIdentityAndServices}>Verify Connection</Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Wallet Balance (live)</span>
                      <Button size="sm" variant="ghost" onClick={loadApgBalance} disabled={apgBalanceLoading}>
                        {apgBalanceLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Refresh"}
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">{apgBalance !== null ? `GHS ${apgBalance.toFixed(2)}` : "—"}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-sm">Wallet Summary</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2 flex-wrap">
                      <Input type="date" value={apgSummaryFrom} onChange={e => setApgSummaryFrom(e.target.value)} className="h-8 text-xs" placeholder="From" />
                      <Input type="date" value={apgSummaryTo} onChange={e => setApgSummaryTo(e.target.value)} className="h-8 text-xs" placeholder="To" />
                      <Button size="sm" onClick={loadApgSummary} disabled={apgSummaryLoading}>{apgSummaryLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Fetch"}</Button>
                    </div>
                    {apgSummary && (
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div><span className="text-muted-foreground">Orders:</span> {apgSummary.orders ?? "—"}</div>
                        <div><span className="text-muted-foreground">Success:</span> {apgSummary.success_count ?? "—"}</div>
                        <div><span className="text-muted-foreground">Failed:</span> {apgSummary.failure_count ?? "—"}</div>
                        <div><span className="text-muted-foreground">Total GB:</span> {apgSummary.data_gb ?? "—"}</div>
                        <div><span className="text-muted-foreground">Charged (GHS):</span> {apgSummary.charged ?? "—"}</div>
                        <div><span className="text-muted-foreground">Pending Top-ups:</span> {apgSummary.pending_topups ?? "—"}</div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {apgServices.length > 0 && (
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Supported Services</CardTitle></CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead><tr className="border-b"><th className="text-left py-1 pr-4">Network</th><th className="text-left py-1">GB Options</th></tr></thead>
                          <tbody>
                            {apgServices.map((svc: any, i: number) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1 pr-4 font-medium">{svc.network ?? svc.name ?? JSON.stringify(svc)}</td>
                                <td className="py-1 text-muted-foreground">{svc.options?.join(", ") ?? svc.gb_options?.join(", ") ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              {/* ─── APG: Wallet ─── */}
              <TabsContent value="wallet" className="space-y-4 mt-4">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Top Up Wallet (MoMo)</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex gap-2 flex-wrap">
                      <Input placeholder="Amount (GHS)" value={apgTopupAmount} onChange={e => setApgTopupAmount(e.target.value)} className="h-8 text-xs w-32" />
                      <Input placeholder="Phone" value={apgTopupPhone} onChange={e => setApgTopupPhone(e.target.value)} className="h-8 text-xs w-36" />
                      <select value={apgTopupNetwork} onChange={e => setApgTopupNetwork(e.target.value)} className="h-8 text-xs border rounded-md px-2 bg-background">
                        <option value="MTN">MTN</option>
                        <option value="TELECEL">Telecel</option>
                        <option value="AIRTELTIGO">AirtelTigo</option>
                      </select>
                      <Button size="sm" onClick={handleApgTopup} disabled={apgTopupLoading || !apgTopupAmount || !apgTopupPhone}>
                        {apgTopupLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Top Up"}
                      </Button>
                    </div>
                    {apgTopupResult && <p className="text-xs text-muted-foreground">{apgTopupResult}</p>}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Transaction History</span>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setApgTransactionsPage(p => Math.max(1, p - 1))} disabled={apgTransactionsPage === 1}>←</Button>
                        <span className="text-xs px-1 self-center">p{apgTransactionsPage}</span>
                        <Button size="sm" variant="ghost" onClick={() => setApgTransactionsPage(p => p + 1)}>→</Button>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b"><th className="text-left py-1 pr-3">Type</th><th className="text-left py-1 pr-3">Amount</th><th className="text-left py-1 pr-3">Reason</th><th className="text-left py-1">Date</th></tr></thead>
                        <tbody>
                          {apgTransactions.map((tx: any, i: number) => (
                            <tr key={i} className="border-b border-border/50">
                              <td className="py-1 pr-3"><Badge variant="outline" className="text-[10px]">{tx.type}</Badge></td>
                              <td className="py-1 pr-3">GHS {tx.amount}</td>
                              <td className="py-1 pr-3 text-muted-foreground">{tx.reason ?? tx.description ?? "—"}</td>
                              <td className="py-1 text-muted-foreground">{tx.created_at ? new Date(tx.created_at).toLocaleDateString() : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Top-up History</span>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setApgTopupsPage(p => Math.max(1, p - 1))} disabled={apgTopupsPage === 1}>←</Button>
                        <span className="text-xs px-1 self-center">p{apgTopupsPage}</span>
                        <Button size="sm" variant="ghost" onClick={() => setApgTopupsPage(p => p + 1)}>→</Button>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b"><th className="text-left py-1 pr-3">Amount</th><th className="text-left py-1 pr-3">Phone</th><th className="text-left py-1 pr-3">Network</th><th className="text-left py-1 pr-3">Status</th><th className="text-left py-1">Date</th></tr></thead>
                        <tbody>
                          {apgTopups.map((tu: any, i: number) => (
                            <tr key={i} className="border-b border-border/50">
                              <td className="py-1 pr-3">GHS {tu.amount}</td>
                              <td className="py-1 pr-3">{tu.phone}</td>
                              <td className="py-1 pr-3">{tu.network}</td>
                              <td className="py-1 pr-3"><Badge variant="outline" className="text-[10px]">{tu.status}</Badge></td>
                              <td className="py-1 text-muted-foreground">{tu.created_at ? new Date(tu.created_at).toLocaleDateString() : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── APG: Webhooks ─── */}
              <TabsContent value="webhooks" className="space-y-4 mt-4">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Webhook Configuration</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2 flex-wrap">
                      <Input placeholder="Webhook URL" value={apgWebhookUrl} onChange={e => setApgWebhookUrl(e.target.value)} className="h-8 text-xs flex-1 min-w-48" />
                      <div className="flex items-center gap-2">
                        <Switch checked={apgWebhookEnabled} onCheckedChange={setApgWebhookEnabled} />
                        <Label className="text-xs">Enabled</Label>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => saveApgWebhookConfig(false)} disabled={apgWebhookSaving}>{apgWebhookSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}</Button>
                      <Button size="sm" variant="outline" onClick={() => saveApgWebhookConfig(true)} disabled={apgWebhookSaving}>Rotate Secret</Button>
                    </div>
                    {apgWebhookConfig?.secret && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>Secret: {apgWebhookConfig.secret.slice(0, 8)}…</span>
                        <Button size="sm" variant="ghost" className="h-5 px-1 text-[10px]" onClick={() => navigator.clipboard.writeText(apgWebhookConfig.secret)}>Copy</Button>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Webhook Deliveries</span>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => { setApgExpandedDelivery(null); setApgDeliveriesPage(p => Math.max(1, p - 1)) }} disabled={apgDeliveriesPage === 1}>←</Button>
                        <span className="text-xs px-1 self-center">p{apgDeliveriesPage}</span>
                        <Button size="sm" variant="ghost" onClick={() => { setApgExpandedDelivery(null); setApgDeliveriesPage(p => p + 1) }}>→</Button>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground mb-2">Click a row to inspect the delivered payload.</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b"><th className="text-left py-1 pr-3">Order ID</th><th className="text-left py-1 pr-3">Status</th><th className="text-left py-1 pr-3">Attempts</th><th className="text-left py-1 pr-3">Date</th><th className="text-left py-1"></th></tr></thead>
                        <tbody>
                          {apgDeliveries.map((d: any, i: number) => {
                            let decodedPayload: any = null
                            try { decodedPayload = d.payload ? JSON.parse(atob(d.payload)) : null } catch { decodedPayload = null }
                            return (
                              <>
                                <tr key={i} className="border-b border-border/50 cursor-pointer hover:bg-muted/30" onClick={() => setApgExpandedDelivery(p => (p === i ? null : i))}>
                                  <td className="py-1 pr-3 font-mono">{d.order_id}</td>
                                  <td className="py-1 pr-3">
                                    <Badge variant={d.success ? "default" : "destructive"} className="text-[10px]">
                                      {d.success ? "Delivered" : "Failed"} {d.last_status_code ? `(${d.last_status_code})` : ""}
                                    </Badge>
                                  </td>
                                  <td className="py-1 pr-3 text-muted-foreground">{d.attempts ?? "—"}</td>
                                  <td className="py-1 pr-3 text-muted-foreground">{d.created_at ? new Date(d.created_at).toLocaleDateString() : "—"}</td>
                                  <td className="py-1"><Button size="sm" variant="ghost" className="h-5 px-1 text-[10px]" onClick={e => { e.stopPropagation(); resendApgDelivery(d.id) }}>Resend</Button></td>
                                </tr>
                                {apgExpandedDelivery === i && (
                                  <tr key={`${i}-raw`} className="bg-muted/20">
                                    <td colSpan={5} className="py-2 px-3 space-y-2">
                                      {d.last_error && <p className="text-xs text-destructive">Last error: {d.last_error}</p>}
                                      {decodedPayload && (
                                        <div>
                                          <p className="text-[10px] font-medium text-muted-foreground mb-1">Decoded payload:</p>
                                          <pre className="text-[10px] whitespace-pre-wrap break-all">{JSON.stringify(decodedPayload, null, 2)}</pre>
                                        </div>
                                      )}
                                      <div>
                                        <p className="text-[10px] font-medium text-muted-foreground mb-1">Raw delivery record:</p>
                                        <pre className="text-[10px] whitespace-pre-wrap break-all">{JSON.stringify(d, null, 2)}</pre>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── APG: Whitelist ─── */}
              <TabsContent value="whitelist" className="space-y-4 mt-4">
                <Card>
                  <CardHeader><CardTitle className="text-sm">Whitelist Checker</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <textarea
                      className="w-full h-28 text-xs font-mono border rounded-md p-2 bg-background resize-none"
                      placeholder="One phone number per line (up to 1,000)"
                      value={apgWhitelistInput}
                      onChange={e => setApgWhitelistInput(e.target.value)}
                    />
                    <Button size="sm" onClick={checkApgWhitelist} disabled={apgWhitelistLoading || !apgWhitelistInput.trim()}>
                      {apgWhitelistLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Check"}
                    </Button>
                    {apgWhitelistResult.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="text-xs text-muted-foreground">
                            {apgWhitelistResult.filter(r => r.allowed).length} allowed · {apgWhitelistResult.filter(r => !r.allowed).length} blocked
                          </span>
                          <Button size="sm" variant="outline" onClick={() => downloadWhitelistExport(true)}>
                            <Download className="h-3 w-3 mr-1" />Export Allowed
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => downloadWhitelistExport(false)}>
                            <Download className="h-3 w-3 mr-1" />Export Blocked
                          </Button>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead><tr className="border-b"><th className="text-left py-1 pr-4">MSISDN</th><th className="text-left py-1">Allowed</th></tr></thead>
                            <tbody>
                              {apgWhitelistResult.map((r: any, i: number) => (
                                <tr key={i} className="border-b border-border/50">
                                  <td className="py-1 pr-4 font-mono">{r.msisdn}</td>
                                  <td className="py-1"><Badge variant={r.allowed ? "default" : "destructive"} className="text-[10px]">{r.allowed ? "Yes" : "No"}</Badge></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── APG: Orders ─── */}
              <TabsContent value="orders" className="space-y-4 mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span>Order History</span>
                      <div className="flex gap-2">
                        <Input placeholder="Search…" value={apgOrdersSearch} onChange={e => setApgOrdersSearch(e.target.value)} className="h-7 w-36 text-xs" />
                        <Button size="sm" onClick={loadApgOrders} disabled={apgOrdersLoading}>{apgOrdersLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Search"}</Button>
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="border-b"><th className="text-left py-1 pr-3">Name</th><th className="text-left py-1 pr-3">Status</th><th className="text-left py-1 pr-3">Success</th><th className="text-left py-1 pr-3">Fail</th><th className="text-left py-1">Date</th></tr></thead>
                        <tbody>
                          {apgOrders.map((ord: any, i: number) => {
                            // order_id is the reliable identifier (confirmed live
                            // 2026-07-24 against a real webhook payload) — `id` is
                            // kept only as a fallback in case a given endpoint
                            // response uses that name instead.
                            const ordId = ord.order_id ?? ord.id
                            return (
                            <>
                              <tr key={i} className="border-b border-border/50 cursor-pointer hover:bg-muted/30" onClick={() => expandApgOrder(ordId)}>
                                <td className="py-1 pr-3">{ord.group_name ?? ord.name ?? ordId}</td>
                                <td className="py-1 pr-3"><Badge variant="outline" className="text-[10px]">{ord.processing_status ?? ord.status}</Badge></td>
                                <td className="py-1 pr-3 text-emerald-500">{ord.success_count ?? "—"}</td>
                                <td className="py-1 pr-3 text-red-500">{ord.failure_count ?? "—"}</td>
                                <td className="py-1 text-muted-foreground">{ord.created_at ? new Date(ord.created_at).toLocaleDateString() : "—"}</td>
                              </tr>
                              {apgExpandedOrder === ordId && (
                                <tr key={`${i}-items`} className="bg-muted/20">
                                  <td colSpan={5} className="py-2 px-3">
                                    {apgOrderItems[ordId] ? (
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-[10px]">
                                          <thead><tr className="border-b"><th className="text-left pr-3 py-0.5">MSISDN</th><th className="text-left pr-3 py-0.5">Item ID</th><th className="text-left pr-3 py-0.5">Status</th><th className="text-left py-0.5">Reason</th></tr></thead>
                                          <tbody>
                                            {apgOrderItems[ordId].map((item: any, j: number) => (
                                              <tr key={j} className="border-b border-border/30">
                                                <td className="pr-3 py-0.5 font-mono">{item.msisdn}</td>
                                                <td className="pr-3 py-0.5 font-mono text-muted-foreground">{(item.order_item_id ?? item.reference)?.slice(0, 8) ?? "—"}…</td>
                                                <td className="pr-3 py-0.5"><Badge variant="outline" className="text-[9px]">{item.status}</Badge></td>
                                                <td className="py-0.5 text-muted-foreground">{item.failed_reason ?? "—"}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">Loading items…</p>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}
