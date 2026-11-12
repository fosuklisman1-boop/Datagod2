"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Loader2, Lock, Send } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { supabase } from "@/lib/supabase"
import { customerTextError, type ClientMessage, type ClientThread } from "@/lib/support-client"
import { MessageBubble } from "./message-bubble"
import { PushPrompt } from "./push-prompt"

interface Props {
  thread: ClientThread
  messages: ClientMessage[]
  onSend: (text: string) => Promise<void>
  onBack: () => void
  onNew: () => void
}

async function fetchAttachmentUrl(threadId: string): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) return null
    const res = await fetch(`/api/support/threads/${threadId}/attachment`, { headers: { Authorization: `Bearer ${token}` } })
    const json = await res.json()
    return res.ok ? (json?.data?.url ?? null) : null
  } catch {
    // The screenshot is a nicety; the chat still works without it.
    return null
  }
}

export function ChatPane({ thread, messages, onSend, onBack, onNew }: Props) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const hasAttachment = messages.some((m) => m.attachment_path)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages.length, thread.id])

  const refetched = useRef(false)

  // Signed URL lives 10 minutes: fetch on open, never cache across sessions.
  useEffect(() => {
    setAttachmentUrl(null)
    refetched.current = false
    if (!hasAttachment) return
    let cancelled = false
    ;(async () => {
      const url = await fetchAttachmentUrl(thread.id)
      if (!cancelled) setAttachmentUrl(url)
    })()
    return () => {
      cancelled = true
    }
  }, [thread.id, hasAttachment])

  // The link expired while the chat stayed open: refetch it once, never in a loop.
  const onImageError = async () => {
    if (refetched.current) return
    refetched.current = true
    const url = await fetchAttachmentUrl(thread.id)
    if (url) setAttachmentUrl(url)
  }

  const send = async () => {
    if (inFlight.current) return
    const body = text.trim()
    if (!body) return
    const bad = customerTextError(body)
    if (bad) return toast.error(bad)
    inFlight.current = true
    setSending(true)
    try {
      await onSend(body)
      setText("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Message could not be sent")
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const open = thread.status === "open"

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-foreground">{thread.subject}</p>
          <p className="text-xs capitalize text-muted-foreground">{open ? "Open" : "Closed"} · {thread.category}</p>
        </div>
      </div>
      {open && <PushPrompt />}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4">
        {attachmentUrl && (
          <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="mb-2 block w-fit">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachmentUrl} onError={() => void onImageError()} alt="Screenshot you attached" className="max-h-40 rounded-xl border border-border" />
          </a>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={endRef} />
      </div>
      {open ? (
        <div className="flex items-end gap-2 border-t border-border p-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Type a message"
            className="resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <Button onClick={send} disabled={sending || !text.trim()} aria-label="Send message">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 border-t border-border bg-muted/40 p-4 text-center">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" /> This complaint is closed.
          </p>
          <Button size="sm" onClick={onNew}>New Complaint</Button>
        </div>
      )}
    </div>
  )
}
