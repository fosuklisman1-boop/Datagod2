import { Download } from "lucide-react"
import { cn } from "@/lib/utils"

const BASE = "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const PRIMARY = "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
const SECONDARY = "border border-border bg-card text-foreground hover:bg-muted"

/** Download links for the generated Postman collection and its two environments. Plain anchors, so it works in server and client trees. */
export function PostmanButtons({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <a href="/developers/postman/collection" download className={cn(BASE, PRIMARY)}>
        <Download className="size-4" aria-hidden />
        Download Postman collection
      </a>
      <a href="/developers/postman/sandbox-environment" download className={cn(BASE, SECONDARY)}>
        <Download className="size-4" aria-hidden />
        Sandbox environment
      </a>
      <a href="/developers/postman/live-environment" download className={cn(BASE, SECONDARY)}>
        <Download className="size-4" aria-hidden />
        Live environment
      </a>
    </div>
  )
}
