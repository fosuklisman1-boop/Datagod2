import type { ReactNode } from "react"
import { SmsAccountProvider } from "./_lib/useSmsAccount"

// Provides the shared SMS account context to every /dashboard/sms route.
// Every page renders <SmsShell> (which wraps DashboardLayout) and reads the context via useSmsAccount().
export default function SmsLayout({ children }: { children: ReactNode }) {
  return <SmsAccountProvider>{children}</SmsAccountProvider>
}
