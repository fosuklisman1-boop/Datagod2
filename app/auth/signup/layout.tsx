import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Create Your DATAGOD Account | Free Registration",
  description: "Sign up for free on DATAGOD to buy data packages, airtime, and digital services. Fast registration, instant access to all features.",
  robots: {
    index: false,
    follow: true,
  },
  openGraph: {
    title: "Create Your DATAGOD Account | Free Registration",
    description: "Sign up for free to access affordable data packages and instant delivery.",
    type: "website",
    url: "https://www.datagod.store/auth/signup",
  },
}

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children
}
