// app/dashboard/sms/page.tsx
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { calculateSegments } from "@/lib/sms/segments"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import {
  MessageSquare, Send, Wallet, Sparkles, Clock, AlertCircle, Loader2, Plus,
  BadgeCheck, History, ShieldCheck, Ban, CreditCard, Users, Eye, EyeOff, Smartphone, X, Trash2, Copy,
} from "lucide-react"

// ─── types ────────────────────────────────────────────────────────────────
interface AccountData {
  id: string
  ownerType: string
  unitBalance: number
  pendingUnits: number
  status: string // 'inactive' | 'active' | 'suspended'
  bonusClaimed: boolean
  activatedAt: string | null
  activationFee: number
  welcomeBonusCredits: number
  pricePerCredit: number
}
interface SendLog {
  id: string; message: string; recipients_count: number; segments: number
  credits_used: number; status: string; created_at: string
}
interface SenderId {
  id: string; sender_id: string; local_status: "pending" | "active" | "rejected"
  moolre_status: string | null; last_polled_at: string | null; created_at: string
}
interface ShopTokens { shop_name: string; shop_link: string; shop_phone: string; shop_whatsapp: string }
interface ShopCustomer { phone: string; name: string | null }
interface TenantTemplate { id: string; name: string; body: string }
interface BatchMessage { id: string; phone: string; status: string; attempts: number; last_error: string | null; processed_at: string | null }
interface BatchDetail {
  log: { id: number; status: string; message: string; sender_id: string | null; recipients_count: number; segments: number; credits_reserved: number; credits_used: number; created_at: string; completed_at: string | null }
  messages: BatchMessage[]
}

// ─── constants / helpers ──────────────────────────────────────────────────
const MAX_RECIPIENTS = 50

// Quick-insert chips: {shop_*} tokens are resolved server-side (and previewed
// client-side); Promo / Order now drop in handy starter text.
const INSERT_CHIPS: { label: string; insert: string }[] = [
  { label: "Shop Name", insert: "{shop_name}" },
  { label: "Shop Link", insert: "{shop_link}" },
  { label: "Phone", insert: "{shop_phone}" },
  { label: "WhatsApp", insert: "{shop_whatsapp}" },
  { label: "Promo", insert: "Special offer: " },
  { label: "Order now", insert: "Order now: {shop_link}" },
]

/** Resolve {shop_*} tokens for the live preview. Function replacers so a token
 *  value containing a `$` pattern can't splice text into the slot. Empty values
 *  leave the literal token visible (so unconfigured fields are obvious). */
function resolveTokens(msg: string, t: ShopTokens | null): string {
  if (!t) return msg
  return msg
    .replaceAll("{shop_name}", () => t.shop_name || "{shop_name}")
    .replaceAll("{shop_link}", () => t.shop_link || "{shop_link}")
    .replaceAll("{shop_phone}", () => t.shop_phone || "{shop_phone}")
    .replaceAll("{shop_whatsapp}", () => t.shop_whatsapp || "{shop_whatsapp}")
}

/** Split a free-typed string into individual numbers (comma / space / newline). */
function splitNumbers(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}

const LOG_BADGE: Record<string, string> = {
  queued: "bg-amber-100 text-amber-800", sending: "bg-blue-100 text-blue-800",
  sent: "bg-green-100 text-green-800", partial: "bg-orange-100 text-orange-800",
  failed: "bg-red-100 text-red-800", blocked: "bg-red-200 text-red-900",
}
const SENDER_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-700", pending: "bg-amber-100 text-amber-700",
  rejected: "bg-red-100 text-red-700",
}
// Per-recipient (sms_messages) status → friendly label + colour for the detail modal.
const MSG_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "queued", cls: "bg-amber-100 text-amber-800" },
  claimed: { label: "sending", cls: "bg-blue-100 text-blue-800" },
  sent: { label: "sent", cls: "bg-green-100 text-green-800" },
  failed: { label: "failed", cls: "bg-red-100 text-red-800" },
}
/** True while a batch still has work the cron will keep processing. */
const isInFlight = (status: string) => status === "queued" || status === "sending"

