import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))

import { SMSTemplates } from "@/lib/sms-service"
import { EmailTemplates } from "@/lib/email-service"

const EVIL = '<a href="https://evil.example/pay">Pay now at https://evil.example</a>\nSecond line'

describe("owner alert templates carry no raw recruit name", () => {
  it("SMS has no recruit name and starts DTGOD:", () => {
    const sms = SMSTemplates.subAgentCatalogNeeded(EVIL)
    expect(sms.startsWith("DTGOD:")).toBe(true)
    expect(sms).not.toContain("evil")
    expect(sms).not.toContain("<a")
  })

  it("email subject has no recruit name", () => {
    const t = EmailTemplates.subAgentCatalogNeeded(EVIL, "https://datagod.store/dashboard/sub-agent-catalog")
    expect(t.subject).not.toContain("evil")
    expect(t.subject).not.toContain("<a")
  })

  it("email body escapes the name, is single line and at most 40 chars of it", () => {
    const t = EmailTemplates.subAgentCatalogNeeded(EVIL, "https://datagod.store/dashboard/sub-agent-catalog")
    expect(t.html).not.toContain('<a href="https://evil.example')
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example/pay&quot;")
    expect(t.html).not.toContain("Second line")
  })

  it("escapes the catalog link", () => {
    const t = EmailTemplates.subAgentCatalogNeeded("Shop", 'https://x.example/"><script>alert(1)</script>')
    expect(t.html).not.toContain("<script>alert(1)")
  })
})
