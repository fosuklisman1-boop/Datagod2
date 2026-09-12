import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Retrieve Your Voucher | DATAGOD",
  description: "Look up your DATAGOD results checker voucher PINs and resend them by SMS.",
  openGraph: {
    title: "Retrieve Your Voucher | DATAGOD",
    description: "Look up your results checker voucher PINs and resend them by SMS.",
    type: "website",
    url: "https://www.datagod.store/vouchers",
  },
}

export default function VouchersLayout({ children }: { children: React.ReactNode }) {
  return children
}
