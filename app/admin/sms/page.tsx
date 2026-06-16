"use client"
import { useEffect, useState, useCallback } from "react"
import { supabase } from "@/lib/supabase"

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

export default function AdminSmsPage() {
  const [tab, setTab] = useState<Tab>("overview")
  const [bundles, setBundles] = useState<DashboardData["bundles"]>([])
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [accountId, setAccountId] = useState("")
  const [units, setUnits] = useState("")
  const [msg, setMsg] = useState("")
  const [loading, setLoading] = useState(false)

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

  useEffect(() => {
    // Legacy bundle load for the overview tab (fast path)
    token().then((t) =>
      fetch("/api/admin/sms/bundles", { headers: { Authorization: `Bearer ${t}` } })
        .then((r) => r.json())
        .then((d) => setBundles(d.bundles ?? []))
    )
    // Full dashboard for the moderation tab
    loadDashboard()
  }, [loadDashboard])

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
                                : "text-green-600 font-medium"
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
                                  ? "border-green-500 text-green-600 hover:bg-green-50"
                                  : "border-destructive text-destructive hover:bg-red-50"
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
  )
}
