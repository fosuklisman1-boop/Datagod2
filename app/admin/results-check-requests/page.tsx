"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { ClipboardCheck, Send, RefreshCw, Settings2, Paperclip, X } from "lucide-react"

interface CheckRequest {
  id: string
  phone_number: string
  exam_board: string
  index_number: string
  exam_year: number
  fee: number
  payment_status: string
  status: string
  result_data: string | null
  media_url: string | null
  media_type: string | null
  channel: string
  mode: string
  voucher_pin: string | null
  voucher_serial: string | null
  payment_reference: string
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
  checking: "bg-blue-100 text-blue-800 border-blue-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  failed: "bg-red-100 text-red-800 border-red-200",
}

export default function ResultsCheckRequestsPage() {
  const [requests, setRequests] = useState<CheckRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState("pending")
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [resultInputs, setResultInputs] = useState<Record<string, string>>({})
  const [mediaFiles, setMediaFiles] = useState<Record<string, File>>({})
  const [mediaTypeInputs, setMediaTypeInputs] = useState<Record<string, "image" | "document" | "video">>({})
  const [delivering, setDelivering] = useState<Record<string, boolean>>({})
  const [fee, setFee] = useState("2.00")
  const [enabled, setEnabled] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => { loadRequests() }, [statusFilter, page])
  useEffect(() => { loadSettings() }, [])

  async function getAuthHeader() {
    const { data: { session } } = await supabase.auth.getSession()
    return { Authorization: `Bearer ${session?.access_token}` }
  }

  async function loadRequests() {
    setLoading(true)
    try {
      const headers = await getAuthHeader()
      const res = await fetch(`/api/admin/results-check-requests?status=${statusFilter}&page=${page}`, { headers })
      if (!res.ok) throw new Error("Failed to load")
      const json = await res.json()
      setRequests(json.data)
      setTotal(json.count)
    } catch {
      toast.error("Failed to load requests")
    } finally {
      setLoading(false)
    }
  }

  async function loadSettings() {
    try {
      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/results-check-settings", { headers })
      if (!res.ok) return
      const data = await res.json()
      setEnabled(data.enabled)
      setFee(String(data.fee))
    } catch {}
  }

  async function saveSettings() {
    setSavingSettings(true)
    try {
      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/results-check-settings", {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, fee: parseFloat(fee) }),
      })
      if (!res.ok) throw new Error()
      toast.success("Settings saved")
      setShowSettings(false)
    } catch {
      toast.error("Failed to save settings")
    } finally {
      setSavingSettings(false)
    }
  }

  async function deliverResult(req: CheckRequest) {
    const resultText = resultInputs[req.id]?.trim() ?? req.result_data ?? ""
    const file = mediaFiles[req.id]
    if (!resultText && !file && !req.media_url) {
      toast.error("Enter result text or attach a file first")
      return
    }
    setDelivering(d => ({ ...d, [req.id]: true }))
    try {
      let mediaUrl = req.media_url ?? ""
      let mediaType = mediaTypeInputs[req.id] ?? req.media_type ?? "image"

      // Upload file to Supabase storage if one was selected
      if (file) {
        const ext = file.name.split(".").pop() ?? "bin"
        const path = `results-check/${req.id}-${Date.now()}.${ext}`
        const { error: uploadErr } = await supabase.storage
          .from("admin-uploads")
          .upload(path, file, { upsert: true, contentType: file.type })
        if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`)
        const { data: urlData } = supabase.storage.from("admin-uploads").getPublicUrl(path)
        mediaUrl = urlData.publicUrl
        // Derive media type from MIME
        if (file.type.startsWith("image/")) mediaType = "image"
        else if (file.type.startsWith("video/")) mediaType = "video"
        else mediaType = "document"
      }

      const headers = await getAuthHeader()
      const payload: Record<string, unknown> = {
        id: req.id,
        status: "completed",
        deliver: true,
        ...(resultText && { result_data: resultText }),
        ...(mediaUrl && { media_url: mediaUrl, media_type: mediaType }),
      }
      const res = await fetch("/api/admin/results-check-requests", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error()
      toast.success(`Results sent to ${req.phone_number}`)
      setMediaFiles(f => { const n = { ...f }; delete n[req.id]; return n })
      loadRequests()
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to deliver results")
    } finally {
      setDelivering(d => ({ ...d, [req.id]: false }))
    }
  }

  async function updateStatus(id: string, status: string) {
    try {
      const headers = await getAuthHeader()
      await fetch("/api/admin/results-check-requests", {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      })
      loadRequests()
    } catch {
      toast.error("Failed to update status")
    }
  }

  const totalPages = Math.ceil(total / 20)

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-100">
            <ClipboardCheck size={22} className="text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Results Check Requests</h1>
            <p className="text-sm text-muted-foreground">Manage customer requests to check exam results on their behalf</p>
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowSettings(s => !s)}>
              <Settings2 size={16} className="mr-1" /> Settings
            </Button>
            <Button variant="ghost" size="sm" onClick={loadRequests}>
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>

        {showSettings && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Service Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="enabled"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  className="accent-blue-600"
                />
                <Label htmlFor="enabled" className="cursor-pointer">Service enabled</Label>
              </div>
              <div className="space-y-1 max-w-xs">
                <Label className="text-sm">Fee per check (GHS)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.50"
                  value={fee}
                  onChange={e => setFee(e.target.value)}
                  className="text-sm"
                />
              </div>
              <Button onClick={saveSettings} disabled={savingSettings} size="sm" className="gap-1.5">
                {savingSettings ? "Saving..." : "Save Settings"}
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2 flex-wrap">
          {["pending", "checking", "completed", "failed", "all"].map(s => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              onClick={() => { setStatusFilter(s); setPage(1) }}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-10 text-muted-foreground text-sm">Loading...</div>
        ) : requests.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">No {statusFilter} requests</div>
        ) : (
          <div className="space-y-4">
            {requests.map(req => (
              <Card key={req.id}>
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <p className="font-semibold text-sm">{req.phone_number}</p>
                      <p className="text-sm text-muted-foreground">
                        {req.exam_board} · {req.index_number} · {req.exam_year}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {req.channel === "whatsapp" ? "WhatsApp" : "USSD"} ·{" "}
                        {req.mode === "combo" ? "Combo (voucher+check)" : "Own voucher"} ·{" "}
                        {new Date(req.created_at).toLocaleString("en-GB")} ·{" "}
                        GHS {req.fee.toFixed(2)} · Ref: {req.payment_reference}
                      </p>
                      {req.voucher_pin && (
                        <p className="text-xs font-mono text-blue-700 mt-0.5">
                          {req.voucher_serial ? `Serial: ${req.voucher_serial} · ` : ""}PIN: {req.voucher_pin}
                        </p>
                      )}
                    </div>
                    <Badge className={`text-xs border ${STATUS_COLORS[req.status] ?? ""} capitalize`}>
                      {req.status}
                    </Badge>
                  </div>

                  {req.result_data && (
                    <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">
                      {req.result_data}
                    </div>
                  )}

                  {req.status !== "completed" && (
                    <div className="space-y-2">
                      <Textarea
                        placeholder="Enter exam results here (e.g. English: A1, Maths: B2, ...)"
                        rows={4}
                        value={resultInputs[req.id] ?? req.result_data ?? ""}
                        onChange={e => setResultInputs(r => ({ ...r, [req.id]: e.target.value }))}
                        className="text-sm resize-none"
                      />
                      {req.channel === "whatsapp" && (
                        <div className="space-y-1.5">
                          {mediaFiles[req.id] ? (
                            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                              <Paperclip size={13} className="shrink-0 text-muted-foreground" />
                              <span className="flex-1 truncate font-medium">{mediaFiles[req.id].name}</span>
                              <button
                                onClick={() => setMediaFiles(f => { const n = { ...f }; delete n[req.id]; return n })}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <X size={13} />
                              </button>
                            </div>
                          ) : req.media_url ? (
                            <p className="text-xs text-muted-foreground truncate">
                              Attached: <span className="font-mono">{req.media_url.split("/").pop()}</span>
                            </p>
                          ) : null}
                          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 transition-colors">
                            <Paperclip size={13} />
                            {mediaFiles[req.id] ? "Replace file" : "Attach image / PDF / video (optional)"}
                            <input
                              type="file"
                              accept="image/*,application/pdf,video/*"
                              className="sr-only"
                              onChange={e => {
                                const f = e.target.files?.[0]
                                if (f) setMediaFiles(m => ({ ...m, [req.id]: f }))
                                e.target.value = ""
                              }}
                            />
                          </label>
                        </div>
                      )}
                      <div className="flex gap-2">
                        {req.status === "pending" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => updateStatus(req.id, "checking")}
                          >
                            Mark Checking
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="gap-1.5"
                          disabled={delivering[req.id]}
                          onClick={() => deliverResult(req)}
                        >
                          <Send size={13} />
                          {delivering[req.id] ? "Sending..." : `Send via ${req.channel === "whatsapp" ? "WhatsApp" : "SMS"}`}
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground self-center">
              {page} / {totalPages}
            </span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next
            </Button>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
