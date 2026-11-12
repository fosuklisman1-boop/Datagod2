"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mail, MessageCircle, Phone, Send } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { SupplierResult } from "@/lib/order-supplier"
import { getMessageTickState, type TickState } from "@/lib/support-ticks"
import type { SupportOrder } from "@/lib/support-order"
import { mailtoHref, telHref, userDisplayName, whatsappHref } from "@/lib/support-admin-client"
import { cn } from "@/lib/utils"
import { adminApi, usePolling } from "./support-api"
import { OrderDetailsDialog, formatDateTime } from "./order-details-dialog"

const CONVERSATION_POLL_MS = 30_000
const CLOSED_MSG = "This complaint is already closed"

export interface ConversationMessage {
  id: string
  sender_role: "user" | "admin" | "ai"
  body: string
  created_at: string
  delivered_at: string | null
  read_at: string | null
  attachment_url: string | null
}

export interface ConversationDetail {
  id: string
  subject: string
  status: "open" | "closed"
  phone_number: string
  whatsapp_number: string
  user: { first_name: string | null; last_name: string | null; email: string | null; phone_number: string | null }
  order: SupportOrder | null
  supplier: SupplierResult
  messages: ConversationMessage[]
}

function Ticks({ state }: { state: TickState }) {
  return (
    <span
      aria-label={state}
      className={cn("ml-1 text-[11px] leading-none", state === "read" ? "text-sky-500" : "text-muted-foreground")}
    >
      {state === "sent" ? "✓" : "✓✓"}
    </span>
  )
}

function ContactLink({ href, icon, label, external }: { href: string | null; icon: React.ReactNode; label: string; external?: boolean }) {
  const body = (
    <>
      {icon}
      <span className="break-all">{label}</span>
    </>
  )
  const cls = "inline-flex items-center gap-1.5 text-sm"
  if (!href) return <span className={cn(cls, "text-muted-foreground")}>{body}</span>
  return (
    <a
      href={href}
      className={cn(cls, "text-primary underline-offset-2 hover:underline")}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {body}
    </a>
  )
}

