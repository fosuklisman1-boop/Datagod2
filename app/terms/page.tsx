import { createClient } from "@supabase/supabase-js"
import Link from "next/link"
import { Shield } from "lucide-react"

const DEFAULT_TERMS = `Welcome to DATAGOD. By accessing or using our platform, you agree to be bound by these Terms of Service. Please read them carefully before creating an account or making any purchase.

1. General Account Registration & Security
By creating an account on DATAGOD, you agree to provide truthful and accurate personal information including your full name, phone number, and email address. You are solely responsible for maintaining the confidentiality of your password and for all activities that occur under your account. Your Wallet balance is tied exclusively to your account and may not be transferred to another user. DATAGOD reserves the right to suspend or terminate any account found to have provided false information or engaged in suspicious activity.

2. Instant, Non-Refundable Delivery
All digital products — including Mobile Data Bundles (MTN, Telecel, AT-iShare, AT-BigTime), Airtime, WAEC/School Results Checker Vouchers, and MTN AFA Registrations — are processed and delivered instantly upon successful payment or Wallet deduction. Once a transaction has been completed and the product delivered, it cannot be reversed, recalled, or refunded under any circumstances, except where explicitly covered under Section 4.

3. Buyer Accuracy Guarantee
You are solely responsible for verifying that the recipient's phone number and the selected telecommunications network (MTN, Telecel, AT-iShare, or AT-BigTime) are 100% correct before confirming any order. DATAGOD will not be held liable for deliveries made to an incorrect phone number or wrong network as a result of user input errors. No refund, credit, or replacement will be issued in such cases.

4. Processing Times & 24-Hour Reporting Window
While the vast majority of transactions are fulfilled within seconds, occasional delays may occur due to network downtime or high traffic. If you do not receive your order within a reasonable time, you MUST report it to our support team within 24 hours of purchase. Failure to report within this window may result in forfeiture of eligibility for fulfillment or manual compensation.

5. Payment Verification & Stay-on-Page Policy
When paying via our Paystack-powered checkout, you MUST remain on the payment page until you receive the final confirmation screen. Closing or navigating away from the payment tab before this confirmation may result in your payment being recorded but your order remaining unprocessed. DATAGOD is not liable for order failures caused by premature tab closure. If this occurs, use the order tracking feature or contact support immediately with your payment reference.

6. Wallet Top-Ups & Withdrawals
Wallet top-ups are processed via Paystack and are subject to applicable gateway and platform fees displayed at checkout. Funds added to your Wallet are non-transferable and may only be used for purchases on the DATAGOD platform. Withdrawal requests are subject to a processing fee and may take up to 3 business days to complete. DATAGOD reserves the right to pause wallet top-ups or withdrawals during scheduled maintenance.

7. Results Checker Vouchers
WAEC and School Results Checker Vouchers are strictly one-time-use digital products. Once a voucher has been delivered to you or used on any examination body's portal, it cannot be refunded, replaced, or reused. Ensure you use your voucher promptly and keep it secure. DATAGOD bears no responsibility for vouchers used or misplaced after delivery.

8. Agent, Dealer & Shop Roles
Users who subscribe to Agent or Dealer upgrade plans, or who operate Shops or Sub-Agent storefronts on the DATAGOD platform, are bound by the pricing guidelines, operational policies, and network provider rules set by DATAGOD. Sub-agents and shop owners must not set prices below the minimum floor prices defined by the platform. DATAGOD reserves the right to suspend, revoke, or downgrade any account found to be abusing the platform, violating network provider terms, or engaging in fraudulent activity.`

async function getTerms() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { data } = await supabase
      .from("app_settings")
      .select("terms_content, terms_last_updated")
      .single()
    return data
  } catch {
    return null
  }
}

function parseTerms(content: string) {
  const lines = content.split("\n")
  let intro = ""
  const sections: Array<{ title: string; body: string }> = []
  let current: { title: string; lines: string[] } | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (/^\d+\.\s/.test(trimmed)) {
      if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })
      current = { title: trimmed, lines: [] }
    } else if (current) {
      current.lines.push(trimmed)
    } else {
      intro += (intro ? " " : "") + trimmed
    }
  }

  if (current) sections.push({ title: current.title, body: current.lines.join(" ").trim() })

  return { intro, sections }
}

export default async function TermsPage() {
  const data = await getTerms()
  const rawContent = data?.terms_content || DEFAULT_TERMS

  const lastUpdated = data?.terms_last_updated
    ? new Date(data.terms_last_updated).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
    : "April 2026"

  const { intro, sections } = parseTerms(rawContent)

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <nav className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-bold text-gray-900 hover:text-violet-700 transition-colors">
            <Shield className="w-5 h-5 text-violet-600" />
            DATAGOD
          </Link>
          <Link href="/" className="text-sm text-violet-600 hover:underline">
            Back to Home
          </Link>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-4 py-12">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-violet-100 rounded-2xl mb-4">
            <Shield className="w-7 h-7 text-violet-600" />
          </div>
          <h1 className="text-4xl font-black text-gray-900 mb-4">Terms of Service</h1>
          {intro && (
            <p className="text-base text-gray-600 max-w-2xl mx-auto leading-relaxed">{intro}</p>
          )}
        </div>

        <div className="space-y-4">
          {sections.map((section, i) => (
            <div key={i} className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow">
              <h2 className="text-base font-bold text-violet-700 mb-2">{section.title}</h2>
              <p className="text-gray-700 leading-relaxed text-sm">{section.body}</p>
            </div>
          ))}
        </div>

        <p className="text-center text-sm text-gray-400 mt-10 pb-6">
          Last updated: {lastUpdated}
        </p>
      </main>
    </div>
  )
}
