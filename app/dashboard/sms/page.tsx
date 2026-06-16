// app/dashboard/sms/page.tsx
"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { calculateSegments, calculateCredits } from "@/lib/sms/segments"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import {
  MessageSquare, Send, Wallet, Sparkles, Clock, AlertCircle, Loader2, Plus,
  BadgeCheck, History, ShieldCheck, Ban, CreditCard,
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
}
interface Bundle { id: string; name: string; units: number; price_ghs: number }
interface SendLog {
  id: string; message: string; recipients_count: number; segments: number
  credits_used: number; status: string; created_at: string
}
interface SenderId {
  id: string; sender_id: string; local_status: "pending" | "active" | "rejected"
  moolre_status: string | null; last_polled_at: string | null; created_at: string
}

// ─── helpers ────────────────────────────────────────────────────────────────
function parseRecipients(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of raw.split(/[\n,]+/)) {
    const t = p.trim()
    if (t && !seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
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

// ─── component ────────────────────────────────────────────────────────────────
export default function SmsDashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null)
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [logs, setLogs] = useState<SendLog[]>([])
  const [senderIds, setSenderIds] = useState<SenderId[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState("overview")

  // compose
  const [message, setMessage] = useState("")
  const [recipientsRaw, setRecipientsRaw] = useState("")
  const [sending, setSending] = useState(false)
  // sender-id request
  const [newSender, setNewSender] = useState("")

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const load = useCallback(async () => {
    // try/catch/finally: if a fetch rejects (offline/5xx) or .json() throws (the
    // server returned an HTML error page for 401/500), we must still drop the
    // loading flag — otherwise the page is stuck on the skeleton forever.
    try {
      const t = await token()
      const headers = { Authorization: `Bearer ${t}` }
      const [accRes, bunRes] = await Promise.all([
        fetch("/api/sms/account", { headers }).then((r) => r.json()),
        fetch("/api/sms/bundles", { headers }).then((r) => r.json()),
      ])
      setAccount(accRes.account ?? null)
      setBundles(bunRes.bundles ?? [])
      setLoadError(!accRes.account) // 403 / no account → show the retry card, not a spinner
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
    } catch {
      toast.error("Could not load send history.")
    }
  }, [])

  const loadSenderIds = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/sender-ids", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
      setSenderIds(res.data ?? [])
    } catch {
      toast.error("Could not load your sender IDs.")
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === "history" || tab === "send") loadLogs() }, [tab, loadLogs])
  useEffect(() => { if (tab === "senders") loadSenderIds() }, [tab, loadSenderIds])

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
        ? "Insufficient wallet balance. Top up your wallet or pay with Paystack."
        : res.error)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else {
      toast.success("Account activated! Welcome to SMS.")
      await load()
    }
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

  async function buyBundle(bundleId: string) {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) toast.error(res.error === "NOT_ACTIVATED" ? "Activate your account before buying bundles." : res.error)
    else if (res.pending) toast.info("Payment received — SMS credits are pending SMS supply top-up.")
    else { toast.success(`${res.unitsCredited} SMS credits added.`); await load() }
  }

  async function sendMessage() {
    if (!account) return
    const recipients = parseRecipients(recipientsRaw)
    if (message.length < 3 || recipients.length === 0) return
    setSending(true)
    const t = await token()
    const res = await fetch("/api/shop/sms/send", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, recipients }),
    }).then((r) => r.json())
    setSending(false)
    if (res.success) {
      const { total, creditsReserved } = res.data ?? {}
      toast.success(`Queued ${total} recipient${total !== 1 ? "s" : ""} (${creditsReserved} credits)`)
      setMessage(""); setRecipientsRaw("")
      await Promise.all([load(), loadLogs()])
    } else {
      const code: string = res.error ?? "UNKNOWN_ERROR"
      const map: Record<string, string> = {
        INSUFFICIENT_CREDITS: "Not enough credits. Buy a bundle first.",
        TOO_MANY_RECIPIENTS: "Max 500 recipients per send.",
        BLOCKED: `Sending blocked: ${res.reason ?? "content policy"}`,
        NOT_ACTIVATED: "Activate your SMS account before sending.",
        SUSPENDED: "Your SMS account is suspended.",
        NO_VALID_RECIPIENTS: "No valid phone numbers found.",
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
    } else {
      toast.error(res.error ?? "Could not request sender ID")
    }
  }

  // ─── live meter ─────────────────────────────────────────────────────────────
  const recipients = useMemo(() => parseRecipients(recipientsRaw), [recipientsRaw])
  const meter = useMemo(() => calculateSegments(message), [message])
  const cost = useMemo(() => calculateCredits(message, recipients.length), [message, recipients.length])
  const balance = account?.unitBalance ?? 0
  const overBudget = message.length >= 3 && recipients.length > 0 && cost > balance
  const sendDisabled = sending || message.length < 3 || recipients.length === 0 || overBudget

  // ─── loading / derived ────────────────────────────────────────────────────
  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-4 md:p-6 space-y-4 max-w-4xl">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
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
            <CardContent>
              <Button onClick={() => { setLoading(true); load() }}>
                <Loader2 className="h-4 w-4" /> Retry
              </Button>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    )
  }

  const isActive = account.status === "active"
  const isSuspended = account.status === "suspended"
  const isPlatform = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive && !isSuspended
  const showBonus = isActive && !account.bonusClaimed

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
            <TabsTrigger value="send" disabled={!isActive}>Send</TabsTrigger>
            <TabsTrigger value="senders">Sender IDs</TabsTrigger>
            <TabsTrigger value="bundles">Buy Credits</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          {/* ── OVERVIEW ── */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            {/* Balance cards */}
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardDescription className="flex items-center gap-1.5"><CreditCard className="h-4 w-4" /> SMS credits</CardDescription>
                  <CardTitle className="text-3xl">{balance.toLocaleString()}</CardTitle>
                </CardHeader>
                <CardContent>
                  <Badge variant={isActive ? "default" : "secondary"}>
                    {isPlatform ? "Platform" : account.status}
                  </Badge>
                </CardContent>
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

            {/* Activation */}
            {showActivation && (
              <Card className="border-primary/30">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /> Activate SMS</CardTitle>
                  <CardDescription>
                    A one-time activation fee of GHS {account.activationFee} unlocks sending and grants{" "}
                    {account.welcomeBonusCredits} free welcome credits.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button onClick={() => activate("wallet")} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Pay from wallet
                  </Button>
                  <Button variant="outline" onClick={() => activate("paystack")} disabled={busy}>
                    <CreditCard className="h-4 w-4" /> Pay with Paystack
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Welcome bonus */}
            {showBonus && (
              <Card className="border-amber-300/50 bg-amber-50/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-amber-500" /> Claim welcome bonus</CardTitle>
                  <CardDescription>Grab your {account.welcomeBonusCredits} free SMS credits — one-time offer.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button onClick={claimBonus} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Claim {account.welcomeBonusCredits} credits
                  </Button>
                </CardContent>
              </Card>
            )}

            {isActive && (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setTab("send")}><Send className="h-4 w-4" /> Compose a message</Button>
                <Button variant="outline" onClick={() => setTab("bundles")}><Plus className="h-4 w-4" /> Buy more credits</Button>
              </div>
            )}
          </TabsContent>

          {/* ── SEND ── */}
          <TabsContent value="send" className="pt-4">
            <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
              <Card>
                <CardHeader>
                  <CardTitle>Compose</CardTitle>
                  <CardDescription>Personalisation tokens aren’t applied here — paste numbers and a message.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="msg">Message</Label>
                    <Textarea id="msg" rows={5} value={message} onChange={(e) => setMessage(e.target.value)}
                      placeholder="Type your message…" maxLength={1000} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rcpts">Recipients</Label>
                    <Textarea id="rcpts" rows={4} value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)}
                      placeholder={"0241234567, 0207654321\nor one per line"} className="font-mono text-sm" />
                  </div>
                  {overBudget && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>This send needs {cost} credits but you have {balance}. Buy more credits.</AlertDescription>
                    </Alert>
                  )}
                  <Button onClick={sendMessage} disabled={sendDisabled} className="w-full sm:w-auto">
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {sending ? "Sending…" : `Send to ${recipients.length || 0} recipient${recipients.length === 1 ? "" : "s"}`}
                  </Button>
                </CardContent>
              </Card>

              {/* Live preview + estimate */}
              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Preview</CardTitle></CardHeader>
                  <CardContent>
                    <div className="rounded-2xl rounded-bl-sm bg-primary/10 p-3 text-sm whitespace-pre-wrap min-h-[4rem]">
                      {message || <span className="text-muted-foreground">Your message preview…</span>}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Estimate</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <Row label="Characters" value={String(message.length)} />
                    <Row label="Encoding" value={meter.encoding.toUpperCase()} />
                    <Row label="Segments" value={message.length === 0 ? "0" : String(meter.segments)} />
                    <Row label="Recipients" value={String(recipients.length)} />
                    <Row label="Credits needed" value={message.length === 0 ? "0" : String(cost)} />
                    <Row label="Your balance" value={String(balance)} />
                    {message.length > 0 && meter.encoding === "unicode" && (
                      <p className="pt-1 text-xs text-amber-600">Non-GSM characters switched this to Unicode (fewer chars per segment).</p>
                    )}
                    {message.length > 0 && meter.segments > 1 && (
                      <p className="text-xs text-muted-foreground">{meter.remaining} chars left before the next segment.</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* ── SENDER IDs ── */}
          <TabsContent value="senders" className="space-y-4 pt-4">
            <Card>
              <CardHeader>
                <CardTitle>Request a sender ID</CardTitle>
                <CardDescription>
                  The name recipients see as the SMS sender (max 11 characters, letters/numbers). Requests are
                  registered with the SMS provider and approved automatically — status updates within minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sid">Sender ID</Label>
                  <Input id="sid" value={newSender} onChange={(e) => setNewSender(e.target.value)}
                    placeholder="e.g. MYSHOP" maxLength={11} className="w-48 uppercase" />
                </div>
                <Button onClick={requestSenderId} disabled={busy || !newSender.trim()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Request
                </Button>
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

          {/* ── BUNDLES ── */}
          <TabsContent value="bundles" className="pt-4">
            {!isActive ? (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>Activate your SMS account (Overview tab) before buying credit bundles.</AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {bundles.map((b) => (
                  <Card key={b.id}>
                    <CardHeader>
                      <CardTitle>{b.name}</CardTitle>
                      <CardDescription>{b.units.toLocaleString()} SMS credits</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-2xl font-bold">GHS {b.price_ghs}</p>
                      <Button className="w-full" onClick={() => buyBundle(b.id)} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Buy with wallet
                      </Button>
                    </CardContent>
                  </Card>
                ))}
                {bundles.length === 0 && <p className="text-sm text-muted-foreground">No bundles available right now.</p>}
              </div>
            )}
          </TabsContent>

          {/* ── HISTORY ── */}
          <TabsContent value="history" className="pt-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" /> Recent sends</CardTitle>
              </CardHeader>
              <CardContent>
                {logs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No sends yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-2 font-medium">Message</th>
                          <th className="py-2 font-medium">To</th>
                          <th className="py-2 font-medium">Credits</th>
                          <th className="py-2 font-medium">Status</th>
                          <th className="py-2 font-medium">When</th>
                        </tr>
                      </thead>
                      <tbody>
                        {logs.map((l) => (
                          <tr key={l.id} className="border-b last:border-0">
                            <td className="max-w-[16rem] truncate py-2">{l.message}</td>
                            <td className="py-2">{l.recipients_count}</td>
                            <td className="py-2">{l.credits_used}</td>
                            <td className="py-2">
                              <span className={`rounded px-2 py-0.5 text-xs font-medium ${LOG_BADGE[l.status] ?? "bg-muted text-muted-foreground"}`}>
                                {l.status}
                              </span>
                            </td>
                            <td className="py-2 text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
