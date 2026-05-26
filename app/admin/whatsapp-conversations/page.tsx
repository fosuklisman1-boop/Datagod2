"use client"

import { useEffect, useState, useRef } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { useAdminProtected } from "@/hooks/use-admin"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Loader2, MessageCircle, Search, Send, X, Download, RefreshCw, User, Bot,
} from "lucide-react"

// ─── Types ───────────────────────────────────────────────────────────────────

interface WaUser { first_name: string | null; last_name: string | null }

interface Conversation {
  id: string
  phone_number: string
  status: "active" | "closed"
  latest_inbound_at: string | null
  latest_outbound_at: string | null
  last_message_preview: string | null
  created_at: string
  user: WaUser | null
}

interface Message {
  id: string
  direction: "inbound" | "outbound" | "status"
  message: string | null
  meta_message_id: string | null
  status: string | null
  error_message: string | null
  tool_context: Record<string, unknown> | null
  created_at: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function displayName(conv: Conversation): string {
  const u = conv.user
  if (u?.first_name || u?.last_name) {
    return [u.first_name, u.last_name].filter(Boolean).join(" ")
  }
  return "Guest"
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

async function getAuthHeader(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  return `Bearer ${data.session?.access_token ?? ""}`
}

async function fetchConversations(
  page: number,
  search: string,
  status: string,
  matched: string
): Promise<{ conversations: Conversation[]; total: number }> {
  const params = new URLSearchParams({ page: String(page) })
  if (search) params.set("search", search)
  if (status) params.set("status", status)
  if (matched) params.set("matched", matched)
  const res = await fetch(`/api/admin/whatsapp-conversations?${params}`, {
    headers: { Authorization: await getAuthHeader() },
  })
  if (!res.ok) throw new Error("Failed to load conversations")
  return res.json()
}

async function fetchMessages(id: string): Promise<Message[]> {
  const res = await fetch(`/api/admin/whatsapp-conversations/${id}`, {
    headers: { Authorization: await getAuthHeader() },
  })
  if (!res.ok) throw new Error("Failed to load messages")
  const data = await res.json()
  return data.messages
}

async function patchStatus(id: string, status: "active" | "closed"): Promise<void> {
  const res = await fetch(`/api/admin/whatsapp-conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: await getAuthHeader() },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? "Failed to update status")
  }
}

async function sendAdminReply(id: string, message: string): Promise<void> {
  const res = await fetch(`/api/admin/whatsapp-conversations/${id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: await getAuthHeader() },
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as { error?: string }).error ?? "Failed to send reply")
  }
}

