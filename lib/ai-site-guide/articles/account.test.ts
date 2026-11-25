import { describe, expect, it } from "vitest"
import { ADMIN_PAGES } from "@/lib/ai-admin-catalog/pages"
import { bannedHits } from "../banned"
import { checkSiteGuideLimits, renderSiteGuide } from "../guide"
import { SITE_PAGES } from "../pages"
import { searchSite } from "../search"
import type { Audience } from "../types"
import { ACCOUNT_ARTICLES } from "./account"
import { ARTICLES } from "./index"

const VALID: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]
const CUSTOMER: Audience[] = ["public", "customer"]
const GUEST: Audience[] = ["public"]
const ADMIN: Audience[] = ["public", "customer", "dealer", "shop_owner", "admin"]

const ADMIN_IDS = ["admin-ai-assistant-cards", "admin-custom-roles", "admin-knowledge-base", "admin-main-switches"]
const EXPECTED_IDS = [
  ...ADMIN_IDS,
  "account-complete-profile",
  "account-forgot-password",
  "account-log-in",
  "account-profile-and-phone",
  "account-security-tips",
  "account-sign-up",
  "ai-assistant-customer",
  "developer-api-dashboard",
  "developer-api-docs",
  "developer-api-keys",
  "support-chat",
  "support-report-order-problem",
]

const byId = (id: string) => ACCOUNT_ARTICLES.find((a) => a.id === id)!
const isAdminArticle = (id: string) => ADMIN_IDS.includes(id)
const textOf = (a: { title: string; summary: string; body: string; keywords: string[] }) => [a.title, a.summary, a.body, ...a.keywords].join("\n")

function pathsIn(text: string): string[] {
  return Array.from(text.matchAll(/\/(?:dashboard|auth|developers|ai|admin)[A-Za-z0-9/:_-]*/g)).map((m) => m[0].replace(/[.,;:)]+$/, ""))
}

