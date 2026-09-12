import type { Metadata } from "next"

// Each invite code renders near-identical content behind a different URL —
// indexing them individually would create a pile of thin, duplicate pages
// with no organic search value (nobody searches for someone else's invite
// code), which can drag down how Google evaluates the site's overall content
// quality. `follow: true` still lets link equity flow through to /join.
export const metadata: Metadata = {
  title: "Join DATAGOD",
  description: "Accept your invite to join DATAGOD and start buying affordable data packages and airtime.",
  robots: {
    index: false,
    follow: true,
  },
}

export default function JoinCodeLayout({ children }: { children: React.ReactNode }) {
  return children
}
