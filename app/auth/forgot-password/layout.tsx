import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Reset Your Password | DATAGOD",
  description: "Forgot your DATAGOD password? Reset it easily using your email or contact our support team.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "Reset Your Password | DATAGOD",
    description: "Regain access to your DATAGOD account quickly and securely.",
    type: "website",
    url: "https://www.datagod.store/auth/forgot-password",
  },
}

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children
}
