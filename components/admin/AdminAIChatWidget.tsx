"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Bot, X, Send, Trash2 } from "lucide-react"
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

const STORAGE_KEY = (uid: string) => `admin_chat_${uid}`
const MAX_STORED = 20

const hints = [
  "View platform statistics",
  "Manage orders & fulfillment",
  "Look up users & wallets",
  "Monitor all order types",
]

const mdComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }: any) => <code className="bg-gray-200 rounded px-1 text-xs font-mono">{children}</code>,
}

export function AdminAIChatWidget() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [firstName, setFirstName] = useState("")
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      tokenRef.current = session.access_token
      setUserId(session.user.id)

      const { data: profile } = await supabase
        .from("users")
        .select("first_name")
        .eq("id", session.user.id)
        .single()
      const name = profile?.first_name ?? ""
      setFirstName(name)

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
      setMessages([{
        role: "assistant",
        content: `Hi${name ? " " + name : ""}! I have access to all admin tools. Ask me about orders, users, stats, or anything else.`,
        timestamp: Date.now(),
      }])
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
        body: JSON.stringify({ messages: history, context: "admin" }),
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
    return "px-3 py-1.5 rounded-xl text-xs font-medium border border-gray-600 bg-gray-800 text-gray-100 hover:bg-gray-700 transition-colors"
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-[calc(100vw-3rem)] sm:w-[420px] h-[580px] max-h-[calc(100vh-100px)] bg-white rounded-2xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
          <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="font-semibold text-sm">Admin AI Assistant</p>
              <p className="text-gray-400 text-xs">Full platform access</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const welcome = { role: "assistant" as const, content: `Hi${firstName ? " " + firstName : ""}! I have access to all admin tools. Ask me about orders, users, stats, or anything else.`, timestamp: Date.now() }
                  setMessages([welcome])
                  setActionButtons(null)
                  if (userId) { try { localStorage.removeItem(STORAGE_KEY(userId)) } catch {} }
                }}
                className="text-gray-400 hover:text-white transition-colors"
                title="Clear chat"
              >
                <Trash2 size={15} />
              </button>
              <button onClick={() => setIsOpen(false)} className="text-gray-400 hover:text-white transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((msg, i) => (
              <ChatMessage key={i} role={msg.role} content={msg.content} variant="dark" />
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
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-thinking" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-thinking" style={{ animationDelay: "200ms" }} />
                      <span className="w-2 h-2 bg-gray-500 rounded-full animate-thinking" style={{ animationDelay: "400ms" }} />
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
              placeholder="Ask anything..."
              className="flex-1 text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 outline-none focus:border-gray-400 disabled:opacity-50 transition-colors"
            />
            <button
              onClick={() => sendMessage()}
              disabled={isStreaming || !input.trim()}
              className="bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white rounded-xl p-2 transition-colors flex-shrink-0"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {!isOpen && (
        <div className={`transition-opacity duration-300 ${hintVisible ? "opacity-100" : "opacity-0"}`}>
          <div className="bg-white/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg border border-gray-200">
            <p className="text-xs font-semibold text-gray-700 whitespace-nowrap">{hints[hintIndex]}</p>
          </div>
        </div>
      )}

      <div className="relative">
        {!isOpen && (
          <span className="absolute inset-0 rounded-full bg-gray-500 animate-ping opacity-15 pointer-events-none" />
        )}
        <button
          onClick={() => setIsOpen(o => !o)}
          className="relative bg-gradient-to-br from-gray-600 via-gray-800 to-gray-900 text-white rounded-full w-16 h-16 flex items-center justify-center shadow-xl shadow-gray-900/50 hover:shadow-gray-900/70 transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open admin AI assistant"
        >
          {isOpen ? <X size={22} /> : <Bot size={26} />}
        </button>
      </div>
    </div>
  )
}
