import Link from "next/link"
import { Shield } from "lucide-react"

export const metadata = {
  title: "Privacy Policy | DATAGOD",
  description: "DATAGOD Privacy Policy — how we collect, use, and protect your personal information.",
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-muted/40">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="flex items-center gap-3 mb-8">
          <Shield className="w-8 h-8 text-emerald-600" />
          <h1 className="text-3xl font-bold text-foreground">Privacy Policy</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">Last updated: June 2026</p>

        <div className="bg-card rounded-xl shadow-sm border border-border p-8 space-y-8 text-foreground leading-relaxed">

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">1. Information We Collect</h2>
            <p>When you create an account or make a purchase on DATAGOD, we collect personal information including your full name, email address, phone number, and transaction history. We also collect technical data such as IP addresses and browser information for security and fraud prevention purposes.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">2. How We Use Your Information</h2>
            <p>We use your information to process orders, manage your wallet, send order confirmations and delivery notifications via SMS and email, prevent fraud, and improve our services. We do not sell your personal information to third parties.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">3. Data Sharing</h2>
            <p>We share your information only with service providers necessary to fulfil your orders (telecommunications networks, payment processors such as Paystack, and SMS providers). These partners are contractually bound to protect your data and use it only for the purposes we specify.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">4. Payment Information</h2>
            <p>All payment processing is handled by Paystack. DATAGOD does not store your card or mobile money details. Wallet balances are stored securely in our database and are associated only with your account.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">5. Data Retention</h2>
            <p>We retain your account and transaction data for as long as your account is active or as required by applicable law. You may request deletion of your account and associated data by contacting our support team.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">6. Security</h2>
            <p>We implement industry-standard security measures including encrypted connections (HTTPS), hashed passwords, and role-based access controls to protect your personal information from unauthorised access, disclosure, or misuse.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">7. Your Rights</h2>
            <p>You have the right to access, correct, or request deletion of your personal data. You may also opt out of marketing communications at any time. To exercise these rights, contact us through our support channels.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">8. Cookies</h2>
            <p>We use essential cookies to maintain your session and keep you logged in. We do not use tracking or advertising cookies.</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-foreground mb-3">9. Contact</h2>
            <p>If you have questions about this Privacy Policy, please contact us through the support channels available on the DATAGOD platform.</p>
          </section>

        </div>

        <div className="mt-8 text-center text-sm text-muted-foreground">
          <Link href="/terms" className="text-emerald-600 hover:underline">Terms of Service</Link>
          {" · "}
          <Link href="/" className="text-emerald-600 hover:underline">Back to Home</Link>
        </div>
      </div>
    </div>
  )
}
