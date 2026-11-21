"use client"

/** Three dots in an assistant bubble; the label is announced politely to screen readers. */
export function TypingIndicator({ name }: { name: string }) {
  return (
    <div className="flex justify-start">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-3 shadow-sm"
      >
        <span className="sr-only">{name} is typing</span>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-primary/70 motion-safe:animate-bounce"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
