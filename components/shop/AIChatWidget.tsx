"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Bot, X, Send, Trash2 } from "lucide-react"
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
  shop: { id: string; shop_name: string }
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

export function AIChatWidget({ shop, shopSlug, onCheckoutPrefill }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)
  const [typedContent, setTypedContent] = useState("")

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const charQueueRef = useRef<string[]>([])
  const typedContentRef = useRef("")
  const displayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
  }, [messages, typedContent, actionButtons])

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100)
  }, [isOpen])

  // Rotate hint text while panel is closed
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

  const drainChar = useCallback(() => {
    if (charQueueRef.current.length === 0) {
      displayTimerRef.current = null
      return
    }
    typedContentRef.current += charQueueRef.current.shift()!
    setTypedContent(typedContentRef.current)
    displayTimerRef.current = setTimeout(drainChar, 12)
  }, [])

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || isStreaming) return

    setActionButtons(null)

    // Reset typewriter state
    charQueueRef.current = []
    typedContentRef.current = ""
    setTypedContent("")
    if (displayTimerRef.current) clearTimeout(displayTimerRef.current)
    displayTimerRef.current = null

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
        body: JSON.stringify({ messages: history, context: "storefront", shopSlug, shopId: shop.id }),
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
              charQueueRef.current.push(...(event.content as string).split(""))
              if (!displayTimerRef.current) drainChar()
            } else if (event.type === "error") {
              assistantText = event.content ?? "Something went wrong. Please try again."
              charQueueRef.current.push(...assistantText.split(""))
              if (!displayTimerRef.current) drainChar()
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
      // Flush any remaining queued chars instantly
      if (charQueueRef.current.length > 0) {
        typedContentRef.current += charQueueRef.current.splice(0).join("")
        setTypedContent(typedContentRef.current)
      }
      if (displayTimerRef.current) {
        clearTimeout(displayTimerRef.current)
        displayTimerRef.current = null
      }
      setIsStreaming(false)
    }
  }, [input, isStreaming, messages, shopSlug, shop.id, onCheckoutPrefill, drainChar])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function buttonClass(style?: string) {
    if (style === "danger") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors"
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-[calc(100vw-3rem)] sm:w-[360px] h-[520px] max-h-[calc(100vh-100px)] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          <div className="bg-violet-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
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

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <ChatMessage key={i} role={msg.role} content={msg.content} />
            ))}

            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-gray-100 text-gray-800 whitespace-pre-wrap">
                  {typedContent ? (
                    <>
                      {typedContent}
                      <span className="inline-block w-[2px] h-[13px] bg-gray-500 animate-pulse ml-0.5 align-middle rounded-full" />
                    </>
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

          <div className="border-t border-gray-100 px-3 py-3 flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              placeholder="Type a message..."
              className="flex-1 text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 outline-none focus:border-violet-400 disabled:opacity-50 transition-colors"
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
        <div className={`transition-opacity duration-300 ${hintVisible ? "opacity-100" : "opacity-0"}`}>
          <div className="bg-white/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-violet-100">
            <p className="text-xs font-semibold text-violet-600 whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-violet-400 animate-ping opacity-20 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative bg-gradient-to-br from-violet-500 via-purple-600 to-violet-700 text-white rounded-full w-16 h-16 flex items-center justify-center shadow-xl shadow-violet-500/40 hover:shadow-violet-500/60 transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open AI chat"
        >
          {isOpen ? <X size={22} /> : <Bot size={26} />}
        </button>
      </div>
    </div>
  )
}
