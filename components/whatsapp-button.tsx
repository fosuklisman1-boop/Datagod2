import { MessageCircle } from "lucide-react"

interface WhatsAppButtonProps {
  whatsappLink: string
  variant?: "default" | "compact"
  className?: string
}

export function WhatsAppButton({
  whatsappLink,
  variant = "default",
  className = "",
}: WhatsAppButtonProps) {
  if (!whatsappLink) return null

  if (variant === "compact") {
    return (
      <a
        href={whatsappLink}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center justify-center w-12 h-12 bg-green-600 hover:bg-green-700 text-white rounded-full shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-110 ${className}`}
        title="Contact on WhatsApp"
        aria-label="Contact on WhatsApp"
      >
        <MessageCircle className="w-6 h-6" />
      </a>
    )
  }

  return (
    <a
      href={whatsappLink}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-all duration-300 hover:shadow-lg ${className}`}
      title="Contact on WhatsApp"
    >
      <MessageCircle className="w-4 h-4" />
      Contact on WhatsApp
    </a>
  )
}
