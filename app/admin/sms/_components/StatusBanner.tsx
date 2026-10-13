"use client"
import type { OverviewData } from "../_lib/api"
import { bannerFor, toneClass } from "../_lib/view"

export default function StatusBanner({ overview }: { overview: OverviewData }) {
  const b = bannerFor(overview)
  return <div className={`rounded-2xl px-4 py-2.5 text-sm font-medium ${toneClass(b.tone)}`} role="status">{b.text}</div>
}
