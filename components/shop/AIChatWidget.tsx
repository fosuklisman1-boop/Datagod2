"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, Send, Trash2, ChevronDown, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { ChatMessage } from "@/components/ui/chat-message"

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

interface ShopPackageData {
  shop_package_id: string
  network: string
  volume_gb: number
  price: number
}

interface ActionButton {
  label: string
  value: string
  style?: "primary" | "danger" | "secondary"
}

interface Props {
  shop: { shop_name: string }
  shopSlug: string
  onCheckoutPrefill?: (pkg: ShopPackageData) => void
}

const STORAGE_KEY = (slug: string) => `storefront_chat_${slug}`
const MAX_STORED = 20

const hints = [
  "Find the perfect data bundle",
  "Check your order status",
  "Instant delivery after payment",
  "MTN · Telecel · AirtelTigo",
]

const mdComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }: any) => <code className="bg-muted rounded px-1 text-xs font-mono">{children}</code>,
}

export function AIChatWidget({ shop, shopSlug, onCheckoutPrefill }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY(shopSlug))
      if (stored) {
        const parsed = JSON.parse(stored) as Message[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(parsed)
          return
        }
      }
    } catch {}
    setMessages([{
      role: "assistant",
      content: `Hi! I'm the ${shop.shop_name} assistant. I can help you find data packages, check your order status, or answer any questions. What do you need?`,
      timestamp: Date.now(),
    }])
  }, [shopSlug, shop.shop_name])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent, actionButtons])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
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

  function persist(msgs: Message[]) {
    try {
      localStorage.setItem(STORAGE_KEY(shopSlug), JSON.stringify(msgs.slice(-MAX_STORED)))
    } catch {}
  }

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    persist(nextMessages)
    setInput("")
    setIsStreaming(true)

    const history = nextMessages.slice(-10).map(m => ({ role: m.role, content: m.content }))

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, context: "storefront", shopSlug }),
      })

      if (!res.ok || !res.body) throw new Error("Request failed")

      const reader = res.body.getReader()
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
            } else if (event.type === "checkout_prefill" && onCheckoutPrefill) {
              onCheckoutPrefill(event.data as ShopPackageData)
            } else if (event.type === "action_buttons") {
              setActionButtons(event.buttons as ActionButton[])
            } else if (event.type === "done") {
              break
            }
          } catch {}
        }
      }

      const finalText = assistantText || "Sorry, I couldn't get a response. Please try again."
      const finalMessages = [...nextMessages, { role: "assistant" as const, content: finalText, timestamp: Date.now() }]
      setMessages(finalMessages)
      persist(finalMessages)
    } catch {
      const errMessages = [...nextMessages, { role: "assistant" as const, content: "Sorry, something went wrong. Please try again.", timestamp: Date.now() }]
      setMessages(errMessages)
      persist(errMessages)
    } finally {
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [input, isStreaming, messages, shopSlug, onCheckoutPrefill])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function handleScroll() {
    const el = scrollContainerRef.current
    if (!el) return
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 60)
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  function buttonClass(style?: string) {
    if (style === "danger") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-card text-muted-foreground hover:bg-accent transition-colors"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors"
  }

  return (
    <div ref={wrapperRef} className="fixed bottom-24 md:bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-[calc(100vw-3rem)] sm:w-[360px] h-[520px] max-h-[calc(100vh-100px)] bg-card/12 backdrop-blur-3xl backdrop-saturate-150 rounded-2xl border border-white/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_0_rgba(0,0,0,0.06),0_24px_48px_rgba(0,0,0,0.14),0_4px_16px_rgba(139,92,246,0.15)] flex flex-col overflow-hidden">
          <div className="bg-violet-500/55 backdrop-blur-sm text-white px-4 py-3 flex items-center justify-between flex-shrink-0 border-b border-white/20">
            <div>
              <p className="font-semibold text-sm">{shop.shop_name}</p>
              <p className="text-violet-200 text-xs">AI Assistant</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const welcome = { role: "assistant" as const, content: `Hi! I can help you find the right data bundle or check on an existing order. What do you need?`, timestamp: Date.now() }
                  setMessages([welcome])
                  setActionButtons(null)
                  try { localStorage.removeItem(STORAGE_KEY(shopSlug)) } catch {}
                }}
                className="text-violet-200 hover:text-white transition-colors"
                title="Clear chat"
              >
                <Trash2 size={15} />
              </button>
              <button onClick={() => setIsOpen(false)} className="text-violet-200 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 relative overflow-hidden">
            <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto p-4 space-y-3">
              {messages.map((msg, i) => (
                <ChatMessage key={i} role={msg.role} content={msg.content} />
              ))}

              {isStreaming && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                    {streamingContent ? (
                      <ReactMarkdown components={mdComponents}>
                        {streamingContent + "▋"}
                      </ReactMarkdown>
                    ) : (
                      <span className="flex gap-1.5 items-center h-4">
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-thinking" style={{ animationDelay: "0ms" }} />
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-thinking" style={{ animationDelay: "200ms" }} />
                        <span className="w-2 h-2 bg-violet-500 rounded-full animate-thinking" style={{ animationDelay: "400ms" }} />
                      </span>
                    )}
                  </div>
                </div>
              )}

              {!isStreaming && actionButtons && actionButtons.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {actionButtons.map((btn, i) => (
                    <button key={i} onClick={() => sendMessage(btn.value)} className={buttonClass(btn.style)}>
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
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-violet-600/85 backdrop-blur-sm border border-violet-400/50 text-white shadow-lg hover:bg-violet-600 transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          <div className="border-t border-white/20 bg-card/8 backdrop-blur-sm px-3 py-3 flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              placeholder="Type a message..."
              className="flex-1 text-sm bg-card/30 border border-white/40 rounded-xl px-3 py-2 outline-none focus:border-violet-400/80 focus:bg-card/50 disabled:opacity-50 transition-all placeholder:text-muted-foreground text-foreground"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isStreaming || !input.trim()}
              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-xl p-2 transition-colors flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

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
            <p className="text-xs font-semibold text-violet-600 whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-violet-500 animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative flex items-center gap-2 bg-violet-700 border border-violet-400/60 text-white rounded-full px-5 py-2.5 shadow-lg shadow-violet-500/30 hover:shadow-violet-500/50 hover:bg-violet-600 hover:border-border transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open AI chat"
        >
          {isOpen
            ? <X size={18} />
            : <><Sparkles size={17} className="text-violet-200" /><span className="text-sm font-semibold">Ask</span></>
          }
        </button>
      </div>
    </div>
  )
}
