"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, ChevronDown, RefreshCw, EyeOff } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { useDraggableFloatingPosition } from "@/hooks/use-draggable-floating-position"
import { DraftCard } from "@/components/ai/DraftCard"
import { usePathname, useRouter } from "next/navigation"
import { parseReapproveParams } from "@/lib/ai-drafts/deep-link"
import { ChatWelcome, ChatInput, HandoffButton, SuggestionChips, TypingIndicator, useAssistantProfile } from "@/components/ai/chat"
import { AssistantMarkdown } from "@/components/ai/chat/AssistantMarkdown"
import { createIdleTimeout } from "@/lib/ai-chat-ui/idle-timeout"
import { widgetVisible, isAssistantOffResponse, assistantOffMessage } from "@/lib/ai-chat-ui/widget-visibility"
import { followupsFor } from "@/lib/ai-chat-ui/suggestions"
import { pingConversationEvent } from "@/lib/ai-chat-ui/conversation-events"
import { safeClear, safeLoad, safeSave, trimHistory } from "@/lib/ai-chat-ui/history"

interface CardData {
  draftId: string
  display: unknown
  expires_at: string
  warnings?: string[]
}

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
  cards?: CardData[]
  isError?: boolean
}

async function getAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error("Not signed in")
  return session.access_token
}

interface ActionButton {
  label: string
  value?: string
  url?: string
  style?: "primary" | "danger" | "secondary"
}

const STORAGE_KEY = (uid: string) => `dashboard_chat_${uid}`
const HIDDEN_KEY = "datagod_ai_widget_hidden"
const MAX_STORED = 30
const getStorage = () => { try { return window.localStorage } catch { return null } }

const hints = [
  "Check your wallet balance",
  "Place a data order instantly",
  "View your order history",
  "Manage your account",
]

