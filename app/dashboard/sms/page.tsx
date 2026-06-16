// app/dashboard/sms/page.tsx
"use client"
import { useCallback, useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"
import { calculateSegments, calculateCredits } from "@/lib/sms/segments"

interface AccountData {
  id: string
  ownerType: string
  unitBalance: number
  pendingUnits: number
  status: string // 'inactive' | 'active' | 'suspended'
  bonusClaimed: boolean
  bonusClaimedAt: string | null
  activatedAt: string | null
  activationFee: number
  welcomeBonusCredits: number
}

interface Bundle {
  id: string
  name: string
  units: number
  price_ghs: number
}

interface SendLog {
  id: string
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  status: string
  created_at: string
}

// Tab IDs — extended in M3 to add "compose"
type TabId = "overview" | "compose"

// ─── helpers ────────────────────────────────────────────────────────────────

function parseRecipients(raw: string): string[] {
  const parts = raw.split(/[\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

const STATUS_BADGE: Record<string, string> = {
  queued:  "bg-yellow-100 text-yellow-800",
  sending: "bg-blue-100 text-blue-800",
  sent:    "bg-green-100 text-green-800",
  partial: "bg-orange-100 text-orange-800",
  failed:  "bg-red-100 text-red-800",
  blocked: "bg-red-200 text-red-900",
}

// ─── main component ──────────────────────────────────────────────────────────

export default function SmsDashboardPage() {
  const [account, setAccount]   = useState<AccountData | null>(null)
  const [bundles, setBundles]   = useState<Bundle[]>([])
  const [busy, setBusy]         = useState(false)
  const [msg, setMsg]           = useState<{ text: string; ok: boolean } | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>("overview")

  // compose state
  const [message, setMessage]         = useState("")
  const [recipientsRaw, setRecipientsRaw] = useState("")
  const [sending, setSending]         = useState(false)
  const [sendMsg, setSendMsg]         = useState<{ text: string; ok: boolean } | null>(null)
  const [logs, setLogs]               = useState<SendLog[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  const notice = (text: string, ok = true) => setMsg({ text, ok })

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const load = useCallback(async () => {
    const t = await token()
    const headers = { Authorization: `Bearer ${t}` }
    const [accRes, bunRes] = await Promise.all([
      fetch("/api/sms/account", { headers }).then((r) => r.json()),
      fetch("/api/sms/bundles", { headers }).then((r) => r.json()),
    ])
    setAccount(accRes.account ?? null)
    setBundles(bunRes.bundles ?? [])
  }, [])

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    const t = await token()
    const res = await fetch("/api/sms/logs", {
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    setLogsLoading(false)
    setLogs(res.data?.logs ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  // Load logs whenever compose tab is activated
  useEffect(() => {
    if (activeTab === "compose") loadLogs()
  }, [activeTab, loadLogs])

  async function activate(paidFrom: "wallet" | "paystack") {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/activate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ paidFrom }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "INSUFFICIENT_BALANCE"
        ? "Insufficient wallet balance. Top up your wallet first or pay with Paystack."
        : res.error, false)
    } else if (res.authorizationUrl) {
      window.location.href = res.authorizationUrl
    } else {
      notice("Account activated! Welcome to SMS.")
      await load()
    }
  }

  async function claimBonus() {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/claim-bonus", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "ALREADY_CLAIMED" ? "Bonus already claimed." : res.error, false)
    } else if (res.pending) {
      notice(`${res.unitsCredited} bonus SMS credits queued — awaiting SMS supply top-up.`)
    } else {
      notice(`${res.unitsCredited} bonus SMS credits added to your account!`)
      await load()
    }
  }

  async function buyBundle(bundleId: string) {
    setBusy(true)
    setMsg(null)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      notice(res.error === "NOT_ACTIVATED"
        ? "Activate your account before buying bundles."
        : res.error, false)
    } else if (res.pending) {
      notice("Payment received — SMS credits are pending SMS supply top-up.")
    } else {
      notice(`${res.unitsCredited} SMS credits added.`)
      await load()
    }
  }

  async function sendMessage() {
    if (!account) return
    const recipients = parseRecipients(recipientsRaw)
    if (message.length < 3 || recipients.length === 0) return

    setSending(true)
    setSendMsg(null)
    const t = await token()
    const res = await fetch("/api/shop/sms/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, recipients }),
    }).then((r) => r.json())
    setSending(false)

    if (res.success) {
      const { total, creditsReserved } = res.data ?? {}
      setSendMsg({
        text: `Queued ${total} recipient${total !== 1 ? "s" : ""} (${creditsReserved} credits used)`,
        ok: true,
      })
      setMessage("")
      setRecipientsRaw("")
      await Promise.all([load(), loadLogs()])
    } else {
      const errCode: string = res.error ?? "UNKNOWN_ERROR"
      let errText: string
      switch (errCode) {
        case "INSUFFICIENT_CREDITS":
          errText = "Not enough credits. Buy a bundle first."
          break
        case "TOO_MANY_RECIPIENTS":
          errText = "Max 500 recipients per send."
          break
        case "BLOCKED":
          errText = `Sending blocked: ${res.reason ?? "content policy"}`
          break
        case "NOT_ACTIVATED":
          errText = "Activate your SMS account before sending."
          break
        case "SUSPENDED":
          errText = "Your SMS account is suspended."
          break
        default:
          errText = res.message ?? errCode
      }
      setSendMsg({ text: errText, ok: false })
    }
  }

  // ─── live meter ────────────────────────────────────────────────────────────

  const recipients = useMemo(() => parseRecipients(recipientsRaw), [recipientsRaw])
  const meter      = useMemo(() => calculateSegments(message), [message])
  const cost       = useMemo(
    () => calculateCredits(message, recipients.length),
    [message, recipients.length]
  )
  const balance        = account?.unitBalance ?? 0
  const overBudget     = message.length >= 3 && recipients.length > 0 && cost > balance
  const sendDisabled   =
    sending ||
    message.length < 3 ||
    recipients.length === 0 ||
    overBudget

  // ─── derived display flags ─────────────────────────────────────────────────

  if (!account) {
    return <div className="p-6 text-muted-foreground">Loading SMS dashboard…</div>
  }

  const isActive     = account.status === "active"
  const isSuspended  = account.status === "suspended"
  const isPlatform   = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive && !isSuspended
  const showBonus    = isActive && !account.bonusClaimed

  // ─── render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Page header with tab bar */}
      <div className="flex items-center justify-between border-b pb-3">
        <h1 className="text-2xl font-bold">SMS</h1>
        <nav className="flex gap-1" aria-label="SMS sections">
          <button
            onClick={() => setActiveTab("overview")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === "overview"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-current={activeTab === "overview" ? "page" : undefined}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab("compose")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === "compose"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-current={activeTab === "compose" ? "page" : undefined}
          >
            Compose
          </button>
        </nav>
      </div>

      {msg && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            msg.ok
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* ── OVERVIEW TAB ─────────────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <>
          {/* Suspended notice */}
          {isSuspended && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-5">
              <div className="font-semibold text-red-900">SMS Sending Suspended</div>
              <p className="mt-1 text-sm text-red-800">
                Your SMS account has been suspended. Please contact support to restore access.
              </p>
            </div>
          )}

          {/* Activation card */}
          {showActivation && (
            <div className="rounded-lg border p-5 space-y-3 bg-amber-50 border-amber-200">
              <div className="font-semibold text-amber-900">Activate SMS</div>
              <p className="text-sm text-amber-800">
                A one-time activation fee of <strong>GHS {account.activationFee.toFixed(2)}</strong> unlocks
                SMS credits, bundle purchases, and campaign sending.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button
                  disabled={busy}
                  onClick={() => activate("wallet")}
                  className="rounded bg-amber-700 px-4 py-2 text-sm text-white hover:bg-amber-800 disabled:opacity-50"
                >
                  Pay with Wallet (GHS {account.activationFee.toFixed(2)})
                </button>
                <button
                  disabled={busy}
                  onClick={() => activate("paystack")}
                  className="rounded border border-amber-700 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                >
                  Pay with Paystack
                </button>
              </div>
            </div>
          )}

          {/* Welcome bonus claim */}
          {showBonus && (
            <div className="rounded-lg border p-5 space-y-3 bg-blue-50 border-blue-200">
              <div className="font-semibold text-blue-900">Welcome Bonus</div>
              <p className="text-sm text-blue-800">
                Claim your free <strong>{account.welcomeBonusCredits} SMS credits</strong> — a one-time gift to get started.
              </p>
              <button
                disabled={busy}
                onClick={claimBonus}
                className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-800 disabled:opacity-50"
              >
                Claim {account.welcomeBonusCredits} Free SMS Credits
              </button>
            </div>
          )}

          {/* Balance panel */}
          <div className="rounded-lg border p-5">
            <div className="text-sm text-muted-foreground">SMS Credits</div>
            <div className="text-3xl font-bold">{account.unitBalance.toLocaleString()}</div>
            {account.pendingUnits > 0 && (
              <div className="mt-1 text-sm text-amber-600">
                + {account.pendingUnits.toLocaleString()} pending (awaiting SMS supply top-up)
              </div>
            )}
            {isActive && account.activatedAt && (
              <div className="mt-1 text-xs text-muted-foreground">
                Active since {new Date(account.activatedAt).toLocaleDateString()}
              </div>
            )}
          </div>

          {/* Bundle store */}
          {isActive && bundles.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-semibold">Buy SMS Credits</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {bundles.map((b) => (
                  <div key={b.id} className="rounded-lg border p-4 space-y-2">
                    <div className="font-semibold">{b.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {Number(b.units).toLocaleString()} credits · GHS {Number(b.price_ghs).toFixed(2)}
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => buyBundle(b.id)}
                      className="w-full rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                    >
                      Buy with wallet
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inactive state — bundle store locked */}
          {showActivation && bundles.length > 0 && (
            <div className="rounded-lg border p-4 opacity-50">
              <p className="text-sm text-center text-muted-foreground">
                Bundle store unlocks after activation.
              </p>
            </div>
          )}
        </>
      )}

      {/* ── COMPOSE TAB ──────────────────────────────────────────────────── */}
      {activeTab === "compose" && (
        <>
          {/* Inactive / suspended gate */}
          {!isActive && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-5">
              <div className="font-semibold text-amber-900">Activate SMS to send messages</div>
              <p className="mt-1 text-sm text-amber-800">
                {isSuspended
                  ? "Your SMS account has been suspended. Contact support to restore access."
                  : "A one-time activation fee unlocks bulk sending. Switch to the Overview tab to activate."}
              </p>
            </div>
          )}

          {/* Send feedback */}
          {sendMsg && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                sendMsg.ok
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-red-200 bg-red-50 text-red-800"
              }`}
            >
              {sendMsg.text}
            </div>
          )}

          {/* Compose form + phone preview side-by-side on large screens */}
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">

            {/* ── Left: form ── */}
            <div className="flex-1 space-y-4">

              {/* Message */}
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="sms-message">
                  Message
                </label>
                <textarea
                  id="sms-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  maxLength={1000}
                  rows={5}
                  disabled={!isActive}
                  placeholder="Type your message here…"
                  className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 resize-y"
                />

                {/* Live meter */}
                {message.length > 0 && (
                  <div
                    className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                      overBudget
                        ? "border-red-300 bg-red-50 text-red-700"
                        : "border-border bg-muted/40 text-muted-foreground"
                    }`}
                  >
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>
                        <span className="font-medium">{meter.length}</span> chars
                      </span>
                      <span>
                        <span className="font-medium">{meter.segments}</span>{" "}
                        segment{meter.segments !== 1 ? "s" : ""}
                      </span>
                      <span>
                        <span className="font-medium">{meter.remaining}</span> remaining
                      </span>
                      <span className={meter.encoding === "unicode" ? "font-semibold text-orange-600" : ""}>
                        {meter.encoding === "gsm7" ? "GSM-7" : "Unicode"}
                      </span>
                      {recipients.length > 0 && (
                        <span>
                          Cost:{" "}
                          <span className={`font-semibold ${overBudget ? "text-red-700" : ""}`}>
                            {cost} credits
                          </span>
                          {" / "}
                          <span className="font-medium">{balance.toLocaleString()}</span> balance
                        </span>
                      )}
                    </div>
                    {meter.encoding === "unicode" && (
                      <div className="text-orange-600">
                        A special character switched this to Unicode — fewer chars per segment (70 / 67 multi).
                      </div>
                    )}
                    {overBudget && (
                      <div className="font-medium">
                        Insufficient credits — buy a bundle on the Overview tab.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Recipients */}
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="sms-recipients">
                  Recipients{" "}
                  {recipients.length > 0 && (
                    <span className="text-muted-foreground font-normal">
                      ({recipients.length} unique)
                    </span>
                  )}
                </label>
                <textarea
                  id="sms-recipients"
                  value={recipientsRaw}
                  onChange={(e) => setRecipientsRaw(e.target.value)}
                  rows={4}
                  disabled={!isActive}
                  placeholder={"One per line or comma-separated:\n+233201234567\n+233551234567"}
                  className="w-full rounded-md border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 resize-y"
                />
                <p className="text-xs text-muted-foreground">
                  Duplicates are removed automatically. Max 500 per send.
                </p>
              </div>

              {/* Send button */}
              <button
                onClick={sendMessage}
                disabled={sendDisabled}
                className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {sending ? "Sending…" : `Send to ${recipients.length || "…"} recipient${recipients.length !== 1 ? "s" : ""}`}
              </button>
            </div>

            {/* ── Right: phone preview ── */}
            <div className="lg:w-56 flex-shrink-0 space-y-2">
              <p className="text-sm font-medium">Preview</p>
              <div className="relative mx-auto w-44 rounded-[2rem] border-4 border-gray-800 bg-gray-800 shadow-xl overflow-hidden">
                {/* status bar */}
                <div className="bg-gray-800 px-3 pt-2 pb-1 flex justify-between items-center">
                  <span className="text-white text-[9px] font-semibold">9:41</span>
                  <span className="text-white text-[9px]">●●●</span>
                </div>
                {/* screen */}
                <div className="bg-gray-100 min-h-[200px] px-2 py-2">
                  {/* sender name */}
                  <div className="text-center mb-2">
                    <span className="text-[9px] text-gray-500 bg-gray-200 rounded-full px-2 py-0.5">
                      Datagod
                    </span>
                  </div>
                  {/* bubble */}
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-white shadow-sm px-2.5 py-1.5">
                      <p className="text-[10px] text-gray-900 break-words whitespace-pre-wrap leading-snug">
                        {message || (
                          <span className="text-gray-400 italic">Your message appears here…</span>
                        )}
                      </p>
                    </div>
                  </div>
                </div>
                {/* home bar */}
                <div className="bg-gray-100 pb-1.5 flex justify-center">
                  <div className="w-10 h-1 rounded-full bg-gray-400" />
                </div>
              </div>
              <p className="text-xs text-center text-muted-foreground">
                Displayed as it appears on the recipient&apos;s phone
              </p>
            </div>
          </div>

          {/* ── Send history ── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Send History</h2>
              <button
                onClick={loadLogs}
                disabled={logsLoading}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {logsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            {logsLoading && logs.length === 0 && (
              <p className="text-sm text-muted-foreground">Loading history…</p>
            )}

            {!logsLoading && logs.length === 0 && (
              <p className="text-sm text-muted-foreground">No sends yet.</p>
            )}

            {logs.length > 0 && (
              <div className="divide-y rounded-lg border overflow-hidden">
                {logs.map((log) => (
                  <div key={log.id} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-muted/30">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm truncate text-foreground">{log.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {log.recipients_count} recipient{log.recipients_count !== 1 ? "s" : ""} ·{" "}
                        {log.segments} seg{log.segments !== 1 ? "s" : ""} ·{" "}
                        {log.credits_used} credit{log.credits_used !== 1 ? "s" : ""} ·{" "}
                        {new Date(log.created_at).toLocaleString()}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                        STATUS_BADGE[log.status] ?? "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {log.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