// ─── component ────────────────────────────────────────────────────────────────
export default function SmsDashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null)
  const [creditQty, setCreditQty] = useState("")
  const [logs, setLogs] = useState<SendLog[]>([])
  const [senderIds, setSenderIds] = useState<SenderId[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState("overview")

  // compose
  const [message, setMessage] = useState("")
  const [recipients, setRecipients] = useState<string[]>([])
  const [addInput, setAddInput] = useState("")
  const [showPreview, setShowPreview] = useState(true)
  const [showCustomers, setShowCustomers] = useState(false)
  const [selectedSenderId, setSelectedSenderId] = useState("") // "" = account default / platform
  const [sending, setSending] = useState(false)

  // shop context (token values + customers) + tenant templates
  const [tokens, setTokens] = useState<ShopTokens | null>(null)
  const [customers, setCustomers] = useState<ShopCustomer[]>([])
  const [templates, setTemplates] = useState<TenantTemplate[]>([])
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [templateName, setTemplateName] = useState("")

  // sender-id request
  const [newSender, setNewSender] = useState("")

  // history detail modal
  const [detail, setDetail] = useState<BatchDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const load = useCallback(async () => {
    // try/catch/finally: a rejected fetch or a thrown .json() (HTML 401/500 body)
    // must still drop the loading flag, else the page hangs on the skeleton.
    try {
      const t = await token()
      const headers = { Authorization: `Bearer ${t}` }
      const accRes = await fetch("/api/sms/account", { headers }).then((r) => r.json())
      setAccount(accRes.account ?? null)
      setLoadError(!accRes.account)
    } catch {
      setLoadError(true)
      toast.error("Could not load your SMS account. Please retry.")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadLogs = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/logs", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
      setLogs(res.data?.logs ?? [])
    } catch { toast.error("Could not load send history.") }
  }, [])

  const loadSenderIds = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/sender-ids", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
      setSenderIds(res.data ?? [])
    } catch { toast.error("Could not load your sender IDs.") }
  }, [])

  const loadComposeContext = useCallback(async () => {
    try {
      const t = await token()
      const headers = { Authorization: `Bearer ${t}` }
      const [ctxRes, tplRes] = await Promise.all([
        fetch("/api/sms/context", { headers }).then((r) => r.json()),
        fetch("/api/sms/templates", { headers }).then((r) => r.json()),
      ])
      if (ctxRes.success) { setTokens(ctxRes.data.tokens); setCustomers(ctxRes.data.customers ?? []) }
      if (tplRes.success) setTemplates(tplRes.data ?? [])
    } catch { /* non-fatal — compose still works without tokens/customers */ }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const t = await token()
      const res = await fetch(`/api/sms/logs/${id}`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
      if (res.success) setDetail(res.data)
    } catch { toast.error("Could not load batch details.") }
  }, [])

  function openDetail(id: number) {
    setDetailId(id); setDetail(null); setDetailOpen(true); setDetailLoading(true)
    loadDetail(id).finally(() => setDetailLoading(false))
  }

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === "history") loadLogs() }, [tab, loadLogs])
  // Sender IDs power the management tab AND the compose "From" selector.
  useEffect(() => { if (tab === "senders" || tab === "send") loadSenderIds() }, [tab, loadSenderIds])
  useEffect(() => { if (tab === "send") loadComposeContext() }, [tab, loadComposeContext])

  // Live status: while any batch is still draining, auto-refresh the history (so a
  // send visibly moves queued → sending → sent instead of looking stuck).
  useEffect(() => {
    if (tab !== "history" || !logs.some((l) => isInFlight(l.status))) return
    const iv = setInterval(loadLogs, 7000)
    return () => clearInterval(iv)
  }, [tab, logs, loadLogs])

  // …and refresh the open detail modal while its batch is still in flight.
  useEffect(() => {
    if (!detailOpen || detailId == null || (detail && !isInFlight(detail.log.status))) return
    const iv = setInterval(() => loadDetail(detailId), 5000)
    return () => clearInterval(iv)
  }, [detailOpen, detailId, detail, loadDetail])

  // ─── actions ──────────────────────────────────────────────────────────────
  async function activate(paidFrom: "wallet" | "paystack") {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/activate", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ paidFrom }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      toast.error(res.error === "INSUFFICIENT_BALANCE"
        ? "Insufficient wallet balance. Top up your wallet or pay with Paystack." : res.error)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else { toast.success("Account activated! Welcome to SMS."); await load() }
  }

  async function claimBonus() {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/claim-bonus", {
      method: "POST", headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) toast.error(res.error === "ALREADY_CLAIMED" ? "Bonus already claimed." : res.error)
    else if (res.pending) toast.info(`${res.unitsCredited} bonus credits queued — awaiting SMS supply top-up.`)
    else { toast.success(`${res.unitsCredited} bonus SMS credits added!`); await load() }
  }

  async function buyCredits(paidFrom: "wallet" | "paystack") {
    const credits = Number(creditQty)
    if (!Number.isInteger(credits) || credits <= 0) return toast.error("Enter how many credits to buy.")
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ credits, paidFrom }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      toast.error(res.error === "NOT_ACTIVATED" ? "Activate your account first."
        : res.error === "Insufficient wallet balance" ? "Insufficient wallet balance — top up your wallet or pay with Paystack."
        : res.error)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else if (res.pending) {
      toast.info(`Payment received — ${credits} credits pending SMS supply top-up.`)
      setCreditQty(""); await load()
    } else {
      toast.success(`${res.unitsCredited} SMS credits added (GHS ${Number(res.cost).toFixed(2)}).`)
      setCreditQty(""); await load()
    }
  }

  // ── recipients ──
  function addNumbers(raw: string) {
    const incoming = splitNumbers(raw)
    if (incoming.length === 0) return
    setRecipients((cur) => {
      const seen = new Set(cur)
      const next = [...cur]
      let capped = false
      for (const n of incoming) {
        if (next.length >= MAX_RECIPIENTS) { capped = true; break }
        if (!seen.has(n)) { seen.add(n); next.push(n) }
      }
      if (capped) toast.warning(`Recipient limit is ${MAX_RECIPIENTS}.`)
      return next
    })
    setAddInput("")
  }
  function removeNumber(n: string) { setRecipients((cur) => cur.filter((x) => x !== n)) }
  function addCustomer(phone: string) { addNumbers(phone) }
  function selectAllCustomers() {
    addNumbers(customers.map((c) => c.phone).join(","))
    setShowCustomers(false)
  }

  // ── insert chips ──
  function insertChip(text: string) {
    setMessage((m) => (m.length && !/\s$/.test(m) ? m + " " : m) + text)
  }

  // ── templates ──
  async function saveTemplate() {
    const name = templateName.trim()
    if (!name) return toast.error("Give the template a name.")
    if (!message.trim()) return toast.error("Write a message first.")
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/templates", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, body: message }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.success) {
      toast.success("Template saved.")
      setSavingTemplate(false); setTemplateName("")
      await loadComposeContext()
    } else toast.error(res.error ?? "Could not save template")
  }
  async function deleteTemplate(id: string) {
    setBusy(true)
    const t = await token()
    const res = await fetch(`/api/sms/templates/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    setBusy(false)
    if (res.success) { setTemplates((cur) => cur.filter((x) => x.id !== id)) }
    else toast.error(res.error ?? "Could not delete template")
  }

  // ── send ──
  async function sendMessage() {
    if (!account || message.length < 3 || recipients.length === 0) return
    setSending(true)
    const t = await token()
    const res = await fetch("/api/shop/sms/send", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, recipients, senderId: selectedSenderId || undefined }),
    }).then((r) => r.json())
    setSending(false)
    if (res.success) {
      const { total, creditsReserved } = res.data ?? {}
      toast.success(`Queued ${total} recipient${total !== 1 ? "s" : ""} (${creditsReserved} credits)`)
      setMessage(""); setRecipients([])
      await Promise.all([load(), loadLogs()])
    } else {
      const code: string = res.error ?? "UNKNOWN_ERROR"
      const map: Record<string, string> = {
        INSUFFICIENT_CREDITS: "Not enough credits. Buy a bundle first.",
        TOO_MANY_RECIPIENTS: `Max ${MAX_RECIPIENTS} recipients per send.`,
        BLOCKED: `Sending blocked: ${res.reason ?? "content policy"}`,
        NOT_ACTIVATED: "Activate your SMS account before sending.",
        SUSPENDED: "Your SMS account is suspended.",
        NO_VALID_RECIPIENTS: "No valid phone numbers found.",
        INVALID_SENDER_ID: "Your sender ID isn’t active yet.",
      }
      toast.error(map[code] ?? res.message ?? code)
    }
  }

  async function requestSenderId() {
    const sid = newSender.trim()
    if (!sid) return
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/sender-ids", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sender_id: sid }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.success) {
      toast.success(`Requested “${sid.toUpperCase()}”. Approval is reviewed automatically — check back shortly.`)
      setNewSender(""); await loadSenderIds()
    } else toast.error(res.error ?? "Could not request sender ID")
  }

  // ─── derived ────────────────────────────────────────────────────────────────
  const resolved = useMemo(() => resolveTokens(message, tokens), [message, tokens])
  const meter = useMemo(() => calculateSegments(resolved), [resolved])
  const segPerRecipient = resolved.length === 0 ? 0 : meter.segments
  const totalCredits = segPerRecipient * recipients.length
  const balance = account?.unitBalance ?? 0
  const overBudget = recipients.length > 0 && totalCredits > balance
  const sendDisabled = sending || message.trim().length < 3 || recipients.length === 0 || overBudget
  const activeSenders = senderIds.filter((s) => s.local_status === "active")

  // ─── loading / error ────────────────────────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-4 md:p-6 space-y-4 max-w-4xl">
          <Skeleton className="h-9 w-40" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" />
        </div>
      </DashboardLayout>
    )
  }
  if (!account) {
    return (
      <DashboardLayout>
        <div className="p-4 md:p-6 max-w-md">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-destructive" /> Couldn’t load SMS</CardTitle>
              <CardDescription>
                {loadError ? "We couldn’t load your SMS account. Check your connection and try again." : "No SMS account is available for your profile."}
              </CardDescription>
            </CardHeader>
            <CardContent><Button onClick={() => { setLoading(true); load() }}><Loader2 className="h-4 w-4" /> Retry</Button></CardContent>
          </Card>
        </div>
      </DashboardLayout>
    )
  }

  const isActive = account.status === "active"
  const isSuspended = account.status === "suspended"
  const isPlatform = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive && !isSuspended
  // Welcome bonus is a tenant perk — never offered to the platform/admin account.
  const showBonus = isActive && !isPlatform && !account.bonusClaimed

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquare className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SMS</h1>
            <p className="text-sm text-muted-foreground">Send bulk SMS to your customers with your own sender ID.</p>
          </div>
        </div>

        {isSuspended && (
          <Alert variant="destructive">
            <Ban className="h-4 w-4" />
            <AlertDescription>Your SMS account is suspended. Contact support to restore sending.</AlertDescription>
          </Alert>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="send" disabled={!isActive}>Compose</TabsTrigger>
            <TabsTrigger value="senders">Sender IDs</TabsTrigger>
            <TabsTrigger value="bundles">Buy Credits</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          {/* ── OVERVIEW ── */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5"><CreditCard className="h-4 w-4" /> SMS credits</CardDescription>
                  <CardTitle className="text-3xl">{balance.toLocaleString()}</CardTitle>
                </CardHeader>
                <CardContent><Badge variant={isActive ? "default" : "secondary"}>{isPlatform ? "Platform" : account.status}</Badge></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5"><Clock className="h-4 w-4" /> Pending credits</CardDescription>
                  <CardTitle className="text-3xl">{account.pendingUnits.toLocaleString()}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    {account.pendingUnits > 0 ? "Awaiting SMS supply top-up — credited automatically." : "No pending credits."}
                  </p>
                </CardContent>
              </Card>
            </div>

            {showActivation && (
              <Card className="border-primary/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Activate SMS</CardTitle>
                  <CardDescription>A one-time activation fee of GHS {account.activationFee} unlocks sending and grants {account.welcomeBonusCredits} free welcome credits.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button onClick={() => activate("wallet")} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Pay from wallet</Button>
                  <Button variant="outline" onClick={() => activate("paystack")} disabled={busy}><CreditCard className="h-4 w-4" /> Pay with Paystack</Button>
                </CardContent>
              </Card>
            )}

            {showBonus && (
              <Card className="border-amber-300/50 bg-amber-50/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-amber-500" /> Claim welcome bonus</CardTitle>
                  <CardDescription>Grab your {account.welcomeBonusCredits} free SMS credits — one-time offer.</CardDescription>
                </CardHeader>
                <CardContent><Button onClick={claimBonus} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Claim {account.welcomeBonusCredits} credits</Button></CardContent>
              </Card>
            )}

            {isActive && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setTab("bundles")}><Plus className="h-4 w-4" /> Buy more credits</Button>
              </div>
            )}
          </TabsContent>

          {/* ── SEND (compose) ── */}
          <TabsContent value="send" className="space-y-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-primary" /> Compose Message</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* From (sender ID) */}
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground">From (sender ID)</Label>
                  <Select value={selectedSenderId || "default"} onValueChange={(v) => setSelectedSenderId(v === "default" ? "" : v)}>
                    <SelectTrigger className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default{activeSenders[0] ? ` (${activeSenders[0].sender_id})` : ""}</SelectItem>
                      {activeSenders.map((s) => (
                        <SelectItem key={s.id} value={s.sender_id}>{s.sender_id}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {activeSenders.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No approved sender IDs yet — request one in the <span className="font-medium">Sender IDs</span> tab. Messages use the platform default meanwhile.
                    </p>
                  )}
                </div>

                {/* Recipients */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-muted-foreground">Recipients ({recipients.length} / max {MAX_RECIPIENTS})</Label>
                    <div className="flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setShowCustomers((s) => !s)} disabled={customers.length === 0}>
                        <Users className="h-4 w-4" /> My Customers
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={selectAllCustomers} disabled={customers.length === 0}>
                        Select all ({customers.length})
                      </Button>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Input
                      value={addInput}
                      onChange={(e) => setAddInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNumbers(addInput) } }}
                      placeholder="Add any number, e.g. 0244123456"
                      className="font-mono"
                    />
                    <Button type="button" variant="outline" onClick={() => addNumbers(addInput)}><Plus className="h-4 w-4" /> Add</Button>
                  </div>

                  {/* Customer picker */}
                  {showCustomers && (
                    <div className="max-h-44 overflow-y-auto rounded-md border p-2 space-y-1">
                      {customers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No saved customers.</p>
                      ) : customers.map((c) => (
                        <button key={c.phone} type="button" onClick={() => addCustomer(c.phone)}
                          className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-accent disabled:opacity-50"
                          disabled={recipients.includes(c.phone)}>
                          <span>{c.name || "Customer"}</span>
                          <span className="font-mono text-muted-foreground">{c.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Recipient chips */}
                  {recipients.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {recipients.map((n) => (
                        <span key={n} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-mono">
                          {n}
                          <button type="button" onClick={() => removeNumber(n)} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Message */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="msg" className="text-muted-foreground">Message</Label>
                    <button type="button" onClick={() => setShowPreview((s) => !s)} className="flex items-center gap-1 text-sm text-primary hover:underline">
                      {showPreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {showPreview ? "Hide Preview" : "Show Preview"}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Insert:</span>
                    {INSERT_CHIPS.map((c) => (
                      <button key={c.label} type="button" onClick={() => insertChip(c.insert)}
                        className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium hover:bg-accent">
                        {c.label}
                      </button>
                    ))}
                  </div>

                  <Textarea id="msg" rows={4} value={message} onChange={(e) => setMessage(e.target.value)}
                    placeholder="Type your message…" maxLength={1000} />
                </div>

                {/* Recipient preview */}
                {showPreview && (
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Smartphone className="h-3.5 w-3.5" /> Recipient preview
                    </p>
                    <div className="rounded-md bg-background p-3">
                      {resolved.trim() ? (
                        <span className="inline-block max-w-[80%] rounded-2xl rounded-bl-sm bg-green-500 px-3 py-2 text-sm text-white whitespace-pre-wrap break-words">
                          {resolved}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Your message preview appears here…</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Meter */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{resolved.length} chars · {segPerRecipient} SMS</span>
                  <span className="font-medium text-primary">{segPerRecipient} credit{segPerRecipient === 1 ? "" : "s"} per recipient</span>
                </div>

                {overBudget && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>This send needs {totalCredits} credits but you have {balance}. Buy more credits.</AlertDescription>
                  </Alert>
                )}

                {/* Save as template */}
                {savingTemplate ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" className="w-48" />
                    <Button size="sm" onClick={saveTemplate} disabled={busy}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setSavingTemplate(false); setTemplateName("") }}>Cancel</Button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setSavingTemplate(true)} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                    <Copy className="h-4 w-4" /> Save as template
                  </button>
                )}

                <Button onClick={sendMessage} disabled={sendDisabled} className="w-full" size="lg">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sending ? "Sending…" : "Send SMS"}
                </Button>
              </CardContent>
            </Card>

            {/* Message Templates */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Message Templates</CardTitle>
                <Button size="sm" variant="outline" onClick={() => { setMessage(""); setSavingTemplate(false); toast.info("Compose a message, then “Save as template”.") }}>
                  <Plus className="h-4 w-4" /> New
                </Button>
              </CardHeader>
              <CardContent>
                {templates.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">No templates yet. Click <span className="font-medium">New</span> to create your first one.</p>
                ) : (
                  <ul className="divide-y">
                    {templates.map((tpl) => (
                      <li key={tpl.id} className="flex items-center justify-between gap-3 py-2">
                        <button type="button" onClick={() => { setMessage(tpl.body); toast.success(`Loaded “${tpl.name}”`) }} className="min-w-0 flex-1 text-left">
                          <p className="font-medium">{tpl.name}</p>
                          <p className="truncate text-sm text-muted-foreground">{tpl.body}</p>
                        </button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTemplate(tpl.id)} disabled={busy} className="text-red-600 hover:text-red-700">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── SENDER IDs ── */}
          <TabsContent value="senders" className="space-y-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Request a sender ID</CardTitle>
                <CardDescription>The name recipients see as the SMS sender (max 11 characters, letters/numbers). Requests are registered with the SMS provider and approved automatically — status updates within minutes.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sid">Sender ID</Label>
                  <Input id="sid" value={newSender} onChange={(e) => setNewSender(e.target.value)} placeholder="e.g. MYSHOP" maxLength={11} className="w-48 uppercase" />
                </div>
                <Button onClick={requestSenderId} disabled={busy || !newSender.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Request</Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Your sender IDs</CardTitle></CardHeader>
              <CardContent>
                {senderIds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sender IDs yet. Request one above.</p>
                ) : (
                  <ul className="divide-y">
                    {senderIds.map((s) => (
                      <li key={s.id} className="flex items-center justify-between py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium">{s.sender_id}</span>
                          {s.local_status === "active" && <BadgeCheck className="h-4 w-4 text-green-600" />}
                        </div>
                        <Badge className={SENDER_BADGE[s.local_status] ?? ""} variant="secondary">{s.local_status}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── BUY CREDITS (free quantity at the per-credit fee) ── */}
          <TabsContent value="bundles" className="pt-4">
            {!isActive ? (
              <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>Activate your SMS account (Overview tab) before buying credits.</AlertDescription></Alert>
            ) : (
              <Card className="max-w-md">
                <CardHeader>
                  <CardTitle>Buy SMS credits</CardTitle>
                  <CardDescription>GHS {account.pricePerCredit.toFixed(3)} per credit. Enter how many you want.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="qty">Credits</Label>
                    <Input id="qty" inputMode="numeric" value={creditQty}
                      onChange={(e) => setCreditQty(e.target.value.replace(/[^0-9]/g, ""))}
                      placeholder="e.g. 1000" />
                  </div>
                  {(() => {
                    const credits = Number(creditQty)
                    const cost = Number.isFinite(credits) ? credits * account.pricePerCredit : 0
                    return (
                      <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
                        <span className="text-muted-foreground">{credits > 0 ? `${credits.toLocaleString()} credits` : "Total"}</span>
                        <span className="text-lg font-bold">GHS {cost.toFixed(2)}</span>
                      </div>
                    )
                  })()}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => buyCredits("wallet")} disabled={busy || !Number(creditQty)}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Buy with wallet
                    </Button>
                    <Button variant="outline" onClick={() => buyCredits("paystack")} disabled={busy || !Number(creditQty)}>
                      <CreditCard className="h-4 w-4" /> Pay with Paystack
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── HISTORY ── */}
          <TabsContent value="history" className="pt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" /> Recent sends</CardTitle>
                <Button variant="outline" size="sm" onClick={loadLogs}><Loader2 className="h-4 w-4" /> Refresh</Button>
              </CardHeader>
              <CardContent>
                {logs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sends yet.</p>
                ) : (
                  <>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Tap a row to see each recipient and its status.
                      {logs.some((l) => isInFlight(l.status)) && " Live-updating while sends are in progress…"}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-muted-foreground">
                            <th className="py-2 font-medium">Message</th><th className="py-2 font-medium">To</th>
                            <th className="py-2 font-medium">Credits</th><th className="py-2 font-medium">Status</th><th className="py-2 font-medium">When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logs.map((l) => (
                            <tr key={l.id} onClick={() => openDetail(l.id as unknown as number)}
                              className="cursor-pointer border-b last:border-0 hover:bg-accent/50">
                              <td className="max-w-[16rem] truncate py-2">{l.message}</td>
                              <td className="py-2">{l.recipients_count}</td>
                              <td className="py-2">{l.credits_used}</td>
                              <td className="py-2">
                                <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${LOG_BADGE[l.status] ?? "bg-muted text-muted-foreground"}`}>
                                  {isInFlight(l.status) && <Loader2 className="h-3 w-3 animate-spin" />}{l.status}
                                </span>
                              </td>
                              <td className="py-2 text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Batch detail modal (scrollable) */}
        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                Batch #{detailId}
                {detail && (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${LOG_BADGE[detail.log.status] ?? "bg-muted"}`}>{detail.log.status}</span>
                )}
              </DialogTitle>
              <DialogDescription>
                {detail
                  ? `${detail.log.recipients_count} recipient${detail.log.recipients_count === 1 ? "" : "s"} · ${detail.log.credits_used}/${detail.log.credits_reserved} credits used · from ${detail.log.sender_id || "default"}`
                  : "Loading batch…"}
              </DialogDescription>
            </DialogHeader>

            {detailLoading && !detail ? (
              <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-full" /></div>
            ) : detail ? (
              <>
                <div className="rounded-md bg-muted/40 p-2 text-sm whitespace-pre-wrap break-words">{detail.log.message}</div>
                {(() => {
                  const c = detail.messages.reduce((a, m) => { a[m.status] = (a[m.status] || 0) + 1; return a }, {} as Record<string, number>)
                  return (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {(["sent", "failed", "claimed", "pending"] as const).filter((s) => c[s]).map((s) => (
                        <span key={s} className={`rounded px-2 py-0.5 font-medium ${MSG_STATUS[s].cls}`}>{c[s]} {MSG_STATUS[s].label}</span>
                      ))}
                    </div>
                  )
                })()}
                <div className="max-h-72 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-3 py-1.5 font-medium">Number</th>
                        <th className="px-3 py-1.5 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.messages.map((m) => {
                        const s = MSG_STATUS[m.status] ?? { label: m.status, cls: "bg-muted text-muted-foreground" }
                        return (
                          <tr key={m.id} className="border-b last:border-0">
                            <td className="px-3 py-1.5 font-mono">{m.phone}</td>
                            <td className="px-3 py-1.5">
                              <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
                              {m.status === "failed" && m.last_error && (
                                <span className="ml-2 text-xs text-muted-foreground">{m.last_error}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {detail.log.status && isInFlight(detail.log.status) && (
                  <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Still sending — this updates automatically.</p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Couldn’t load this batch.</p>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  )
}
