"use client"
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

export default function AdminSmsPage() {
  const [bundles, setBundles] = useState<any[]>([])
  const [accountId, setAccountId] = useState("")
  const [units, setUnits] = useState("")
  const [msg, setMsg] = useState("")

  async function token() {
    const { data } = await supabase.auth.getSession()
    return data.session?.access_token ?? ""
  }
  async function load() {
    const t = await token()
    const res = await fetch("/api/admin/sms/bundles", { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())
    setBundles(res.bundles ?? [])
  }
  useEffect(() => { load() }, [])

  async function allocate() {
    const t = await token()
    const res = await fetch("/api/admin/sms/allocate", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, units: Number(units) }),
    }).then((r) => r.json())
    setMsg(res.error ? `Error: ${res.error}` : res.pending ? "Allocated (pending — top up Moolre wholesale)" : `Credited ${res.unitsCredited} units`)
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">SMS Admin</h1>
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">Allocate units</h2>
        <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="sms_account id" className="w-full rounded border px-2 py-1" />
        <input value={units} onChange={(e) => setUnits(e.target.value)} placeholder="units" className="w-full rounded border px-2 py-1" />
        <button onClick={allocate} className="rounded bg-primary px-3 py-2 text-primary-foreground">Allocate</button>
        {msg && <div className="text-sm">{msg}</div>}
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="font-semibold mb-2">Bundles</h2>
        <ul className="text-sm space-y-1">
          {bundles.map((b) => (
            <li key={b.id}>{b.name} — {Number(b.units).toLocaleString()} units — GHS {Number(b.price_ghs).toFixed(2)} {b.active ? "" : "(inactive)"}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}