export function ConversationDialog({
  threadId,
  onClose,
  onChanged,
}: {
  threadId: string | null
  onClose: () => void
  /** Called after read / reply / close so the list can refresh. */
  onChanged: () => void
}) {
  const open = threadId !== null
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reply, setReply] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [note, setNote] = useState("")
  const [showOrder, setShowOrder] = useState(false)
  const sendGuard = useRef(false)
  const closeGuard = useRef(false)
  const loadGuard = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeId = useRef<string | null>(null)

  const load = useCallback(async (id: string) => {
    const r = await adminApi<ConversationDetail>(`/api/admin/support/threads/${id}`)
    if (activeId.current !== id) return
    if (r.ok && r.data) {
      setDetail(r.data)
      setLoadError(null)
    } else {
      setLoadError(r.error ?? "Could not load this conversation")
    }
  }, [])

  // Open: reset, load once, and mark read once.
  useEffect(() => {
    activeId.current = threadId
    setDetail(null)
    setLoadError(null)
    setReply("")
    setActionError(null)
    setConfirmClose(false)
    setNote("")
    setShowOrder(false)
    sendGuard.current = false
    closeGuard.current = false
    if (!threadId) return
    void load(threadId)
    void adminApi(`/api/admin/support/threads/${threadId}`, { method: "POST", body: { action: "read" } }).then((r) => {
      if (r.ok && activeId.current === threadId) onChanged()
    })
    // onChanged is intentionally not a dependency: read fires once per opened conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, load])

  usePolling(
    async () => {
      if (!threadId || loadGuard.current) return
      loadGuard.current = true
      try {
        await load(threadId)
      } finally {
        loadGuard.current = false
      }
    },
    CONVERSATION_POLL_MS,
    open,
  )

  const messageCount = detail?.messages.length ?? 0
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messageCount])

  async function afterConflict() {
    setActionError(CLOSED_MSG)
    setConfirmClose(false)
    if (threadId) await load(threadId)
    onChanged()
  }

  async function sendReply() {
    if (!threadId || sendGuard.current) return
    const text = reply.trim()
    if (!text) return
    sendGuard.current = true
    setSending(true)
    setActionError(null)
    try {
      const r = await adminApi(`/api/admin/support/threads/${threadId}`, { method: "POST", body: { action: "reply", message: text } })
      if (r.ok) {
        setReply("")
        await load(threadId)
        onChanged()
      } else if (r.status === 409) {
        await afterConflict()
      } else {
        setActionError(r.error ?? "Could not send the reply")
      }
    } finally {
      sendGuard.current = false
      setSending(false)
    }
  }

  async function closeThread() {
    if (!threadId || closeGuard.current) return
    closeGuard.current = true
    setClosing(true)
    setActionError(null)
    try {
      const trimmed = note.trim()
      const r = await adminApi(`/api/admin/support/threads/${threadId}`, {
        method: "POST",
        body: trimmed ? { action: "close", note: trimmed } : { action: "close" },
      })
      if (r.ok) {
        setConfirmClose(false)
        setNote("")
        await load(threadId)
        onChanged()
      } else if (r.status === 409) {
        await afterConflict()
      } else {
        setActionError(r.error ?? "Could not close the complaint")
      }
    } finally {
      closeGuard.current = false
      setClosing(false)
    }
  }

  const isOpen = detail?.status === "open"
  const order = detail?.order ?? null
  const firstAttachment = detail?.messages[0]?.attachment_url ?? null
  const pkg = order ? [order.network, order.size].filter(Boolean).join(" ") : ""

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[90vh] w-[95vw] max-w-2xl flex-col gap-3 overflow-hidden p-4 sm:w-full sm:p-6">
          <DialogHeader className="shrink-0 text-left">
            <div className="flex items-start gap-2 pr-6">
              <DialogTitle className="min-w-0 flex-1 break-words text-base leading-snug">{detail?.subject ?? "Conversation"}</DialogTitle>
              {detail && (
                <Badge variant={isOpen ? "default" : "secondary"} className="shrink-0">
                  {isOpen ? "Open" : "Closed"}
                </Badge>
              )}
            </div>
            <DialogDescription className="sr-only">Conversation with the customer</DialogDescription>
          </DialogHeader>

          {!detail ? (
            <div className="flex flex-1 items-center justify-center py-10">
              {loadError ? <p className="text-sm text-destructive">{loadError}</p> : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
            </div>
          ) : (
            <>
              <div className="shrink-0 space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-sm font-medium">{userDisplayName(detail.user)}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <ContactLink href={telHref(detail.phone_number)} icon={<Phone className="h-3.5 w-3.5" />} label={detail.phone_number} />
                  <ContactLink
                    href={whatsappHref(detail.whatsapp_number)}
                    icon={<MessageCircle className="h-3.5 w-3.5" />}
                    label={`WhatsApp ${detail.whatsapp_number}`}
                    external
                  />
                  {detail.user.email && <ContactLink href={mailtoHref(detail.user.email)} icon={<Mail className="h-3.5 w-3.5" />} label={detail.user.email} />}
                </div>
              </div>

              {order && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{order.reference ?? "Order"}</span>
                    <span className="text-muted-foreground">
                      {pkg ? ` · ${pkg}` : ""}
                      {order.beneficiary ? ` · ${order.beneficiary}` : ""}
                    </span>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={() => setShowOrder(true)}>
                    View Details
                  </Button>
                </div>
              )}

              <div className="min-h-[160px] flex-1 space-y-2 overflow-y-auto rounded-lg border border-border bg-background p-3">
                {detail.messages.map((m, i) => {
                  const mine = m.sender_role !== "user"
                  return (
                    <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                      <div
                        className={cn(
                          "max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                          mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{m.body}</p>
                        {i === 0 && firstAttachment && (
                          <a href={firstAttachment} target="_blank" rel="noopener noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={firstAttachment} alt="Screenshot from the customer" className="mt-2 max-h-56 rounded-lg" />
                          </a>
                        )}
                        <p className={cn("mt-1 flex items-center justify-end text-[11px]", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
                          {formatDateTime(m.created_at)}
                          {m.sender_role === "admin" && (
                            <span className="rounded bg-background/80 px-1">
                              <Ticks state={getMessageTickState({ delivered_at: m.delivered_at, read_at: m.read_at })} />
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  )
                })}
                <div ref={bottomRef} />
              </div>

              {actionError && <p className="shrink-0 text-sm text-destructive">{actionError}</p>}

              {isOpen ? (
                confirmClose ? (
                  <div className="shrink-0 space-y-2 rounded-lg border border-border p-3">
                    <p className="text-sm font-medium">Close this complaint?</p>
                    <Input
                      value={note}
                      maxLength={5000}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Closing note (optional, sent to the customer)"
                    />
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={() => setConfirmClose(false)} disabled={closing}>
                        Cancel
                      </Button>
                      <Button type="button" size="sm" onClick={closeThread} disabled={closing}>
                        {closing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        Close complaint
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-end gap-2">
                    <Textarea
                      value={reply}
                      maxLength={5000}
                      rows={2}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="Write a reply…"
                      className="min-h-[44px] flex-1 resize-none"
                    />
                    <Button type="button" onClick={sendReply} disabled={sending || reply.trim().length === 0} aria-label="Send reply">
                      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setConfirmClose(true)}>
                      Close
                    </Button>
                  </div>
                )
              ) : (
                <p className="shrink-0 text-center text-sm text-muted-foreground">This complaint is closed.</p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <OrderDetailsDialog open={showOrder} onOpenChange={setShowOrder} order={order} supplier={detail?.supplier ?? null} />
    </>
  )
}
