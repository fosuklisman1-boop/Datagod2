export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://www.datagod.store").replace(/\/+$/, "")
  return base + (path.startsWith("/") ? path : `/${path}`)
}

/** Plain-text in, safe HTML out: every string is escaped here, callers pass raw text. */
export function emailShell(o: { heading: string; paragraphs: string[]; cta?: { label: string; url: string } }): string {
  const paras = o.paragraphs
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1f2937">${escapeHtml(p)}</p>`)
    .join("")
  const button = o.cta && /^https?:\/\//i.test(o.cta.url)
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(o.cta.url)}" style="background:#059669;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:15px;display:inline-block">${escapeHtml(o.cta.label)}</a></p>`
    : ""
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 16px;font-size:20px;color:#111827">${escapeHtml(o.heading)}</h2>` +
    paras +
    button +
    `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">DATAGOD</p>` +
    `</div>`
  )
}

export function clipSms(s: string, max = 160): string {
  return s.length <= max ? s : s.slice(0, max - 3).trimEnd() + "..."
}

/** Masks a phone/account number for messages: first 3 + last 3 when length >= 8, else asterisks + last 2. */
export function maskNumber(s: string | null | undefined): string {
  const v = String(s ?? "").trim()
  if (!v) return ""
  if (v.length >= 8) return v.slice(0, 3) + "*".repeat(v.length - 6) + v.slice(-3)
  return "****" + v.slice(-2)
}
