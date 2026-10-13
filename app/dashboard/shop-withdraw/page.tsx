"use client"

import { useEffect, useMemo, useState } from "react"
import { useAuth } from "@/lib/auth-context"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { DashboardHeroBanner } from "@/components/shared/dashboard-hero-banner"
import { shopService, shopProfitService, withdrawalService } from "@/lib/shop-service"
import { supabase } from "@/lib/supabase"
import {
  Banknote, RefreshCw, Wallet, ShieldCheck, Info, CreditCard,
  Landmark, CheckCircle2, Loader2, PencilLine,
} from "lucide-react"
import { toast } from "sonner"

type Method = "mobile_money" | "bank_transfer"
type Network = "MTN" | "Telecel" | "AT"

const NETWORKS: Network[] = ["MTN", "Telecel", "AT"]

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-600",
  processing: "bg-[#1b388b]/10 text-[#1b388b]",
  approved: "bg-[#1b388b]/10 text-[#1b388b]",
  completed: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
  failed: "bg-destructive/10 text-destructive",
}

export default function ShopWithdrawPage() {
  const { user } = useAuth()
  const [shop, setShop] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const [balance, setBalance] = useState<{ available_balance: number; total_profit: number; withdrawn_profit: number } | null>(null)
  const [withdrawals, setWithdrawals] = useState<any[]>([])

  const [feePercentage, setFeePercentage] = useState(0)
  const [feeMinimum, setFeeMinimum] = useState(0)
  const [minWithdrawal, setMinWithdrawal] = useState(5)

  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<Method>("mobile_money")

  // Mobile money
  const [network, setNetwork] = useState<Network>("MTN")
  const [phone, setPhone] = useState("")

  // Bank
  const [banks, setBanks] = useState<{ name: string; sublistid: string }[]>([])
  const [loadingBanks, setLoadingBanks] = useState(false)
  const [bankSublistId, setBankSublistId] = useState("")
  const [accountNumber, setAccountNumber] = useState("")

  // Shared verification state
  const [accountName, setAccountName] = useState("")
  const [verified, setVerified] = useState(false)
  const [manualEntry, setManualEntry] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState("")

  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!user) return
    loadData()
  }, [user])

  const loadData = async () => {
    try {
      setLoading(true)
      if (!user?.id) return
      const userShop = await shopService.getShop(user.id)
      setShop(userShop)
      if (!userShop) return

      const [balanceData, withdrawalList, feesRes] = await Promise.all([
        shopProfitService.getShopBalanceFromTable(userShop.id).catch(() => null),
        withdrawalService.getWithdrawalRequests(user.id).catch(() => []),
        fetch("/api/settings/fees").then((r) => r.json()).catch(() => ({})),
      ])

      setBalance(balanceData)
      setWithdrawals(withdrawalList || [])
      if (feesRes.withdrawal_fee_percentage !== undefined) setFeePercentage(feesRes.withdrawal_fee_percentage)
      if (feesRes.withdrawal_fee_minimum !== undefined) setFeeMinimum(feesRes.withdrawal_fee_minimum)
      if (feesRes.minimum_withdrawal_amount !== undefined) setMinWithdrawal(feesRes.minimum_withdrawal_amount)
    } catch (error) {
      console.error("Error loading withdraw page:", error)
      toast.error(error instanceof Error ? error.message : "Failed to load withdrawal data")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleRefresh = () => { setRefreshing(true); loadData() }

  const fetchBanks = async () => {
    if (banks.length > 0) return
    setLoadingBanks(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/user/withdrawals/banks", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      if (res.ok) setBanks(await res.json())
    } catch {
      toast.error("Failed to load bank list")
    } finally {
      setLoadingBanks(false)
    }
  }

  const resetVerification = () => {
    setAccountName("")
    setVerified(false)
    setManualEntry(false)
    setVerifyError("")
  }

  const handleMethodChange = (m: Method) => {
    setMethod(m)
    resetVerification()
    if (m === "bank_transfer") fetchBanks()
  }

  const handleVerifyMomo = async (phoneValue: string, networkValue: Network) => {
    if (!phoneValue) return
    setVerifying(true)
    setVerifyError("")
    setAccountName("")
    setVerified(false)
    setManualEntry(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/user/withdrawals/validate-account", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ phone: phoneValue, network: networkValue }),
      })
      const data = await res.json()
      if (res.ok && data.accountName) {
        setAccountName(data.accountName)
        setVerified(true)
      } else {
        setVerifyError(data.error || "Could not verify account. Check the phone number and network.")
      }
    } catch {
      setVerifyError("Verification failed. Please try again.")
    } finally {
      setVerifying(false)
    }
  }

  const handleVerifyBank = async () => {
    if (!accountNumber || !bankSublistId) {
      toast.error("Select a bank and enter the account number")
      return
    }
    setVerifying(true)
    setVerifyError("")
    setAccountName("")
    setVerified(false)
    setManualEntry(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/user/withdrawals/validate-account", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ network: "BANK", accountNumber, sublistid: bankSublistId }),
      })
      const data = await res.json()
      if (res.ok && data.accountName) {
        setAccountName(data.accountName)
        setVerified(true)
      } else {
        setVerifyError(data.error || "Could not verify bank account. Check the account number and bank.")
      }
    } catch {
      setVerifyError("Verification failed. Please try again.")
    } finally {
      setVerifying(false)
    }
  }

  const requestedAmount = parseFloat(amount) || 0
  const percentageFee = Math.round(requestedAmount * (feePercentage / 100) * 100) / 100
  const fee = Math.max(percentageFee, feeMinimum)
  const feeExceedsAmount = requestedAmount > 0 && fee >= requestedAmount
  const youReceive = requestedAmount > 0 && !feeExceedsAmount ? requestedAmount - fee : 0

  const pendingWithdrawal = useMemo(
    () => withdrawals.find((w) => w.status === "pending" || w.status === "processing"),
    [withdrawals]
  )

  const canSubmit =
    requestedAmount >= minWithdrawal &&
    !feeExceedsAmount &&
    !pendingWithdrawal &&
    accountName.trim().length > 0 &&
    (method === "mobile_money" ? phone.length > 0 : bankSublistId.length > 0 && accountNumber.length > 0)

  const handleSubmit = async () => {
    if (!shop?.id || !user?.id) return
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const account_details: Record<string, any> =
        method === "mobile_money"
          ? { phone, network, account_name: accountName, name_verified: verified && !manualEntry }
          : {
              bank_name: banks.find((b) => b.sublistid === bankSublistId)?.name || "",
              sublistid: bankSublistId,
              account_number: accountNumber,
              account_name: accountName,
              name_verified: verified && !manualEntry,
            }

      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch("/api/user/withdrawals/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ shopId: shop.id, amount: requestedAmount, withdrawal_method: method, account_details }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result?.error || "Failed to create withdrawal request")

      toast.success("Withdrawal request submitted successfully")
      setAmount("")
      setPhone("")
      setAccountNumber("")
      setBankSublistId("")
      resetVerification()
      loadData()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create withdrawal request")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <RefreshCw className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-3xl space-y-5">
        <DashboardHeroBanner backHref="/dashboard/my-shop" title="Withdraw Earnings" subtitle="Payout from your shop wallet to mobile money or bank." icon={Banknote}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-sm font-semibold text-white hover:bg-white/20"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </DashboardHeroBanner>

        {/* Balance hero */}
        <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-white/80"><Wallet className="h-3.5 w-3.5" /> Available Balance</p>
          <p className="mt-1 text-3xl font-black">GH₵{(balance?.available_balance || 0).toFixed(2)}</p>
          <div className="mt-2 flex gap-4 text-xs text-white/80">
            <span>Earned: GH₵{(balance?.total_profit || 0).toFixed(2)}</span>
            <span>Withdrawn: GH₵{(balance?.withdrawn_profit || 0).toFixed(2)}</span>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-4 text-sm text-foreground">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#1b388b]" />
          <p><span className="font-semibold">Processing times:</span> Payouts are processed on business days. Weekend and holiday requests are handled the next business day.</p>
        </div>

        {pendingWithdrawal && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700">
            You have a {pendingWithdrawal.status === "processing" ? "withdrawal being transferred" : "pending withdrawal request"} for GH₵{Number(pendingWithdrawal.amount || 0).toFixed(2)}. Please wait for it to complete before requesting another.
          </div>
        )}

        {/* New withdrawal request */}
        <div className="space-y-5 rounded-2xl border border-white/60 dark:border-white/5 bg-card p-5 clay">
          <h2 className="text-base font-bold text-foreground">New Withdrawal Request</h2>

          {/* Step 1: amount */}
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-[#1b388b] text-[11px] font-bold text-white">1</span>
              Enter Withdrawal Amount (GHS)
            </p>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`Min: GH₵${minWithdrawal.toFixed(2)}`}
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-base font-semibold text-foreground focus:border-[#1b388b] focus:outline-none"
            />
            <p className="text-xs text-muted-foreground">Available: GH₵{(balance?.available_balance || 0).toFixed(2)} · Minimum: GH₵{minWithdrawal.toFixed(2)}</p>
          </div>

          {/* Payout breakdown */}
          {requestedAmount > 0 && (
            <div className="space-y-2 rounded-2xl border border-dashed border-success/30 bg-success/5 p-4">
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-success"><ShieldCheck className="h-3.5 w-3.5" /> Payout Breakdown</p>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Withdrawal Amount</span>
                <span className="font-semibold text-foreground">GHS {requestedAmount.toFixed(2)}</span>
              </div>
              {feeExceedsAmount ? (
                <p className="text-xs text-destructive">Withdrawal fee configuration issue — the fee would exceed this amount. Please contact support or try a larger amount.</p>
              ) : (
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 text-destructive">
                    Processing Fee
                    {feePercentage > 0 && <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold">{feePercentage}%{feeMinimum > 0 ? ", min GH₵" + feeMinimum.toFixed(2) : ""}</span>}
                  </span>
                  <span className="font-semibold text-destructive">-GHS {fee.toFixed(2)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-success/20 pt-2 text-sm">
                <div>
                  <p className="font-bold text-foreground">You Receive</p>
                  <p className="text-[10px] text-muted-foreground">Sent directly to your account</p>
                </div>
                <span className="text-xl font-black text-success">GHS {youReceive.toFixed(2)}</span>
              </div>
            </div>
          )}

          {/* Step 2: method type */}
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-[#1b388b] text-[11px] font-bold text-white">2</span>
              Payment Method Type
            </p>
            <div className="inline-flex w-full gap-1 rounded-2xl bg-muted p-1">
              <button
                onClick={() => handleMethodChange("mobile_money")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold transition ${method === "mobile_money" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <CreditCard className="h-4 w-4" /> Mobile Money
              </button>
              <button
                onClick={() => handleMethodChange("bank_transfer")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold transition ${method === "bank_transfer" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                <Landmark className="h-4 w-4" /> Bank Transfer
              </button>
            </div>
          </div>

          {/* Step 3: account details */}
          <div className="space-y-3 rounded-2xl border border-dashed border-border p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-[#1b388b] text-[11px] font-bold text-white">3</span>
              {method === "mobile_money" ? "Mobile Money Account" : "Bank Account"}
            </p>

            {method === "mobile_money" ? (
              <>
                <div>
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">Mobile Money Network</label>
                  <select
                    value={network}
                    onChange={(e) => {
                      const n = e.target.value as Network
                      setNetwork(n)
                      resetVerification()
                      if (phone) handleVerifyMomo(phone, n)
                    }}
                    className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                  >
                    {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">MoMo Number</label>
                  <div className="flex gap-2">
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => { setPhone(e.target.value); resetVerification() }}
                      placeholder="0244123456"
                      className="flex-1 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                    />
                    <button
                      onClick={() => handleVerifyMomo(phone, network)}
                      disabled={!phone || verifying}
                      className="flex-shrink-0 rounded-xl bg-[#1b388b] px-4 text-sm font-bold text-white disabled:opacity-50"
                    >
                      {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">Bank</label>
                  {loadingBanks ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading banks...</p>
                  ) : (
                    <select
                      value={bankSublistId}
                      onChange={(e) => { setBankSublistId(e.target.value); resetVerification() }}
                      className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                    >
                      <option value="">Select a bank...</option>
                      {banks.map((b) => <option key={b.sublistid} value={b.sublistid}>{b.name}</option>)}
                    </select>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-muted-foreground">Account Number</label>
                  <div className="flex gap-2">
                    <input
                      value={accountNumber}
                      onChange={(e) => { setAccountNumber(e.target.value); resetVerification() }}
                      placeholder="Account number"
                      className="flex-1 rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                    />
                    <button
                      onClick={handleVerifyBank}
                      disabled={!accountNumber || !bankSublistId || verifying}
                      className="flex-shrink-0 rounded-xl bg-[#1b388b] px-4 text-sm font-bold text-white disabled:opacity-50"
                    >
                      {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Verify"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Account holder name / verification result */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Account Holder Name</label>
                {!verified && verifyError && !manualEntry && (
                  <button
                    onClick={() => { setManualEntry(true); setVerifyError("") }}
                    className="rounded-full bg-success/10 px-3 py-1 text-[11px] font-bold text-success"
                  >
                    Verify Manually
                  </button>
                )}
              </div>
              {manualEntry ? (
                <input
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="Type the account holder's name"
                  className="w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground focus:border-[#1b388b] focus:outline-none"
                />
              ) : (
                <div className="rounded-xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                  {verified && accountName ? (
                    <span className="flex items-center gap-1.5 font-semibold text-success"><CheckCircle2 className="h-3.5 w-3.5" /> {accountName}</span>
                  ) : (
                    "Enter details above to verify name"
                  )}
                </div>
              )}
              {verifyError && !manualEntry && <p className="mt-1 text-xs text-destructive">{verifyError}</p>}
              {manualEntry && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-600"><PencilLine className="h-3 w-3" /> Manually entered — admin will review before paying out.</p>
              )}
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-700">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <p>Account name must be verified via Moolre. If verification keeps failing, you can enter the name manually — admin will review before paying out.</p>
          </div>

          <div className="flex items-start gap-2 rounded-2xl border border-[#1b388b]/20 bg-[#1b388b]/5 p-3 text-xs text-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[#1b388b]" />
            <p><span className="font-semibold">Note:</span> Withdrawals requested during weekends, public holidays, or outside standard working hours may experience slight processing delays. For the fastest payout, submit requests during regular business hours.</p>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1b388b] py-3.5 text-sm font-bold text-white disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
            {accountName ? "Submit Withdrawal Request" : "Verify Account to Continue"}
          </button>
        </div>

        {/* Withdrawal history */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">Withdrawal History</h2>
          </div>

          {withdrawals.length === 0 ? (
            <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-8 text-center clay">
              <Banknote className="mx-auto mb-2 h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No withdrawals yet.</p>
            </div>
          ) : (
            <>
              {/* Mobile: stacked cards */}
              <div className="space-y-2 lg:hidden">
                {withdrawals.map((w) => (
                  <div key={w.id} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-bold text-foreground">GH₵{Number(w.amount || 0).toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground">{new Date(w.created_at).toLocaleDateString()}</p>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${STATUS_STYLES[w.status] || "bg-muted text-muted-foreground"}`}>{w.status}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{w.account_details?.account_name || "—"} · {w.account_details?.network || w.account_details?.bank_name || "—"}</span>
                      <span>Payout GH₵{Number(w.net_amount ?? w.amount).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden overflow-hidden rounded-2xl border border-border lg:block">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">Date</th>
                      <th className="px-4 py-3 text-left font-semibold">Requested</th>
                      <th className="px-4 py-3 text-left font-semibold">Fee</th>
                      <th className="px-4 py-3 text-left font-semibold">Payout</th>
                      <th className="px-4 py-3 text-left font-semibold">Account</th>
                      <th className="px-4 py-3 text-left font-semibold">Network</th>
                      <th className="px-4 py-3 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {withdrawals.map((w) => (
                      <tr key={w.id}>
                        <td className="px-4 py-3 text-muted-foreground">{new Date(w.created_at).toLocaleDateString()}</td>
                        <td className="px-4 py-3 font-semibold text-foreground">GH₵{Number(w.amount || 0).toFixed(2)}</td>
                        <td className="px-4 py-3 text-destructive">-GH₵{Number(w.fee_amount ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-3 font-semibold text-success">GH₵{Number(w.net_amount ?? w.amount).toFixed(2)}</td>
                        <td className="px-4 py-3 text-foreground">{w.account_details?.account_name || "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{w.account_details?.network || w.account_details?.bank_name || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${STATUS_STYLES[w.status] || "bg-muted text-muted-foreground"}`}>{w.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
