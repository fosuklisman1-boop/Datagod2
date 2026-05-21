"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { MessageCircle, X, Send } from "lucide-react"
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

interface Props {
  shop: { id: string; shop_name: string }
  shopSlug: string
  onCheckoutPrefill?: (pkg: ShopPackageData) => void
}

const STORAGE_KEY = (slug: string) => `storefront_chat_${slug}`
const MAX_STORED = 20

export function AIChatWidget({ shop, shopSlug, onCheckoutPrefill }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Restore from localStorage on mount
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
    // Welcome message on first open
    setMessages([{
      role: "assistant",
      content: `Hi! I'm the ${shop.shop_name} assistant. I can help you find data packages, check your order status, or answer any questions. What do you need?`,
      timestamp: Date.now(),
    }])
  }, [shopSlug, shop.shop_name])

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingContent])

  // Focus input when chat opens
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100)
  }, [isOpen])

  function persist(msgs: Message[]) {
    try {
      localStorage.setItem(STORAGE_KEY(shopSlug), JSON.stringify(msgs.slice(-MAX_STORED)))
    } catch {}
  }

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    persist(nextMessages)
    setInput("")
    setIsStreaming(true)
    setStreamingContent("")

    // Build Anthropic-format message history (last 20 only)
    const history = nextMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))

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
              setStreamingContent(assistantText)
            } else if (event.type === "checkout_prefill" && onCheckoutPrefill) {
              onCheckoutPrefill(event.data as ShopPackageData)
            } else if (event.type === "done") {
              break
            }
          } catch {}
        }
      }

      if (assistantText) {
        const finalMessages = [...nextMessages, { role: "assistant" as const, content: assistantText, timestamp: Date.now() }]
        setMessages(finalMessages)
        persist(finalMessages)
      }
    } catch {
      const errMessages = [...nextMessages, { role: "assistant" as const, content: "Sorry, something went wrong. Please try again.", timestamp: Date.now() }]
      setMessages(errMessages)
      persist(errMessages)
    } finally {
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [input, isStreaming, messages, shopSlug, shop.id, onCheckoutPrefill])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {/* Chat panel */}
      {isOpen && (
        <div className="w-[360px] h-[520px] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-violet-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="font-semibold text-sm">{shop.shop_name}</p>
              <p className="text-violet-200 text-xs">AI Assistant</p>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-violet-200 hover:text-white transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <ChatMessage key={i} role={msg.role} content={msg.content} />
            ))}

            {/* Streaming partial response */}
            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-gray-100 text-gray-800">
                  {streamingContent || (
                    <span className="flex gap-1 items-center h-4">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </span>
                  )}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
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
              onClick={sendMessage}
              disabled={isStreaming || !input.trim()}
              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-xl p-2 transition-colors flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={() => setIsOpen(o => !o)}
        className="bg-violet-600 hover:bg-violet-700 text-white rounded-full w-14 h-14 flex items-center justify-center shadow-lg transition-colors"
        aria-label="Open AI chat"
      >
        {isOpen ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </div>
  )
}