describe("account articles: shape", () => {
  it("has the expected set of articles", () => {
    expect(ACCOUNT_ARTICLES.map((a) => a.id).sort()).toEqual([...EXPECTED_IDS].sort())
  })

  it("is registered in the shared ARTICLES list with unique kebab-case ids", () => {
    for (const a of ACCOUNT_ARTICLES) expect(ARTICLES).toContain(a)
    const ids = ARTICLES.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it("keeps summaries and bodies inside the size limits", () => {
    for (const a of ACCOUNT_ARTICLES) {
      expect(a.summary.length, `${a.id} summary`).toBeLessThanOrEqual(200)
      expect(a.body.length, `${a.id} body`).toBeLessThanOrEqual(2500)
      expect(a.keywords.length, `${a.id} keywords`).toBeGreaterThan(2)
    }
  })

  it("uses valid audiences; admin articles are admin only and nobody else gets admin", () => {
    for (const a of ACCOUNT_ARTICLES) {
      expect(a.audiences.length).toBeGreaterThan(0)
      for (const x of a.audiences) expect(VALID).toContain(x)
      if (isAdminArticle(a.id)) expect(a.audiences, a.id).toEqual(["admin"])
      else expect(a.audiences, a.id).not.toContain("admin")
    }
  })

  it("answers where / how / what next / what if it goes wrong", () => {
    for (const a of ACCOUNT_ARTICLES) {
      expect(a.body, `${a.id} where`).toMatch(/Where:/)
      expect(a.body, `${a.id} how`).toMatch(/How:[\s\S]*\n1\. /)
      expect(a.body, `${a.id} next`).toMatch(/What happens next:/)
      expect(a.body, `${a.id} wrong`).toMatch(/If something goes wrong:/)
    }
  })

  it("keeps the whole guide inside its budget for every audience set", () => {
    expect(checkSiteGuideLimits(SITE_PAGES, ARTICLES)).toEqual([])
    for (const set of [GUEST, CUSTOMER, ADMIN]) expect(renderSiteGuide(set).length).toBeLessThanOrEqual(10000)
  })
})

describe("account articles: content rules", () => {
  it("contains no banned words in articles anyone but admins can read", () => {
    for (const a of ACCOUNT_ARTICLES.filter((x) => !isAdminArticle(x.id))) expect(bannedHits(textOf(a)), a.id).toEqual([])
  })

  it("has no digits (limits, times, counts, codes, versions) at all", () => {
    for (const a of ACCOUNT_ARTICLES) expect(textOf(a).replace(/^\d+\. /gm, ""), a.id).not.toMatch(/\d/)
  })

  it("quotes no amounts, currency, percentages or waiting times", () => {
    for (const a of ACCOUNT_ARTICLES) {
      expect([a.body, a.summary].join("\n"), a.id).not.toMatch(/GHS|GH₵|cedis|%|percent|minutes?\b|hours?\b|seconds?\b|requests? per|rate limit/i)
    }
  })

  it("never reveals rule shapes or internals in non-admin text", () => {
    for (const a of ACCOUNT_ARTICLES.filter((x) => !isAdminArticle(x.id))) {
      expect(textOf(a), a.id).not.toMatch(/eligib|attempt|\bcap\b|\blimit(s|ed)?\b|cooldown|expire|reCAPTCHA|session token|webhook|database|\bRLS\b/i)
      expect(textOf(a), a.id).not.toMatch(/\/admin/)
    }
  })

  it("names real page paths only (customer pages from SITE_PAGES, admin pages from the admin catalog)", () => {
    const known = new Set(SITE_PAGES.map((p) => p.path))
    const admin = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const a of ACCOUNT_ARTICLES) {
      const paths = pathsIn(a.body)
      expect(paths.length, `${a.id} has a page path`).toBeGreaterThan(0)
      for (const p of paths) expect(isAdminArticle(a.id) ? admin.has(p) || known.has(p) : known.has(p), `${a.id}: ${p}`).toBe(true)
    }
  })

  it("never sends a public article to a signed-in-only page without saying an account is needed", () => {
    const byPath = new Map(SITE_PAGES.map((p) => [p.path, p]))
    for (const a of ACCOUNT_ARTICLES.filter((x) => x.audiences.includes("public"))) {
      const signedIn = pathsIn(a.body).filter((p) => !byPath.get(p)!.audiences.includes("public"))
      if (signedIn.length) expect(a.body, a.id).toMatch(/log in|logged in|signed in|account/i)
    }
  })

  it("uses the exact page titles for the pages it names", () => {
    expect(byId("account-sign-up").body).toContain("Sign up (/auth/signup)")
    expect(byId("account-log-in").body).toContain("Log in (/auth/login)")
    expect(byId("account-forgot-password").body).toContain("Forgot password (/auth/forgot-password)")
    expect(byId("account-forgot-password").body).toContain("Reset password (/auth/reset-password)")
    expect(byId("account-complete-profile").body).toContain("Complete profile (/auth/complete-profile)")
    expect(byId("account-profile-and-phone").body).toContain("Profile (/dashboard/profile)")
    expect(byId("support-chat").body).toContain("Support chat (/dashboard/complaints)")
    expect(byId("support-report-order-problem").body).toContain("My orders (/dashboard/my-orders)")
    expect(byId("developer-api-keys").body).toContain("Developer / API (/dashboard/developer)")
    expect(byId("developer-api-docs").body).toContain("Developer docs (/developers)")
    expect(byId("ai-assistant-customer").body).toContain("AI assistant (/ai)")
    expect(byId("admin-ai-assistant-cards").body).toContain("AI Assistant (/admin/ai-assistant)")
    expect(byId("admin-custom-roles").body).toContain("Roles & Tiers (/admin/roles)")
    expect(byId("admin-main-switches").body).toContain("App Settings (/admin/settings)")
    expect(byId("admin-main-switches").body).toContain("Payment Gateway (/admin/gateway)")
    expect(byId("admin-main-switches").body).toContain("Order Work Queue (/admin/order-payment-status)")
    expect(byId("admin-knowledge-base").body).toContain("AI Assistant (/admin/ai-assistant)")
  })

  it("describes only buttons, tabs and labels the code really shows", () => {
    const need: Record<string, string[]> = {
      "account-sign-up": ["Send OTP", "Verify", "Confirm Password", "Terms of Service", "Check your email", "Spam", "Continue with Google"],
      "account-log-in": ["Forgot password?", "Create an account"],
      "account-forgot-password": ["Send Reset Link", "Back to Login"],
      "account-complete-profile": ["Send OTP", "Verify", "Phone Number"],
      "account-profile-and-phone": ["Edit Profile", "Add", "Change", "Verify", "Change Password", "Set Password", "Active Sessions", "Logout All Devices"],
      "support-chat": ["New Complaint", "Send complaint", "Talk to a person", "Subject", "What is it about?", "What went wrong?"],
      "support-report-order-problem": ["Complain", "Report a problem", "Send complaint"],
      "developer-api-keys": ["API Keys", "Documentation", "Request API access", "Message admin", "Waiting for approval", "Regenerate", "Revoke key"],
      "ai-assistant-customer": ["Confirm", "Cancel"],
      "admin-ai-assistant-cards": ["Settings", "Admin assistant can use every admin page (every change needs your tap)", "Confirm", "Cancel", "Danger", "Money", "Change", "secure box"],
      "admin-custom-roles": ["Roles & Tiers", "Role details"],
      "admin-main-switches": ["Global Ordering Status", "Auto-Fulfillment Mode"],
      "admin-knowledge-base": ["Knowledge", "Add Entry", "Visible to", "Category", "Answer"],
    }
    for (const [id, labels] of Object.entries(need)) for (const l of labels) expect(byId(id).body, `${id}: ${l}`).toContain(l)
  })

  it("keeps the documented audience for each article", () => {
    expect(byId("account-sign-up").audiences).toEqual(["public"])
    expect(byId("account-log-in").audiences).toEqual(["public"])
    expect(byId("account-forgot-password").audiences).toEqual(["public"])
    expect(byId("account-security-tips").audiences).toEqual(["public"])
    expect(byId("ai-assistant-customer").audiences).toEqual(["public"])
    expect(byId("developer-api-docs").audiences).toEqual(["public"])
    for (const id of ["account-complete-profile", "account-profile-and-phone", "support-chat", "support-report-order-problem", "developer-api-keys"]) {
      expect(byId(id).audiences, id).toEqual(["customer"])
    }
  })

  it("states the security rules plainly", () => {
    const tips = byId("account-security-tips").body
    expect(tips).toMatch(/never share/i)
    expect(tips).toMatch(/PIN/)
    expect(tips).toMatch(/password/i)
    expect(tips).toMatch(/staff (will )?never ask/i)
    const ai = byId("ai-assistant-customer").body
    expect(ai).toMatch(/never (asks for|takes|needs) (your )?(password|PIN)/i)
    expect(ai).toMatch(/tap Confirm/)
  })

  it("covers the live approval rules for developer keys without inventing numbers", () => {
    const k = byId("developer-api-keys").body
    expect(k).toMatch(/test keys?/i)
    expect(k).toMatch(/live keys?/i)
    expect(k).toMatch(/approv/i)
    expect(k).toMatch(/only once/i)
    expect(k).toMatch(/If you don't see this option, it isn't available right now\./)
  })

  it("tells admins the real state of custom roles and the secure box", () => {
    expect(byId("admin-custom-roles").body).toMatch(/not (switched on|available) (yet|for)|switched off|off for now/i)
    const c = byId("admin-ai-assistant-cards").body
    expect(c).toMatch(/never type it in the chat/i)
    expect(c).toMatch(/check the page/i)
    expect(byId("admin-knowledge-base").body).toMatch(/latest word|win(s)? over|takes priority|newer/i)
  })
})

describe("account articles: realistic questions find the right article", () => {
  const cases: { q: string; aud: Audience[]; id: string }[] = [
    { q: "how do i create an account on datagod", aud: GUEST, id: "account-sign-up" },
    { q: "otp not coming when i sign up", aud: GUEST, id: "account-sign-up" },
    { q: "i did not get the confirmation email", aud: GUEST, id: "account-sign-up" },
    { q: "how i go login to my account", aud: GUEST, id: "account-log-in" },
    { q: "can i sign in with google", aud: GUEST, id: "account-log-in" },
    { q: "i forgot my password how do i reset it", aud: GUEST, id: "account-forgot-password" },
    { q: "reset password link not working", aud: GUEST, id: "account-forgot-password" },
    { q: "finish setting up my profile after google sign in", aud: CUSTOMER, id: "account-complete-profile" },
    { q: "how do i verify my phone number", aud: CUSTOMER, id: "account-profile-and-phone" },
    { q: "i want to change my phone number on my account", aud: CUSTOMER, id: "account-profile-and-phone" },
    { q: "how to log out of all other devices", aud: CUSTOMER, id: "account-profile-and-phone" },
    { q: "someone asked me for my pin is it safe to share", aud: GUEST, id: "account-security-tips" },
    { q: "how do i talk to a real person", aud: CUSTOMER, id: "support-chat" },
    { q: "i want to complain to support chat", aud: CUSTOMER, id: "support-chat" },
    { q: "where is the complain button for my order", aud: CUSTOMER, id: "support-report-order-problem" },
    { q: "report a problem with a data order", aud: CUSTOMER, id: "support-report-order-problem" },
    { q: "how do i get an api key for my app", aud: CUSTOMER, id: "developer-api-keys" },
    { q: "why is my live api key waiting for approval", aud: CUSTOMER, id: "developer-api-keys" },
    { q: "where is the api documentation", aud: GUEST, id: "developer-api-docs" },
    { q: "can the ai assistant buy data for me", aud: GUEST, id: "ai-assistant-customer" },
    { q: "what does the confirm card from the assistant do", aud: CUSTOMER, id: "ai-assistant-customer" },
    { q: "how does the admin assistant confirm card work", aud: ADMIN, id: "admin-ai-assistant-cards" },
    { q: "turn on admin assistant full access", aud: ADMIN, id: "admin-ai-assistant-cards" },
    { q: "how do custom roles and tiers work", aud: ADMIN, id: "admin-custom-roles" },
    { q: "where do i pause ordering for the whole site", aud: ADMIN, id: "admin-main-switches" },
    { q: "where to switch payment gateway or auto fulfilment", aud: ADMIN, id: "admin-main-switches" },
    { q: "how do i add an entry to the ai knowledge base", aud: ADMIN, id: "admin-knowledge-base" },
  ]
  for (const c of cases) {
    it(`"${c.q}" finds ${c.id}`, () => {
      expect(searchSite(c.q, c.aud, 3).map((a) => a.id)).toContain(c.id)
    })
  }

  it("keeps admin articles away from non-admin audiences", () => {
    for (const id of ADMIN_IDS) {
      expect(searchSite("admin assistant custom roles ordering switch knowledge base", CUSTOMER, 20).map((a) => a.id)).not.toContain(id)
    }
  })
})
