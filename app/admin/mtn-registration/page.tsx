"use client"

import { useCallback, useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Download, Loader2, CheckCircle2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { useAdminProtected } from "@/hooks/use-admin"

interface BatchRow {
  id: string
  batch_time: string
  number_count: number
  status: "submitted" | "registered"
  registered_at: string | null
  downloaded_by_email: string | null
}

interface ListPayload {
  counts: Record<string, number>
  batches: BatchRow[]
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const element = document.createElement("a")
  element.setAttribute("href", url)
  element.setAttribute("download", filename)
  element.style.display = "none"
  document.body.appendChild(element)
  element.click()
  document.body.removeChild(element)
  window.URL.revokeObjectURL(url)
}

export default function MtnRegistrationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [payload, setPayload] = useState<ListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/list", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error("Failed to load")
      setPayload(await res.json())
    } catch {
      toast.error("Failed to load MTN registration status")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin && !adminLoading) loadStatus()
  }, [isAdmin, adminLoading, loadStatus])

  const handleExport = async () => {
    setExporting(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/export", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Export failed")
      }
      const newCount = Number(res.headers.get("X-New-Count") || "0")
      if (newCount === 0) {
        toast.info("No new numbers to register — everything pending has already been submitted.")
        return
      }
      const blob = await res.blob()
      triggerBlobDownload(blob, `mtn-register-${new Date().toISOString().split("T")[0]}.xlsx`)
      toast.success(`Downloaded ${newCount} new number${newCount === 1 ? "" : "s"} for registration.`)
      await loadStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed")
    } finally {
      setExporting(false)
    }
  }

  const handleMarkRegistered = async (batchId: string) => {
    setMarkingId(batchId)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/mark-registered", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to mark registered")
      toast.success(`Marked ${data.numbersRegistered} numbers as registered.`)
      await loadStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to mark registered")
    } finally {
      setMarkingId(null)
    }
  }

  const handleRedownload = async (batchId: string, batchTime: string) => {
    setRedownloadingId(batchId)
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/mtn-registration/batch/${batchId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || "Re-download failed")
      }
      const blob = await res.blob()
      triggerBlobDownload(blob, `mtn-register-batch-${batchTime.split("T")[0]}.xlsx`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Re-download failed")
    } finally {
      setRedownloadingId(null)
    }
  }

  if (adminLoading) return null

  const counts = payload?.counts ?? {}

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">MTN Registration</h1>
            <p className="text-muted-foreground mt-1">
              Download new numbers to hand to the provider for MTN registration.
            </p>
          </div>
          <Button onClick={handleExport} disabled={exporting || loading}>
            {exporting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {exporting ? "Exporting…" : "Download new numbers"}
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            ["pending", "pending"],
            ["submitted", "submitted"],
            ["registered", "registered"],
            ["held_orders", "held orders"],
          ] as const).map(([key, label]) => (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : (counts[key] ?? 0).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Registration batches</CardTitle>
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </CardHeader>
          <CardContent>
            {(payload?.batches ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No batches yet. Click “Download new numbers” to create the first one.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-4">Date</th>
                      <th className="py-2 pr-4">Numbers</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">By</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(payload?.batches ?? []).map(b => (
                      <tr key={b.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {new Date(b.batch_time).toLocaleString()}
                        </td>
                        <td className="py-2 pr-4">{b.number_count.toLocaleString()}</td>
                        <td className="py-2 pr-4">
                          <Badge variant={b.status === "registered" ? "default" : "secondary"}>
                            {b.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-4">{b.downloaded_by_email ?? "—"}</td>
                        <td className="py-2">
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleRedownload(b.id, b.batch_time)}
                              disabled={redownloadingId === b.id}
                            >
                              {redownloadingId === b.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                            </Button>
                            {b.status === "submitted" && (
                              <Button
                                size="sm"
                                onClick={() => handleMarkRegistered(b.id)}
                                disabled={markingId === b.id}
                              >
                                {markingId === b.id ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4 mr-1" />
                                )}
                                Mark registered
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
