"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ArrowLeft, Loader2, Scale } from "lucide-react"

interface Debtor {
  userId: string
  email: string
  firstName: string | null
  role: string
  balance: number
  updatedAt: string
}

export default function AdminDebtorsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [loading, setLoading] = useState(true)
  const [debtors, setDebtors] = useState<Debtor[]>([])
  const [totalOwed, setTotalOwed] = useState(0)

  useEffect(() => {
    if (isAdmin && !adminLoading) loadDebtors()
  }, [isAdmin, adminLoading])

  const loadDebtors = async () => {
    try {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const res = await fetch("/api/admin/debtors", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to load debtors")
      setDebtors(data.debtors || [])
      setTotalOwed(data.totalOwed || 0)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load debtors")
    } finally {
      setLoading(false)
    }
  }

  if (adminLoading || loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin" />
        </div>
      </DashboardLayout>
    )
  }

  if (!isAdmin) return null

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-2xl lg:max-w-4xl space-y-5">
        <div className="flex items-center gap-2">
          <Link href="/admin" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground"><Scale className="h-5 w-5 text-[#1b388b]" /> Debtors</h1>
            <p className="text-sm text-muted-foreground">Users whose wallet balance is negative — the platform has already paid out more than they funded.</p>
          </div>
        </div>

        <div className="rounded-2xl bg-gradient-to-br from-[#1b388b] to-[#2a5ce8] p-5 text-white">
          <p className="text-sm text-white/70">Total Outstanding Debt</p>
          <p className="mt-1 text-3xl font-black">GH₵{totalOwed.toFixed(2)}</p>
          <p className="mt-2 text-xs text-white/70">{debtors.length} debtor{debtors.length === 1 ? "" : "s"}</p>
        </div>

        {debtors.length === 0 ? (
          <div className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-8 text-center clay">
            <Scale className="mx-auto mb-2 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No debtor accounts right now.</p>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-2 lg:hidden">
              {debtors.map((d) => (
                <div key={d.userId} className="rounded-2xl border border-white/60 dark:border-white/5 bg-card p-4 clay">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{d.firstName || d.email}</p>
                      <p className="truncate text-xs text-muted-foreground">{d.email} · {d.role}</p>
                    </div>
                    <p className="shrink-0 font-bold text-destructive">GH₵{Math.abs(d.balance).toFixed(2)}</p>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Since {new Date(d.updatedAt).toLocaleDateString()}</p>
                </div>
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden overflow-hidden rounded-2xl border border-border lg:block">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold">Name</th>
                    <th className="px-4 py-3 text-left font-semibold">Email</th>
                    <th className="px-4 py-3 text-left font-semibold">Role</th>
                    <th className="px-4 py-3 text-left font-semibold">Owed</th>
                    <th className="px-4 py-3 text-left font-semibold">Since</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {debtors.map((d) => (
                    <tr key={d.userId}>
                      <td className="px-4 py-3 font-medium text-foreground">{d.firstName || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{d.email}</td>
                      <td className="px-4 py-3 text-muted-foreground capitalize">{d.role}</td>
                      <td className="px-4 py-3 font-bold text-destructive">GH₵{Math.abs(d.balance).toFixed(2)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(d.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  )
}
