"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, ChevronDown, RefreshCw } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { useDraggableFloatingPosition } from "@/hooks/use-draggable-floating-position"
import { usePathname, useRouter } from "next/navigation"
import { DraftCard } from "@/components/ai/DraftCard"
import { parseDraftParam } from "@/lib/ai-drafts/deep-link"
import { ChatWelcome, ChatInput, SuggestionChips, TypingIndicator, useAssistantProfile, VoiceCallButtons, CallPanel, useVoiceCall } from "@/components/ai/chat"
import { callToMessages } from "@/lib/ai-voice/call-messages"
import { closeWidgetDuringCall, type CloseSource } from "@/lib/ai-voice/close-widget"
import { AssistantMarkdown } from "@/components/ai/chat/AssistantMarkdown"
import { createIdleTimeout } from "@/lib/ai-chat-ui/idle-timeout"
import { widgetVisible, isAssistantOffResponse, assistantOffMessage, showTryAgain } from "@/lib/ai-chat-ui/widget-visibility"
import { followupsFor } from "@/lib/ai-chat-ui/suggestions"
import { historyKey, safeClear, safeLoad, safeSave, trimHistory } from "@/lib/ai-chat-ui/history"
import { scrollToEnd } from "@/lib/ai-chat-ui/scroll"

interface CardData {
  draftId: string
  status?: string
  outcome?: Record<string, unknown> | null
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

const MAX_STORED = 30
const getStorage = () => { try { return window.localStorage } catch { return null } }

const hints = [
  "View platform statistics",
  "Manage orders & fulfillment",
  "Look up users & wallets",
  "Monitor all order types",
]

export function AdminAIChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  // A card opened from a push notification (?draft=<uuid>). The GET route is owner-scoped, so a non-owned id is "not found".
  const [linkedCard, setLinkedCard] = useState<{ id: string; card: CardData | null; missing: boolean } | null>(null)

