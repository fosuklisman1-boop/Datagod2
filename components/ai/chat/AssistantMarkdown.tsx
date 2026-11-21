"use client"

import ReactMarkdown from "react-markdown"
import { MessageText } from "./MessageText"

/** Turns plain-string markdown children into copy-chip text; other nodes pass through. */
function wrapChips(children: React.ReactNode): React.ReactNode {
  return Array.isArray(children)
    ? children.map((c, i) => (typeof c === "string" ? <MessageText key={i} text={c} /> : c))
    : typeof children === "string" ? <MessageText text={children} /> : children
}

const base = {
  ul:     ({ children }: any) => <ul className="list-disc pl-4 mb-1 space-y-0.5">{children}</ul>,
  ol:     ({ children }: any) => <ol className="list-decimal pl-4 mb-1 space-y-0.5">{children}</ol>,
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  code:   ({ children }: any) => <code className="bg-muted rounded px-1 text-xs font-mono">{children}</code>,
}

const chipComponents = {
  ...base,
  p:  ({ children }: any) => <p className="mb-1 last:mb-0">{wrapChips(children)}</p>,
  li: ({ children }: any) => <li>{wrapChips(children)}</li>,
}

const plainComponents = {
  ...base,
  p:  ({ children }: any) => <p className="mb-1 last:mb-0">{children}</p>,
  li: ({ children }: any) => <li>{children}</li>,
}

/** Assistant markdown. `chips` adds tappable copy chips (finished messages); streaming text stays plain. */
export function AssistantMarkdown({ text, chips = true }: { text: string; chips?: boolean }) {
  return <ReactMarkdown components={chips ? chipComponents : plainComponents}>{text}</ReactMarkdown>
}
