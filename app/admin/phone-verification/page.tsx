"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Upload, Download, CheckCircle, XCircle, Eye, Phone } from "lucide-react"

type Tab = "upload" | "history"
type VerifyState = "idle" | "uploading" | "processing" | "completed" | "error"

interface Progress {
  sessionId: string
  fileName: string
  total: number
  verified: number
  invalid: number
  processed: number
}

interface VerificationResult {
  id: number
  phone_number: string
  account_name: string | null
  network: string
  status: "pending" | "verified" | "invalid"
}

interface SessionSummary {
  id: string
  file_name: string
  total_count: number
  verified_count: number
  invalid_count: number
  status: string
  created_at: string
  completed_at: string | null
}

interface ResultsPage {
  session: SessionSummary
  results: VerificationResult[]
  total: number
  page: number
  pages: number
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function PhoneVerificationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<Tab>("upload")
  const [verifyState, setVerifyState] = useState<VerifyState>("idle")
  const [progress, setProgress] = useState<Progress | null>(null)
  const [resultsPage, setResultsPage] = useState<ResultsPage | null>(null)
  const [resultFilter, setResultFilter] = useState<"all" | "verified" | "invalid">("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading && activeTab === "history") loadSessions()
  }, [isAdmin, adminLoading, activeTab])

  const loadSessions = async () => {
    setHistoryLoading(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/phone-verify/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json()
      setSessions(Array.isArray(data) ? data : [])
    } catch {
      toast.error("Failed to load session history")
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadResults = useCallback(async (
    sessionId: string,
    filter: "all" | "verified" | "invalid" = "all",
    page = 1
  ) => {
    try {
      const token = await getToken()
      const res = await fetch(
        `/api/admin/phone-verify/session/${sessionId}?status=${filter}&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      setResultsPage(data)
    } catch {
      toast.error("Failed to load results")
    }
  }, [])

  const handleFileSelect = useCallback(async (file: File) => {
    setVerifyState("uploading")
    setProgress(null)
    setResultsPage(null)

    try {
      const token = await getToken()
      const formData = new FormData()
      formData.append("file", file)

      const uploadRes = await fetch("/api/admin/phone-verify/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.error ?? "Upload failed")

      const { sessionId, total } = uploadData
      setProgress({ sessionId, fileName: file.name, total, verified: 0, invalid: 0, processed: 0 })
      setVerifyState("processing")

      let remaining = total
      while (remaining > 0) {
        const processRes = await fetch("/api/admin/phone-verify/process", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        })
        const processData = await processRes.json()
        if (!processRes.ok) throw new Error(processData.error ?? "Processing failed")

        remaining = processData.remaining
        setProgress(prev => prev ? {
          ...prev,
          verified: processData.verified,
          invalid: processData.invalid,
          processed: processData.verified + processData.invalid,
        } : prev)

        if (processData.status === "completed") break
        await new Promise(r => setTimeout(r, 300))
      }

      setVerifyState("completed")
      await loadResults(sessionId, "all", 1)
      toast.success("Verification complete!")
    } catch (error: any) {
      setVerifyState("error")
      toast.error(error.message ?? "Verification failed")
    }
  }, [loadResults])

  const handleFilterChange = (filter: "all" | "verified" | "invalid") => {
    setResultFilter(filter)
    setCurrentPage(1)
    if (progress?.sessionId) loadResults(progress.sessionId, filter, 1)
  }

  const handlePageChange = (page: number) => {
    setCurrentPage(page)
    if (progress?.sessionId) loadResults(progress.sessionId, resultFilter, page)
  }

  const handleViewSession = async (session: SessionSummary) => {
    setActiveTab("upload")
    setVerifyState("completed")
    setProgress({
      sessionId: session.id,
      fileName: session.file_name,
      total: session.total_count,
      verified: session.verified_count,
      invalid: session.invalid_count,
      processed: session.verified_count + session.invalid_count,
    })
    setResultFilter("all")
    setCurrentPage(1)
    await loadResults(session.id, "all", 1)
  }

  const downloadExport = async (sessionId: string) => {
    try {
      const token = await getToken()
      const res = await fetch(`/api/admin/phone-verify/session/${sessionId}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) { toast.error("Export failed"); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `verification-${sessionId.slice(0, 8)}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("Export failed")
    }
  }

  const downloadTemplate = () => {
    const blob = new Blob(["phone_number\n0551234567\n0241234567\n0207654321"], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "phone-verification-template.csv"
    a.click()
    URL.revokeObjectURL(url)
  }

  if (adminLoading) return null

  const progressPct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Phone className="w-6 h-6" /> Phone Number Verification
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Bulk-verify Ghana MoMo numbers against Moolre. Numbers with a returned account name are saved as verified.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border">
          {(["upload", "history"] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab === "upload" ? "📤 Upload & Verify" : "🕓 Session History"}
            </button>
          ))}
        </div>

        {/* Tab 1: Upload & Verify */}
        {activeTab === "upload" && (
          <div className="space-y-4">
            {(verifyState === "idle" || verifyState === "error") && (
              <Card>
                <CardContent className="pt-6">
                  <div
                    onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f) }}
                    onDragOver={e => e.preventDefault()}
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:border-primary transition-colors"
                  >
                    <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                    <p className="text-sm font-medium mb-1">
                      Drag & drop your file here, or <span className="text-primary underline">browse</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Accepts .csv or .xlsx · Max 50 MB · One phone number per row (first column)
                    </p>
                    <Button
                      variant="outline" size="sm" className="mt-4"
                      onClick={e => { e.stopPropagation(); downloadTemplate() }}
                    >
                      <Download className="w-4 h-4 mr-2" /> Download Template
                    </Button>
                  </div>
                  <input
                    ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); e.target.value = "" }}
                  />
                </CardContent>
              </Card>
            )}

            {verifyState === "uploading" && (
              <Card>
                <CardContent className="pt-6 text-center">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-primary" />
                  <p className="text-sm text-muted-foreground">Uploading and parsing file...</p>
                </CardContent>
              </Card>
            )}

            {(verifyState === "processing" || verifyState === "completed") && progress && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    {verifyState === "processing"
                      ? <Loader2 className="w-4 h-4 animate-spin text-primary" />
                      : <CheckCircle className="w-4 h-4 text-green-500" />}
                    {progress.fileName}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>
                        {verifyState === "processing"
                          ? `Verifying... ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
                          : "Verification complete"}
                      </span>
                      <span>{progressPct}%</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-300"
                        style={{ width: `${progressPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-green-600 dark:text-green-400">{progress.verified.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Verified</div>
                    </div>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-red-600 dark:text-red-400">{progress.invalid.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Invalid</div>
                    </div>
                    <div className="bg-muted rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold">{progress.total.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                  </div>

                  {verifyState === "completed" && (
                    <div className="flex gap-2 flex-wrap">
                      <Button onClick={() => downloadExport(progress.sessionId)} className="gap-2">
                        <Download className="w-4 h-4" /> Export .xlsx
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setVerifyState("idle"); setProgress(null); setResultsPage(null) }}
                      >
                        Upload Another File
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {verifyState === "completed" && resultsPage && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <CardTitle className="text-sm">Results</CardTitle>
                    <div className="flex gap-2 flex-wrap">
                      {(["all", "verified", "invalid"] as const).map(f => (
                        <Button
                          key={f} size="sm"
                          variant={resultFilter === f ? "default" : "outline"}
                          onClick={() => handleFilterChange(f)}
                        >
                          {f === "all" && `All (${resultsPage.session.total_count.toLocaleString()})`}
                          {f === "verified" && `✓ Verified (${resultsPage.session.verified_count.toLocaleString()})`}
                          {f === "invalid" && `✗ Invalid (${resultsPage.session.invalid_count.toLocaleString()})`}
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="pb-2 pr-4">#</th>
                          <th className="pb-2 pr-4">Phone</th>
                          <th className="pb-2 pr-4">Account Name</th>
                          <th className="pb-2 pr-4">Network</th>
                          <th className="pb-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultsPage.results.map((row, i) => (
                          <tr key={row.id} className="border-b last:border-0">
                            <td className="py-2 pr-4 text-muted-foreground">{(resultsPage.page - 1) * 100 + i + 1}</td>
                            <td className="py-2 pr-4 font-mono">{row.phone_number}</td>
                            <td className="py-2 pr-4">{row.account_name ?? "—"}</td>
                            <td className="py-2 pr-4"><Badge variant="outline">{row.network}</Badge></td>
                            <td className="py-2">
                              {row.status === "verified" ? (
                                <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                                  <CheckCircle className="w-3 h-3 mr-1" /> Verified
                                </Badge>
                              ) : (
                                <Badge className="bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20">
                                  <XCircle className="w-3 h-3 mr-1" /> Invalid
                                </Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {resultsPage.pages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <span className="text-xs text-muted-foreground">
                        Page {resultsPage.page} of {resultsPage.pages} ({resultsPage.total.toLocaleString()} results)
                      </span>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => handlePageChange(currentPage - 1)}>
                          Previous
                        </Button>
                        <Button variant="outline" size="sm" disabled={currentPage >= resultsPage.pages} onClick={() => handlePageChange(currentPage + 1)}>
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Tab 2: Session History */}
        {activeTab === "history" && (
          <Card>
            <CardHeader><CardTitle>Past Verification Sessions</CardTitle></CardHeader>
            <CardContent>
              {historyLoading ? (
                <div className="text-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" />
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-8">No sessions yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4">Date</th>
                        <th className="pb-2 pr-4">File</th>
                        <th className="pb-2 pr-4 text-center">Total</th>
                        <th className="pb-2 pr-4 text-center">Verified</th>
                        <th className="pb-2 pr-4 text-center">Invalid</th>
                        <th className="pb-2 pr-4 text-center">Status</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map(session => (
                        <tr key={session.id} className="border-b last:border-0">
                          <td className="py-2 pr-4 text-muted-foreground text-xs">{new Date(session.created_at).toLocaleString()}</td>
                          <td className="py-2 pr-4 max-w-[180px] truncate">{session.file_name}</td>
                          <td className="py-2 pr-4 text-center">{session.total_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-green-600 dark:text-green-400 font-medium">{session.verified_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-red-600 dark:text-red-400">{session.invalid_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center">
                            <Badge variant={session.status === "completed" ? "default" : "secondary"}>{session.status}</Badge>
                          </td>
                          <td className="py-2">
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => handleViewSession(session)}>
                                <Eye className="w-4 h-4 mr-1" /> View
                              </Button>
                              {session.status === "completed" && (
                                <Button variant="ghost" size="sm" onClick={() => downloadExport(session.id)}>
                                  <Download className="w-4 h-4 mr-1" /> xlsx
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
        )}
      </div>
    </DashboardLayout>
  )
}
