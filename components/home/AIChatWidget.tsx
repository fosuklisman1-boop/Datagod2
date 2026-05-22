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
  code:   ({ children }: any) => <code className="bg-gray-200 rounded px-1 text-xs font-mono">{children}</code>,
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
  const wrapperRef        = useRef<HTMLDivElement>(null)

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
    if (style === "primary")   return "px-3 py-1.5 rounded-xl text-xs font-medium border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
    if (style === "danger")    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors"
    if (style === "secondary") return "px-3 py-1.5 rounded-xl text-xs font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
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
    <div ref={wrapperRef} className="fixed bottom-24 md:bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-[calc(100vw-3rem)] sm:w-[360px] h-[500px] max-h-[calc(100vh-120px)] bg-white rounded-2xl border border-blue-100 shadow-[0_24px_48px_rgba(0,0,0,0.12),0_4px_16px_rgba(59,130,246,0.12)] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="font-semibold text-sm">DATAGOD Assistant</p>
              <p className="text-blue-200 text-xs">Your AI receptionist</p>
            </div>
            <button onClick={() => setIsOpen(false)} className="text-blue-200 hover:text-white transition-colors">
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
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-gray-100 text-gray-800 rounded-bl-sm"
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
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-gray-100 text-gray-800">
                  <ReactMarkdown components={mdComponents}>{streamingContent}</ReactMarkdown>
                </div>
              </div>
            )}

            {isStreaming && !streamingContent && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-3 py-2">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
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
                      if (btn.url) { window.location.href = btn.url }
                      else if (btn.value) sendMessage(btn.value)
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
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-blue-600/85 backdrop-blur-sm border border-blue-400/50 text-white shadow-lg hover:bg-blue-600 transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-gray-100 bg-white px-3 py-3 flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              placeholder="Ask me anything..."
              className="flex-1 text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 outline-none focus:border-blue-400 focus:bg-white disabled:opacity-50 transition-all placeholder:text-gray-400"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isStreaming || !input.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-xl p-2 transition-colors flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Refresh button — hidden when chat is open */}
      {!isOpen && (
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 bg-white/90 backdrop-blur-sm border border-gray-200 text-gray-500 rounded-full px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-gray-50 hover:text-gray-700 transition-all active:scale-95"
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
          <div className="bg-white/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-blue-100">
            <p className="text-xs font-semibold text-blue-600 whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      {/* Toggle button */}
      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative flex items-center gap-2 bg-blue-600 border border-blue-400/60 text-white rounded-full px-5 py-2.5 shadow-lg shadow-blue-500/30 hover:shadow-blue-500/50 hover:bg-blue-500 hover:border-blue-300 transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open DATAGOD AI assistant"
        >
          {isOpen
            ? <X size={18} />
            : <><Sparkles size={17} className="text-blue-200" /><span className="text-sm font-semibold">Ask</span></>
          }
        </button>
      </div>
    </div>
  )
}
