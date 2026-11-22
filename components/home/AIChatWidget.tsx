"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, ChevronDown, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useDraggableFloatingPosition } from "@/hooks/use-draggable-floating-position"
import { ChatWelcome, ChatInput, HandoffButton, MessageText, CopyAnnounceProvider, SuggestionChips, TypingIndicator, useAssistantProfile } from "@/components/ai/chat"
import { createIdleTimeout } from "@/lib/ai-chat-ui/idle-timeout"
import { widgetVisible, isAssistantOffResponse, assistantOffMessage, showTryAgain } from "@/lib/ai-chat-ui/widget-visibility"
import { followupsFor } from "@/lib/ai-chat-ui/suggestions"
import { newConversationKey, pingConversationEvent } from "@/lib/ai-chat-ui/conversation-events"
import { historyKey, safeClear, safeLoad, safeSave, trimHistory } from "@/lib/ai-chat-ui/history"

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
  isError?: boolean
}

interface ActionButton {
  label: string
  value?: string
  url?: string
  style?: "primary" | "danger" | "secondary"
}

const hints = [
  "What data packages do you offer?",
  "How do I become a dealer?",
  "How does payment work?",
  "How fast is data delivery?",
]

const mdComponents = {
  p:      ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  ul:     ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol:     ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  li:     ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code:   ({ children }: any) => <code className="bg-muted rounded px-1 text-xs font-mono">{children}</code>,
}

const HISTORY_KEY = historyKey("home", {})
const getStorage = () => { try { return window.localStorage } catch { return null } }

/** Turns plain-string markdown children into copy-chip text; other nodes pass through. */
function wrapChips(children: React.ReactNode): React.ReactNode {
  return Array.isArray(children)
    ? children.map((c, i) => (typeof c === "string" ? <MessageText key={i} text={c} /> : c))
    : typeof children === "string" ? <MessageText text={children} /> : children
}

const chipMdComponents = {
  ...mdComponents,
  p:  ({ children }: any) => <p className="mb-1 last:mb-0">{wrapChips(children)}</p>,
  li: ({ children }: any) => <li>{wrapChips(children)}</li>,
}

