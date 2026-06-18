"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Loader2, Send, Search, UserCheck, Bot, AlertTriangle, MessageSquare, X, ChevronRight, Check, CheckCheck, Paperclip, FileText, Hand } from "lucide-react"

interface Conversation {
  id: string
  phone_number: string
  user_id: string | null
  customer_name: string | null
  last_message_preview: string | null
  latest_inbound_at: string | null
  latest_outbound_at: string | null
  updated_at: string | null
  human_takeover: boolean
  taken_over_by: string | null
  takeover_active: boolean
  is_stale: boolean
  unread: boolean
  wants_human: boolean
}

interface ThreadMessage {
  id: string
  direction: "inbound" | "outbound"
  message: string | null
  status: string | null
  created_at: string
  tool_context?: { media_url?: string; media_type?: string } | null
}

interface ThreadConvo {
  phone_number: string
  customer_name: string | null
  human_takeover: boolean
  taken_over_by: string | null
  taken_over_by_name: string | null
  taken_over_at: string | null
  takeover_active: boolean
  is_stale: boolean
  wants_human: boolean
  open_complaints: number
}

function timeAgo(iso: string | null): string {
  if (!iso) return ""
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// WhatsApp-style clock label on each bubble, e.g. "2:55 PM".
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

// Day label for the in-thread date separators.
function dayLabel(iso: string): string {
  const d = new Date(iso); d.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: diff > 300 ? "numeric" : undefined })
}

function initials(name: string | null, phone: string): string {
  if (name?.trim()) {
    const p = name.trim().split(/\s+/)
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || name[0]!.toUpperCase()
  }
  return phone.slice(-2)
}

const AVATAR_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-primary", "bg-amber-500", "bg-rose-500", "bg-teal-500", "bg-primary", "bg-primary"]
function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function Avatar({ name, phone }: { name: string | null; phone: string }) {
  return (
    <span className={`shrink-0 w-9 h-9 rounded-full ${avatarColor(name || phone)} text-primary-foreground grid place-items-center text-xs font-semibold`}>
      {initials(name, phone)}
    </span>
  )
}

// WhatsApp delivery ticks for our outbound messages.
function Ticks({ status }: { status: string | null }) {
  if (status === "failed") return <span className="text-destructive text-[11px] font-bold" title="Failed to deliver">!</span>
  if (status === "read") return <CheckCheck className="w-3.5 h-3.5 text-sky-500" />
  if (status === "delivered") return <CheckCheck className="w-3.5 h-3.5 text-muted-foreground" />
  return <Check className="w-3.5 h-3.5 text-muted-foreground" />
}