  useEffect(() => {
    const id = parseDraftParam(window.location.search)
    if (!id) return
    setIsOpen(true)
    setLinkedCard({ id, card: null, missing: false })
    // Drop the param so a refresh does not re-open the card.
    const params = new URLSearchParams(window.location.search)
    params.delete("draft")
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    let cancelled = false
    ;(async () => {
      try {
        const token = await getAccessToken()
        const res = await fetch(`/api/ai/drafts/${id}`, { headers: { Authorization: `Bearer ${token}` } })
        if (cancelled) return
        if (!res.ok) return setLinkedCard({ id, card: null, missing: true })
        const s = await res.json()
        setLinkedCard({ id, card: { draftId: id, status: s.status, outcome: s.outcome ?? null, display: s.display, expires_at: s.expires_at }, missing: false })
      } catch {
        if (!cancelled) setLinkedCard({ id, card: null, missing: true })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [firstName, setFirstName] = useState("")
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const { name: assistantName, audiences, voice } = useAssistantProfile()
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const tokenRef = useRef<string | null>(null)
  // One key per widget session. The server uses it to link cards to this conversation.
  const conversationKeyRef = useRef<string | null>(null)
  if (conversationKeyRef.current === null && typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    conversationKeyRef.current = crypto.randomUUID()
  }

  const call = useVoiceCall({
    context: "admin",
    assistantName,
    authHeader: async () => `Bearer ${await getAccessToken()}`,
    conversationKey: () => conversationKeyRef.current,
    onCallEnded: (turns, cards) => setMessages(prev => [...prev, ...callToMessages(turns, cards, Date.now())]),
  })
  const callOpen = call.state === "starting" || call.state === "live"
  // Every close path hangs up a live call first (mic + slot), and a backdrop tap never drops one.
  function closeChat(source: CloseSource) {
    closeWidgetDuringCall({ callActive: call.isActive(), source, hangUp: call.hangUp, close: () => setIsOpen(false) })
  }
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const { position: fabPosition, containerRef: fabContainerRef, onPointerDown: onFabPointerDown, onClickCapture: onFabClickCapture } =
    useDraggableFloatingPosition("datagod_ai_widget_position")

  useEffect(() => {
    async function init() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) return
        tokenRef.current = session.access_token
        setUserId(session.user.id)

        const { data: profile } = await supabase
          .from("users")
          .select("first_name")
          .eq("id", session.user.id)
          .single()
        setFirstName(profile?.first_name ?? "")

        const saved = safeLoad(getStorage(), historyKey("admin", { userId: session.user.id }))
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
    scrollToEnd(scrollContainerRef.current)
  }, [messages, streamingContent, actionButtons])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeChat("escape") }
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

  // History lives on this device only (per admin user). Error bubbles are never saved.
  useEffect(() => {
    if (!historyLoaded || !userId || isStreaming) return
    const key = historyKey("admin", { userId })
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
        body: JSON.stringify({ messages: history, context: "admin", ...(conversationKeyRef.current ? { conversationKey: conversationKeyRef.current } : {}) }),
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
    scrollToEnd(scrollContainerRef.current)
  }

  function buttonClass(style?: string) {
    if (style === "danger") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-white/60 dark:border-white/5 bg-card text-muted-foreground hover:bg-accent transition-colors clay"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
  }

  if (!widgetVisible("admin", audiences)) return null

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" onClick={() => closeChat("backdrop")}>
          <div className={`w-full h-full sm:h-[85vh] sm:max-h-[700px] sm:w-[460px] sm:max-w-[calc(100vw-2rem)] bg-card sm:rounded-2xl border border-border shadow-[0_32px_64px_rgba(0,0,0,0.35)] flex flex-col overflow-hidden ${callOpen ? "lg:w-[880px]" : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className="bg-primary text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0 border-b border-border">
            <div>
              <p className="font-semibold text-sm">{assistantName}</p>
              <p className="text-primary-foreground opacity-90 text-xs">Full platform access</p>
            </div>
            <div className="flex items-center gap-3">
              {voice.admin && !call.blocked && <VoiceCallButtons onStart={call.start} disabled={isStreaming || callOpen} />}
              {messages.length > 0 && (
                <button onClick={newChat} disabled={isStreaming} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:text-primary-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground disabled:opacity-50">New chat</button>
              )}
              <button onClick={() => closeChat("button")} aria-label="Close chat" className="text-primary-foreground hover:opacity-80 transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          {callOpen ? (
            <CallPanel call={call} name={assistantName} getToken={getAccessToken} />
          ) : (<>
          <div className="flex-1 min-h-0 relative overflow-hidden">
            <div ref={scrollContainerRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto overscroll-contain p-4 space-y-3 bg-transparent">
              {linkedCard && (
                <div className="space-y-2">
                  {linkedCard.card ? (
                    <DraftCard
                      key={linkedCard.id}
                      draftId={linkedCard.id}
                      initial={{ display: linkedCard.card.display, expires_at: linkedCard.card.expires_at, status: linkedCard.card.status, outcome: linkedCard.card.outcome }}
                      getToken={getAccessToken}
                    />
                  ) : linkedCard.missing ? (
                    <p className="text-sm text-muted-foreground">This card is no longer available.</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Loading card…</p>
                  )}
                </div>
              )}
              {messages.length === 0 && !isStreaming && !linkedCard && (
                <ChatWelcome context="admin" name={assistantName} firstName={firstName} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
              )}

              {messages.map((msg, i) => (
                <div key={i} className="space-y-2">
                  <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-card text-foreground border border-border rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}>
                      {msg.role === "assistant" ? <AssistantMarkdown text={msg.content} /> : msg.content}
                      {msg.isError && (
                        <div className="mt-2">
                          {showTryAgain(msg) && <button onClick={retryLast} disabled={isStreaming} className="text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">Try again</button>}
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
                <SuggestionChips chips={followupsFor("admin")} onPick={(t) => sendMessage(t)} label="Follow-up questions" />
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
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-muted backdrop-blur-sm border border-border text-foreground shadow-lg hover:bg-accent transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          {call.endMessage && <p role="status" className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{call.endMessage}</p>}
          <ChatInput autoFocus name={assistantName} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
          </>)}
          </div>
        </div>
      )}

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
            <p className="text-xs font-semibold text-foreground whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => (isOpen ? closeChat("button") : setIsOpen(true))}
          className="relative flex items-center gap-2 bg-primary border border-primary/60 text-primary-foreground rounded-full px-5 py-2.5 shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:bg-primary/90 hover:border-border transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open admin AI assistant"
        >
          {isOpen
            ? <X size={18} />
            : <><Sparkles size={17} className="text-primary-foreground/70" /><span className="text-sm font-semibold">Ask</span></>
          }
        </button>
      </div>
      </div>
    </>
  )
}
