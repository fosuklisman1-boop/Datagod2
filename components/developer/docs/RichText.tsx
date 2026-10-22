// components/developer/docs/RichText.tsx
import { Fragment } from "react"
import { cn } from "@/lib/utils"

/**
 * Code-like tokens in registry prose that read better as inline monospace chips:
 * JSON shapes (one level of nesting), header names, key prefixes and URLs.
 * Longer alternatives come first so "Authorization: Bearer <key>" wins over "Authorization".
 */
const CODE_TOKEN =
  /(\{(?:[^{}]|\{[^{}]*\})*\}|Authorization: Bearer <key>|Authorization|X-API-Key|dg2_(?:live|test)_|https:\/\/[^\s,]+)/g

export function InlineCode({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-md border border-primary/15 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[0.85em] font-medium text-primary [overflow-wrap:anywhere] dark:bg-primary/10",
        className
      )}
    >
      {children}
    </code>
  )
}

/** Renders plain registry text, turning code-like tokens into InlineCode chips. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(CODE_TOKEN)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : <Fragment key={i}>{part}</Fragment>
      )}
    </>
  )
}
