"use client"

import { useEffect, useRef, useState } from "react"
import { Send } from "lucide-react"

interface ChatInputProps {
  name: string
  onSend: (text: string) => void
  disabled?: boolean
  maxLength?: number
  /** Fills the box (never sends) when it changes, e.g. a deep link that pre-writes a request. */
  prefill?: string
  /** Focuses the box when it mounts (the widgets mount it when the chat opens). */
  autoFocus?: boolean
}

export function ChatInput({ name, onSend, disabled, maxLength = 1000, prefill, autoFocus }: ChatInputProps) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    const t = setTimeout(() => ref.current?.focus(), 100)
    return () => clearTimeout(t)
  }, [autoFocus])
  useEffect(() => { if (prefill) setValue(prefill) }, [prefill])
  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    setValue("")
    onSend(text)
  }
  return (
    <form
      className="flex items-center gap-2 border-t border-border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
        ref={ref}
        type="text"
        value={value}
        maxLength={maxLength}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Ask ${name} anything…`}
        aria-label={`Message ${name}`}
        className="min-w-0 flex-1 rounded-full border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </button>
    </form>
  )
}
