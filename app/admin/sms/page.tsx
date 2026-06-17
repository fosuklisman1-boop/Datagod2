"use client"
import { useEffect, useState, useCallback } from "react"
import { supabase } from "@/lib/supabase"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

type Tab = "overview" | "moderation"

interface RevenueData {
  activations: number
  activationTotal: number
  bundleTotal: number
  creditsSold: number
}

interface FlaggedLog {
  id: string
  sms_account_id: string
  message: string
  recipients_count: number
  segments: number
  credits_used: number
  flag_reason: string | null
  created_at: string
}

interface AccountRow {
  id: string
  user_id: string
  owner_type: string
  unit_balance: number
  status: string
  amount_paid: number | null
}

interface DashboardData {
  settings: Record<string, unknown>
  bundles: { id: string; name: string; units: number; price_ghs: number; active: boolean }[]
  revenue: RevenueData
  flagged: FlaggedLog[]
  accounts: AccountRow[]
  suspendedAccountIds: string[]
}

interface Supply { wholesaleBalance: number; totalUsable: number; totalPending: number; headroom: number }
interface SenderIdRow {
  id: string; sender_id: string; local_status: string; moolre_status: string | null
  sms_account_id: string | null; last_polled_at: string | null
}

export default function AdminSmsPage() {
  const [tab, setTab] = useState<Tab>("overview")
  const [bundles, setBundles] = useState<DashboardData["bundles"]>([])
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [accountId, setAccountId] = useState("")
  const [units, setUnits] = useState("")
  const [msg, setMsg] = useState("")
  const [loading, setLoading] = useState(false)

  // SMS supply / pricing / sender-ID monitoring
  const [supply, setSupply] = useState<Supply | null>(null)
  const [senders, setSenders] = useState<SenderIdRow[]>([])
  const [priceFee, setPriceFee] = useState("")
  const [savingPrice, setSavingPrice] = useState(false)
  const [activationFee, setActivationFee] = useState("")
  const [savingActivation, setSavingActivation] = useState(false)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }

  const loadDashboard = useCallback(async () => {
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      headers: { Authorization: `Bearer ${t}` },
    }).then((r) => r.json())
    if (res.data) {
      setDashboard(res.data)
      setBundles(res.data.bundles ?? [])
    }
  }, [])

  const loadMonitoring = useCallback(async () => {
    const t = await token()
    const headers = { Authorization: `Bearer ${t}` }
    const [sup, snd] = await Promise.all([
      fetch("/api/admin/sms-supply", { headers }).then((r) => r.json()),
      fetch("/api/admin/sms-sender-ids", { headers }).then((r) => r.json()),
    ])
    if (sup.success) setSupply(sup.data)
    if (snd.success) setSenders(snd.data ?? [])
  }, [])

  useEffect(() => {
    // Legacy bundle load for the overview tab (fast path)
    token().then((t) =>
      fetch("/api/admin/sms/bundles", { headers: { Authorization: `Bearer ${t}` } })
        .then((r) => r.json())
        .then((d) => setBundles(d.bundles ?? []))
    )
    // Full dashboard for the moderation tab
    loadDashboard()
    loadMonitoring()
  }, [loadDashboard, loadMonitoring])

  // Seed the per-credit fee input from the saved setting once the dashboard loads.
  useEffect(() => {
    const pf = dashboard?.settings?.sms_price_per_credit as { amount?: number } | number | undefined
    const amount = typeof pf === "object" && pf !== null ? pf.amount : (typeof pf === "number" ? pf : undefined)
    if (amount !== undefined) setPriceFee(String(amount))
  }, [dashboard])

  // Seed the activation-fee input from the saved setting (0 is valid = free).
  useEffect(() => {
    const af = dashboard?.settings?.sms_activation_fee as { amount?: number } | number | undefined
    const amount = typeof af === "object" && af !== null ? af.amount : (typeof af === "number" ? af : undefined)
    if (amount !== undefined) setActivationFee(String(amount))
  }, [dashboard])

  async function savePrice() {
    const amount = Number(priceFee)
    if (!Number.isFinite(amount) || amount < 0) { setMsg("Enter a valid per-credit price."); return }
    setSavingPrice(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sms_price_per_credit: { amount } }),
    }).then((r) => r.json())
    setSavingPrice(false)
    if (res.success) { setMsg("Per-credit fee saved."); await loadDashboard() }
    else setMsg(`Error: ${res.error ?? "could not save"}`)
  }

  async function saveActivationFee() {
    const amount = Number(activationFee)
    if (!Number.isFinite(amount) || amount < 0) { setMsg("Enter a valid activation fee (0 = free)."); return }
    setSavingActivation(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sms_activation_fee: { amount } }),
    }).then((r) => r.json())
    setSavingActivation(false)
    if (res.success) { setMsg(amount === 0 ? "Activation fee saved (free activation)." : "Activation fee saved."); await loadDashboard() }
    else setMsg(`Error: ${res.error ?? "could not save"}`)
  }

  async function allocate() {
    const t = await token()
    const res = await fetch("/api/admin/sms/allocate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, units: Number(units) }),
    }).then((r) => r.json())
    setMsg(
      res.error
        ? `Error: ${res.error}`
        : res.pending
        ? "Allocated (pending — top up Moolre wholesale)"
        : `Credited ${res.unitsCredited} units`
    )
  }

  async function handleDismiss(logId: string) {
    setLoading(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss_flag", logId }),
    }).then((r) => r.json())
    if (res.error) alert(`Error: ${res.error}`)
    else await loadDashboard()
    setLoading(false)
  }

  async function handleSuspendToggle(acct: AccountRow) {
    const willSuspend = acct.status !== "suspended"
    const label = willSuspend ? "suspend" : "unsuspend"
    if (!confirm(`${label} account ${acct.id}?`)) return
    setLoading(true)
    const t = await token()
    const res = await fetch("/api/admin/shop-sms", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_suspended", accountId: acct.id, suspended: willSuspend }),
    }).then((r) => r.json())
    if (res.error) alert(`Error: ${res.error}`)
    else await loadDashboard()
    setLoading(false)
  }

  const rev = dashboard?.revenue

  return (
    <DashboardLayout>
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">SMS Admin</h1>

      {/* Tab bar */}
      <div className="flex gap-2 border-b pb-1">
        {(["overview", "moderation"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-t text-sm font-medium capitalize ${
              tab === t
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Overview tab ── */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* SMS supply (live Moolre balance + solvency) */}
          <section className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">SMS supply</h2>
              <button onClick={loadMonitoring} className="rounded border px-2 py-1 text-xs hover:bg-muted">Refresh</button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "Moolre wholesale", value: supply?.wholesaleBalance },
                { label: "Usable credits", value: supply?.totalUsable },
                { label: "Pending credits", value: supply?.totalPending },
                { label: "Headroom", value: supply?.headroom },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-xl font-bold">{s.value === undefined ? "…" : s.value.toLocaleString()}</p>
                </div>
              ))}
            </div>
            {supply && supply.totalPending > 0 && (
              <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                {supply.totalPending.toLocaleString()} credit(s) pending.
                {(() => { const sf = Math.max(0, supply.totalUsable + supply.totalPending - supply.wholesaleBalance);
                  return sf > 0 ? ` Top up the Moolre SMS balance by ≥ ${sf.toLocaleString()} units to release them.` : " They’ll be released on the next cron run." })()}
              </p>
            )}
            {supply && supply.wholesaleBalance === 0 && (
              <p className="text-xs text-muted-foreground">A balance of 0 can also mean the Moolre API key isn’t set in this environment (the balance read fails closed to 0).</p>
            )}
          </section>

          {/* Per-credit fee (selling price) */}
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">Per-credit fee</h2>
            <p className="text-xs text-muted-foreground">The selling price per SMS credit (GHS). For reference, bundles work out to ~0.026–0.035/credit.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">GHS</span>
              <input value={priceFee} onChange={(e) => setPriceFee(e.target.value)} placeholder="0.035" inputMode="decimal"
                className="w-32 rounded border px-2 py-1" />
              <span className="text-sm text-muted-foreground">per credit</span>
              <button onClick={savePrice} disabled={savingPrice}
                className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
                {savingPrice ? "Saving…" : "Save"}
              </button>
            </div>
          </section>

          {/* Activation fee (one-time, charged when a tenant activates SMS) */}
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">Activation fee</h2>
            <p className="text-xs text-muted-foreground">The one-time fee (GHS) a tenant pays to activate SMS sending. Set to 0 for free activation.</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">GHS</span>
              <input value={activationFee} onChange={(e) => setActivationFee(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" inputMode="decimal"
                className="w-32 rounded border px-2 py-1" />
              <span className="text-sm text-muted-foreground">one-time</span>
              <button onClick={saveActivationFee} disabled={savingActivation}
                className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
                {savingActivation ? "Saving…" : "Save"}
              </button>
            </div>
          </section>

          {/* Sender ID status (all accounts) */}
          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">Sender IDs ({senders.length})</h2>
            {senders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sender IDs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-1.5 font-medium">Sender ID</th>
                      <th className="py-1.5 font-medium">Owner</th>
                      <th className="py-1.5 font-medium">Status</th>
                      <th className="py-1.5 font-medium">Moolre</th>
                    </tr>
                  </thead>
                  <tbody>
                    {senders.map((s) => (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="py-1.5 font-mono">{s.sender_id}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{s.sms_account_id ? "tenant" : "platform"}</td>
                        <td className="py-1.5">
                          <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                            s.local_status === "active" ? "bg-success/15 text-success"
                            : s.local_status === "rejected" ? "bg-destructive/15 text-destructive"
                            : "bg-warning/15 text-warning"}`}>{s.local_status}</span>
                        </td>
                        <td className="py-1.5 text-muted-foreground">{s.moolre_status ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-lg border p-4 space-y-3">
            <h2 className="font-semibold">Allocate units</h2>
            <input
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="sms_account id"
              className="w-full rounded border px-2 py-1"
            />
            <input
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              placeholder="units"
              className="w-full rounded border px-2 py-1"
            />
            <button
              onClick={allocate}
              className="rounded bg-primary px-3 py-2 text-primary-foreground"
            >
              Allocate
            </button>
            {msg && <div className="text-sm">{msg}</div>}
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">Bundles</h2>
            <ul className="text-sm space-y-1">
              {bundles.map((b) => (
                <li key={b.id}>
                  {b.name} — {Number(b.units).toLocaleString()} units — GHS{" "}
                  {Number(b.price_ghs).toFixed(2)} {b.active ? "" : "(inactive)"}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* ── Moderation tab ── */}
      {tab === "moderation" && (
        <div className="space-y-6">
          {/* Revenue card */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-3">Revenue Summary</h2>
            {rev ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Activations</dt>
                  <dd className="font-medium">{rev.activations}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Activation fees (GHS)</dt>
                  <dd className="font-medium">{rev.activationTotal.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Bundle revenue (GHS)</dt>
                  <dd className="font-medium">{rev.bundleTotal.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Credits sold</dt>
                  <dd className="font-medium">{rev.creditsSold.toLocaleString()}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">Loading...</p>
            )}
          </section>

          {/* Flagged messages */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">
              Flagged Messages ({dashboard?.flagged.length ?? 0})
            </h2>
            {!dashboard?.flagged.length ? (
              <p className="text-sm text-muted-foreground">No flagged messages.</p>
            ) : (
              <div className="space-y-2">
                {dashboard.flagged.map((log) => (
                  <div
                    key={log.id}
                    className="flex items-start justify-between gap-4 rounded border px-3 py-2 text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {log.sms_account_id}
                      </p>
                      <p className="mt-0.5">{log.message}</p>
                      <p className="text-xs text-destructive mt-0.5">{log.flag_reason}</p>
                      <p className="text-xs text-muted-foreground">
                        {log.recipients_count} recipient(s) · {log.segments} seg · {log.credits_used} credits
                      </p>
                    </div>
                    <button
                      disabled={loading}
                      onClick={() => handleDismiss(log.id)}
                      className="shrink-0 rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      Dismiss
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Accounts table */}
          <section className="rounded-lg border p-4">
            <h2 className="font-semibold mb-2">
              SMS Accounts ({dashboard?.accounts.length ?? 0})
            </h2>
            {!dashboard?.accounts.length ? (
              <p className="text-sm text-muted-foreground">No accounts yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-1 pr-4">Account ID</th>
                      <th className="pb-1 pr-4">Type</th>
                      <th className="pb-1 pr-4">Balance</th>
                      <th className="pb-1 pr-4">Status</th>
                      <th className="pb-1">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.accounts.map((acct) => (
                      <tr key={acct.id} className="border-b last:border-0">
                        <td className="py-1 pr-4 font-mono text-xs">{acct.id.slice(0, 8)}…</td>
                        <td className="py-1 pr-4">{acct.owner_type}</td>
                        <td className="py-1 pr-4">{acct.unit_balance.toLocaleString()}</td>
                        <td className="py-1 pr-4">
                          <span
                            className={
                              acct.status === "suspended"
                                ? "text-destructive font-medium"
                                : acct.status === "inactive"
                                ? "text-muted-foreground"
                                : "text-success font-medium"
                            }
                          >
                            {acct.status}
                          </span>
                        </td>
                        <td className="py-1">
                          {acct.status === "inactive" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <button
                              disabled={loading}
                              onClick={() => handleSuspendToggle(acct)}
                              className={`rounded border px-2 py-0.5 text-xs ${
                                acct.status === "suspended"
                                  ? "border-success/30 text-success hover:bg-success/10"
                                  : "border-destructive text-destructive hover:bg-destructive/10"
                              }`}
                            >
                              {acct.status === "suspended" ? "Unsuspend" : "Suspend"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
    </DashboardLayout>
  )
}
