"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { supabase } from "@/lib/supabase"
import { computeFee } from "@/lib/momo-claim/money"
import { buildSendAndClaimView, momoErrorCopy } from "@/lib/momo-claim/view-model"
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

export function SendAndClaimTab({ onCredited }: { onCredited: (netAmount: number) => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [amount, setAmount] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsVerify, setNeedsVerify] = useState(false)
  const [modal, setModal] = useState<PaymentModalData | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const seen = useRef<Map<string, string>>(new Map())
  const pollStart = useRef<number | null>(null)
  const creditedRef = useRef(onCredited)
  creditedRef.current = onCredited

  const load = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await fetch("/api/wallet/momo-sessions", { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const body = await res.json()
      if (!body.enabled) return
      setInfo({ accounts: body.accounts, accountName: body.accountName, feePercent: body.feePercent, minNet: body.minNet, maxSent: body.maxSent })
      const list: Session[] = body.sessions ?? []
      for (const s of list) {
        if (seen.current.get(s.id) === "pending" && s.status === "claimed") creditedRef.current(s.netAmount)
        seen.current.set(s.id, s.status)
      }
      setSessions(list)
    } catch {
      /* transient network error; next poll retries */
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
    if (!hasPending) {
      pollStart.current = null
      return
    }
    if (pollStart.current === null) pollStart.current = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const slow = Date.now() - (pollStart.current ?? Date.now()) > BACKOFF_AFTER_MS
      timer = setTimeout(async () => {
        if (!document.hidden) await load()
        tick()
      }, slow ? SLOW_MS : FAST_MS)
    }
    const onVisible = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener("visibilitychange", onVisible)
    tick()
    return () => {
      clearTimeout(timer)
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

  if (!info) return <div className="h-40 animate-pulse rounded-2xl bg-muted" />

  const disabled = busy || !valid || !mtn || view.generateDisabled

  return (
    <div className="space-y-4">
      <HowItWorks defaultOpen={view.guideOpenByDefault} />
      <div className="space-y-4 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
        <div className="space-y-3 self-start rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
          <label htmlFor="momo-amount" className="text-sm font-bold text-foreground">Amount you will send (GHS)</label>
          <Input
            id="momo-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="rounded-xl"
          />
          {preview && (
            <p className="text-sm font-medium text-foreground">
              Fee: GHS {preview.fee.toFixed(2)} · You get: GHS {preview.net.toFixed(2)}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Minimum GHS {info.minNet} credited · Maximum GHS {info.maxSent} per payment
          </p>
          {!mtn && <p className="text-sm text-destructive">Payment number not set — contact support</p>}
          {error && (
            <p className="text-sm text-destructive">
              {error}{" "}
              {needsVerify && (
                <Link href="/dashboard" className="font-semibold underline">Verify now</Link>
              )}
            </p>
          )}
          {view.generateDisabled && view.nextSlotFreeAt && (
            <p className="text-sm text-muted-foreground">
              You have 5 open payments. A new one unlocks when one expires or is credited. Next slot in{" "}
              <span className="font-mono tabular-nums">{formatCountdown(view.nextSlotFreeAt, nowMs)}</span>
            </p>
          )}
          <Button onClick={generate} disabled={disabled} className="w-full rounded-2xl bg-[#1b388b] text-white hover:bg-[#1b388b]/90">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Get payment code
          </Button>
        </div>
        <div className="space-y-3">
          <p className="text-sm font-bold text-foreground">Open payments ({view.boxes.length})</p>
          {view.boxes.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              No open payments. Get a code to start.
            </p>
          ) : (
            view.boxes.map((s) => (
              <ClaimBox key={s.id} session={s} nowMs={nowMs} getToken={getToken} onDone={load} onCancel={cancel} />
            ))
          )}
        </div>
      </div>
      {modal && <PaymentModal data={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
