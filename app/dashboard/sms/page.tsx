// app/dashboard/sms/page.tsx
"use client"
import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

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

// Tab IDs — extend here in M3 to add "compose"
type TabId = "overview"

export default function SmsDashboardPage() {
  const [account, setAccount] = useState<AccountData | null>(null)
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  // tab state: ready for M3 to add more tabs without a rewrite
  const [activeTab] = useState<TabId>("overview")

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

  useEffect(() => { load() }, [load])

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

  if (!account) {
    return <div className="p-6 text-muted-foreground">Loading SMS dashboard…</div>
  }

  const isActive = account.status === "active"
  const isSuspended = account.status === "suspended"
  const isPlatform = account.ownerType === "platform"
  const showActivation = !isPlatform && !isActive && !isSuspended
  const showBonus = isActive && !account.bonusClaimed

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      {/* Page header with tab bar — M3 adds "Compose" tab here */}
      <div className="flex items-center justify-between border-b pb-3">
        <h1 className="text-2xl font-bold">SMS</h1>
        {/* Tab bar: currently one tab; M3 will add more without rewriting this page */}
        <nav className="flex gap-1" aria-label="SMS sections">
          <button
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              activeTab === "overview"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            aria-current={activeTab === "overview" ? "page" : undefined}
          >
            Overview
          </button>
          {/* M3: add <ComposeTab> button here */}
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
    </div>
  )
}
