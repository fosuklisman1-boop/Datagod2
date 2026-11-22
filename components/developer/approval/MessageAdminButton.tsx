"use client"

import { MessageCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { buildApprovalLink } from "@/lib/api-v2/approval-contact"

/** Where "Message admin" sends people, from GET /api/user/v2-keys. */
export interface ApprovalInfo {
  /** WhatsApp number, digits only (admin setting, else the support number); null = none configured. */
  contact: string | null
  /** The account email, put in the pre-filled message so the admin finds the right account. */
  email: string | null
}

/**
 * Opens WhatsApp with the request code already typed. The link is built from digits by buildApprovalLink, so
 * it can only ever point at wa.me. Without a contact there is no button, only "Contact support".
 */
export function MessageAdminButton({ approval, code, className }: { approval: ApprovalInfo | null; code: string | null; className?: string }) {
  let href: string | null = null
  if (approval?.contact && code) {
    try {
      href = buildApprovalLink(approval.contact, { code, email: approval.email })
    } catch {
      href = null
    }
  }
  if (!href) {
    return <p className={cn("text-xs text-muted-foreground", className)}>Contact support to get it approved.</p>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <MessageCircle className="size-4" aria-hidden /> Message admin on WhatsApp
    </a>
  )
}

/** "Request code: API-XXXXXX", selectable so it can be copied by hand. */
export function RequestCode({ code }: { code: string | null }) {
  if (!code) return null
  return (
    <span className="text-xs text-muted-foreground">
      Request code: <span className="select-all font-mono font-semibold text-foreground">{code}</span>
    </span>
  )
}
