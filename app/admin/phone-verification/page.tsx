"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Upload, Download, CheckCircle, XCircle, Eye, Phone, ClipboardList, Copy, CircleMinus, ShieldCheck } from "lucide-react"

type Tab = "upload" | "history"
type VerifyState = "idle" | "uploading" | "processing" | "completed" | "error"
type InputMode = "file" | "text"
type CheckType = "moolre" | "mtn_whitelist"
type ResultFilter = "all" | "verified" | "invalid" | "duplicate" | "not_applicable"

const NORMAL_DELAY_MS = 200
const MAX_BACKOFF_MS = 120_000

const PROVIDER_LABELS: Record<string, string> = {
  xpress: "Xpress",
  codecraft: "CodeCraft",
  agentportalgh: "AgentPortalGH",
}

interface Progress {
  sessionId: string
  fileName: string
  checkType: CheckType
  whitelistProviders: string[]
  total: number
  verified: number
  invalid: number
  notApplicable: number
  duplicates: number
  processed: number
}

interface VerificationResult {
  id: number
  phone_number: string
  account_name: string | null
  whitelist_provider: string | null
  network: string
  status: "pending" | "verified" | "invalid" | "duplicate" | "not_applicable"
}

interface SessionSummary {
  id: string
  file_name: string
  check_type: CheckType
  whitelist_providers: string[] | null
  total_count: number
  verified_count: number
  invalid_count: number
  not_applicable_count: number
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

function duplicateCount(s: { total_count: number; verified_count: number; invalid_count: number; not_applicable_count: number }): number {
  return Math.max(0, s.total_count - s.verified_count - s.invalid_count - s.not_applicable_count)
}

async function getToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ?? ""
}