export function HomeAIChatWidget() {
  const [isOpen, setIsOpen]             = useState(false)
  const [messages, setMessages]         = useState<Message[]>([])
  const [isStreaming, setIsStreaming]   = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [hintIndex, setHintIndex]       = useState(0)
  const [hintVisible, setHintVisible]   = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [whatsapp, setWhatsapp]         = useState<string | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const { name: assistantName, audiences } = useAssistantProfile()

  useEffect(() => {
    const saved = safeLoad(getStorage(), HISTORY_KEY)
    if (Array.isArray(saved)) {
      setMessages(trimHistory(saved.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !m.isError) as Message[], 30))
    }
    setHistoryLoaded(true)
    fetch("/api/support-config").then(r => (r.ok ? r.json() : null)).then(j => { if (j?.whatsapp) setWhatsapp(String(j.whatsapp)) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!historyLoaded || isStreaming) return
    safeSave(getStorage(), HISTORY_KEY, trimHistory(messages.filter(m => !m.isError), 30))
  }, [messages, historyLoaded, isStreaming])

  function newChat() {
    if (isStreaming) return
    setMessages([])
    setActionButtons(null)
    safeClear(getStorage(), HISTORY_KEY)
    conversationKeyRef.current = newConversationKey()
  }

  function retryLast() {
    if (isStreaming) return
    const idx = messages.map(m => m.role).lastIndexOf("user")
    if (idx < 0) return
    sendMessage(messages[idx].content, messages.slice(0, idx))
  }

  const messagesEndRef    = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const { position: fabPosition, containerRef: fabContainerRef, onPointerDown: onFabPointerDown, onClickCapture: onFabClickCapture } =
    useDraggableFloatingPosition("datagod_ai_widget_position")

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

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const onScroll = () => {
      setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 80)
    }
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  function getButtonClass(style?: string) {
    if (style === "primary")   return "px-3 py-1.5 rounded-xl text-xs font-medium border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
    if (style === "danger")    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-white/60 dark:border-white/5 bg-card text-muted-foreground hover:bg-accent transition-colors clay"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
  }

  const sendingRef = useRef(false)
  // One key per chat session; the server groups this chat's transcript turns under it.
  const conversationKeyRef = useRef<string | null>(null)
  if (conversationKeyRef.current === null) conversationKeyRef.current = newConversationKey()

  const sendMessageInner = useCallback(async (overrideText?: string, baseMessages?: Message[]) => {
    const text = (overrideText ?? "").trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...(baseMessages ?? messages), userMsg]
    setMessages(nextMessages)
    setIsStreaming(true)

    const history = nextMessages.filter(m => !m.isError).slice(-10).map(m => ({ role: m.role, content: m.content }))

    const ctrl = new AbortController()
    // Idle timeout: abort only after 60 s with no bytes; every chunk resets it.
    const idle = createIdleTimeout(60_000, () => ctrl.abort())
    try {
      const res = await fetch("/api/ai/chat", {
        signal: ctrl.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, context: "home", ...(conversationKeyRef.current ? { conversationKey: conversationKeyRef.current } : {}) }),
      })

      if (!res.ok && (await isAssistantOffResponse(res))) {
        setMessages(prev => [...prev, assistantOffMessage()])
        return
      }
      if (!res.ok || !res.body) throw new Error("Request failed")

      const reader  = res.body.getReader()
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
            }
          } catch {}
        }
      }

      const finalText = assistantText || "Sorry, I couldn't get a response. Please try again."
      setMessages(prev => [...prev, { role: "assistant", content: finalText, timestamp: Date.now(), ...(streamError ? { isError: true } : {}) }])
    } catch {
      pingConversationEvent(conversationKeyRef.current, "error")
      setMessages(prev => [...prev, { role: "assistant", content: "Something went wrong.", timestamp: Date.now(), isError: true }])
    } finally {
      idle.clear()
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [messages, isStreaming])

  // Check-and-set synchronously so a double-tap can never start two requests.
  const sendMessage = useCallback(async (overrideText?: string, baseMessages?: Message[]) => {
    if (sendingRef.current) return
    sendingRef.current = true
    try {
      await sendMessageInner(overrideText, baseMessages)
    } finally {
      sendingRef.current = false
    }
  }, [sendMessageInner])

  if (!widgetVisible("home", audiences)) return null

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" onClick={() => setIsOpen(false)}>
          <div className="w-full h-full sm:h-[85vh] sm:max-h-[700px] sm:w-[420px] sm:max-w-[calc(100vw-2rem)] bg-card sm:rounded-2xl border border-primary/20 shadow-[0_24px_48px_rgba(0,0,0,0.12)] shadow-primary/10 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="bg-primary text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="font-semibold text-sm">{assistantName}</p>
              <p className="text-primary-foreground opacity-90 text-xs">Your AI receptionist</p>
            </div>
            <div className="flex items-center gap-3">
              <HandoffButton mode="whatsapp" messages={messages} conversationKey={conversationKeyRef.current} whatsappNumber={whatsapp} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground" />
              {messages.length > 0 && (
                <button onClick={newChat} disabled={isStreaming} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground disabled:opacity-50">New chat</button>
              )}
              <button onClick={() => setIsOpen(false)} aria-label="Close chat" className="text-primary-foreground hover:opacity-80 transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-3 relative"
          >
            {messages.length === 0 && !isStreaming && (
              <ChatWelcome context="home" name={assistantName} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}>
                  {msg.role === "assistant"
                    ? <CopyAnnounceProvider><ReactMarkdown components={chipMdComponents}>{msg.content}</ReactMarkdown></CopyAnnounceProvider>
                    : msg.content
                  }
                  {msg.isError && (
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      {showTryAgain(msg) && <button onClick={retryLast} disabled={isStreaming} className="text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">Try again</button>}
                      <HandoffButton mode="whatsapp" messages={messages} conversationKey={conversationKeyRef.current} whatsappNumber={whatsapp} />
                    </div>
                  )}
                </div>
              </div>
            ))}

            {!isStreaming && !actionButtons && messages.length > 0 && messages[messages.length - 1].role === "assistant" && !messages[messages.length - 1].isError && (
              <SuggestionChips chips={followupsFor("home").filter(c => c !== "Talk to a person")} onPick={(t) => sendMessage(t)} label="Follow-up questions" />
            )}

            {isStreaming && streamingContent && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                  <ReactMarkdown components={mdComponents}>{streamingContent}</ReactMarkdown>
                </div>
              </div>
            )}

            {isStreaming && !streamingContent && <TypingIndicator name={assistantName} />}

            {actionButtons && (
              <div className="flex flex-wrap gap-2 justify-end">
                {actionButtons.map((btn, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setActionButtons(null)
                      if (btn.url) {
                        // Only allow same-origin absolute URLs or relative paths — never javascript: or external redirects
                        const isRelative = btn.url.startsWith("/")
                        const isSameOrigin = (() => { try { return new URL(btn.url).origin === window.location.origin } catch { return false } })()
                        if (isRelative || isSameOrigin) window.location.href = btn.url
                      } else if (btn.value) sendMessage(btn.value)
                    }}
                    className={getButtonClass(btn.style)}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            )}

            {showScrollBtn && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-primary/85 backdrop-blur-sm border border-primary/50 text-primary-foreground shadow-lg hover:bg-primary/90 transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <ChatInput autoFocus name={assistantName} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
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
      {/* Refresh button — hidden when chat is open */}
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

      {/* Rotating hint pill */}
      {!isOpen && (
        <div className={`transition-opacity duration-300 ${hintVisible ? "opacity-100" : "opacity-0"}`}>
          <div className="bg-card/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-primary/20">
            <p className="text-xs font-semibold text-primary whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative flex items-center gap-2 bg-primary border border-primary/60 text-primary-foreground rounded-full px-5 py-2.5 shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:bg-primary hover:border-border transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open DATAGOD AI assistant"
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
