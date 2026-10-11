import type { ReactNode } from "react"
import { SmsAccountProvider } from "./_lib/useSmsAccount"

// Provides the shared SMS account context to every /dashboard/sms route.
// Pages render <SmsShell> (which wraps DashboardLayout) themselves; the legacy
// monolith page.tsx keeps wrapping itself in DashboardLayout and ignores the context.
export default function SmsLayout({ children }: { children: ReactNode }) {
  return <SmsAccountProvider>{children}</SmsAccountProvider>
}
