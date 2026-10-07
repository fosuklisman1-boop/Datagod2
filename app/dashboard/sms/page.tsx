// app/dashboard/sms/page.tsx
"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { supabase } from "@/lib/supabase"
import { calculateSegments } from "@/lib/sms/segments"
import { shopService, shopProfitService } from "@/lib/shop-service"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { useResendCooldown } from "@/lib/use-resend-cooldown"
import {
  MessageSquare, Send, Wallet, Sparkles, Clock, AlertCircle, CheckCircle, Loader2, Plus,
  BadgeCheck, History, ShieldCheck, Ban, CreditCard, Users, Eye, EyeOff, Smartphone, X, Trash2, Copy,
  Upload, UserPlus, ShieldQuestion, Lock, Gift, Hourglass, Info, MessagesSquare,
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
interface SmsBundle { id: string; name: string; units: number; price_ghs: number }
interface BatchDetail {
  log: { id: number; status: string; message: string; sender_id: string | null; recipients_count: number; segments: number; credits_reserved: number; credits_used: number; created_at: string; completed_at: string | null }
  messages: BatchMessage[]
}
// ── Address book (groups + contacts) ──
interface Group {
  id: string; name: string; description: string | null
  created_at: string; updated_at: string; contact_count: number
}
type VerifyStatus = "unverified" | "pending" | "verified" | "invalid"
interface Contact {
  id: string; group_id: string; first_name: string | null; last_name: string | null
  phone_number: string; opted_out: boolean; verify_status: VerifyStatus
  verified_name: string | null; verified_at: string | null; created_at: string
}
interface BulkImportResult {
  inserted: number; skipped: number; pendingVerify: number
  skippedSamples: { phone: string; reason: "invalid" | "duplicate" }[]
}
interface VerifyCounts { total: number; pending: number; verified: number; invalid: number; unverified: number; done: boolean }
interface VerifyChunk { processed: number; verified: number; invalid: number; rateLimited: number; remaining: number }
type BulkRow = { phone_number: string; first_name?: string; last_name?: string }
// Reusable on-page MoMo payment dialog (shared by Buy Credits + Activation).
interface MomoDialog {
  open: boolean
  kind: "credits" | "activation"
  phone: string
  otpSent: boolean
  otpVerified: boolean
  otpCode: string
  stage: "form" | "awaiting" | "done" | "error"
  message: string
  credits: number // for kind="credits": how many credits being bought
  cost: number    // GHS to charge
}

// ─── constants / helpers ──────────────────────────────────────────────────
const MAX_RECIPIENTS = 5000

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

/** Parse CSV/paste text into contact rows. Each line: phone[,firstName[,lastName]]
 *  — PHONE FIRST. A header row on line 0 is tolerated (skipped only if its first
 *  cell has no digit). Empty name cells become undefined. */
function parseRows(text: string): BulkRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows: BulkRow[] = []
  lines.forEach((line, i) => {
    const [phone_number, first_name, last_name] = line.split(",").map((p) => p.trim())
    if (!phone_number) return
    if (i === 0 && !/\d/.test(phone_number)) return // tolerate a header row
    rows.push({ phone_number, first_name: first_name || undefined, last_name: last_name || undefined })
  })
  return rows
}

const LOG_BADGE: Record<string, string> = {
  queued: "bg-warning/10 text-warning", sending: "bg-blue-100 text-blue-800",
  sent: "bg-success/15 text-success", partial: "bg-warning/10 text-warning",
  failed: "bg-destructive/15 text-destructive", blocked: "bg-destructive/15 text-destructive",
}
const SENDER_BADGE: Record<string, string> = {
  active: "bg-success/15 text-success", pending: "bg-warning/10 text-warning",
  rejected: "bg-destructive/15 text-destructive",
}
// Per-recipient (sms_messages) status → friendly label + colour for the detail modal.
const MSG_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "queued", cls: "bg-warning/10 text-warning" },
  claimed: { label: "sending", cls: "bg-blue-100 text-blue-800" },
  sent: { label: "sent", cls: "bg-success/15 text-success" },
  failed: { label: "failed", cls: "bg-destructive/15 text-destructive" },
}
/** True while a batch still has work the cron will keep processing. */
const isInFlight = (status: string) => status === "queued" || status === "sending"

/** Display name for a contact: typed name → verified MoMo name → em-dash. */
function contactName(c: Contact): string {
  const typed = [c.first_name, c.last_name].filter(Boolean).join(" ")
  return typed || c.verified_name || "—"
}

/** Generate a few plausible sender-ID suggestions from the shop's own name
 *  (letters/numbers only, 11-char max — same constraint the input enforces). */
function senderSuggestions(shopName: string): string[] {
  const clean = shopName.replace(/[^a-zA-Z0-9 ]/g, "").trim()
  if (!clean) return []
  const compact = clean.replace(/\s+/g, "").toUpperCase().slice(0, 11)
  const words = clean.split(/\s+/).filter(Boolean)
  const initials = words.map((w) => w[0]).join("").toUpperCase()
  const out = [
    compact,
    initials.length >= 2 ? initials.slice(0, 11) : compact.slice(0, 4),
    (compact.slice(0, 9) + "GH").slice(0, 11),
    (compact.slice(0, 8) + "HUB").slice(0, 11),
  ]
  return Array.from(new Set(out.filter((s) => s.length >= 2)))
}

