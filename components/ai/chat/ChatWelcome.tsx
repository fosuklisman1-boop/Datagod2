"use client"

import { Sparkles } from "lucide-react"
import { welcomeFor, type ChatContext, type StorefrontServices } from "@/lib/ai-chat-ui/suggestions"
import { SuggestionChips } from "./SuggestionChips"

interface ChatWelcomeProps {
  context: ChatContext
  name: string
  firstName?: string | null
  services?: StorefrontServices
  onSend: (text: string) => void
  disabled?: boolean
}

/** Empty-conversation screen: avatar, greeting, one-line subtitle, a TRY IT question and suggestion chips. */
export function ChatWelcome({ context, name, firstName, services, onSend, disabled }: ChatWelcomeProps) {
  const content = welcomeFor(context, services)
  const who = firstName?.trim()
  return (
    <div className="flex flex-col items-center gap-4 px-2 py-4 text-center lg:gap-5 lg:py-6">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary ring-2 ring-primary ring-offset-2 ring-offset-background lg:h-16 lg:w-16">
        <Sparkles className="h-6 w-6 lg:h-7 lg:w-7" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground lg:text-xl">
          {who ? `Hi ${who}, I am ${name}.` : `Hi, I am ${name}.`}
        </h2>
        <p className="text-sm text-muted-foreground">{content.subtitle}</p>
      </div>
      <div className="flex w-full flex-col items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Try it</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSend(content.tryIt)}
          className="max-w-full rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-2.5 text-left text-sm text-foreground shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        >
          {content.tryIt}
        </button>
      </div>
      <div className="flex w-full justify-center">
        <SuggestionChips chips={content.chips} onPick={onSend} disabled={disabled} />
      </div>
    </div>
  )
}
