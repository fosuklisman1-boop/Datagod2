import type { Metadata } from "next"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Link2, Store } from "lucide-react"

export const metadata: Metadata = {
  title: "Sub-agent sign-up | Datagod",
  robots: { index: false, follow: false },
}

// Landing for subagents.<root> with no shop in the address (and for any address on it that isn't a shop).
// Without this page, /join/shop would fall through to the /join/[code] invite route and say "Invalid invite".
export default function SubAgentSignupLanding() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-card p-4">
      <Card className="w-full max-w-md lg:max-w-lg">
        <CardHeader className="text-center">
          <Link2 className="w-12 h-12 text-primary mx-auto mb-4" />
          <CardTitle>This is a sub-agent sign-up address</CardTitle>
          <CardDescription>
            To join a shop as a sub-agent, open the link the shop owner shared with you. It looks like{" "}
            <span className="font-mono text-foreground">subagents.datagod.store/their-shop</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">
            Don&apos;t have a link? Ask the shop you buy from, or start your own shop instead.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button asChild>
              <Link href="/join">
                <Store className="mr-2 h-4 w-4" /> Start your own shop
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/">Go to Homepage</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