function exportConversationCsv(conv: Conversation, messages: Message[]): void {
  const rows = [
    ["timestamp", "direction", "message", "status", "error"],
    ...messages.map(m => [
      m.created_at,
      m.direction,
      `"${(m.message ?? "").replace(/"/g, '""')}"`,
      m.status ?? "",
      m.error_message ?? "",
    ]),
  ]
  const csv = rows.map(r => r.join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `whatsapp-${conv.phone_number}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WhatsAppConversationsPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()

  // ─── List state ──────────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [matchedFilter, setMatchedFilter] = useState("")
  const [listLoading, setListLoading] = useState(true)

  // ─── Thread state ─────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Conversation | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [reply, setReply] = useState("")
  const [sending, setSending] = useState(false)
  const [closing, setClosing] = useState(false)
  const [expandedCtx, setExpandedCtx] = useState<Set<string>>(new Set())
  const threadRef = useRef<HTMLDivElement>(null)

  const PAGE_SIZE = 20
  const totalPages = Math.ceil(total / PAGE_SIZE)

  // ─── Load list ────────────────────────────────────────────────────────────
  const loadList = async () => {
    setListLoading(true)
    try {
      const result = await fetchConversations(page, search, statusFilter, matchedFilter)
      setConversations(result.conversations)
      setTotal(result.total)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load")
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => { if (isAdmin) loadList() }, [isAdmin, page, statusFilter, matchedFilter])

  useEffect(() => {
    const t = setTimeout(() => { if (isAdmin) { setPage(1); loadList() } }, 400)
    return () => clearTimeout(t)
  }, [search])

  // ─── Load thread ──────────────────────────────────────────────────────────
  const loadThread = async (conv: Conversation) => {
    setSelected(conv)
    setMessages([])
    setReply("")
    setExpandedCtx(new Set())
    setThreadLoading(true)
    try {
      const msgs = await fetchMessages(conv.id)
      setMessages(msgs)
      setTimeout(() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" }), 50)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load messages")
    } finally {
      setThreadLoading(false)
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  const handleClose = async () => {
    if (!selected) return
    const newStatus = selected.status === "active" ? "closed" : "active"
    setClosing(true)
    try {
      await patchStatus(selected.id, newStatus)
      setSelected(prev => prev ? { ...prev, status: newStatus } : prev)
      setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, status: newStatus } : c))
      toast.success(`Conversation marked as ${newStatus}`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update")
    } finally {
      setClosing(false)
    }
  }

  const handleSend = async () => {
    if (!selected || !reply.trim()) return
    setSending(true)
    try {
      await sendAdminReply(selected.id, reply.trim())
      const optimistic: Message = {
        id: crypto.randomUUID(),
        direction: "outbound",
        message: reply.trim(),
        meta_message_id: null,
        status: "sent",
        error_message: null,
        tool_context: { source: "admin_reply" },
        created_at: new Date().toISOString(),
      }
      setMessages(prev => [...prev, optimistic])
      setReply("")
      setTimeout(() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" }), 50)
      toast.success("Message sent")
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to send")
    } finally {
      setSending(false)
    }
  }

  const toggleCtx = (id: string) =>
    setExpandedCtx(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  // ─── Loading guard ────────────────────────────────────────────────────────
  if (adminLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
        </div>
      </DashboardLayout>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)]">
        {/* Page header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-600 rounded-lg text-white">
              <MessageCircle className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold">WhatsApp Conversations</h1>
              <p className="text-xs text-gray-500">{total} total conversations</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={loadList} disabled={listLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${listLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Two-panel body */}
        <div className="flex flex-1 overflow-hidden">
          {/* LEFT: conversation list */}
          <aside className="w-80 shrink-0 border-r flex flex-col overflow-hidden">
            {/* Filters */}
            <div className="p-3 space-y-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
                <Input
                  className="pl-8 h-8 text-sm"
                  placeholder="Search phone..."
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1) }}
                />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {(["", "active", "closed"] as const).map(f => (
                  <button
                    key={f || "all"}
                    onClick={() => { setStatusFilter(f); setPage(1) }}
                    className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                      statusFilter === f
                        ? "bg-green-600 text-white border-green-600"
                        : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {f || "All"}
                  </button>
                ))}
                {(["true", "false"] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => { setMatchedFilter(prev => prev === f ? "" : f); setPage(1) }}
                    className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                      matchedFilter === f
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    {f === "true" ? "Matched" : "Guest"}
                  </button>
                ))}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {listLoading ? (
                <div className="flex justify-center items-center h-32">
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              ) : conversations.length === 0 ? (
                <p className="text-center text-sm text-gray-400 mt-12">No conversations found</p>
              ) : (
                conversations.map(conv => (
                  <button
                    key={conv.id}
                    onClick={() => loadThread(conv)}
                    className={`w-full text-left px-4 py-3 border-b hover:bg-gray-50 transition-colors ${
                      selected?.id === conv.id ? "bg-green-50 border-l-4 border-l-green-500" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-sm font-semibold truncate max-w-[150px]">
                        {displayName(conv)}
                      </span>
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 ${
                          conv.status === "active"
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-100 text-gray-500"
                        }`}
                      >
                        {conv.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-500 truncate">{conv.phone_number}</p>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{conv.last_message_preview ?? "—"}</p>
                    <p className="text-[10px] text-gray-300 mt-1">{timeAgo(conv.latest_inbound_at)}</p>
                  </button>
                ))
              )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-gray-500">
                <button
                  disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}
                  className="disabled:opacity-40 hover:text-gray-800"
                >
                  ← Prev
                </button>
                <span>{page} / {totalPages}</span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                  className="disabled:opacity-40 hover:text-gray-800"
                >
                  Next →
                </button>
              </div>
            )}
          </aside>

          {/* RIGHT: thread */}
          {!selected ? (
            <main className="flex-1 flex items-center justify-center text-gray-400 text-sm">
              Select a conversation to view messages
            </main>
          ) : (
            <main className="flex-1 flex flex-col overflow-hidden">
              {/* Thread header */}
              <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
                <div>
                  <p className="font-semibold text-sm">{displayName(selected)}</p>
                  <p className="text-xs text-gray-500">{selected.phone_number}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => exportConversationCsv(selected, messages)}
                    disabled={messages.length === 0}
                  >
                    <Download className="w-3.5 h-3.5 mr-1" />
                    Export
                  </Button>
                  <Button
                    size="sm"
                    variant={selected.status === "active" ? "destructive" : "outline"}
                    onClick={handleClose}
                    disabled={closing}
                  >
                    {closing
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <X className="w-3.5 h-3.5 mr-1" />}
                    {selected.status === "active" ? "Close" : "Reopen"}
                  </Button>
                </div>
              </div>

              {/* Messages */}
              <div ref={threadRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {threadLoading ? (
                  <div className="flex justify-center items-center h-32">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-gray-400 mt-12">No messages</p>
                ) : (
                  messages.map(msg => {
                    if (msg.direction === "status") {
                      return (
                        <div key={msg.id} className="flex justify-center">
                          <span className="text-[10px] text-gray-400 bg-gray-100 rounded-full px-3 py-0.5">
                            {msg.status} · {new Date(msg.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      )
                    }
                    const isInbound = msg.direction === "inbound"
                    const isAdminReply =
                      String(msg.tool_context?.reference ?? "").startsWith("admin_reply:") ||
                      msg.tool_context?.source === "admin_reply"
                    return (
                      <div key={msg.id} className={`flex flex-col gap-1 ${isInbound ? "items-end" : "items-start"}`}>
                        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                          {isInbound
                            ? <User className="w-3 h-3" />
                            : isAdminReply
                              ? <User className="w-3 h-3 text-orange-400" />
                              : <Bot className="w-3 h-3" />}
                          {isInbound ? "User" : isAdminReply ? "Admin" : "AI"}
                          · {new Date(msg.created_at).toLocaleTimeString()}
                        </div>
                        <div
                          className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                            isInbound
                              ? "bg-green-500 text-white rounded-br-sm"
                              : "bg-blue-600 text-white rounded-bl-sm"
                          }`}
                        >
                          {msg.message ?? <em className="opacity-60">empty</em>}
                        </div>
                        {msg.tool_context && Object.keys(msg.tool_context).length > 0 && (
                          <button
                            onClick={() => toggleCtx(msg.id)}
                            className="text-[10px] text-gray-400 hover:text-gray-600 underline"
                          >
                            {expandedCtx.has(msg.id) ? "hide context" : "context"}
                          </button>
                        )}
                        {expandedCtx.has(msg.id) && (
                          <pre className="text-[10px] bg-gray-100 text-gray-600 rounded p-2 max-w-[75%] overflow-x-auto">
                            {JSON.stringify(msg.tool_context, null, 2)}
                          </pre>
                        )}
                      </div>
                    )
                  })
                )}
              </div>

              {/* Reply box */}
              <div className="px-5 py-3 border-t shrink-0 flex gap-2">
                <Textarea
                  placeholder="Type a reply... (Enter to send, Shift+Enter for new line)"
                  value={reply}
                  onChange={e => setReply(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
                  }}
                  className="min-h-[40px] max-h-32 resize-none text-sm"
                  disabled={sending}
                />
                <Button
                  onClick={handleSend}
                  disabled={sending || !reply.trim()}
                  className="self-end bg-green-600 hover:bg-green-700"
                >
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
            </main>
          )}
        </div>
      </div>
    </DashboardLayout>
  )
}
