// components/developer/docs/RichText.tsx
import { Fragment } from "react"
import { cn } from "@/lib/utils"
import { splitRichText } from "@/lib/api-v2/docs/rich-text"

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
  return (
    <>
      {splitRichText(text).map((part, i) =>
        part.code ? <InlineCode key={i}>{part.text}</InlineCode> : <Fragment key={i}>{part.text}</Fragment>
      )}
    </>
  )
}
