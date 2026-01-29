import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Sign In to Your Account | DATAGOD",
  description: "Log in to your DATAGOD account to access your dashboard, manage orders, and purchase data packages.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "Sign In to Your Account | DATAGOD",
    description: "Log in to your DATAGOD account to access your dashboard and manage orders.",
    type: "website",
    url: "https://www.datagod.store/auth/login",
  },
}

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
