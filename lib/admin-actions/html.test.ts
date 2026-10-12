import { appUrl, clipSms, emailShell, escapeHtml } from "./html"

describe("escapeHtml", () => {
  it("escapes the five dangerous characters", () => {
    expect(escapeHtml(`<script>alert("x")&'</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;")
  })
  it("tolerates null/undefined/numbers", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
    expect(escapeHtml(12.5)).toBe("12.5")
  })
})

describe("appUrl", () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL
  afterEach(() => {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = prev
  })
  it("joins base and path with exactly one slash", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example.com/"
    expect(appUrl("/admin/withdrawals")).toBe("https://example.com/admin/withdrawals")
    expect(appUrl("admin/x")).toBe("https://example.com/admin/x")
  })
  it("falls back to the production domain", () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(appUrl("/a")).toBe("https://www.datagod.store/a")
  })
})

describe("emailShell", () => {
  it("escapes heading, paragraphs and cta", () => {
    const html = emailShell({
      heading: "<b>Hi</b>",
      paragraphs: ["<img src=x onerror=alert(1)>", "ok"],
      cta: { label: "Go <now>", url: 'https://x.test/?a="b"' },
    })
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<b>Hi")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain("Go &lt;now&gt;")
    expect(html).toContain("https://x.test/?a=&quot;b&quot;")
  })
  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "JAVASCRIPT:alert(1)"])("omits the button for unsafe url %s", (url) => {
    const html = emailShell({ heading: "H", paragraphs: ["p"], cta: { label: "Go", url } })
    expect(html).not.toContain("<a ")
    expect(html).not.toContain("javascript:")
  })
  it("renders the button for https and http urls", () => {
    expect(emailShell({ heading: "H", paragraphs: ["p"], cta: { label: "Go", url: "https://x.test/a" } })).toContain('<a href="https://x.test/a"')
    expect(emailShell({ heading: "H", paragraphs: ["p"], cta: { label: "Go", url: "http://x.test/a" } })).toContain("<a ")
  })
  it("omits the button when there is no cta", () => {
    expect(emailShell({ heading: "H", paragraphs: ["p"] })).not.toContain("<a ")
  })
})

describe("clipSms", () => {
  it("leaves short text alone", () => expect(clipSms("hello")).toBe("hello"))
  it("clips to 160 chars with ASCII ellipsis", () => {
    const out = clipSms("x".repeat(400))
    expect(out).toHaveLength(160)
    expect(out.endsWith("...")).toBe(true)
  })
  it("honours a custom max", () => expect(clipSms("abcdefghij", 8)).toBe("abcde..."))
})
