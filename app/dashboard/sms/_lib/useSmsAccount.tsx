"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { supabase } from "@/lib/supabase"
import { shopService, shopProfitService } from "@/lib/shop-service"
import { smsFetch, type SmsAccount, type SmsHome, type SmsLimits, type SmsMode, type SmsStats, type LedgerEntry } from "./api"

export interface SmsAccountState {
  account: SmsAccount | null
  mode: SmsMode | null
  limits: SmsLimits | null
  stats: SmsStats | null
  recentLedger: LedgerEntry[] | null
  /** Kill-switch state; defaults to true until /api/sms/home says otherwise. */
  featureEnabled: boolean
  /** Platform default sender name (null until /api/sms/home has loaded once). */
  platformSender: string | null
  /** The sender a send uses when none is picked (null = platform default or not loaded). */
  defaultSender: string | null
  /** Shared pool sender names for business-mode accounts. */
  senderPool: string[]
  walletBalance: number
  profitBalance: number
  loading: boolean
  /** True only for a network failure or an unparseable response (not for a clean 403). */
  error: boolean
  /** A clean 403: this profile has no entitlement to an SMS account (by design). */
  notEntitled: boolean
  reload: () => Promise<void>
}

const Ctx = createContext<SmsAccountState | null>(null)

export function SmsAccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<SmsAccount | null>(null)
  const [home, setHome] = useState<SmsHome | null>(null)
  const [walletBalance, setWalletBalance] = useState(0)
  const [profitBalance, setProfitBalance] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [notEntitled, setNotEntitled] = useState(false)
  const alive = useRef(true)
  const seq = useRef(0)

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Informational wallet cards. A shop is optional (e.g. sub-agent accounts), so both fetches are best-effort.
  const loadWallets = useCallback(async (mine: number) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const [userShop, walletRes] = await Promise.all([
        shopService.getShop(uid).catch(() => null),
        session?.access_token
          ? fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${session.access_token}` } })
              .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          : null,
      ])
      if (!alive.current || mine !== seq.current) return
      if (walletRes) setWalletBalance(walletRes.balance || 0)
      if (userShop?.id) {
        const bal = await shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null)
        if (alive.current && mine === seq.current) setProfitBalance(bal?.available_balance || 0)
      }
    } catch { /* non-fatal: cards just show 0 */ }
  }, [])

  const reload = useCallback(async () => {
    const mine = ++seq.current
    try {
      void loadWallets(mine) // best-effort; never blocks the skeleton
      const [acc, hm] = await Promise.all([
        smsFetch<{ account?: SmsAccount }>("/api/sms/account"),
        smsFetch<SmsHome>("/api/sms/home"),
      ])
      if (!alive.current || mine !== seq.current) return
      const a = acc.ok ? (acc.body.account as SmsAccount | undefined) ?? null : null
      if (a) {
        setAccount(a); setNotEntitled(false); setError(false)
      } else if (acc.status === 403) {
        // Definitive: no entitlement. Clear everything.
        setAccount(null); setHome(null); setNotEntitled(true); setError(false)
      } else {
        // Transient failure: keep the last good account/home so mounted pages survive.
        setError(true)
      }
      // Keep the previous home if this refresh of it failed.
      if (hm.ok) setHome(hm.data)
    } catch {
      if (alive.current && mine === seq.current) setError(true)
    } finally {
      if (alive.current && mine === seq.current) setLoading(false)
    }
  }, [loadWallets])

  useEffect(() => { void reload() }, [reload])

  const value = useMemo<SmsAccountState>(() => ({
    account,
    mode: home?.mode ?? null,
    limits: home?.limits ?? null,
    stats: home?.stats ?? null,
    recentLedger: home?.recentLedger ?? null,
    featureEnabled: home?.featureEnabled ?? true,
    platformSender: home?.platformSender ?? null,
    defaultSender: home?.defaultSender ?? null,
    senderPool: home?.senderPool ?? [],
    walletBalance,
    profitBalance,
    loading,
    error,
    notEntitled,
    reload,
  }), [account, home, walletBalance, profitBalance, loading, error, notEntitled, reload])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSmsAccount(): SmsAccountState {
  const v = useContext(Ctx)
  if (!v) throw new Error("useSmsAccount must be used inside <SmsAccountProvider>")
  return v
}
