"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { CircleAlert, Loader2, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { supabase } from "@/lib/supabase"
import { computeFee } from "@/lib/momo-claim/money"
import { buildSendAndClaimView, limitsLine, momoErrorCopy } from "@/lib/momo-claim/view-model"
import { startPoller } from "@/lib/momo-claim/poller"
import { MAX_OPEN_SESSIONS } from "@/lib/momo-claim/window"
import { HowItWorks } from "./how-it-works"
import { PaymentModal, type PaymentModalData } from "./payment-modal"
import { ClaimBox, formatCountdown } from "./claim-box"

type Session = {
  id: string
  code: string
  amount: number
  fee: number
  netAmount: number
  status: string
  createdAt: string
  expiresAt: string
}

type Info = {
  accounts: { network: string; number: string }[]
  accountName: string
  feePercent: number
  minNet: number
  maxSent: number
}

const FAST_MS = 5000
const SLOW_MS = 15000
const BACKOFF_AFTER_MS = 2 * 60 * 1000
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

async function getToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export function SendAndClaimTab({
  onCredited,
  openGuideSignal = 0,
}: {
  onCredited: (netAmount: number) => void
  openGuideSignal?: number
}) {
  const [info, setInfo] = useState<Info | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsVerify, setNeedsVerify] = useState(false)
  const [modal, setModal] = useState<PaymentModalData | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const seen = useRef<Map<string, string>>(new Map())
  const [loadFailed, setLoadFailed] = useState(false)
  const creditedRef = useRef(onCredited)
  creditedRef.current = onCredited

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch("/api/wallet/momo-sessions", { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        setLoadFailed(true)
        return
      }
      const body = await res.json()
      if (!body.enabled) {
        setLoadFailed(true)
        return
      }
      setLoadFailed(false)
      setInfo({ accounts: body.accounts, accountName: body.accountName, feePercent: body.feePercent, minNet: body.minNet, maxSent: body.maxSent })
      const list: Session[] = body.sessions ?? []
      for (const s of list) {
        if (seen.current.get(s.id) === "pending" && s.status === "claimed") creditedRef.current(s.netAmount)
        seen.current.set(s.id, s.status)
      }
      setSessions(list)
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const view = useMemo(
    () => buildSendAndClaimView(sessions, new Date(nowMs), modal !== null, sessions.some((s) => s.status === "claimed")),
    [sessions, nowMs, modal],
  )
  const hasPending = sessions.some((s) => s.status === "pending")

  useEffect(() => {
    if (!hasPending) return
    const poller = startPoller({
      load,
      isHidden: () => document.hidden,
      fastMs: FAST_MS,
      slowMs: SLOW_MS,
      backoffAfterMs: BACKOFF_AFTER_MS,
    })
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      poller.stop()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [hasPending, load])

  const mtn = info?.accounts.find((a) => a.network === "MTN")
  const valid = AMOUNT_RE.test(amount) && Number(amount) > 0
  const preview = useMemo(() => {
    if (!valid || !info) return null
    const { feePesewas, netPesewas } = computeFee(Math.round(Number(amount) * 100), info.feePercent)
    return { fee: feePesewas / 100, net: netPesewas / 100 }
  }, [valid, amount, info])

  const generate = async () => {
    if (!info || !mtn) return
    setBusy(true)
    setError(null)
    setNeedsVerify(false)
    try {
      const token = await getToken()
      const res = await fetch("/api/wallet/momo-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amount: Number(amount) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(momoErrorCopy(body.error, info))
        setNeedsVerify(body.error === "phone_not_verified")
        if (body.error === "too_many_open") await load()
        return
      }
      seen.current.set(body.session.id, "pending")
      setModal({ code: body.session.code, amount: body.session.amount, number: mtn.number, accountName: info.accountName })
      setAmount("")
      await load()
    } catch {
      setError("Something went wrong. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (id: string) => {
    const token = await getToken()
    await fetch(`/api/wallet/momo-sessions?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined)
    await load()
  }

  if (!info) {
    return loadFailed ? (
      <div className="flex items-center gap-3 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 text-sm text-foreground clay">
        Couldn&apos;t load Send &amp; Claim.
        <Button size="sm" variant="outline" className="rounded-full" onClick={() => { setLoadFailed(false); void load() }}>
          Retry
        </Button>
      </div>
    ) : (
      <div className="h-40 animate-pulse rounded-2xl bg-muted" />
    )
  }

  const overMax = valid && Number(amount) > info.maxSent
  const disabled = busy || !valid || !mtn || view.generateDisabled || overMax

  return (
    <div className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      <HowItWorks defaultOpen={view.guideOpenByDefault} limits={info} openSignal={openGuideSignal} />
      <div className="space-y-4">
        <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div>
            <p className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Zap className="h-4 w-4 text-amber-500" />
              Send &amp; Claim
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter an amount and we&apos;ll generate a payment reference — send the money and your wallet is credited automatically.
            </p>
          </div>
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="flex items-center gap-2 text-sm font-bold">
              <CircleAlert className="h-4 w-4 flex-shrink-0" />
              {limitsLine(info)}
            </p>
            <p className="mt-1 text-xs">
              The minimum applies to the amount credited after any fee. Payments above the maximum are held for admin review.
            </p>
          </div>
          <label htmlFor="momo-amount" className="block text-sm font-bold text-foreground">Amount (GHS)</label>
          <Input
            id="momo-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount"
            className="rounded-xl"
          />
          {preview && (
            <p className="text-sm font-medium text-foreground">
              Fee: GHS {preview.fee.toFixed(2)} · You get: GHS {preview.net.toFixed(2)}
            </p>
          )}
          {overMax && <p className="text-sm text-destructive">{momoErrorCopy("above_max", info)}</p>}
          {!mtn && <p className="text-sm text-destructive">Payment number not set — contact support</p>}
          {error && (
            <p className="text-sm text-destructive">
              {error}{" "}
              {needsVerify && (
                <Link href="/dashboard/profile" className="font-semibold underline">Verify now</Link>
              )}
            </p>
          )}
          {view.generateDisabled && view.nextSlotFreeAt && (
            <p className="text-sm text-muted-foreground">
              You have {MAX_OPEN_SESSIONS} open payments. A new one unlocks when one expires or is credited. Next slot in{" "}
              <span className="font-mono tabular-nums">{formatCountdown(view.nextSlotFreeAt, nowMs)}</span>
            </p>
          )}
          <Button onClick={generate} disabled={disabled} className="w-full rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Generate Payment Details
          </Button>
        </div>
        {view.boxes.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-bold text-foreground">Open payments ({view.boxes.length})</p>
            {view.boxes.map((s) => (
              <ClaimBox key={s.id} session={s} nowMs={nowMs} getToken={getToken} onDone={load} onCancel={cancel} />
            ))}
          </div>
        )}
      </div>
      {modal && <PaymentModal data={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
