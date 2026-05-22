"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Sparkles, X, Send, Trash2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { createClient } from "@supabase/supabase-js"
import { ChatMessage } from "@/components/ui/chat-message"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

interface ActionButton {
  label: string
  value: string
  style?: "primary" | "danger" | "secondary"
}

const STORAGE_KEY = (uid: string) => `dashboard_chat_${uid}`
const MAX_STORED = 20

const hints = [
  "Check your wallet balance",
  "Place a data order instantly",
  "View your order history",
  "Manage your account",
]

const mdComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }: any) => <code className="bg-gray-200 rounded px-1 text-xs font-mono">{children}</code>,
}

export function DashboardAIChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [firstName, setFirstName] = useState("")
  const [balance, setBalance] = useState<string | null>(null)
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      tokenRef.current = session.access_token
      setUserId(session.user.id)

      const [profileRes, balanceRes] = await Promise.all([
        supabase.from("users").select("first_name").eq("id", session.user.id).single(),
        fetch("/api/wallet/balance", { headers: { Authorization: `Bearer ${session.access_token}` } })
          .then(r => r.json()),
      ])
      const name = profileRes.data?.first_name ?? ""
      const bal = balanceRes.balance !== undefined ? `GHS ${Number(balanceRes.balance).toFixed(2)}` : null
      setFirstName(name)
      setBalance(bal)

      try {
        const stored = localStorage.getItem(STORAGE_KEY(session.user.id))
        if (stored) {
          const parsed = JSON.parse(stored) as Message[]
          if (Array.isArray(parsed) && parsed.length > 0) {
            setMessages(parsed)
            return
          }
        }
      } catch {}
      const greeting = bal
        ? `Hi${name ? " " + name : ""}! Your wallet balance is ${bal}. I can help you buy data, check your orders, or answer any questions.`
        : `Hi${name ? " " + name : ""}! I can help you buy data, check your orders, or answer any questions.`
      setMessages([{ role: "assistant", content: greeting, timestamp: Date.now() }])
    }
    init()
  }, [])

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
    if (!userId) return
    try {
      localStorage.setItem(STORAGE_KEY(userId), JSON.stringify(msgs.slice(-MAX_STORED)))
    } catch {}
  }

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText !== undefined ? overrideText : input).trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    tokenRef.current = session.access_token

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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenRef.current}`,
        },
        body: JSON.stringify({ messages: history, context: "dashboard" }),
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
  }, [input, isStreaming, messages, userId])

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
    <div ref={wrapperRef} className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-[calc(100vw-3rem)] sm:w-[380px] h-[520px] max-h-[calc(100vh-100px)] bg-white/12 backdrop-blur-3xl backdrop-saturate-150 rounded-2xl border border-white/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_0_rgba(0,0,0,0.06),0_24px_48px_rgba(0,0,0,0.14),0_4px_16px_rgba(99,102,241,0.15)] flex flex-col overflow-hidden">
          <div className="bg-violet-500/55 backdrop-blur-sm text-white px-4 py-3 flex items-center justify-between flex-shrink-0 border-b border-white/20">
            <div>
              <p className="font-semibold text-sm">Datagod Assistant</p>
              {balance && <p className="text-violet-200 text-xs">Wallet: {balance}</p>}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const welcome = { role: "assistant" as const, content: `Hi${firstName ? " " + firstName : ""}! Your wallet balance is ${balance ?? "loading..."}. I can help you buy data, check your orders, or answer any questions.`, timestamp: Date.now() }
                  setMessages([welcome])
                  setActionButtons(null)
                  if (userId) { try { localStorage.removeItem(STORAGE_KEY(userId)) } catch {} }
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
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-gray-100 text-gray-800">
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

          <div className="border-t border-white/20 bg-white/8 backdrop-blur-sm px-3 py-3 flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              placeholder="Type a message..."
              className="flex-1 text-sm bg-white/30 border border-white/40 rounded-xl px-3 py-2 outline-none focus:border-violet-400/80 focus:bg-white/50 disabled:opacity-50 transition-all placeholder:text-gray-500 text-gray-800"
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
          <span className="absolute inset-0 rounded-full bg-indigo-500 animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative flex items-center gap-2 bg-indigo-700 border border-indigo-400/60 text-white rounded-full px-5 py-2.5 shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:bg-indigo-600 hover:border-indigo-300 transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open AI assistant"
        >
          {isOpen
            ? <X size={18} />
            : <><Sparkles size={17} className="text-indigo-200" /><span className="text-sm font-semibold">Ask</span></>
          }
        </button>
      </div>
    </div>
  )
}