export default function PhoneVerificationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [activeTab, setActiveTab] = useState<Tab>("upload")
  const [verifyState, setVerifyState] = useState<VerifyState>("idle")
  const [checkType, setCheckType] = useState<CheckType>("moolre")
  const [whitelistAvailable, setWhitelistAvailable] = useState(true)
  const [availableProviders, setAvailableProviders] = useState<Array<{ name: string; configured: boolean }>>([])
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<Progress | null>(null)
  const [resultsPage, setResultsPage] = useState<ResultsPage | null>(null)
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>("file")
  const [pastedNumbers, setPastedNumbers] = useState("")
  const [rateLimitWarning, setRateLimitWarning] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isAdmin && !adminLoading) {
      (async () => {
        try {
          const token = await getToken()
          const res = await fetch("/api/admin/phone-verify/whitelist-availability", {
            headers: { Authorization: `Bearer ${token}` },
          })
          const data = await res.json()
          setWhitelistAvailable(data.available !== false)
          const providers: Array<{ name: string; configured: boolean }> = Array.isArray(data.providers) ? data.providers : []
          setAvailableProviders(providers)
          setSelectedProviders(new Set(providers.filter(p => p.configured).map(p => p.name)))
        } catch {
          // Leave the defaults (whitelist enabled, no providers known yet) —
          // a real check happens server-side on upload too.
        }
      })()
    }
  }, [isAdmin, adminLoading])

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
    filter: ResultFilter = "all",
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

  const toggleProvider = (name: string) => {
    setSelectedProviders(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleFileSelect = useCallback(async (file: File) => {
    if (checkType === "mtn_whitelist" && selectedProviders.size === 0) {
      toast.error("Select at least one provider to check against")
      return
    }

    setVerifyState("uploading")
    setProgress(null)
    setResultsPage(null)

    try {
      const token = await getToken()
      const formData = new FormData()
      formData.append("file", file)
      formData.append("checkType", checkType)
      if (checkType === "mtn_whitelist") {
        formData.append("providers", Array.from(selectedProviders).join(","))
      }

      const uploadRes = await fetch("/api/admin/phone-verify/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.error ?? "Upload failed")

      const {
        sessionId, total, newCount = total, duplicates = 0,
        checkType: sessionCheckType, whitelistProviders: sessionWhitelistProviders,
      } = uploadData
      setProgress({
        sessionId, fileName: file.name, checkType: sessionCheckType ?? checkType,
        whitelistProviders: sessionWhitelistProviders ?? [],
        total, verified: 0, invalid: 0, notApplicable: 0, duplicates, processed: duplicates,
      })
      setRateLimitWarning(false)
      setVerifyState("processing")

      if (duplicates > 0) {
        toast.info(
          newCount === 0
            ? `All ${duplicates.toLocaleString()} number(s) were already uploaded before — nothing new to verify.`
            : `${duplicates.toLocaleString()} number(s) were already uploaded before — marked as duplicate and skipped.`
        )
      }

      let remaining = total
      let backoffMs = 10_000
      let consecutiveRateLimits = 0

      while (remaining > 0) {
        let processData: any = null
        try {
          const processRes = await fetch("/api/admin/phone-verify/process", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          })
          processData = await processRes.json()

          if (!processRes.ok) {
            consecutiveRateLimits++
            const wait = Math.min(backoffMs * consecutiveRateLimits, MAX_BACKOFF_MS)
            setRateLimitWarning(true)
            await new Promise(r => setTimeout(r, wait))
            continue
          }
        } catch {
          consecutiveRateLimits++
          await new Promise(r => setTimeout(r, Math.min(10_000 * consecutiveRateLimits, MAX_BACKOFF_MS)))
          continue
        }

        remaining = processData.remaining
        setProgress(prev => prev ? {
          ...prev,
          verified: processData.verified,
          invalid: processData.invalid,
          notApplicable: processData.notApplicable ?? prev.notApplicable,
          processed: prev.total - processData.remaining,
        } : prev)

        if (processData.status === "completed") break

        if (processData.rateLimited > 0) {
          consecutiveRateLimits++
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
          setRateLimitWarning(true)
          await new Promise(r => setTimeout(r, backoffMs))
        } else {
          consecutiveRateLimits = 0
          backoffMs = 10_000
          setRateLimitWarning(false)
          await new Promise(r => setTimeout(r, NORMAL_DELAY_MS))
        }
      }

      setVerifyState("completed")
      await loadResults(sessionId, "all", 1)
      toast.success("Verification complete!")
    } catch (error: any) {
      setVerifyState("error")
      toast.error(error.message ?? "Verification failed")
    }
  }, [loadResults, checkType, selectedProviders])

  const handleTextSubmit = useCallback(async () => {
    const trimmed = pastedNumbers.trim()
    if (!trimmed) { toast.error("Paste at least one phone number"); return }
    const blob = new Blob([trimmed], { type: "text/csv" })
    const file = new File([blob], "pasted-numbers.csv", { type: "text/csv" })
    await handleFileSelect(file)
  }, [pastedNumbers, handleFileSelect])

  const handleFilterChange = (filter: ResultFilter) => {
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
    const dupCount = duplicateCount(session)
    setProgress({
      sessionId: session.id,
      fileName: session.file_name,
      checkType: session.check_type,
      whitelistProviders: session.whitelist_providers ?? [],
      total: session.total_count,
      verified: session.verified_count,
      invalid: session.invalid_count,
      notApplicable: session.not_applicable_count,
      duplicates: dupCount,
      processed: session.verified_count + session.invalid_count + session.not_applicable_count + dupCount,
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
    const content = [
      "Title,First Name,Last Name,Phone Number,Email Address,Country",
      "Mr.,Kwame,Doe,0551234567,kwame.doe@example.com,Ghana",
      "Miss,Akosua,Smith,0241234567,akosua.smith@example.com,Ghana",
      "",
      "Note:",
      "Phone Number is the only required field.",
      "Delete this note i.e. row 5 6 7 before uploading",
    ].join("\n")
    const blob = new Blob([content], { type: "text/csv" })
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
  const activeCheckType = progress?.checkType ?? checkType
  const isWhitelistView = activeCheckType === "mtn_whitelist"

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Phone className="w-6 h-6" /> Phone Number Verification
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isWhitelistView
              ? "Bulk-check Ghana numbers against MTN whitelist-capable providers (Xpress/CodeCraft/AgentPortalGH) to see which can currently receive an MTN data order."
              : "Bulk-verify Ghana MoMo numbers against Moolre. Numbers with a returned account name are saved as verified."}
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
                <CardContent className="pt-6 space-y-4">
                  {/* Check type toggle */}
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      onClick={() => setCheckType("moolre")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        checkType === "moolre"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Phone className="w-4 h-4" /> Moolre (MoMo Check)
                    </button>
                    <button
                      onClick={() => whitelistAvailable && setCheckType("mtn_whitelist")}
                      disabled={!whitelistAvailable}
                      title={whitelistAvailable ? undefined : "No MTN whitelist provider is configured (Xpress/CodeCraft/AgentPortalGH)"}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        !whitelistAvailable
                          ? "text-muted-foreground/50 cursor-not-allowed"
                          : checkType === "mtn_whitelist"
                            ? "bg-background shadow text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ShieldCheck className="w-4 h-4" /> MTN Whitelist (Order Eligibility)
                    </button>
                  </div>

                  {/* Provider selection — only relevant in whitelist mode */}
                  {checkType === "mtn_whitelist" && (
                    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
                      <span className="text-xs text-muted-foreground">Check against:</span>
                      {availableProviders.map(p => (
                        <label
                          key={p.name}
                          className={`flex items-center gap-1.5 text-sm ${!p.configured ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                          title={p.configured ? undefined : "Not configured"}
                        >
                          <input
                            type="checkbox"
                            checked={selectedProviders.has(p.name)}
                            disabled={!p.configured}
                            onChange={() => toggleProvider(p.name)}
                            className="accent-primary"
                          />
                          {PROVIDER_LABELS[p.name] ?? p.name}
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Input mode toggle */}
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      onClick={() => setInputMode("file")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        inputMode === "file"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Upload className="w-4 h-4" /> File Upload
                    </button>
                    <button
                      onClick={() => setInputMode("text")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                        inputMode === "text"
                          ? "bg-background shadow text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <ClipboardList className="w-4 h-4" /> Paste Numbers
                    </button>
                  </div>

                  {inputMode === "file" ? (
                    <>
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
                          Accepts .csv or .xlsx · Max 50 MB · Multi-column format supported (Phone Number column auto-detected) · Numbers uploaded in earlier sessions are flagged as duplicates
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
                    </>
                  ) : (
                    <div className="space-y-3">
                      <textarea
                        value={pastedNumbers}
                        onChange={e => setPastedNumbers(e.target.value)}
                        placeholder={"Paste phone numbers here, one per line:\n0551234567\n0241234567\n0207654321"}
                        className="w-full h-48 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {pastedNumbers.trim()
                            ? `${pastedNumbers.trim().split(/[\r\n]+/).filter(l => l.trim()).length.toLocaleString()} numbers detected`
                            : "One number per line · numbers already uploaded before are flagged as duplicates"}
                        </span>
                        <Button
                          onClick={handleTextSubmit}
                          disabled={!pastedNumbers.trim() || (checkType === "mtn_whitelist" && selectedProviders.size === 0)}
                          className="gap-2"
                        >
                          <Phone className="w-4 h-4" /> Verify Numbers
                        </Button>
                      </div>
                    </div>
                  )}
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
                      : <CheckCircle className="w-4 h-4 text-success" />}
                    {progress.fileName}
                    <Badge variant="outline" className="ml-1">{isWhitelistView ? "MTN Whitelist" : "Moolre"}</Badge>
                  </CardTitle>
                  {isWhitelistView && progress.whitelistProviders.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Checked against: {progress.whitelistProviders.map(p => PROVIDER_LABELS[p] ?? p).join(", ")}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground mb-1">
                      <span>
                        {verifyState === "processing"
                          ? `Checking... ${progress.processed.toLocaleString()} done / ${progress.total.toLocaleString()} total`
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

                  <div className={`grid grid-cols-2 gap-3 ${isWhitelistView ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
                    <div className="bg-success/10 border border-success/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-success">{progress.verified.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">{isWhitelistView ? "Allowed" : "Verified"}</div>
                    </div>
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-destructive">{progress.invalid.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">{isWhitelistView ? "Blocked" : "Invalid"}</div>
                    </div>
                    {isWhitelistView && (
                      <div className="bg-muted border border-border rounded-lg p-3 text-center">
                        <div className="text-2xl font-bold">{progress.notApplicable.toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">N/A</div>
                      </div>
                    )}
                    <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold text-warning">{progress.duplicates.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Duplicate</div>
                    </div>
                    <div className="bg-muted rounded-lg p-3 text-center">
                      <div className="text-2xl font-bold">{progress.total.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground">Total</div>
                    </div>
                  </div>

                  {rateLimitWarning && verifyState === "processing" && (
                    <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                      Rate limit hit — backing off and retrying automatically...
                    </div>
                  )}

                  {verifyState === "completed" && (
                    <div className="flex gap-2 flex-wrap">
                      <Button onClick={() => downloadExport(progress.sessionId)} className="gap-2">
                        <Download className="w-4 h-4" /> Export .xlsx
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => { setVerifyState("idle"); setProgress(null); setResultsPage(null); setPastedNumbers(""); setRateLimitWarning(false) }}
                      >
                        Verify More Numbers
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
                      {(["all", "verified", "invalid", "duplicate", ...(isWhitelistView ? ["not_applicable" as const] : [])] as const).map(f => (
                        <Button
                          key={f} size="sm"
                          variant={resultFilter === f ? "default" : "outline"}
                          onClick={() => handleFilterChange(f)}
                        >
                          {f === "all" && `All (${resultsPage.session.total_count.toLocaleString()})`}
                          {f === "verified" && `✓ ${isWhitelistView ? "Allowed" : "Verified"} (${resultsPage.session.verified_count.toLocaleString()})`}
                          {f === "invalid" && `✗ ${isWhitelistView ? "Blocked" : "Invalid"} (${resultsPage.session.invalid_count.toLocaleString()})`}
                          {f === "duplicate" && `⧉ Duplicate (${duplicateCount(resultsPage.session).toLocaleString()})`}
                          {f === "not_applicable" && `– N/A (${resultsPage.session.not_applicable_count.toLocaleString()})`}
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
                          <th className="pb-2 pr-4">{isWhitelistView ? "Allowed By" : "Account Name"}</th>
                          <th className="pb-2 pr-4">Network</th>
                          <th className="pb-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resultsPage.results.map((row, i) => (
                          <tr key={row.id} className="border-b last:border-0">
                            <td className="py-2 pr-4 text-muted-foreground">{(resultsPage.page - 1) * 100 + i + 1}</td>
                            <td className="py-2 pr-4 font-mono">{row.phone_number}</td>
                            <td className="py-2 pr-4">{(isWhitelistView ? row.whitelist_provider : row.account_name) ?? "—"}</td>
                            <td className="py-2 pr-4"><Badge variant="outline">{row.network}</Badge></td>
                            <td className="py-2">
                              {row.status === "verified" ? (
                                <Badge className="bg-success/10 text-success border-success/30">
                                  <CheckCircle className="w-3 h-3 mr-1" /> {isWhitelistView ? "Allowed" : "Verified"}
                                </Badge>
                              ) : row.status === "duplicate" ? (
                                <Badge className="bg-warning/10 text-warning border-warning/30">
                                  <Copy className="w-3 h-3 mr-1" /> Duplicate
                                </Badge>
                              ) : row.status === "not_applicable" ? (
                                <Badge className="bg-muted text-muted-foreground border-border">
                                  <CircleMinus className="w-3 h-3 mr-1" /> N/A
                                </Badge>
                              ) : (
                                <Badge className="bg-destructive/10 text-destructive border-destructive/30">
                                  <XCircle className="w-3 h-3 mr-1" /> {isWhitelistView ? "Blocked" : "Invalid"}
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
                        <th className="pb-2 pr-4">Type</th>
                        <th className="pb-2 pr-4 text-center">Total</th>
                        <th className="pb-2 pr-4 text-center">Verified</th>
                        <th className="pb-2 pr-4 text-center">Invalid</th>
                        <th className="pb-2 pr-4 text-center">Dup</th>
                        <th className="pb-2 pr-4 text-center">Status</th>
                        <th className="pb-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map(session => (
                        <tr key={session.id} className="border-b last:border-0">
                          <td className="py-2 pr-4 text-muted-foreground text-xs">{new Date(session.created_at).toLocaleString()}</td>
                          <td className="py-2 pr-4 max-w-[180px] truncate">{session.file_name}</td>
                          <td className="py-2 pr-4">
                            <Badge variant="outline" className="text-xs">
                              {session.check_type === "mtn_whitelist" ? "Whitelist" : "Moolre"}
                            </Badge>
                          </td>
                          <td className="py-2 pr-4 text-center">{session.total_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-success font-medium">{session.verified_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-destructive">{session.invalid_count.toLocaleString()}</td>
                          <td className="py-2 pr-4 text-center text-warning">{duplicateCount(session).toLocaleString()}</td>
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