export function DashboardAIChatWidget() {
  const router = useRouter()
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const [hidden, setHidden] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(HIDDEN_KEY) === "1"
    } catch {
      return false
    }
  })
  const [messages, setMessages] = useState<Message[]>([])
  const [prefill, setPrefill] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [firstName, setFirstName] = useState("")
  const [phone, setPhone] = useState<string | null>(null)
  const [whatsapp, setWhatsapp] = useState<string | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const { name: assistantName, audiences } = useAssistantProfile()
  const [balance, setBalance] = useState<string | null>(null)
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)
  // Admin-level kill switch (app_settings.ai_widget_services) -- overrides
  // the user's own hide/show preference below. The dashboard isn't scoped to
  // any one shop's services, so it shows as long as the admin has AI enabled
  // for at least one product area; a shop/domain-restricted storefront's own
  // widget (components/shop/AIChatWidget.tsx) does the finer per-service
  // intersection check. Optimistically true so the widget doesn't flash-hide
  // while this loads; an empty admin list hides it for real once the fetch
  // resolves.
  const [adminEnabled, setAdminEnabled] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string | null>(null)
  // One key per widget session. The server uses it to link cards to this conversation.
  const conversationKeyRef = useRef<string | null>(null)
  if (conversationKeyRef.current === null && typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    conversationKeyRef.current = crypto.randomUUID()
  }
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const { position: fabPosition, containerRef: fabContainerRef, onPointerDown: onFabPointerDown, onClickCapture: onFabClickCapture } =
    useDraggableFloatingPosition("datagod_ai_widget_position")

  // /dashboard?ai=reapprove&task=<uuid> (push from the scheduled-order pause): open the widget and PREFILL
  // (never auto-send) a request to re-create that task. The owner-scoped list read supplies the old prompt.
  useEffect(() => {
    const link = parseReapproveParams(window.location.search)
    if (!link) return
    setHidden(false)
    setIsOpen(true)
    setPrefill("Re-create my scheduled data order.")
    const params = new URLSearchParams(window.location.search)
    params.delete("ai")
    params.delete("task")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    const taskId = link.taskId
    if (!taskId) return
    let cancelled = false
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        const res = await fetch("/api/admin/scheduled-tasks?scope=own", { headers: { Authorization: `Bearer ${session.access_token}` } })
        if (!res.ok || cancelled) return
        const body = await res.json()
        const task = (body?.tasks as { id: string; prompt?: string }[] | undefined)?.find(t => t.id === taskId)
        if (task?.prompt && !cancelled) setPrefill(`Re-create my scheduled order: ${task.prompt}`)
      } catch {}
    })()
    return () => { cancelled = true }
    // Runs once on mount; router/pathname are stable enough for a one-shot link read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        tokenRef.current = session.access_token
        setUserId(session.user.id)

        const [profileRes, balanceData] = await Promise.all([
          supabase.from("users").select("first_name, phone_number").eq("id", session.user.id).single(),
          fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${session.access_token}` } })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null),
        ])
        setFirstName(profileRes.data?.first_name ?? "")
        setPhone(profileRes.data?.phone_number ?? null)
        setBalance(balanceData?.balance !== undefined ? `GHS ${Number(balanceData.balance).toFixed(2)}` : null)

        const saved = safeLoad(getStorage(), STORAGE_KEY(session.user.id))
        if (Array.isArray(saved)) {
          setMessages(trimHistory(saved.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !m.isError) as Message[], MAX_STORED))
        }
      } catch {
        // No profile/history: the welcome screen still works.
      } finally {
        setHistoryLoaded(true)
      }
    }
    init()
  }, [])

  useEffect(() => {
    fetch("/api/support-config").then(r => (r.ok ? r.json() : null)).then(j => { if (j?.whatsapp) setWhatsapp(String(j.whatsapp)) }).catch(() => {})
  }, [])

  useEffect(() => {
    fetch("/api/public/config")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const services: string[] | undefined = data?.app_settings?.ai_widget_services
        if (Array.isArray(services) && services.length === 0) setAdminEnabled(false)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent, actionButtons])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsOpen(false) }
    window.addEventListener("keydown", onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) return
    const id = setInterval(() => {
      setHintVisible(false)
      setTimeout(() => {
        setHintIndex(i => (i + 1) % hints.length)
        setHintVisible(true)
      }, 300)
    }, 3000)
    return () => clearInterval(id)
  }, [isOpen])

  // History lives on this device only (per user). Error bubbles are never saved.
  useEffect(() => {
    if (!historyLoaded || !userId || isStreaming) return
    const key = STORAGE_KEY(userId)
    if (messages.length === 0) safeClear(getStorage(), key)
    else safeSave(getStorage(), key, trimHistory(messages.filter(m => !m.isError), MAX_STORED))
  }, [messages, historyLoaded, userId, isStreaming])

  function newChat() {
    if (isStreaming) return
    setMessages([])
    setActionButtons(null)
    // A fresh key: cards from the old chat can no longer be linked to this one.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") conversationKeyRef.current = crypto.randomUUID()
  }

  function retryLast() {
    if (isStreaming) return
    const idx = messages.map(m => m.role).lastIndexOf("user")
    if (idx < 0) return
    sendMessage(messages[idx].content, messages.slice(0, idx))
  }

  const sendingRef = useRef(false)

  const sendMessageInner = useCallback(async (text: string, baseMessages?: Message[]) => {
    text = text.trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    tokenRef.current = session.access_token

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...(baseMessages ?? messages), userMsg]
    setMessages(nextMessages)
    setIsStreaming(true)

    const history = nextMessages.filter(m => !m.isError).slice(-10).map(m => ({ role: m.role, content: m.content }))

    const ctrl = new AbortController()
    // Idle timeout: abort only after 60 s with no bytes; every chunk resets it.
    const idle = createIdleTimeout(60_000, () => ctrl.abort())
    const cards: CardData[] = []
    try {
      const res = await fetch("/api/ai/chat", {
        signal: ctrl.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ messages: history, context: "dashboard", ...(conversationKeyRef.current ? { conversationKey: conversationKeyRef.current } : {}) }),
      })

      if (!res.ok && (await isAssistantOffResponse(res))) {
        setMessages(prev => [...prev, assistantOffMessage()])
        return
      }
      if (!res.ok || !res.body) throw new Error("Request failed")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let assistantText = ""
      let streamError = false

      while (true) {
        const { done, value } = await reader.read()
        idle.reset()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const parts = buffer.split("\n\n")
        buffer = parts.pop() ?? ""

        for (const part of parts) {
          const line = part.startsWith("data: ") ? part.slice(6) : part
          if (!line) continue
          try {
            const event = JSON.parse(line)
            if (event.type === "text") {
              assistantText += event.content
              setStreamingContent(assistantText)
            } else if (event.type === "error") {
              assistantText = event.content ?? "Something went wrong. Please try again."
              streamError = true
              setStreamingContent(assistantText)
            } else if (event.type === "action_buttons") {
              setActionButtons(event.buttons as ActionButton[])
            } else if (event.type === "draft_card" && typeof event.draft_id === "string") {
              cards.push({ draftId: event.draft_id, display: event.display, expires_at: event.expires_at, warnings: Array.isArray(event.warnings) ? event.warnings : [] })
            } else if (event.type === "done") {
              break
            }
          } catch {}
        }
      }

      const finalText = assistantText || (cards.length > 0 ? "Please check the details below." : "Sorry, I couldn't get a response. Please try again.")
      const finalMessages = [...nextMessages, { role: "assistant" as const, content: finalText, timestamp: Date.now(), ...(streamError ? { isError: true } : {}), ...(cards.length > 0 ? { cards } : {}) }]
      setMessages(finalMessages)
    } catch {
      pingConversationEvent(conversationKeyRef.current, "error")
      setMessages([...nextMessages, { role: "assistant" as const, content: "Something went wrong.", timestamp: Date.now(), isError: true, ...(cards.length > 0 ? { cards } : {}) }])
    } finally {
      idle.clear()
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [isStreaming, messages])

  // Check-and-set synchronously so a double-tap can never start two requests.
  const sendMessage = useCallback(async (text: string, baseMessages?: Message[]) => {
    if (sendingRef.current) return
    sendingRef.current = true
    try {
      await sendMessageInner(text, baseMessages)
    } finally {
      sendingRef.current = false
    }
  }, [sendMessageInner])

  function handleScroll() {
    const el = scrollContainerRef.current
    if (!el) return
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 60)
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  function buttonClass(style?: string) {
    if (style === "danger") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-white/60 dark:border-white/5 bg-card text-muted-foreground hover:bg-accent transition-colors clay"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
  }

  if (!adminEnabled || !widgetVisible("dashboard", audiences)) return null

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" onClick={() => setIsOpen(false)}>
          <div className="w-full h-full sm:h-[85vh] sm:max-h-[700px] sm:w-[440px] sm:max-w-[calc(100vw-2rem)] bg-card sm:rounded-2xl border border-border shadow-[0_24px_48px_rgba(0,0,0,0.14)] shadow-primary/10 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="bg-primary text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0 border-b border-border">
            <div>
              <p className="font-semibold text-sm">{assistantName}</p>
              {balance && <p className="text-primary-foreground opacity-90 text-xs">Wallet: {balance}</p>}
            </div>
            <div className="flex items-center gap-3">
              <HandoffButton mode="thread" messages={messages} conversationKey={conversationKeyRef.current} getToken={getAccessToken} phone={phone} whatsappNumber={whatsapp} noticeClassName="max-w-[9rem] text-[11px] leading-tight text-primary-foreground" className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground" />
              {messages.length > 0 && (
                <button onClick={newChat} disabled={isStreaming} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground disabled:opacity-50">New chat</button>
              )}
              <button onClick={() => setIsOpen(false)} aria-label="Close chat" className="text-primary-foreground hover:opacity-80 transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden">
            <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && !isStreaming && (
                <ChatWelcome context="dashboard" name={assistantName} firstName={firstName} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
              )}

              {messages.map((msg, i) => (
                <div key={i} className="space-y-2">
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}>
                      {msg.role === "assistant" ? <AssistantMarkdown text={msg.content} /> : msg.content}
                      {msg.isError && (
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <button onClick={retryLast} disabled={isStreaming} className="text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">Try again</button>
                          <HandoffButton mode="thread" messages={messages} conversationKey={conversationKeyRef.current} getToken={getAccessToken} phone={phone} whatsappNumber={whatsapp} />
                        </div>
                      )}
                    </div>
                  </div>
                  {msg.cards?.map((c) => (
                    <DraftCard
                      key={c.draftId}
                      draftId={c.draftId}
                      initial={{ display: c.display, expires_at: c.expires_at, warnings: c.warnings }}
                      getToken={getAccessToken}
                      onPrepareAgain={() => sendMessage("Please prepare that again.")}
                    />
                  ))}
                </div>
              ))}

              {!isStreaming && !actionButtons && messages.length > 0 && messages[messages.length - 1].role === "assistant" && !messages[messages.length - 1].isError && !messages[messages.length - 1].cards?.length && (
                <SuggestionChips chips={followupsFor("dashboard")} onPick={(t) => sendMessage(t)} label="Follow-up questions" />
              )}

              {isStreaming && streamingContent && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                    <AssistantMarkdown text={streamingContent} chips={false} />
                  </div>
                </div>
              )}

              {isStreaming && !streamingContent && <TypingIndicator name={assistantName} />}

              {!isStreaming && actionButtons && actionButtons.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {actionButtons.map((btn, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        if (btn.url) {
                          window.location.href = btn.url
                        } else if (btn.value) {
                          sendMessage(btn.value)
                        }
                      }}
                      className={buttonClass(btn.style)}
                    >
                      {btn.label}
                    </button>
                  ))}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {showScrollBtn && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-primary/85 backdrop-blur-sm border border-primary/50 text-primary-foreground shadow-lg hover:bg-primary transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          <ChatInput autoFocus name={assistantName} onSend={(t) => sendMessage(t)} disabled={isStreaming} prefill={prefill} />
          </div>
        </div>
      )}

      {!hidden && (
      <div
        ref={fabContainerRef}
        onPointerDown={onFabPointerDown}
        onClickCapture={onFabClickCapture}
        style={fabPosition ? { position: "fixed", top: fabPosition.top, left: fabPosition.left } : undefined}
        className={
          (fabPosition ? "fixed z-50" : "fixed bottom-32 md:bottom-10 right-6 z-50") +
          " flex flex-col items-end gap-2 cursor-grab active:cursor-grabbing touch-none select-none"
        }
      >
      {!isOpen && (
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 bg-card/90 backdrop-blur-sm border border-border text-muted-foreground rounded-full px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-accent hover:text-foreground transition-all active:scale-95"
          aria-label="Hard refresh page"
          title="Hard refresh"
        >
          <RefreshCw size={11} />
          <span>Refresh</span>
        </button>
      )}

      {!isOpen && (
        <div className={`transition-opacity duration-300 ${hintVisible ? "opacity-100" : "opacity-0"}`}>
          <div className="bg-card/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-border">
            <p className="text-xs font-semibold text-primary whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-15 pointer-events-none" />
        )}
        {!isOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              setHidden(true)
              try { localStorage.setItem(HIDDEN_KEY, "1") } catch {}
            }}
            className="absolute -left-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-white/60 dark:border-white/5 bg-card text-muted-foreground  hover:bg-destructive/10 hover:text-destructive transition-colors clay-sm"
            aria-label="Hide AI assistant button"
            title="Hide this button"
          >
            <X size={11} />
          </button>
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative flex items-center gap-2 bg-primary border border-primary/60 text-primary-foreground rounded-full px-5 py-2.5 shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:bg-primary/90 hover:border-border transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open AI assistant"
        >
          {isOpen
            ? <X size={18} />
            : <><Sparkles size={17} className="text-primary-foreground/70" /><span className="text-sm font-semibold">Ask</span></>
          }
        </button>
      </div>
      </div>
      )}

      {hidden && (
        <button
          onClick={() => {
            setHidden(false)
            try { localStorage.removeItem(HIDDEN_KEY) } catch {}
          }}
          className="fixed bottom-32 md:bottom-10 right-6 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card/90 backdrop-blur-sm text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground transition-all active:scale-95"
          aria-label="Show AI assistant button"
          title="Show AI assistant"
        >
          <EyeOff size={15} />
        </button>
      )}
    </>
  )
}
