"use client"

import { useState } from "react"
import { Send } from "lucide-react"

interface ChatInputProps {
  name: string
  onSend: (text: string) => void
  disabled?: boolean
  maxLength?: number
}

export function ChatInput({ name, onSend, disabled, maxLength = 1000 }: ChatInputProps) {
  const [value, setValue] = useState("")
  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    setValue("")
    onSend(text)
  }
  return (
    <form
      className="flex items-center gap-2 border-t border-border bg-card/60 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
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