export default function WhatsAppInboxPage() {
  const router = useRouter()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | null>(null)

  const [thread, setThread] = useState<ThreadMessage[]>([])
  const [threadConvo, setThreadConvo] = useState<ThreadConvo | null>(null)
  const [composer, setComposer] = useState("")
  const [sending, setSending] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const listPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const threadPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Keyed by phone so a late poll from a previous conversation can't contaminate
  // the new conversation's incremental cursor.
  const lastTsRef = useRef<{ phone: string; ts: string } | null>(null)
  const selectedRef = useRef<string | null>(null)
  const searchRef = useRef("")
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Throttle for the "admin is typing" indicator pushed to the customer.
  const lastTypingRef = useRef<{ phone: string; ts: number }>({ phone: "", ts: 0 })

  selectedRef.current = selected
  searchRef.current = search

  async function getAuthHeader() {
    const { data: { session } } = await supabase.auth.getSession()
    return { Authorization: `Bearer ${session?.access_token}` }
  }

  // Push a "typing…" indicator to the customer while the admin composes a reply.
  // WhatsApp's indicator lasts ~25s and clears when the reply sends, so we re-ping
  // at most ~every 9s (per conversation) instead of on every keystroke. Best-effort.
  async function pingTyping() {
    if (!selected) return
    const now = Date.now()
    const last = lastTypingRef.current
    if (last.phone === selected && now - last.ts < 9000) return
    lastTypingRef.current = { phone: selected, ts: now }
    try {
      const headers = await getAuthHeader()
      await fetch("/api/admin/whatsapp-inbox/typing", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selected }),
      })
    } catch { /* best-effort */ }
  }

  // ── Admin gate ──────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        let admin = user?.user_metadata?.role === "admin"
        if (!admin && user?.id) {
          const { data: profile } = await supabase.from("users").select("role").eq("id", user.id).single()
          admin = profile?.role === "admin"
        }
        if (!admin) {
          toast.error("Unauthorized access")
          router.push("/dashboard")
          return
        }
        setIsAdmin(true)
      } catch {
        router.push("/dashboard")
      } finally {
        setLoading(false)
      }
    })()
  }, [router])

  // ── Conversation list (load + 5s poll) ───────────────────────────────────────
  const loadConversations = useCallback(async () => {
    try {
      const headers = await getAuthHeader()
      const q = searchRef.current.trim()
      const res = await fetch(`/api/admin/whatsapp-inbox${q ? `?search=${encodeURIComponent(q)}` : ""}`, { headers })
      if (!res.ok) return
      const json = await res.json()
      setConversations(json.data ?? [])
    } catch { /* transient — next poll retries */ }
  }, [])

  useEffect(() => {
    if (!isAdmin) return
    loadConversations()
    // Fallback poll (realtime below makes updates instant; this just backstops it).
    listPollRef.current = setInterval(loadConversations, 2500)
    return () => { if (listPollRef.current) clearInterval(listPollRef.current) }
  }, [isAdmin, loadConversations])

  // Reload the list immediately when the search term changes.
  useEffect(() => {
    if (!isAdmin) return
    const t = setTimeout(loadConversations, 300)
    return () => clearTimeout(t)
  }, [search, isAdmin, loadConversations])

  // ── Thread (full load on select, then 3s incremental poll) ───────────────────
  const fetchThread = useCallback(async (phone: string, incremental: boolean) => {
    try {
      const headers = await getAuthHeader()
      const cursor = incremental && lastTsRef.current?.phone === phone ? lastTsRef.current.ts : null
      const after = cursor ? `?after=${encodeURIComponent(cursor)}` : ""
      const res = await fetch(`/api/admin/whatsapp-inbox/${phone}${after}`, { headers })
      if (!res.ok) return
      const json = await res.json()
      if (selectedRef.current !== phone) return // user switched away mid-request
      setThreadConvo(json.conversation ?? null)
      const incoming: ThreadMessage[] = json.messages ?? []
      if (incoming.length > 0) lastTsRef.current = { phone, ts: incoming[incoming.length - 1].created_at }
      setThread(prev => {
        if (!incremental) return incoming
        if (incoming.length === 0) return prev
        const seen = new Set(prev.map(m => m.id))
        return [...prev, ...incoming.filter(m => !seen.has(m.id))]
      })
    } catch { /* transient */ }
  }, [])

  useEffect(() => {
    if (!selected) return
    lastTsRef.current = null
    setThread([])
    setThreadConvo(null)
    fetchThread(selected, false)
    // Fallback poll (realtime below pushes updates instantly; this backstops it).
    threadPollRef.current = setInterval(() => fetchThread(selected, true), 1500)
    return () => { if (threadPollRef.current) clearInterval(threadPollRef.current) }
  }, [selected, fetchThread])

  // Realtime: the moment any WhatsApp message is logged (customer, bot, or admin), the
  // webhook broadcasts on the "wa-inbox" channel (lib/whatsapp-bot/realtime-notify.ts) and
  // we refresh instantly — no waiting for the poll. Polling above stays as a fallback.
  useEffect(() => {
    if (!isAdmin) return
    const channel = supabase
      .channel("wa-inbox")
      .on("broadcast", { event: "message" }, ({ payload }) => {
        loadConversations()
        const phone = (payload as { phone?: string })?.phone
        if (phone && selectedRef.current === phone) fetchThread(selectedRef.current, true)
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [isAdmin, loadConversations, fetchThread])

  // Auto-scroll to newest message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [thread])

  // Full-screen thread modal: close on Escape, lock body scroll while open.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null) }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [selected])

  // ── Actions ───────────────────────────────────────────────────────────────────
  async function sendReply() {
    const text = composer.trim()
    if (!text || !selected) return
    setSending(true)
    try {
      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/whatsapp-inbox/send", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selected, message: text }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || "Failed to send"); return }
      if (json.warning) toast.warning(json.warning)
      setComposer("")
      await fetchThread(selected, true)
      loadConversations()
    } catch {
      toast.error("Failed to send")
    } finally {
      setSending(false)
    }
  }

  async function handleUpload(file: File) {
    if (!selected) return
    if (file.size > 10 * 1024 * 1024) { toast.error("File must be under 10 MB"); return }
    setUploading(true)
    try {
      const isImage = file.type.startsWith("image/")
      const ext = (file.name.split(".").pop() || (isImage ? "jpg" : "pdf")).toLowerCase()
      const path = `inbox/${selected}-${Date.now()}.${ext}`
      const { error: upErr } = await supabase.storage
        .from("admin-uploads")
        .upload(path, file, { contentType: file.type, upsert: true })
      if (upErr) { toast.error("Upload failed: " + upErr.message); return }
      const { data: { publicUrl } } = supabase.storage.from("admin-uploads").getPublicUrl(path)

      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/whatsapp-inbox/send-media", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: selected,
          mediaUrl: publicUrl,
          mediaType: isImage ? "image" : "document",
          filename: file.name,
          caption: composer.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || "Failed to send file"); return }
      setComposer("")
      await fetchThread(selected, true)
      loadConversations()
    } catch {
      toast.error("Failed to send file")
    } finally {
      setUploading(false)
    }
  }

  async function toggleTakeover(action: "take" | "release") {
    if (!selected) return
    if (action === "take" && threadConvo?.takeover_active && threadConvo.taken_over_by) {
      if (!confirm(`This chat is already handled by ${threadConvo.taken_over_by_name || "another admin"}. Take over anyway?`)) return
    }
    setToggling(true)
    try {
      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/whatsapp-inbox/takeover", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selected, action }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || "Failed"); return }
      toast.success(action === "take" ? "You've taken over this chat — the bot is paused" : "Bot resumed")
      await fetchThread(selected, false)
      loadConversations()
    } catch {
      toast.error("Failed")
    } finally {
      setToggling(false)
    }
  }

  // Explicitly resolve the customer's open complaint(s). Deliberate action — sending
  // a normal reply never resolves complaints (that silently closed them before).
  async function resolveComplaint() {
    if (!selected) return
    if (!confirm("Mark this customer's open complaint(s) as resolved?")) return
    setResolving(true)
    try {
      const headers = await getAuthHeader()
      const res = await fetch("/api/admin/whatsapp-inbox/resolve-complaint", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ phone: selected }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || "Failed to resolve"); return }
      toast.success(json.resolved > 0 ? `Resolved ${json.resolved} complaint${json.resolved === 1 ? "" : "s"}` : "No open complaints to resolve")
      await fetchThread(selected, false)
      loadConversations()
    } catch {
      toast.error("Failed to resolve")
    } finally {
      setResolving(false)
    }
  }

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-[60vh]"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      </DashboardLayout>
    )
  }
  if (!isAdmin) return null

  const selectedConvo = conversations.find(c => c.phone_number === selected)

  return (
    <>
      <DashboardLayout>
        <div className="mb-4">
          <h1 className="text-2xl font-bold flex items-center gap-2"><MessageSquare className="w-6 h-6" /> WhatsApp Inbox</h1>
          <p className="text-sm text-muted-foreground">View bot conversations and take over to reply manually.</p>
        </div>

        {/* Conversation list (full width) */}
        <Card className="flex flex-col overflow-hidden max-w-3xl">
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search by phone…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="max-h-[calc(100vh-260px)] min-h-[320px] overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">No conversations yet.</div>
            ) : conversations.map(c => (
              <button
                key={c.id}
                onClick={() => {
                  setSelected(c.phone_number)
                  // Optimistically clear the dot; the thread GET marks it read server-side.
                  setConversations(prev => prev.map(x => x.phone_number === c.phone_number ? { ...x, unread: false } : x))
                }}
                className={`w-full text-left px-3 py-2.5 border-b hover:bg-accent transition-colors flex items-center gap-2.5 ${c.unread ? "bg-success/10" : ""}`}
              >
                <Avatar name={c.customer_name} phone={c.phone_number} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate ${c.unread ? "font-semibold" : "font-medium"}`}>{c.customer_name || c.phone_number}</span>
                    <span className={`text-[10px] shrink-0 ${c.unread ? "text-success font-medium" : "text-muted-foreground"}`}>{timeAgo(c.updated_at)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className={`text-xs truncate ${c.unread ? "text-foreground" : "text-muted-foreground"}`}>{c.last_message_preview || "—"}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {c.wants_human && <Badge className="text-[10px] px-1.5 py-0 bg-warning hover:bg-warning/90 text-primary-foreground"><Hand className="w-3 h-3 mr-0.5" />wants human</Badge>}
                      {c.takeover_active && <Badge variant="secondary" className="text-[10px] px-1.5 py-0"><UserCheck className="w-3 h-3 mr-0.5" />human</Badge>}
                      {c.unread && <span className="w-2.5 h-2.5 rounded-full bg-success" aria-label="unread" />}
                    </span>
                  </div>
                  {c.customer_name && <div className="text-[10px] text-muted-foreground mt-0.5">{c.phone_number}</div>}
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </Card>
      </DashboardLayout>

      {/* Full-screen thread modal */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-background flex flex-col" role="dialog" aria-modal="true">
          <div className="p-3 border-b flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Button size="icon" variant="ghost" onClick={() => setSelected(null)} aria-label="Close">
                <X className="w-5 h-5" />
              </Button>
              <Avatar name={threadConvo?.customer_name || selectedConvo?.customer_name || null} phone={selected} />
              <div className="min-w-0">
                <div className="font-medium text-sm truncate flex items-center gap-1.5">
                  {threadConvo?.customer_name || selectedConvo?.customer_name || selected}
                  {threadConvo && threadConvo.open_complaints > 0 && (
                    <Badge className="text-[10px] px-1.5 py-0 bg-rose-500 hover:bg-rose-600 text-white"><AlertTriangle className="w-3 h-3 mr-0.5" />complaint</Badge>
                  )}
                  {threadConvo?.wants_human && !threadConvo?.takeover_active && (
                    <Badge className="text-[10px] px-1.5 py-0 bg-warning hover:bg-warning/90 text-primary-foreground"><Hand className="w-3 h-3 mr-0.5" />wants human</Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {threadConvo?.takeover_active
                    ? <span className="flex items-center gap-1"><UserCheck className="w-3 h-3" /> Handled by {threadConvo.taken_over_by_name || "an admin"} · active {timeAgo(threadConvo.taken_over_at)}</span>
                    : <span className="flex items-center gap-1"><Bot className="w-3 h-3" /> Bot is answering</span>}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {threadConvo && threadConvo.open_complaints > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolving}
                  onClick={resolveComplaint}
                  className="border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                >
                  {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Check className="w-4 h-4 mr-1" />Resolve complaint</>}
                </Button>
              )}
              {threadConvo?.takeover_active ? (
                <Button size="sm" variant="outline" disabled={toggling} onClick={() => toggleTakeover("release")}>
                  {toggling ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Bot className="w-4 h-4 mr-1" />Resume bot</>}
                </Button>
              ) : (
                <Button size="sm" disabled={toggling} onClick={() => toggleTakeover("take")}>
                  {toggling ? <Loader2 className="w-4 h-4 animate-spin" /> : <><UserCheck className="w-4 h-4 mr-1" />Take over</>}
                </Button>
              )}
            </div>
          </div>

          {/* WhatsApp-style thread, from the BUSINESS side: our bot/admin replies
              (outbound) sit on the right; the customer (inbound) on the left. */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5 bg-[#efeae2] dark:bg-neutral-900">
            {thread.map((m, i) => {
              const out = m.direction === "outbound"
              const showDay = i === 0 || dayLabel(thread[i - 1].created_at) !== dayLabel(m.created_at)
              return (
                <div key={m.id}>
                  {showDay && (
                    <div className="flex justify-center my-2">
                      <span className="text-[10px] bg-card/90 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 px-2 py-0.5 rounded-md shadow-sm">{dayLabel(m.created_at)}</span>
                    </div>
                  )}
                  <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm ${
                      out
                        ? "bg-[#d9fdd3] dark:bg-emerald-900/50 rounded-tr-none"
                        : "bg-card dark:bg-neutral-800 rounded-tl-none"
                    }`}>
                      {m.tool_context?.media_url && (
                        m.tool_context.media_type === "image" ? (
                          <a href={m.tool_context.media_url} target="_blank" rel="noreferrer">
                            <img src={m.tool_context.media_url} alt="attachment" className="rounded-md mb-1 max-h-64 w-auto object-cover" />
                          </a>
                        ) : m.tool_context.media_type === "video" ? (
                          <video src={m.tool_context.media_url} controls className="rounded-md mb-1 max-h-64 w-auto" />
                        ) : m.tool_context.media_type === "audio" ? (
                          <audio src={m.tool_context.media_url} controls className="mb-1 w-full" />
                        ) : (
                          <a href={m.tool_context.media_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-sm underline mb-1 text-neutral-800 dark:text-neutral-100">
                            <FileText className="w-4 h-4 shrink-0" /> View document
                          </a>
                        )
                      )}
                      {m.message && !(m.tool_context?.media_url && ["📷 Photo", "📄 Document", "🎥 Video", "🎤 Voice note", "🌟 Sticker"].includes(m.message)) && (
                        <div className="text-sm whitespace-pre-wrap break-words text-neutral-900 dark:text-neutral-100">{m.message}</div>
                      )}
                      <div className="text-[10px] text-neutral-500 dark:text-neutral-400 text-right mt-0.5 leading-none flex items-center justify-end gap-0.5">
                        {fmtTime(m.created_at)}
                        {out && <Ticks status={m.status} />}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {threadConvo?.is_stale && (
            <div className="px-3 py-1.5 text-[11px] text-warning bg-warning/10 border-t border-warning/30 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" /> Outside the 24h window — WhatsApp may not deliver a free-form reply.
            </div>
          )}

          <div className="p-3 border-t flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = "" }}
            />
            <Button size="icon" variant="ghost" disabled={uploading || sending} onClick={() => fileRef.current?.click()} title="Send photo or PDF (uses the box as caption)">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </Button>
            <Textarea
              className="min-h-[42px] max-h-32 resize-none"
              placeholder={threadConvo?.takeover_active ? "Type your reply…" : "Type a reply (tip: take over to pause the bot)…"}
              value={composer}
              onChange={e => { setComposer(e.target.value); if (e.target.value.trim()) void pingTyping() }}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply() } }}
            />
            <Button onClick={sendReply} disabled={sending || uploading || !composer.trim()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