// ─── component ────────────────────────────────────────────────────────────────
export default function SmsDashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null)
  const [creditQty, setCreditQty] = useState("")
  const [logs, setLogs] = useState<SendLog[]>([])
  const [senderIds, setSenderIds] = useState<SenderId[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState("send")

  // shop wallet context (informational cards + real payment source for bundles)
  const [shop, setShop] = useState<any>(null)
  const [profitBalance, setProfitBalance] = useState(0)
  const [walletBalance, setWalletBalance] = useState(0)

  // bundle purchases (Buy tab)
  const [bundles, setBundles] = useState<SmsBundle[]>([])
  const [bundlesLoaded, setBundlesLoaded] = useState(false)
  const [buyingBundleId, setBuyingBundleId] = useState<string | null>(null)

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

  // ── address book (groups + contacts) ──
  const [groups, setGroups] = useState<Group[]>([])
  const [groupsLoaded, setGroupsLoaded] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [contactsBusy, setContactsBusy] = useState(false)
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<Group | null>(null)
  const [pendingDeleteContact, setPendingDeleteContact] = useState<Contact | null>(null)
  // create-group form
  const [gName, setGName] = useState("")
  const [gDesc, setGDesc] = useState("")
  // add-contact (single) form
  const [cFirst, setCFirst] = useState("")
  const [cLast, setCLast] = useState("")
  const [cPhone, setCPhone] = useState("")
  // bulk import (paste + file) + verify opt-in
  const [bulk, setBulk] = useState("")
  const [verifyOnImport, setVerifyOnImport] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // verify poll loop
  const [verifying, setVerifying] = useState(false)
  const [verifyCounts, setVerifyCounts] = useState<VerifyCounts | null>(null)
  // Tracks the group the verify loop is bound to; if the selection changes (or
  // clears) the loop sees the mismatch and stops cleanly.
  const verifyGroupRef = useRef<string | null>(null)

  // compose: send to a saved group
  const [selectedGroupId, setSelectedGroupId] = useState("")
  // pre-send confirmation for group sends (real opt-out-filtered count + cost)
  const [sendConfirm, setSendConfirm] = useState({ open: false, loading: false, sentCount: 0, activeCount: 0 })

  // ── direct-charge (on-page MoMo) gates + dialog ───────────────────────────
  //   walletDirect → pay via the on-page direct MoMo charge (vs hosted redirect).
  //   walletOtp    → the MoMo number must be SMS-OTP verified before charging.
  const [walletDirect, setWalletDirect] = useState(false)
  const [walletOtp, setWalletOtp] = useState(false)
  // One reusable MoMo dialog drives BOTH Buy Credits and Activation.
  const [momo, setMomo] = useState<MomoDialog>({
    open: false, kind: "credits", phone: "", otpSent: false, otpVerified: false,
    otpCode: "", stage: "form", message: "", credits: 0, cost: 0,
  })
  const [momoBusy, setMomoBusy] = useState(false)
  const [sendingOtp, setSendingOtp] = useState(false)
  const [verifyingOtp, setVerifyingOtp] = useState(false)
  const otpCooldown = useResendCooldown(momo.phone.replace(/\D/g, ""))

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
      const res = await fetch("/api/sms/account", { headers })
      const accRes = await res.json().catch(() => ({}))
      setAccount(accRes.account ?? null)
      // A clean 403 means this profile genuinely isn't entitled to an SMS
      // account (no shop, not a sub-agent, not admin — see
      // lib/sms/account-service.ts's resolveOwnerContext) — a real, by-design
      // answer, not a connectivity failure. Only treat this as "couldn't
      // load" (and blame the connection) for an actual network-level
      // rejection, caught below, or a response we can't even parse as JSON.
      setLoadError(!accRes.account && res.status !== 403)
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
      const res = await fetch("/api/sms/logs", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch(() => ({}))
      setLogs(res.data?.logs ?? [])
    } catch { toast.error("Could not load send history.") }
  }, [])

  const loadSenderIds = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/sender-ids", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch(() => ({}))
      setSenderIds(res.data ?? [])
    } catch { toast.error("Could not load your sender IDs.") }
  }, [])

  // Informational wallet cards. Shop is optional (a plain user with no shop still
  // has an SMS account e.g. via sub-agent), so both fetches are best-effort.
  const loadWallets = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const [userShop, walletRes] = await Promise.all([
        shopService.getShop(uid).catch(() => null),
        session?.access_token
          ? fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${session.access_token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
          : null,
      ])
      setShop(userShop)
      if (walletRes) setWalletBalance(walletRes.balance || 0)
      if (userShop?.id) {
        const bal = await shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null)
        setProfitBalance(bal?.available_balance || 0)
      }
    } catch { /* non-fatal — cards just show 0 */ }
  }, [])

  const loadBundles = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch(() => ({}))
      setBundles(res.bundles ?? [])
    } catch { toast.error("Could not load SMS bundles.") }
    finally { setBundlesLoaded(true) }
  }, [])

  const loadComposeContext = useCallback(async () => {
    try {
      const t = await token()
      const headers = { Authorization: `Bearer ${t}` }
      const [ctxRes, tplRes] = await Promise.all([
        fetch("/api/sms/context", { headers }).then((r) => r.json()).catch(() => ({})),
        fetch("/api/sms/templates", { headers }).then((r) => r.json()).catch(() => ({})),
      ])
      if (ctxRes.success) { setTokens(ctxRes.data.tokens); setCustomers(ctxRes.data.customers ?? []) }
      if (tplRes.success) setTemplates(tplRes.data ?? [])
    } catch { /* non-fatal — compose still works without tokens/customers */ }
  }, [])

  const loadDetail = useCallback(async (id: number) => {
    try {
      const t = await token()
      const res = await fetch(`/api/sms/logs/${id}`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch(() => ({}))
      if (res.success) setDetail(res.data)
    } catch { toast.error("Could not load batch details.") }
  }, [])

  function openDetail(id: number) {
    setDetailId(id); setDetail(null); setDetailOpen(true); setDetailLoading(true)
    loadDetail(id).finally(() => setDetailLoading(false))
  }

  // ── address book loaders ──
  const loadGroups = useCallback(async () => {
    try {
      const t = await token()
      const res = await fetch("/api/sms/groups", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json()).catch(() => ({}))
      if (res.success) setGroups(res.data ?? [])
    } catch { toast.error("Could not load your contact groups.") }
    finally { setGroupsLoaded(true) }
  }, [])

  // Load a group's contacts + refresh its verify counts. Returns the contacts so
  // the verify poll loop can react to whether anything is still 'pending'.
  const loadGroup = useCallback(async (id: string): Promise<Contact[]> => {
    try {
      const t = await token()
      const headers = { Authorization: `Bearer ${t}` }
      const [grpRes, vRes] = await Promise.all([
        fetch(`/api/sms/groups/${id}`, { headers }).then((r) => r.json()).catch(() => ({})),
        fetch(`/api/sms/contacts/verify?groupId=${id}`, { headers }).then((r) => r.json()).catch(() => ({})),
      ])
      if (grpRes.success) {
        setSelectedGroup(grpRes.data.group)
        setContacts(grpRes.data.contacts ?? [])
      }
      if (vRes.success) setVerifyCounts(vRes.data)
      return grpRes.success ? (grpRes.data.contacts ?? []) : []
    } catch { toast.error("Could not load group contacts."); return [] }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadWallets() }, [loadWallets])
  // Direct-charge + OTP gates (independent toggles), same source as wallet top-up.
  useEffect(() => {
    fetch("/api/public/turnstile-status")
      .then((r) => (r.ok ? r.json() : { wallet_lock: false, wallet_direct_charge: false }))
      .then((d) => { setWalletDirect(d.wallet_direct_charge === true); setWalletOtp(d.wallet_lock === true) })
      .catch(() => { setWalletDirect(false); setWalletOtp(false) })
  }, [])
  useEffect(() => { if (tab === "history") loadLogs() }, [tab, loadLogs])
  // Sender ID is now an always-visible top card (not a tab), so it loads on
  // mount rather than being gated to a "senders" tab; still reloaded when the
  // Send tab opens since it also powers the compose "From" selector.
  useEffect(() => { loadSenderIds() }, [loadSenderIds])
  useEffect(() => { if (tab === "send") loadSenderIds() }, [tab, loadSenderIds])
  useEffect(() => { if (tab === "send" || tab === "templates") loadComposeContext() }, [tab, loadComposeContext])
  useEffect(() => { if (tab === "bundles" && !bundlesLoaded) loadBundles() }, [tab, bundlesLoaded, loadBundles])
  // Groups power BOTH the Contacts tab and the compose "Send to a group" select.
  useEffect(() => { if (tab === "contacts" || tab === "send") loadGroups() }, [tab, loadGroups])
  // If the user deselects/changes the group (or leaves the tab), point the verify
  // loop's binding away from any old group so an in-flight poll stops cleanly.
  useEffect(() => {
    if (selectedGroup === null || (verifyGroupRef.current && verifyGroupRef.current !== selectedGroup.id)) {
      verifyGroupRef.current = selectedGroup?.id ?? null
    }
  }, [selectedGroup])

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
    }).then((r) => r.json()).catch(() => ({}))
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
    }).then((r) => r.json()).catch(() => ({}))
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
    }).then((r) => r.json()).catch(() => ({}))
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

  async function buyBundle(bundleId: string, paidFrom: "wallet" | "paystack") {
    setBuyingBundleId(bundleId)
    const t = await token()
    const endpoint = paidFrom === "wallet" ? "/api/sms/units/purchase-wallet" : "/api/sms/units/purchase-paystack"
    const res = await fetch(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json()).catch(() => ({}))
    setBuyingBundleId(null)
    if (res.error) {
      toast.error(res.error === "Insufficient wallet balance"
        ? "Insufficient wallet balance. Top up your wallet or pay with Paystack."
        : res.error === "NOT_ACTIVATED" ? "Activate your SMS account first." : res.error)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else if (res.pending) {
      toast.info("Payment received — credits pending SMS supply top-up.")
      await load()
    } else {
      toast.success("SMS credits added!")
      await load()
    }
  }

  // ── on-page MoMo direct charge (shared dialog for credits + activation) ────
  function openMomo(kind: "credits" | "activation", credits = 0, cost = 0) {
    setMomo({
      open: true, kind, phone: "", otpSent: false, otpVerified: false,
      otpCode: "", stage: "form", message: "", credits, cost,
    })
  }
  function closeMomo() {
    otpCooldown.reset()
    setMomo((m) => ({ ...m, open: false, stage: "form", otpSent: false, otpVerified: false, otpCode: "", message: "" }))
  }

  async function sendOtp() {
    const digits = momo.phone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) { toast.error("Enter a valid Mobile Money number first"); return }
    setSendingOtp(true)
    try {
      const res = await fetch("/api/auth/send-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: momo.phone }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d?.error || "Failed to send code"); return }
      toast.success("Verification code sent")
      setMomo((m) => ({ ...m, otpSent: true })); otpCooldown.start()
    } catch { toast.error("Network error") } finally { setSendingOtp(false) }
  }

  async function verifyOtp() {
    if (!momo.otpCode || momo.otpCode.length < 4) { toast.error("Enter the code from your SMS"); return }
    setVerifyingOtp(true)
    try {
      const res = await fetch("/api/auth/verify-phone-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: momo.phone, code: momo.otpCode.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d.verified) { toast.error(d?.error || "Incorrect code"); return }
      toast.success("Payment number verified ✓")
      setMomo((m) => ({ ...m, otpVerified: true }))
    } catch { toast.error("Network error") } finally { setVerifyingOtp(false) }
  }

  // Poll the SMS account (NOT /api/payments/momo-status — direct SMS charges create
  // no wallet_payments row) to confirm the charge landed. Baseline is captured
  // before the charge so we detect the delta credited by the webhook.
  function pollSmsConfirm(kind: "credits" | "activation", baselineBalance: number, baselinePending: number) {
    const started = Date.now()
    const TIMEOUT_MS = 2.5 * 60 * 1000
    const tick = async () => {
      if (Date.now() - started > TIMEOUT_MS) {
        setMomo((m) => ({
          ...m, stage: "error",
          message: kind === "credits"
            ? "If you approved the prompt, your credits will appear shortly — refresh in a moment."
            : "If you approved the prompt, your activation will appear shortly — refresh in a moment.",
        }))
        return
      }
      try {
        const t = await token()
        const res = await fetch("/api/sms/account", { headers: { Authorization: `Bearer ${t}` } })
        const d = await res.json().catch(() => ({}))
        const acc = d?.account
        if (acc) {
          const success = kind === "credits"
            ? (Number(acc.unitBalance) > baselineBalance || Number(acc.pendingUnits) > baselinePending)
            : acc.status === "active"
          if (success) {
            setMomo((m) => ({ ...m, stage: "done" }))
            toast.success(kind === "credits" ? "Credits added 🎉" : "Account activated 🎉")
            setMomo((m) => ({ ...m, open: false }))
            await load()
            return
          }
        }
      } catch { /* keep polling */ }
      setTimeout(tick, 4000)
    }
    setTimeout(tick, 4000)
  }

  async function payWithMomo() {
    const digits = momo.phone.replace(/\D/g, "")
    if (!/^0?\d{9}$/.test(digits)) { toast.error("Enter a valid Mobile Money number"); return }
    if (walletOtp && !momo.otpVerified) { toast.error("Verify your Mobile Money number first"); return }
    setMomoBusy(true)
    try {
      const t = await token()
      const baselineBalance = account?.unitBalance ?? 0
      const baselinePending = account?.pendingUnits ?? 0
      const endpoint = momo.kind === "credits" ? "/api/sms/units/purchase" : "/api/sms/activate"
      const payload: Record<string, unknown> =
        momo.kind === "credits"
          ? { credits: momo.credits, paidFrom: "paystack", momoDirect: true, paymentPhone: momo.phone }
          : { paidFrom: "paystack", momoDirect: true, paymentPhone: momo.phone }
      const res = await fetch(endpoint, {
        method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 403 && d?.code === "OTP_REQUIRED") {
        toast.error("Verify your payment number to continue.")
        setMomo((m) => ({ ...m, stage: "form", otpVerified: false, otpSent: false, otpCode: "" }))
        return
      }
      if (d?.momoDirect === true) {
        setMomo((m) => ({ ...m, stage: "awaiting", message: "" }))
        pollSmsConfirm(momo.kind, baselineBalance, baselinePending)
        return
      }
      setMomo((m) => ({ ...m, stage: "error", message: d?.error || "Could not start the Mobile Money charge. Please try again." }))
    } catch {
      setMomo((m) => ({ ...m, stage: "error", message: "Network error. Please try again." }))
    } finally {
      setMomoBusy(false)
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
    }).then((r) => r.json()).catch(() => ({}))
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
    }).then((r) => r.json()).catch(() => ({}))
    setBusy(false)
    if (res.success) { setTemplates((cur) => cur.filter((x) => x.id !== id)) }
    else toast.error(res.error ?? "Could not delete template")
  }

  // ── send ──
  // Group sends aren't visible as chips and can be large, so confirm the REAL
  // (opt-out-filtered, server-counted) recipient count + credit cost before
  // spending. Manual chips are visible, so they send straight through.
  async function sendMessage() {
    if (!account || message.length < 3 || (recipients.length === 0 && !selectedGroupId)) return
    if (selectedGroupId) {
      setSendConfirm({ open: true, loading: true, sentCount: 0, activeCount: 0 })
      const t = await token()
      const res = await fetch(`/api/sms/groups/${selectedGroupId}/preview`, {
        headers: { Authorization: `Bearer ${t}` },
      }).then((r) => r.json()).catch(() => ({}))
      if (res.success) {
        setSendConfirm({ open: true, loading: false, sentCount: res.data.sentCount, activeCount: res.data.activeCount })
      } else {
        setSendConfirm({ open: false, loading: false, sentCount: 0, activeCount: 0 })
        toast.error(res.error ?? "Could not check the group size.")
      }
      return
    }
    await doSend()
  }

  async function doSend() {
    if (!account) return
    setSendConfirm((c) => ({ ...c, open: false }))
    setSending(true)
    const t = await token()
    const res = await fetch("/api/shop/sms/send", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, recipients, groupId: selectedGroupId || undefined, senderId: selectedSenderId || undefined }),
    }).then((r) => r.json()).catch(() => ({}))
    setSending(false)
    if (res.success) {
      const { total, creditsReserved, batches, partial, stoppedReason } = res.data ?? {}
      const batchTxt = batches > 1 ? ` in ${batches} batches` : ""
      if (partial) {
        const why = stoppedReason === "INSUFFICIENT_CREDITS" ? "ran out of credits — top up and resend the rest"
          : stoppedReason === "SUSPENDED" ? "the account was suspended mid-send"
          : stoppedReason === "NOT_ACTIVATED" ? "the account is no longer active"
          : "the rest could not be sent"
        toast.warning(`Sent ${total} recipient${total !== 1 ? "s" : ""}${batchTxt}, then ${why}.`)
      } else {
        toast.success(`Queued ${total} recipient${total !== 1 ? "s" : ""}${batchTxt} (${creditsReserved} credits)`)
      }
      setMessage(""); setRecipients([]); setSelectedGroupId("")
      await Promise.all([load(), loadLogs()])
    } else {
      const code: string = res.error ?? "UNKNOWN_ERROR"
      const map: Record<string, string> = {
        INSUFFICIENT_CREDITS: "Not enough credits. Buy a bundle first.",
        SEND_ERROR: "Something went wrong sending. Please try again.",
        TOO_MANY_RECIPIENTS: `A send can reach at most 5000 recipients. Split into smaller groups.`,
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
    }).then((r) => r.json()).catch(() => ({}))
    setBusy(false)
    if (res.success) {
      toast.success(`Requested “${sid.toUpperCase()}”. Approval is reviewed automatically — check back shortly.`)
      setNewSender(""); await loadSenderIds()
    } else toast.error(res.error ?? "Could not request sender ID")
  }

  // ── address book: groups ──
  function selectGroup(g: Group) {
    if (selectedGroup?.id === g.id) return
    setSelectedGroup(g); setContacts([]); setVerifyCounts(null)
    loadGroup(g.id)
  }
  async function createGroup() {
    const name = gName.trim()
    if (!name) return
    setContactsBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/groups", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: gDesc.trim() || undefined }),
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) { setGName(""); setGDesc(""); toast.success("Group created."); await loadGroups() }
    else toast.error(res.error ?? "Could not create group")
  }
  async function deleteGroup(g: Group) {
    setContactsBusy(true)
    const t = await token()
    const res = await fetch(`/api/sms/groups/${g.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) {
      if (selectedGroup?.id === g.id) { setSelectedGroup(null); setContacts([]); setVerifyCounts(null) }
      toast.success("Group deleted."); await loadGroups()
    } else toast.error(res.error ?? "Could not delete group")
  }

  // ── address book: contacts ──
  async function addContactSingle() {
    if (!selectedGroup || !cPhone.trim()) return
    setContactsBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/contacts", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: selectedGroup.id, phone_number: cPhone.trim(), first_name: cFirst.trim() || undefined, last_name: cLast.trim() || undefined }),
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) {
      setCFirst(""); setCLast(""); setCPhone(""); toast.success("Contact added.")
      await Promise.all([loadGroup(selectedGroup.id), loadGroups()])
    } else toast.error(res.error ?? "Could not add contact")
  }
  // Shared by CSV-file + paste import. Sends the bulk payload (with verify opt-in),
  // refreshes the group, and kicks off the verify poll if rows queued for checking.
  async function postRows(rows: BulkRow[]) {
    if (!selectedGroup) return
    if (rows.length === 0) { toast.error("No valid rows found (expected: phone,firstName,lastName)."); return }
    const gid = selectedGroup.id
    setContactsBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/contacts", {
      method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: gid, rows, verify: verifyOnImport || undefined }),
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) {
      const d = res.data as BulkImportResult
      toast.success(`Imported ${d.inserted}; skipped ${d.skipped} (invalid/duplicate).`)
      await Promise.all([loadGroup(gid), loadGroups()])
      if (verifyOnImport && d.pendingVerify > 0) startVerifyPoll(gid)
    } else toast.error(res.error ?? "Import failed")
  }
  async function importBulk() {
    const rows = parseRows(bulk)
    if (rows.length === 0) return toast.error("No valid rows to import.")
    await postRows(rows)
    setBulk("")
  }
  async function importCsvFile(file: File) {
    if (!selectedGroup) return
    try {
      const text = await file.text()
      const rows = parseRows(text)
      if (rows.length === 0) { toast.error("CSV had no valid rows."); return }
      await postRows(rows)
    } catch {
      toast.error("Could not read that file.")
    } finally {
      if (fileRef.current) fileRef.current.value = ""
    }
  }
  async function toggleOptOut(c: Contact) {
    if (!selectedGroup) return
    setContactsBusy(true)
    const t = await token()
    const res = await fetch(`/api/sms/contacts/${c.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ opted_out: !c.opted_out }),
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) await loadGroup(selectedGroup.id)
    else toast.error(res.error ?? "Could not update contact")
  }
  async function deleteContact(c: Contact) {
    if (!selectedGroup) return
    setContactsBusy(true)
    const t = await token()
    const res = await fetch(`/api/sms/contacts/${c.id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json()).catch(() => ({}))
    setContactsBusy(false)
    if (res.success) await Promise.all([loadGroup(selectedGroup.id), loadGroups()])
    else toast.error(res.error ?? "Could not delete contact")
  }

  // ── verify poll loop ──
  // Repeatedly POSTs one verify chunk (no reverify) until remaining=0, a safety
  // cap, or the user leaves the group. Backs off ~8s on a no-progress rate-limit
  // tick, else ~1.5s. Refreshes contacts after each chunk so badges update live.
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  async function startVerifyPoll(groupId: string) {
    if (verifying) return // guard double-start
    setVerifying(true)
    verifyGroupRef.current = groupId
    toast.info("Verifying numbers…")
    let totalVerified = 0
    let totalInvalid = 0
    let completed = false
    try {
      for (let i = 0; i < 30; i++) {
        if (verifyGroupRef.current !== groupId) return // user navigated away
        const t = await token()
        let chunk: VerifyChunk | null = null
        try {
          const res = await fetch("/api/sms/contacts/verify", {
            method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
            body: JSON.stringify({ groupId }),
          }).then((r) => r.json()).catch(() => ({}))
          if (res.success) chunk = res.data as VerifyChunk
        } catch { /* transient — treat as a no-progress tick and back off */ }
        if (verifyGroupRef.current !== groupId) return
        if (chunk) {
          totalVerified += chunk.verified
          totalInvalid += chunk.invalid
          // The ref guard above proves we're still on this group — refresh badges live.
          await loadGroup(groupId)
          if (chunk.remaining === 0) { completed = true; break }
          // Back off when nothing moved this tick: a throttled provider, or all
          // remaining rows are currently leased by the cron drainer.
          const noProgress = chunk.processed === 0 || (chunk.rateLimited > 0 && chunk.verified + chunk.invalid === 0)
          await sleep(noProgress ? 8000 : 1500)
        } else {
          await sleep(8000) // network blip — back off
        }
      }
      // Only claim "done" if we actually drained to 0; otherwise the cap was hit
      // with rows still pending (the cron backstop finishes them) — don't lie.
      if (completed) {
        toast.success(`Verification done: ${totalVerified} verified, ${totalInvalid} not found.`)
      } else {
        toast.info(`Verified ${totalVerified} so far; the rest will finish in the background.`)
      }
    } finally {
      setVerifying(false)
      if (verifyGroupRef.current === groupId) verifyGroupRef.current = null
    }
  }
  // "Verify numbers" button: re-queue everything in the group, then poll.
  async function reverifyGroup() {
    if (!selectedGroup || verifying) return
    const gid = selectedGroup.id
    const t = await token()
    try {
      const res = await fetch("/api/sms/contacts/verify", {
        method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: gid, reverify: true }),
      }).then((r) => r.json()).catch(() => ({}))
      if (!res.success) { toast.error(res.error ?? "Could not start verification."); return }
    } catch { toast.error("Could not start verification."); return }
    if (selectedGroup?.id === gid) await loadGroup(gid)
    startVerifyPoll(gid)
  }

  // ─── derived ────────────────────────────────────────────────────────────────
  const resolved = useMemo(() => resolveTokens(message, tokens), [message, tokens])
  const meter = useMemo(() => calculateSegments(resolved), [resolved])
  const segPerRecipient = resolved.length === 0 ? 0 : meter.segments
  const composeGroup = groups.find((g) => g.id === selectedGroupId) ?? null
  // Estimate only — the server resolves the group's active contacts authoritatively.
  const estRecipients = recipients.length + (composeGroup?.contact_count ?? 0)
  const totalCredits = segPerRecipient * estRecipients
  const balance = account?.unitBalance ?? 0
  const overBudget = estRecipients > 0 && totalCredits > balance
  // For group sends the estimate counts opted-out contacts too, so it's an UPPER
  // bound — treat over-budget as advisory (warn, don't block) and let the server's
  // authoritative INSUFFICIENT_CREDITS (402) be the real guard. For manual-only
  // sends the count is exact, so keep the hard block.
  const overBudgetBlocks = overBudget && !selectedGroupId
  const sendDisabled =
    sending || message.trim().length < 3 || (recipients.length === 0 && !selectedGroupId) || overBudgetBlocks
  const activeSenders = senderIds.filter((s) => s.local_status === "active")
  // Confirm dialog totals: the group's resolved (opt-out-filtered) count PLUS any
  // typed chips — both get merged + deduped server-side, so this is an upper bound.
  const confirmTotal = sendConfirm.sentCount + recipients.length
  const confirmBatches = Math.ceil(confirmTotal / 500)
  const confirmCost = confirmTotal * segPerRecipient

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
              <CardTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-destructive" /> {loadError ? "Couldn’t load SMS" : "Bulk SMS not available yet"}</CardTitle>
              <CardDescription>
                {loadError
                  ? "We couldn’t load your SMS account. Check your connection and try again."
                  : "Bulk SMS is available to shop owners, sub-agents, and admins. Create a shop to unlock it."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadError ? (
                <Button onClick={() => { setLoading(true); load() }} className="bg-[#1b388b] text-white hover:bg-[#1b388b]/90"><Loader2 className="h-4 w-4" /> Retry</Button>
              ) : (
                <Button asChild className="bg-[#1b388b] text-white hover:bg-[#1b388b]/90"><Link href="/dashboard/my-shop">Create a Shop</Link></Button>
              )}
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
  // Welcome bonus is a tenant perk — never offered to the platform/admin account.
  const showBonus = isActive && !isPlatform && !account.bonusClaimed

  return (
    <DashboardLayout>
      <div className="p-4 md:p-6 space-y-6 max-w-4xl lg:max-w-5xl">
        <DashboardHeroBanner title="SMS" subtitle="Send bulk SMS to your customers with your own sender ID." icon={MessageSquare} />

        {isSuspended && (
          <Alert variant="destructive">
            <Ban className="h-4 w-4" />
            <AlertDescription>Your SMS account is suspended. Contact support to restore sending.</AlertDescription>
          </Alert>
        )}

        {/* Wallet cards — informational. Bundle/activation payment only ever
            debits the Main Wallet (or Paystack) for real; there is no code
            path anywhere that pays from a shop's Profit balance, so it's
            shown here for visibility but never offered as a payment button. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5"><CreditCard className="h-4 w-4" /> SMS Credits</CardDescription>
              <CardTitle className="text-2xl">{balance.toLocaleString()}</CardTitle>
            </CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">credits</p></CardContent>
          </Card>
          <Card className="border-success/30 bg-success/5">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5"><Wallet className="h-4 w-4" /> Profit Wallet</CardDescription>
              <CardTitle className="text-2xl">GH₵{profitBalance.toFixed(2)}</CardTitle>
            </CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">available</p></CardContent>
          </Card>
          <Card className="border-[#1b388b]/30 bg-[#1b388b]/5">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1.5"><Wallet className="h-4 w-4" /> Main Wallet</CardDescription>
              <CardTitle className="text-2xl">GH₵{walletBalance.toFixed(2)}</CardTitle>
            </CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">available</p></CardContent>
          </Card>
        </div>

        {/* Your Sender ID — promoted out of a tab since it gates the whole
            feature; the phone-preview + suggestions are new, the underlying
            senderIds/newSender/requestSenderId are the existing real ones. */}
        {(() => {
          const activeSender = senderIds.find((s) => s.local_status === "active")
          const pendingSender = senderIds.find((s) => s.local_status === "pending")
          return (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2 text-base"><BadgeCheck className="h-4 w-4 text-[#1b388b]" /> Your Sender ID</CardTitle>
                <Badge className={activeSender ? "bg-success text-white hover:bg-success" : pendingSender ? "bg-amber-500 text-white hover:bg-amber-500" : ""} variant={activeSender || pendingSender ? "default" : "secondary"}>
                  {activeSender ? "ACTIVE" : pendingSender ? "UNDER REVIEW" : "NOT SET"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeSender ? (
                  <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3">
                    <BadgeCheck className="h-4 w-4 shrink-0 text-success" />
                    <div>
                      <p className="font-mono font-semibold">{activeSender.sender_id}</p>
                      <p className="text-xs text-muted-foreground">Live — this is what your customers see.</p>
                    </div>
                  </div>
                ) : pendingSender ? (
                  <>
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                      <Hourglass className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                      <div>
                        <p className="font-mono font-semibold">{pendingSender.sender_id}</p>
                        <p className="text-xs text-muted-foreground">Pending review by admin.</p>
                      </div>
                    </div>
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Info className="h-3 w-3 shrink-0" /> <span className="font-medium text-foreground">{pendingSender.sender_id}</span> is waiting for admin review — you can submit another once it&apos;s been reviewed.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                      <p className="flex items-center gap-1.5 text-sm font-medium"><Info className="h-3.5 w-3.5" /> What is a sender ID?</p>
                      <p className="text-xs text-muted-foreground">
                        A sender ID is the name that shows up as the sender on your customer&apos;s phone when they receive an SMS from you — instead of a random phone number, they see <span className="font-medium text-foreground">your brand name</span>. It can be up to <span className="font-medium text-foreground">11 characters</span> (letters, numbers and spaces only).
                      </p>
                      <div className="rounded-md border bg-background p-3">
                        <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"><Smartphone className="h-3 w-3" /> On your customer&apos;s phone</p>
                        <div className="flex items-start gap-2">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success/15 text-xs font-bold text-success">
                            {(newSender || shop?.shop_name || "SH").slice(0, 2).toUpperCase()}
                          </span>
                          <div>
                            <p className="text-sm font-semibold">{newSender || shop?.shop_name || "Your Shop"}</p>
                            <p className="text-xs text-muted-foreground">Your order of GHS 25 MTN data is confirmed. Thank you!</p>
                          </div>
                        </div>
                      </div>
                      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Info className="h-3 w-3 mt-0.5 shrink-0" /> Why it matters: customers trust messages from your brand more than a generic number. Every sender ID request is reviewed before it goes live to prevent impersonation.
                      </p>
                    </div>

                    {shop?.shop_name && senderSuggestions(shop.shop_name).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="text-muted-foreground">Suggestions:</span>
                        {senderSuggestions(shop.shop_name).map((s) => (
                          <button key={s} type="button" onClick={() => setNewSender(s)} className="rounded-full bg-muted px-2.5 py-1 font-mono font-medium hover:bg-accent">{s}</button>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Input value={newSender} onChange={(e) => setNewSender(e.target.value)} placeholder="e.g. KFT Shop" maxLength={11} className="uppercase" />
                      <Button onClick={requestSenderId} disabled={busy || !newSender.trim()} className="shrink-0 bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Request
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{newSender.length}/11 characters · letters, numbers and spaces only.</p>
                  </>
                )}

                {senderIds.some((s) => s.local_status === "rejected") && (
                  <div className="border-t pt-2">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Previous requests</p>
                    <ul className="space-y-1">
                      {senderIds.filter((s) => s.local_status === "rejected").map((s) => (
                        <li key={s.id} className="flex items-center justify-between text-xs">
                          <span className="font-mono">{s.sender_id}</span>
                          <Badge className={SENDER_BADGE[s.local_status] ?? ""} variant="secondary">rejected</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })()}

        {showBonus && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2">
              <Gift className="h-5 w-5 shrink-0 text-amber-600" />
              <div>
                <p className="text-sm font-bold text-foreground">Claim your {account.welcomeBonusCredits} free SMS credits!</p>
                <p className="text-xs text-muted-foreground">Welcome bonus for activating the SMS feature.</p>
              </div>
            </div>
            <Button size="sm" onClick={claimBonus} disabled={busy} className="shrink-0 bg-amber-500 text-white hover:bg-amber-600">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />} Claim
            </Button>
          </div>
        )}

        {showActivation && (
          <Card className="overflow-hidden border-success/30">
            <CardContent className="space-y-4 pt-6 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success/10">
                <Lock className="h-7 w-7 text-success" />
              </div>
              <div>
                <p className="text-lg font-bold text-foreground">Unlock Customer SMS</p>
                <p className="text-sm text-muted-foreground">One-time activation, then pay-as-you-go with SMS bundles.</p>
              </div>
              {account.welcomeBonusCredits > 0 && !account.bonusClaimed && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
                  <Gift className="mr-1 inline h-3.5 w-3.5" /> Activate now and get {account.welcomeBonusCredits} free SMS credits to get started!
                </p>
              )}
              <ul className="space-y-1.5 rounded-lg bg-muted/30 p-3 text-left text-sm">
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Bulk SMS to your entire customer list in one tap</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Single SMS to any Ghana number</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Live character &amp; cost counter — no surprises</li>
                <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 shrink-0 text-success" /> Failed messages are automatically refunded</li>
              </ul>
              {account.activationFee > 0 && (
                <>
                  <p className="text-3xl font-black text-success">GH₵{account.activationFee.toFixed(2)}</p>
                  <p className="-mt-3 text-xs text-muted-foreground">one-time activation fee</p>
                </>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => activate("wallet")} disabled={busy} className="bg-success text-white hover:bg-success/90">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} {account.activationFee === 0 ? "Activate" : `Activate for GH₵${account.activationFee.toFixed(2)}`}
                </Button>
                {account.activationFee > 0 && (
                  walletDirect ? (
                    <Button variant="outline" onClick={() => openMomo("activation", 0, account.activationFee)} disabled={busy}><Smartphone className="h-4 w-4" /> Pay with MoMo</Button>
                  ) : (
                    <Button variant="outline" onClick={() => activate("paystack")} disabled={busy}><CreditCard className="h-4 w-4" /> Pay with Paystack</Button>
                  )
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="send" disabled={!isActive}>Send</TabsTrigger>
            <TabsTrigger value="bundles">Buy</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="contacts">Contacts</TabsTrigger>
          </TabsList>

          {/* ── SEND (compose) ── */}
          <TabsContent value="send" className="space-y-4 pt-4">
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardHeader className="cursor-default pb-2">
                <CardTitle className="flex items-center gap-2 text-sm text-amber-700"><ShieldQuestion className="h-4 w-4" /> Sending rules — avoid scam messages</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 text-xs text-amber-800">
                <p>To protect your customers, every message is checked automatically. These are <span className="font-semibold">not allowed</span> and will be blocked:</p>
                <ul className="space-y-1">
                  <li className="flex items-start gap-1.5"><X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" /> Asking for OTP, PIN, password, or to &quot;verify/confirm your account&quot;</li>
                  <li className="flex items-start gap-1.5"><X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" /> Fake prizes, lottery or &quot;you have won&quot; messages</li>
                  <li className="flex items-start gap-1.5"><X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" /> Fake account-reversal or &quot;send my money back&quot; tricks</li>
                  <li className="flex items-start gap-1.5"><X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" /> Links to suspicious or shortened URLs</li>
                </ul>
                <p><span className="font-semibold">Do</span> promote your real bundles, prices and your shop link — that&apos;s what customers love.</p>
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2">Blocked messages cost <span className="font-semibold">no credits</span>. Repeated scam attempts can disable your SMS feature.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5 text-[#1b388b]" /> Compose Message</CardTitle>
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
                      No approved sender IDs yet — request one in the <span className="font-medium">Your Sender ID</span> card above. Messages use the platform default meanwhile.
                    </p>
                  )}
                </div>

                {/* Send to a saved group */}
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground">Send to a saved group</Label>
                  <Select value={selectedGroupId || "none"} onValueChange={(v) => setSelectedGroupId(v === "none" ? "" : v)}>
                    <SelectTrigger className="w-full sm:w-72"><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>{g.name} ({g.contact_count})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {composeGroup && (
                    <p className="text-xs text-muted-foreground">
                      Will send to all active contacts in “{composeGroup.name}” (up to {composeGroup.contact_count}). Opted-out numbers are skipped.
                    </p>
                  )}
                  {groups.length === 0 && groupsLoaded && (
                    <p className="text-xs text-muted-foreground">
                      No groups yet — build one in the <span className="font-medium">Contacts</span> tab.
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
                    <button type="button" onClick={() => setShowPreview((s) => !s)} className="flex items-center gap-1 text-sm text-[#1b388b] hover:underline">
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
                        <span className="inline-block max-w-[80%] rounded-2xl rounded-bl-sm bg-success px-3 py-2 text-sm text-white whitespace-pre-wrap break-words">
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
                  <span className="font-medium text-[#1b388b]">{segPerRecipient} credit{segPerRecipient === 1 ? "" : "s"} per recipient</span>
                </div>

                {overBudget && (
                  <Alert variant={overBudgetBlocks ? "destructive" : "default"}>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      {composeGroup
                        ? `Estimated ~${totalCredits} credits vs your ${balance}. Opted-out numbers are skipped, so it may still fit — if it doesn't, the whole send is rejected (no partial send). Top up to be safe.`
                        : `This send needs about ${totalCredits} credits but you have ${balance}. Buy more credits.`}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Save as template */}
                {savingTemplate ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" className="w-48" />
                    <Button size="sm" onClick={saveTemplate} disabled={busy} className="bg-[#1b388b] text-white hover:bg-[#1b388b]/90">Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setSavingTemplate(false); setTemplateName("") }}>Cancel</Button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setSavingTemplate(true)} className="flex items-center gap-1.5 text-sm text-[#1b388b] hover:underline">
                    <Copy className="h-4 w-4" /> Save as template
                  </button>
                )}

                {estRecipients > 0 && (
                  <p className="text-center text-xs text-muted-foreground">
                    {composeGroup
                      ? `Approx. ${estRecipients} recipient${estRecipients === 1 ? "" : "s"} (group is an estimate; opted-out numbers are skipped server-side).`
                      : `${estRecipients} recipient${estRecipients === 1 ? "" : "s"}.`}
                  </p>
                )}

                <Button onClick={sendMessage} disabled={sendDisabled} className="w-full bg-[#1b388b] text-white hover:bg-[#1b388b]/90" size="lg">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sending ? "Sending…" : "Send SMS"}
                </Button>

                {/* Group-send confirmation — real opt-out-filtered count + cost */}
                <AlertDialog open={sendConfirm.open} onOpenChange={(o) => setSendConfirm((c) => ({ ...c, open: o }))}>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Send to this group?</AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        {sendConfirm.loading ? (
                          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Checking group size…</div>
                        ) : (
                          <div>
                            This will send to <span className="font-medium text-foreground">{confirmTotal}</span> recipient{confirmTotal === 1 ? "" : "s"}
                            {recipients.length > 0 ? <> ({sendConfirm.sentCount} from the group + {recipients.length} typed)</> : null}
                            {confirmTotal > 500 ? <> — auto-split into <span className="font-medium text-foreground">{confirmBatches}</span> batches of up to 500</> : null} for about <span className="font-medium text-foreground">{confirmCost}</span> credit{confirmCost === 1 ? "" : "s"} (opted-out numbers skipped; duplicates merged).
                            {sendConfirm.activeCount > sendConfirm.sentCount && (
                              <span className="mt-2 block text-amber-600">Group has {sendConfirm.activeCount} active contacts, above the {sendConfirm.sentCount}-per-send limit — only the first {sendConfirm.sentCount} will be sent; send the rest separately.</span>
                            )}
                          </div>
                        )}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={doSend} disabled={sendConfirm.loading || confirmTotal === 0}>
                        Send to {confirmTotal}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── TEMPLATES ── */}
          <TabsContent value="templates" className="pt-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle className="flex items-center gap-2 text-base"><Copy className="h-4 w-4 text-[#1b388b]" /> Message Templates</CardTitle>
                <Button size="sm" onClick={() => { setMessage(""); setSavingTemplate(false); setTab("send"); toast.info("Compose a message, then “Save as template”.") }} className="bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
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
                        <button type="button" onClick={() => { setMessage(tpl.body); setTab("send"); toast.success(`Loaded “${tpl.name}”`) }} className="min-w-0 flex-1 text-left">
                          <p className="font-medium">{tpl.name}</p>
                          <p className="truncate text-sm text-muted-foreground">{tpl.body}</p>
                        </button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTemplate(tpl.id)} disabled={busy} className="text-destructive hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── CONTACTS (address book) ── */}
          <TabsContent value="contacts" className="space-y-4 pt-4">
            <div className="grid gap-4 md:grid-cols-[19rem_1fr]">
              {/* Groups column */}
              <Card className="self-start">
                <CardHeader>
                  <CardTitle className="text-base">Groups</CardTitle>
                  <CardDescription>Address-book groups for targeted SMS.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="New group name" maxLength={100} />
                    <Input value={gDesc} onChange={(e) => setGDesc(e.target.value)} placeholder="Description (optional)" />
                    <Button className="w-full" onClick={createGroup} disabled={contactsBusy || !gName.trim()}>
                      {contactsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create group
                    </Button>
                  </div>

                  {!groupsLoaded ? (
                    <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
                  ) : (
                    <ul className="divide-y">
                      {groups.map((g) => (
                        <li key={g.id} className="flex items-center justify-between gap-2 py-2">
                          <button
                            type="button"
                            onClick={() => selectGroup(g)}
                            className={`min-w-0 flex-1 text-left text-sm ${selectedGroup?.id === g.id ? "font-semibold text-[#1b388b]" : ""}`}
                          >
                            <span className="block truncate">{g.name}</span>
                            <span className="text-xs text-muted-foreground">{g.contact_count} contact{g.contact_count === 1 ? "" : "s"}</span>
                          </button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" onClick={() => setPendingDeleteGroup(g)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </li>
                      ))}
                      {groups.length === 0 && <li className="py-2 text-sm text-muted-foreground">No groups yet.</li>}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {/* Contacts column */}
              <div className="space-y-4">
                {!selectedGroup ? (
                  <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                      Select a group to manage its contacts.
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    {/* Add to {group} */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                          <UserPlus className="h-4 w-4" /> Add to {selectedGroup.name}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {/* Single add */}
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <Input value={cFirst} onChange={(e) => setCFirst(e.target.value)} placeholder="First name" />
                          <Input value={cLast} onChange={(e) => setCLast(e.target.value)} placeholder="Last name" />
                          <Input value={cPhone} onChange={(e) => setCPhone(e.target.value)} placeholder="Phone (0XXXXXXXXX)" className="font-mono" />
                          <Button onClick={addContactSingle} disabled={contactsBusy || !cPhone.trim()}>
                            {contactsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
                          </Button>
                        </div>

                        {/* Verify opt-in (governs both bulk imports below) */}
                        <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3">
                          <Checkbox id="verifyOnImport" checked={verifyOnImport} onCheckedChange={(v) => setVerifyOnImport(v === true)} className="mt-0.5" />
                          <div className="space-y-0.5">
                            <Label htmlFor="verifyOnImport" className="text-sm font-medium">Verify numbers (fetch MoMo name)</Label>
                            <p className="text-xs text-muted-foreground">Verifying looks up each number&apos;s registered Mobile Money name (slow — runs in the background).</p>
                          </div>
                        </div>

                        {/* CSV upload */}
                        <div className="space-y-2 rounded-lg border p-3">
                          <Label className="flex items-center gap-2 text-sm font-medium"><Upload className="h-4 w-4" /> Upload CSV</Label>
                          <p className="text-xs text-muted-foreground">
                            Columns: <code>phone,firstName,lastName</code> (name fields optional; a header row is tolerated).
                          </p>
                          <Input
                            ref={fileRef}
                            type="file"
                            accept=".csv,text/csv"
                            disabled={contactsBusy}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsvFile(f) }}
                          />
                        </div>

                        {/* Bulk paste */}
                        <div className="space-y-2">
                          <Label htmlFor="bulk" className="text-sm font-medium">…or paste rows</Label>
                          <Textarea
                            id="bulk"
                            value={bulk}
                            onChange={(e) => setBulk(e.target.value)}
                            rows={4}
                            placeholder={"0241234567,Ama,Mensah\n0207654321"}
                            className="font-mono text-sm"
                          />
                          <Button variant="outline" onClick={importBulk} disabled={contactsBusy || !bulk.trim()}>
                            {contactsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import pasted rows
                          </Button>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Contacts table + verify control */}
                    <Card>
                      <CardHeader className="flex flex-row items-center justify-between space-y-0">
                        <CardTitle className="text-base">Contacts ({contacts.length})</CardTitle>
                        <Button variant="outline" size="sm" onClick={reverifyGroup} disabled={verifying || contacts.length === 0}>
                          {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldQuestion className="h-4 w-4" />} Verify numbers
                        </Button>
                      </CardHeader>
                      <CardContent>
                        {verifying && verifyCounts && (
                          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Verifying… {verifyCounts.verified + verifyCounts.invalid}/{verifyCounts.total} checked
                          </p>
                        )}
                        {contacts.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No contacts in this group.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="border-b text-left text-muted-foreground">
                                  <th className="py-2 font-medium">Name</th>
                                  <th className="py-2 font-medium">Phone</th>
                                  <th className="py-2 font-medium">Verify</th>
                                  <th className="py-2 font-medium">Status</th>
                                  <th className="py-2 text-right font-medium">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {contacts.map((c) => (
                                  <tr key={c.id} className="border-b last:border-0">
                                    <td className="py-2">
                                      <span>{contactName(c)}</span>
                                      {c.verify_status === "verified" && c.verified_name && (
                                        <span className="block text-xs text-muted-foreground">{c.verified_name}</span>
                                      )}
                                    </td>
                                    <td className="py-2 font-mono">{c.phone_number}</td>
                                    <td className="py-2">
                                      {c.verify_status === "verified" ? (
                                        <Badge className="bg-green-100 text-green-700">Verified</Badge>
                                      ) : c.verify_status === "invalid" ? (
                                        <Badge variant="destructive">Not found</Badge>
                                      ) : c.verify_status === "pending" ? (
                                        <Badge variant="secondary" className="gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Checking…</Badge>
                                      ) : (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </td>
                                    <td className="py-2">
                                      {c.opted_out ? (
                                        <Badge variant="destructive">opted out</Badge>
                                      ) : (
                                        <Badge className="bg-green-100 text-green-700">active</Badge>
                                      )}
                                    </td>
                                    <td className="py-2 text-right">
                                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => toggleOptOut(c)} disabled={contactsBusy}>
                                        {c.opted_out ? "Re-include" : "Opt out"}
                                      </Button>
                                      <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => setPendingDeleteContact(c)} disabled={contactsBusy}>
                                        Delete
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </>
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── BUY CREDITS (free quantity at the per-credit fee) ── */}
          <TabsContent value="bundles" className="space-y-4 pt-4">
            {!isActive ? (
              <Alert><AlertCircle className="h-4 w-4" /><AlertDescription>Activate your SMS account before buying credits.</AlertDescription></Alert>
            ) : !bundlesLoaded ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
              </div>
            ) : bundles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bundles are available right now — check back later.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><Wallet className="h-4 w-4" /> Buy Credits</p>
                  <div className="flex gap-1.5">
                    <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">Profit Wallet GH₵{profitBalance.toFixed(2)}</span>
                    <span className="rounded-full border border-[#1b388b]/30 bg-[#1b388b]/10 px-2.5 py-1 text-xs font-medium text-[#1b388b]">Main Wallet GH₵{walletBalance.toFixed(2)}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {bundles.map((b) => {
                    const perSms = b.units > 0 ? b.price_ghs / b.units : 0
                    const affordable = walletBalance >= b.price_ghs
                    const isBuying = buyingBundleId === b.id
                    return (
                      <Card key={b.id}>
                        <CardContent className="space-y-1.5 pt-4">
                          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Messages</p>
                          <p className="text-xl font-bold">{b.units.toLocaleString()}</p>
                          <p className="text-lg font-bold text-success">GH₵{b.price_ghs.toFixed(2)}</p>
                          <p className="text-[10px] text-muted-foreground">≈ GHS {perSms.toFixed(3)}/SMS</p>
                          {!affordable && <p className="text-[10px] text-amber-600">Need GH₵{(b.price_ghs - walletBalance).toFixed(2)} more</p>}
                          <Button
                            size="sm"
                            className="w-full bg-success text-white hover:bg-success/90"
                            disabled={busy || isBuying}
                            onClick={() => buyBundle(b.id, affordable ? "wallet" : "paystack")}
                          >
                            {isBuying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Buy
                          </Button>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground">Buys with sufficient Main Wallet balance are debited instantly; otherwise you&apos;ll be sent to Paystack/MoMo to pay.</p>
              </>
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

        {/* Shared on-page MoMo payment dialog (Buy Credits + Activation) */}
        <Dialog open={momo.open} onOpenChange={(o) => { if (!o) closeMomo() }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-[#1b388b]" />
                {momo.kind === "credits" ? "Pay with Mobile Money" : "Activate with Mobile Money"}
              </DialogTitle>
              <DialogDescription>
                {momo.kind === "credits"
                  ? `${momo.credits.toLocaleString()} credits · GHS ${momo.cost.toFixed(2)}`
                  : `One-time activation · GHS ${momo.cost.toFixed(2)}`}
              </DialogDescription>
            </DialogHeader>

            {/* FORM stage — phone + (optional) OTP + Pay */}
            {momo.stage === "form" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="momo-phone">Mobile Money number to pay from</Label>
                  <Input
                    id="momo-phone"
                    type="tel"
                    inputMode="numeric"
                    placeholder="0241234567"
                    value={momo.phone}
                    onChange={(e) => {
                      const phone = e.target.value
                      setMomo((m) => ({
                        ...m, phone,
                        // editing the number invalidates a prior verify
                        ...(m.otpSent || m.otpVerified ? { otpSent: false, otpVerified: false, otpCode: "" } : {}),
                      }))
                      if (momo.otpSent || momo.otpVerified) otpCooldown.reset()
                    }}
                    disabled={(walletOtp && momo.otpVerified) || momoBusy}
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">The payment prompt is sent to this number.</p>
                </div>

                {walletOtp && (!momo.otpVerified ? (
                  !momo.otpSent ? (
                    <Button type="button" variant="outline" onClick={sendOtp} disabled={sendingOtp || otpCooldown.seconds > 0} className="w-full">
                      {sendingOtp ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Sending code…</>) : otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Send verification code"}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        inputMode="numeric" maxLength={6} placeholder="Enter 6-digit code" value={momo.otpCode}
                        onChange={(e) => setMomo((m) => ({ ...m, otpCode: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                        className="text-center text-lg tracking-[0.4em] font-mono"
                      />
                      <div className="flex gap-2">
                        <Button type="button" onClick={verifyOtp} disabled={verifyingOtp || momo.otpCode.length < 4} className="flex-1">
                          {verifyingOtp ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Verifying…</>) : "Verify"}
                        </Button>
                        <Button type="button" variant="outline" onClick={sendOtp} disabled={sendingOtp || otpCooldown.seconds > 0}>
                          {otpCooldown.seconds > 0 ? `Resend in ${otpCooldown.seconds}s` : "Resend"}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Don&apos;t see the code? Check your phone&apos;s Spam or Blocked messages folder.</p>
                    </div>
                  )
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3">
                    <CheckCircle className="h-5 w-5 text-success" />
                    <span className="text-sm font-medium text-foreground">Payment number verified ✓</span>
                  </div>
                ))}

                <Button
                  onClick={payWithMomo}
                  disabled={momoBusy || !/^0?\d{9}$/.test(momo.phone.replace(/\D/g, "")) || (walletOtp && !momo.otpVerified)}
                  className="w-full"
                >
                  {momoBusy ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Starting…</>) : `Pay GHS ${momo.cost.toFixed(2)}`}
                </Button>
              </div>
            )}

            {/* AWAITING stage — prompt sent, polling the SMS account */}
            {momo.stage === "awaiting" && (
              <div className="space-y-4 py-2 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#1b388b]/10">
                  <Loader2 className="h-8 w-8 animate-spin text-[#1b388b]" />
                </div>
                <div>
                  <h3 className="text-lg font-bold">Approve the prompt on your phone</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Approve the Mobile Money prompt on your phone to complete payment.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Waiting for confirmation…
                </div>
                <p className="text-xs text-muted-foreground">Keep this page open. This can take up to a minute.</p>
              </div>
            )}

            {/* DONE stage (rare — usually closes on success, this is the fallback) */}
            {momo.stage === "done" && (
              <div className="space-y-4 py-2 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/15">
                  <CheckCircle className="h-9 w-9 text-success" />
                </div>
                <h3 className="text-lg font-bold">{momo.kind === "credits" ? "Credits added 🎉" : "Account activated 🎉"}</h3>
                <Button onClick={closeMomo} className="w-full">Done</Button>
              </div>
            )}

            {/* ERROR / timeout stage */}
            {momo.stage === "error" && (
              <div className="space-y-4 py-2 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/15">
                  <AlertCircle className="h-9 w-9 text-destructive" />
                </div>
                <p className="text-sm text-muted-foreground">{momo.message || "The payment was not completed. Please try again."}</p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setMomo((m) => ({ ...m, stage: "form", message: "" }))} className="flex-1">Try again</Button>
                  <Button variant="ghost" onClick={closeMomo} className="flex-1">Close</Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Delete group confirm */}
        <AlertDialog open={pendingDeleteGroup !== null} onOpenChange={(open) => !open && setPendingDeleteGroup(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete group?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes the group{pendingDeleteGroup ? ` “${pendingDeleteGroup.name}”` : ""} and all of its contacts. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={contactsBusy}
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { if (pendingDeleteGroup) { const g = pendingDeleteGroup; setPendingDeleteGroup(null); void deleteGroup(g) } }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete contact confirm */}
        <AlertDialog open={pendingDeleteContact !== null} onOpenChange={(open) => !open && setPendingDeleteContact(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete contact?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes {pendingDeleteContact ? `“${contactName(pendingDeleteContact)}” (${pendingDeleteContact.phone_number})` : "this contact"} from the group. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={contactsBusy}
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => { if (pendingDeleteContact) { const c = pendingDeleteContact; setPendingDeleteContact(null); void deleteContact(c) } }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </DashboardLayout>
  )
}
