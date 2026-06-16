"use client"
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

export default function SmsDashboardPage() {
  const [balance, setBalance] = useState<number | null>(null)
  const [pending, setPending] = useState(0)
  const [bundles, setBundles] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }
  async function load() {
    const t = await token()
    const acc = await fetch("/api/sms/account", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
    setBalance(acc.account?.unitBalance ?? 0)
    setPending(acc.account?.pendingUnits ?? 0)
    const bun = await fetch("/api/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
    setBundles(bun.bundles ?? [])
  }
  useEffect(() => { load() }, [])

  async function buy(bundleId: string) {
    setBusy(true)
    const t = await token()
    const res = await fetch("/api/sms/units/purchase-wallet", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    }).then((r) => r.json())
    setBusy(false)
    if (res.error) {
      alert(res.error)
    } else {
      if (res.pending) alert("Payment received — your units are pending until SMS supply is topped up.")
      await load()
    }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">SMS Units</h1>
      <div className="rounded-lg border p-4">
        <div className="text-sm text-muted-foreground">Balance</div>
        <div className="text-3xl font-bold">{balance ?? "…"} units</div>
        {pending > 0 && (
          <div className="mt-1 text-sm text-amber-600">{pending} units pending (awaiting SMS supply top-up)</div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {bundles.map((b) => (
          <div key={b.id} className="rounded-lg border p-4 space-y-2">
            <div className="font-semibold">{b.name}</div>
            <div className="text-sm">{Number(b.units).toLocaleString()} units · GHS {Number(b.price_ghs).toFixed(2)}</div>
            <button
              disabled={busy}
              onClick={() => buy(b.id)}
              className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
            >
              Buy with wallet
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
