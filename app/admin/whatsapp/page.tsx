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
import { Loader2, Send, Search, UserCheck, Bot, AlertTriangle, MessageSquare, X, ChevronRight } from "lucide-react"

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
}

interface ThreadMessage {
  id: string
  direction: "inbound" | "outbound"
  message: string | null
  status: string | null
  created_at: string
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

  const listPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const threadPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Keyed by phone so a late poll from a previous conversation can't contaminate
  // the new conversation's incremental cursor.
  const lastTsRef = useRef<{ phone: string; ts: string } | null>(null)
  const selectedRef = useRef<string | null>(null)
  const searchRef = useRef("")
  const scrollRef = useRef<HTMLDivElement | null>(null)

  selectedRef.current = selected
  searchRef.current = search

  async function getAuthHeader() {
    const { data: { session } } = await supabase.auth.getSession()
    return { Authorization: `Bearer ${session?.access_token}` }
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
    listPollRef.current = setInterval(loadConversations, 5000)
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
    threadPollRef.current = setInterval(() => fetchThread(selected, true), 3000)
    return () => { if (threadPollRef.current) clearInterval(threadPollRef.current) }
  }, [selected, fetchThread])

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
                onClick={() => setSelected(c.phone_number)}
                className="w-full text-left px-3 py-2.5 border-b hover:bg-accent transition-colors flex items-center gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{c.customer_name || c.phone_number}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeAgo(c.updated_at)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground truncate">{c.last_message_preview || "—"}</span>
                    {c.takeover_active && <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0"><UserCheck className="w-3 h-3 mr-0.5" />human</Badge>}
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
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">{threadConvo?.customer_name || selectedConvo?.customer_name || selected}</div>
                <div className="text-xs text-muted-foreground">
                  {threadConvo?.takeover_active
                    ? <span className="flex items-center gap-1"><UserCheck className="w-3 h-3" /> Handled by {threadConvo.taken_over_by_name || "an admin"} · active {timeAgo(threadConvo.taken_over_at)}</span>
                    : <span className="flex items-center gap-1"><Bot className="w-3 h-3" /> Bot is answering</span>}
                </div>
              </div>
            </div>
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

          {/* WhatsApp-style thread, from the BUSINESS side: our bot/admin replies
              (outbound) sit on the right; the customer (inbound) on the left. */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1.5 bg-[#efeae2] dark:bg-neutral-900">
            {thread.map(m => {
              const out = m.direction === "outbound"
              return (
                <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[78%] rounded-lg px-2.5 py-1.5 shadow-sm ${
                    out
                      ? "bg-[#d9fdd3] dark:bg-emerald-900/50 rounded-tr-none"
                      : "bg-white dark:bg-neutral-800 rounded-tl-none"
                  }`}>
                    <div className="text-sm whitespace-pre-wrap break-words text-neutral-900 dark:text-neutral-100">{m.message || ""}</div>
                    <div className="text-[10px] text-neutral-500 dark:text-neutral-400 text-right mt-0.5 leading-none">{fmtTime(m.created_at)}</div>
                  </div>
                </div>
              )
            })}
          </div>

          {threadConvo?.is_stale && (
            <div className="px-3 py-1.5 text-[11px] text-amber-700 bg-amber-50 border-t border-amber-200 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" /> Outside the 24h window — WhatsApp may not deliver a free-form reply.
            </div>
          )}

          <div className="p-3 border-t flex items-end gap-2">
            <Textarea
              className="min-h-[42px] max-h-32 resize-none"
              placeholder={threadConvo?.takeover_active ? "Type your reply…" : "Type a reply (tip: take over to pause the bot)…"}
              value={composer}
              onChange={e => setComposer(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply() } }}
            />
            <Button onClick={sendReply} disabled={sending || !composer.trim()}>
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
