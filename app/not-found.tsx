import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">Error 404</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The page you’re looking for doesn’t exist or has moved.</p>
        <Link href="/" className="mt-6 inline-block"><Button>Back to home</Button></Link>
      </div>
    </div>
  )
}
