"use client"

import { useState, useRef, useEffect, useCallback, useMemo } from "react"
import { Sparkles, X, ChevronDown, RefreshCw, EyeOff } from "lucide-react"
import ReactMarkdown from "react-markdown"
import { useDraggableFloatingPosition } from "@/hooks/use-draggable-floating-position"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { ChatWelcome, ChatInput, HandoffButton, MessageText, CopyAnnounceProvider, SuggestionChips, TypingIndicator, useAssistantProfile, VoiceCallButtons, CallPanel, QueueWaitPanel, useVoiceCall } from "@/components/ai/chat"
import { callToMessages } from "@/lib/ai-voice/call-messages"
import { closeWidgetDuringCall, type CloseSource } from "@/lib/ai-voice/close-widget"
import { whatsappHref } from "@/lib/ai-chat-ui/handoff"
import { createIdleTimeout } from "@/lib/ai-chat-ui/idle-timeout"
import { widgetVisible, isAssistantOffResponse, assistantOffMessage, showTryAgain } from "@/lib/ai-chat-ui/widget-visibility"
import { followupsFor } from "@/lib/ai-chat-ui/suggestions"
import { newConversationKey, pingConversationEvent } from "@/lib/ai-chat-ui/conversation-events"
import { safeLoad, safeSave, safeClear, trimHistory } from "@/lib/ai-chat-ui/history"

interface Message {
  role: "user" | "assistant"
  content: string
  timestamp: number
  isError?: boolean
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
  /** The shop's own WhatsApp link, if it has one; otherwise the platform support WhatsApp is used. */
  whatsappLink?: string | null
}

const STORAGE_KEY = (slug: string) => `storefront_chat_${slug}`
const HIDDEN_KEY = "datagod_shop_ai_widget_hidden"
const MAX_STORED = 30
const getStorage = () => { try { return window.localStorage } catch { return null } }

// Universal: true of any purchase regardless of which services this
// storefront offers.
const UNIVERSAL_HINTS = ["Check your order status", "Instant delivery after payment"]
// Service-specific: only relevant if that service is actually offered here.
// Network coverage applies to Data and Airtime alike (both go through
// network/provider selection) -- Results Checker doesn't, it's exam-board
// based, not telco-based.
const SERVICE_HINTS: Record<"data_bundles" | "airtime" | "results_checker", string[]> = {
  data_bundles: ["Find the perfect data bundle", "MTN · Telecel · AirtelTigo"],
  airtime: ["Top up airtime instantly", "MTN · Telecel · AirtelTigo"],
  results_checker: ["Get your results checker voucher"],
}

