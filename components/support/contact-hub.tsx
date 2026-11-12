"use client"

import { Mail, MessageCircle, Phone } from "lucide-react"
import { useSupportConfig } from "@/hooks/use-support-config"

export function ContactHub() {
  const { config } = useSupportConfig()
  const items = [
    { href: config.whatsapp, label: "WhatsApp", icon: MessageCircle, external: true },
    { href: `tel:${config.phone}`, label: "Call", icon: Phone, external: false },
    { href: `mailto:${config.email}`, label: "Email", icon: Mail, external: false },
  ]
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ href, label, icon: Icon, external }) => (
        <a
          key={label}
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/40"
        >
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
        </a>
      ))}
    </div>
  )
}
