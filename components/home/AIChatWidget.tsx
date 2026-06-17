"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, Send, ChevronDown, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
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

const GREETING = "Hi! I'm DATAGOD's AI receptionist. Ask me anything — packages, pricing, how to sign up, or how to become a dealer. I'm here to help!"

export function HomeAIChatWidget() {
  const [isOpen, setIsOpen]             = useState(false)
  const [messages, setMessages]         = useState<Message[]>([
    { role: "assistant", content: GREETING, timestamp: Date.now() },
  ])
  const [input, setInput]               = useState("")
  const [isStreaming, setIsStreaming]   = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [hintIndex, setHintIndex]       = useState(0)
  const [hintVisible, setHintVisible]   = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const messagesEndRef    = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef          = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent, actionButtons])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100)
  }, [isOpen])

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
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-card text-muted-foreground hover:bg-accent transition-colors"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
  }

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setInput("")
    setIsStreaming(true)

    const history = nextMessages.slice(-10).map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, context: "home" }),
      })

      if (!res.ok || !res.body) throw new Error("Request failed")

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let assistantText = ""

      while (true) {
        const { done, value } = await reader.read()
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
              setStreamingContent(assistantText)
            } else if (event.type === "action_buttons") {
              setActionButtons(event.buttons as ActionButton[])
            }
          } catch {}
        }
      }

      const finalText = assistantText || "Sorry, I couldn't get a response. Please try again."
      setMessages(prev => [...prev, { role: "assistant", content: finalText, timestamp: Date.now() }])
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Connection error. Please try again.", timestamp: Date.now() }])
    } finally {
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [input, messages, isStreaming])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" onClick={() => setIsOpen(false)}>
          <div className="w-full h-full sm:h-[85vh] sm:max-h-[700px] sm:w-[420px] sm:max-w-[calc(100vw-2rem)] bg-card sm:rounded-2xl border border-primary/20 shadow-[0_24px_48px_rgba(0,0,0,0.12)] shadow-primary/10 flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="bg-gradient-to-r from-primary to-primary/80 text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="font-semibold text-sm">DATAGOD Assistant</p>
              <p className="text-primary-foreground/70 text-xs">Your AI receptionist</p>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-primary-foreground/70 hover:text-primary-foreground transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-3 relative"
          >
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}>
                  {msg.role === "assistant"
                    ? <ReactMarkdown components={mdComponents}>{msg.content}</ReactMarkdown>
                    : msg.content
                  }
                </div>
              </div>
            ))}

            {isStreaming && streamingContent && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                  <ReactMarkdown components={mdComponents}>{streamingContent}</ReactMarkdown>
                </div>
              </div>
            )}

            {isStreaming && !streamingContent && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-2xl rounded-bl-sm px-3 py-2">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            )}

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
          <div className="border-t border-border bg-card px-3 py-3 flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              placeholder="Ask me anything..."
              className="flex-1 text-sm bg-muted/40 border border-border rounded-xl px-3 py-2 outline-none focus:border-primary/80 focus:bg-card disabled:opacity-50 transition-all placeholder:text-muted-foreground"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isStreaming || !input.trim()}
              className="bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground rounded-xl p-2 transition-colors flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-24 md:bottom-6 right-6 z-50 flex flex-col items-end gap-2">
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