function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} or ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`
}

const mdComponents = {
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li>{children}</li>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }: any) => <code className="bg-muted rounded px-1 text-xs font-mono">{children}</code>,
}

function wrapChips(children: React.ReactNode): React.ReactNode {
  return Array.isArray(children)
    ? children.map((c, i) => (typeof c === "string" ? <MessageText key={i} text={c} /> : c))
    : typeof children === "string" ? <MessageText text={children} /> : children
}

const chipMdComponents = {
  ...mdComponents,
  p: ({ children }: any) => <p className="mb-1 last:mb-0">{wrapChips(children)}</p>,
  li: ({ children }: any) => <li>{wrapChips(children)}</li>,
}

export function AIChatWidget({ shop, shopSlug, onCheckoutPrefill, whatsappLink }: Props) {
  const [platformWhatsapp, setPlatformWhatsapp] = useState<string | null>(null)
  const whatsapp = whatsappHref(whatsappLink) ? whatsappLink : platformWhatsapp
  const [isOpen, setIsOpen] = useState(false)
  const { name: assistantName, audiences, voice } = useAssistantProfile()
  const [hidden, setHidden] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(HIDDEN_KEY) === "1"
    } catch {
      return false
    }
  })
  // Admin-level kill switch (app_settings.ai_widget_services) -- same list
  // used for the customer dashboard's AI widget, but here also checked
  // against THIS shop/domain's own allowed services (null = unrestricted,
  // same convention as lib/custom-domains.ts elsewhere): the widget only
  // shows if at least one service this storefront actually offers is also
  // AI-enabled by admin. Overrides the user's own hide/show preference
  // below. Optimistically true so the widget doesn't flash-hide while this
  // loads.
  const [adminEnabled, setAdminEnabled] = useState(true)
  const domainBranding = useDomainBranding()
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const [actionButtons, setActionButtons] = useState<ActionButton[] | null>(null)
  const [hintIndex, setHintIndex] = useState(0)
  const [hintVisible, setHintVisible] = useState(true)
  // null/absent domainBranding.services means this storefront isn't
  // restricted to a subset -- treat it as offering all 3 storefront-facing
  // services for this, same convention used for the admin-toggle check
  // above and everywhere else in this file.
  const hints = useMemo(() => {
    const shopServices = domainBranding.services ?? ["data_bundles", "airtime", "results_checker"]
    const serviceSpecific = (["data_bundles", "airtime", "results_checker"] as const)
      .filter(s => shopServices.includes(s))
      .flatMap(s => SERVICE_HINTS[s])
    return [...UNIVERSAL_HINTS, ...Array.from(new Set(serviceSpecific))]
  }, [domainBranding.services])

  // Same "unrestricted = all 3" convention as `hints` above, for the opening
  // greeting -- a results-checker-only storefront shouldn't invite customers
  // to "find data packages" when there are none to find here.
  const greetingPhrases = useMemo(() => {
    const shopServices = domainBranding.services ?? ["data_bundles", "airtime", "results_checker"]
    const phrases: string[] = []
    if (shopServices.includes("data_bundles")) phrases.push("find data packages")
    if (shopServices.includes("airtime")) phrases.push("top up airtime")
    if (shopServices.includes("results_checker")) phrases.push("get a results checker voucher")
    if (shopServices.includes("data_bundles") || shopServices.includes("airtime")) phrases.push("check your order status")
    phrases.push("answer any questions")
    return joinWithOr(phrases)
  }, [domainBranding.services])

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const { position: fabPosition, containerRef: fabContainerRef, onPointerDown: onFabPointerDown, onClickCapture: onFabClickCapture } =
    useDraggableFloatingPosition("datagod_ai_widget_position")

  useEffect(() => {
    fetch("/api/public/config")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const aiServices: string[] | undefined = data?.app_settings?.ai_widget_services
        if (!Array.isArray(aiServices)) return
        // null/absent domainBranding.services means this storefront isn't
        // restricted to a subset -- treat it as offering all 4 known
        // services for this check, same as isPathAllowedForService does
        // elsewhere for "unrestricted = everything allowed."
        const shopServices = domainBranding.services ?? ["data_bundles", "airtime", "results_checker", "bulk_sms"]
        const hasOverlap = shopServices.some(s => aiServices.includes(s))
        if (!hasOverlap) setAdminEnabled(false)
      })
      .catch(() => {})
  }, [domainBranding.services])

  useEffect(() => {
    const saved = safeLoad(getStorage(), STORAGE_KEY(shopSlug))
    if (Array.isArray(saved)) {
      setMessages(trimHistory(saved.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && !m.isError) as Message[], MAX_STORED))
    }
  }, [shopSlug])

  useEffect(() => {
    fetch("/api/support-config").then(r => (r.ok ? r.json() : null)).then(j => { if (j?.whatsapp) setPlatformWhatsapp(String(j.whatsapp)) }).catch(() => {})
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
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
  }, [isOpen, hints])

  function persist(msgs: Message[]) {
    safeSave(getStorage(), STORAGE_KEY(shopSlug), trimHistory(msgs.filter(m => !m.isError), MAX_STORED))
  }

  function newChat() {
    if (isStreaming) return
    setMessages([])
    setActionButtons(null)
    safeClear(getStorage(), STORAGE_KEY(shopSlug))
    conversationKeyRef.current = newConversationKey()
  }

  function retryLast() {
    if (isStreaming) return
    const idx = messages.map(m => m.role).lastIndexOf("user")
    if (idx < 0) return
    sendMessage(messages[idx].content, messages.slice(0, idx))
  }

  const sendingRef = useRef(false)
  // One key per chat session; the server groups this chat's transcript turns under it.
  const conversationKeyRef = useRef<string | null>(null)
  if (conversationKeyRef.current === null) conversationKeyRef.current = newConversationKey()

  const call = useVoiceCall({
    context: "storefront",
    shopSlug,
    assistantName,
    conversationKey: () => conversationKeyRef.current,
    // Same two events the text stream hands this widget: the order form and the quick-action buttons.
    onCheckoutPrefill: (data) => onCheckoutPrefill?.(data as ShopPackageData),
    onActionButtons: (buttons) => setActionButtons(buttons as ActionButton[]),
    onCallEnded: (turns, cards) =>
      setMessages(prev => {
        const next = [...prev, ...callToMessages(turns, cards, Date.now())]
        persist(next)
        return next
      }),
  })
  const callOpen = call.state === "starting" || call.state === "live"
  // Every close path hangs up a live call first (mic + slot), and a backdrop tap never drops one.
  function closeChat(source: CloseSource) {
    closeWidgetDuringCall({ callActive: call.isActive(), source, hangUp: call.hangUp, close: () => setIsOpen(false) })
  }

  const sendMessageInner = useCallback(async (overrideText?: string, baseMessages?: Message[]) => {
    const text = (overrideText ?? "").trim()
    if (!text || isStreaming) return

    setActionButtons(null)
    setStreamingContent("")

    const userMsg: Message = { role: "user", content: text, timestamp: Date.now() }
    const nextMessages = [...(baseMessages ?? messages), userMsg]
    setMessages(nextMessages)
    persist(nextMessages)
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
        body: JSON.stringify({ messages: history, context: "storefront", shopSlug, ...(conversationKeyRef.current ? { conversationKey: conversationKeyRef.current } : {}) }),
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
      const finalMessages = [...nextMessages, { role: "assistant" as const, content: finalText, timestamp: Date.now(), ...(streamError ? { isError: true } : {}) }]
      setMessages(finalMessages)
      persist(finalMessages)
    } catch {
      pingConversationEvent(conversationKeyRef.current, "error")
      const errMessages = [...nextMessages, { role: "assistant" as const, content: "Something went wrong.", timestamp: Date.now(), isError: true }]
      setMessages(errMessages)
      persist(errMessages)
    } finally {
      idle.clear()
      setIsStreaming(false)
      setStreamingContent("")
    }
  }, [isStreaming, messages, shopSlug, onCheckoutPrefill])

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

  if (!adminEnabled || !widgetVisible("storefront", audiences)) return null

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex bg-black/50 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4" onClick={() => closeChat("backdrop")}>
          <div className={`w-full h-full sm:h-[85vh] sm:max-h-[700px] sm:w-[420px] sm:max-w-[calc(100vw-2rem)] bg-card sm:rounded-2xl border border-border shadow-[0_24px_48px_rgba(0,0,0,0.14)] shadow-primary/10 flex flex-col overflow-hidden ${callOpen ? "lg:w-[880px]" : ""}`} onClick={(e) => e.stopPropagation()}>
          <div className="bg-primary text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0 border-b border-border">
            <div>
              <p className="font-semibold text-sm">{shop.shop_name}</p>
              <p className="text-primary-foreground opacity-90 text-xs">AI Assistant</p>
            </div>
            <div className="flex items-center gap-2">
              {voice.storefront && !call.blocked && <VoiceCallButtons onStart={call.start} disabled={isStreaming || callOpen || call.state === "queued"} />}
              <HandoffButton mode="whatsapp" messages={messages} conversationKey={conversationKeyRef.current} whatsappNumber={whatsapp} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground" />
              {messages.length > 0 && (
                <button onClick={newChat} disabled={isStreaming} className="text-xs font-medium text-primary-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground disabled:opacity-50">New chat</button>
              )}
              <button onClick={() => closeChat("button")} aria-label="Close chat" className="text-primary-foreground hover:opacity-80 transition-colors">
                <X size={18} />
              </button>
            </div>
          </div>

          {callOpen ? (
            <CallPanel call={call} name={assistantName} />
          ) : (<>
          <div className="flex-1 relative overflow-hidden">
            <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto p-4 space-y-3">
              {messages.length === 0 && !isStreaming && (
                <ChatWelcome
                  context="storefront"
                  name={shop.shop_name}
                  services={{
                    sellsData: (domainBranding.services ?? ["data_bundles", "airtime", "results_checker"]).includes("data_bundles"),
                    sellsAirtime: (domainBranding.services ?? ["data_bundles", "airtime", "results_checker"]).includes("airtime"),
                    sellsResultsChecker: (domainBranding.services ?? ["data_bundles", "airtime", "results_checker"]).includes("results_checker"),
                  }}
                  onSend={(t) => sendMessage(t)}
                  disabled={isStreaming}
                />
              )}

              {messages.map((msg, i) => (
                <div key={i}>
                  {msg.role === "assistant" && msg.isError ? (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                        <p>{msg.content}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          {showTryAgain(msg) && <button onClick={retryLast} disabled={isStreaming} className="text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">Try again</button>}
                          <HandoffButton mode="whatsapp" messages={messages} conversationKey={conversationKeyRef.current} whatsappNumber={whatsapp} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${msg.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-muted text-foreground rounded-bl-sm"}`}>
                        {msg.role === "user" ? <span>{msg.content}</span> : <CopyAnnounceProvider><ReactMarkdown components={chipMdComponents}>{msg.content}</ReactMarkdown></CopyAnnounceProvider>}
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {!isStreaming && !actionButtons && messages.length > 0 && messages[messages.length - 1].role === "assistant" && !messages[messages.length - 1].isError && (
                <SuggestionChips chips={followupsFor("storefront").filter(c => c !== "Contact the shop")} onPick={(t) => sendMessage(t)} label="Follow-up questions" />
              )}

              {isStreaming && !streamingContent && <TypingIndicator name={shop.shop_name} />}

              {isStreaming && streamingContent && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm leading-relaxed bg-muted text-foreground">
                    <ReactMarkdown components={mdComponents}>
                      {streamingContent + "▋"}
                    </ReactMarkdown>
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
                className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-primary/85 backdrop-blur-sm border border-primary/50 text-primary-foreground shadow-lg hover:bg-primary transition-all hover:scale-110 active:scale-95"
                aria-label="Scroll to bottom"
              >
                <ChevronDown size={16} />
              </button>
            )}
          </div>

          {call.state === "queued" && <QueueWaitPanel call={call} name={assistantName} />}
          {call.endMessage && <p role="status" className="border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{call.endMessage}</p>}
          <ChatInput autoFocus name={shop.shop_name} onSend={(t) => sendMessage(t)} disabled={isStreaming} />
          </>)}
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
          onClick={() => (isOpen ? closeChat("button") : setIsOpen(true))}
          className="relative flex items-center gap-2 bg-primary border border-primary/60 text-primary-foreground rounded-full px-5 py-2.5 shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:bg-primary/90 hover:border-border transition-all duration-300 hover:scale-105 active:scale-95"
          aria-label="Open AI chat"
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
