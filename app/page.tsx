"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Package, Zap, Users, ArrowRight, Lock,
  ShoppingCart, Wallet, GraduationCap, Store,
  CheckCircle2, CreditCard, Phone, UserPlus,
  TrendingUp, Share2, Settings, Search, ChevronDown
} from "lucide-react"
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import StorefrontRedirector from "@/components/StorefrontRedirector"

function Step({
  number,
  icon,
  title,
  description,
  mockup,
}: {
  number: number
  icon: React.ReactNode
  title: string
  description: string
  mockup?: React.ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 text-white text-sm font-bold flex items-center justify-center shadow">
        {number}
      </div>
      <div className="flex-1 pb-6 border-b border-gray-100 last:border-0 last:pb-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-blue-600">{icon}</span>
          <h4 className="font-semibold text-gray-900 text-sm">{title}</h4>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed mb-3">{description}</p>
        {mockup && (
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            {mockup}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Mini UI Mockups ─────────────────────────── */

function MockNetworkPicker() {
  return (
    <div className="p-3 bg-slate-50">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">Select Network</p>
      <div className="grid grid-cols-4 gap-2">
        {[
          { name: "MTN", color: "bg-yellow-400" },
          { name: "Telecel", color: "bg-red-500" },
          { name: "AT-iShare", color: "bg-blue-600" },
          { name: "AT-BigTime", color: "bg-purple-600" },
        ].map((n, i) => (
          <div key={n.name} className={`rounded-lg border-2 p-2 text-center ${i === 0 ? "border-blue-500 bg-blue-50" : "border-gray-200"}`}>
            <div className={`w-5 h-5 ${n.color} rounded-full mx-auto mb-1`} />
            <p className="text-[9px] font-bold text-gray-700">{n.name}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function MockPackageCard() {
  return (
    <div className="p-3 bg-slate-50 flex gap-2">
      {[{ size: "1GB", price: "5.00" }, { size: "3GB", price: "12.00" }, { size: "5GB", price: "18.00" }].map((p) => (
        <div key={p.size} className="flex-1 bg-white border border-gray-200 rounded-xl p-2 text-center shadow-sm">
          <p className="text-sm font-black text-gray-900">{p.size}</p>
          <p className="text-[10px] text-gray-500 mb-1">MTN</p>
          <p className="text-xs font-bold text-blue-600">GHS {p.price}</p>
        </div>
      ))}
    </div>
  )
}

function MockCheckout() {
  return (
    <div className="p-3 bg-slate-50 space-y-2">
      <div className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
        <Phone className="w-3 h-3 text-gray-400" />
        <span className="text-[11px] text-gray-400">0201234567</span>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
        <span className="text-[11px] text-gray-400">john@email.com</span>
      </div>
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg py-1.5 text-center">
        <span className="text-[11px] font-bold text-white">Order Now — GHS 5.00</span>
      </div>
    </div>
  )
}

function MockPaystack() {
  return (
    <div className="p-3 bg-slate-50 text-center space-y-2">
      <div className="inline-flex items-center gap-1.5 bg-white border border-gray-200 rounded-full px-3 py-1 shadow-sm">
        <Lock className="w-3 h-3 text-green-600" />
        <span className="text-[10px] font-semibold text-gray-700">Secured by Paystack</span>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg p-2 flex items-center gap-2">
        <CreditCard className="w-4 h-4 text-gray-400" />
        <div className="flex-1 h-2 bg-gray-100 rounded" />
        <span className="text-[10px] text-gray-400">****</span>
      </div>
      <p className="text-[10px] text-orange-600 font-semibold">⚠ Do not close this tab until confirmed</p>
    </div>
  )
}

function MockSuccess() {
  return (
    <div className="p-4 bg-green-50 text-center space-y-1">
      <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto" />
      <p className="text-xs font-bold text-green-700">Data Delivered!</p>
      <p className="text-[10px] text-green-600">1GB sent to 0201234567</p>
    </div>
  )
}

function MockWallet() {
  return (
    <div className="p-3 bg-slate-50 space-y-2">
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-xl p-3 text-white">
        <p className="text-[10px] opacity-80">Wallet Balance</p>
        <p className="text-lg font-black">GHS 50.00</p>
      </div>
      <div className="bg-white border border-gray-200 rounded-lg py-1.5 text-center">
        <span className="text-[11px] font-semibold text-blue-600">+ Top Up Wallet</span>
      </div>
    </div>
  )
}

function MockShopLink() {
  return (
    <div className="p-3 bg-slate-50">
      <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 flex items-center gap-2">
        <Store className="w-3 h-3 text-purple-600 flex-shrink-0" />
        <span className="text-[11px] text-gray-600 truncate">datagod.store/shop/<span className="font-bold text-purple-600">your-shop</span></span>
        <Share2 className="w-3 h-3 text-gray-400 flex-shrink-0 ml-auto" />
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5 text-center">Share this link with your customers</p>
    </div>
  )
}

function MockTrackOrder() {
  return (
    <div className="p-3 bg-slate-50 space-y-1.5">
      {[
        { label: "3GB MTN Data", status: "Delivered", color: "text-green-600 bg-green-50 border-green-200" },
        { label: "Airtime GHS 5", status: "Delivered", color: "text-green-600 bg-green-50 border-green-200" },
        { label: "WAEC Voucher", status: "Pending", color: "text-yellow-600 bg-yellow-50 border-yellow-200" },
      ].map((o) => (
        <div key={o.label} className="bg-white border border-gray-100 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
          <span className="text-[10px] font-medium text-gray-700">{o.label}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${o.color}`}>{o.status}</span>
        </div>
      ))}
    </div>
  )
}

function MockVoucher() {
  return (
    <div className="p-3 bg-slate-50 text-center space-y-2">
      <div className="bg-white border-2 border-dashed border-blue-300 rounded-xl p-3">
        <GraduationCap className="w-6 h-6 text-blue-600 mx-auto mb-1" />
        <p className="text-[10px] font-bold text-gray-700">WAEC Results Checker</p>
        <p className="text-[10px] text-gray-400 mt-1">PIN: <span className="font-mono font-bold text-gray-900">****-****-****</span></p>
        <p className="text-[10px] text-gray-400">Serial: <span className="font-mono font-bold text-gray-900">WEC2024****</span></p>
      </div>
      <p className="text-[10px] text-gray-500">Use on waecdirect.org</p>
    </div>
  )
}

function MockProfitMargin() {
  return (
    <div className="p-3 bg-slate-50 space-y-1.5">
      {[
        { size: "1GB MTN", base: "3.00", profit: "2.00", sell: "5.00" },
        { size: "3GB MTN", base: "8.00", profit: "4.00", sell: "12.00" },
      ].map((p) => (
        <div key={p.size} className="bg-white border border-gray-100 rounded-lg px-2.5 py-1.5 flex items-center gap-2">
          <span className="text-[10px] font-medium text-gray-700 flex-1">{p.size}</span>
          <span className="text-[9px] text-gray-400">Base GHS {p.base}</span>
          <span className="text-[9px] text-green-600 font-bold">+{p.profit}</span>
          <span className="text-[9px] font-black text-blue-700">= GHS {p.sell}</span>
        </div>
      ))}
    </div>
  )
}

export default function HomePage() {
  const scrollToGuide = () => {
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      <StorefrontRedirector />
      {/* Organization + Website Schema */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "DATAGOD",
            url: "https://www.datagod.store",
            description: "Buy affordable data packages from multiple networks with instant delivery",
            potentialAction: {
              "@type": "SearchAction",
              target: {
                "@type": "EntryPoint",
                urlTemplate: "https://www.datagod.store/shop?search={search_term_string}",
              },
              query_input: "required name=search_term_string",
            },
          }),
        }}
      />

      {/* Navigation */}
      <nav className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-6 py-4 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="bg-white p-2 rounded-lg">
            <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">DATAGOD</h1>
        </div>
        <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row sm:items-center sm:gap-4">
          <Link href="/auth/login">
            <Button variant="outline" className="w-full sm:w-auto">Sign In</Button>
          </Link>
          <Link href="/auth/signup">
            <Button className="bg-gradient-to-r from-blue-600 to-purple-600 w-full sm:w-auto">
              Get Started
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="max-w-6xl mx-auto px-2 sm:px-6 py-8 sm:py-20">
        <div className="text-center space-y-4 sm:space-y-6 mb-8 sm:mb-16">
          <h2 className="text-2xl sm:text-4xl md:text-5xl font-bold text-gray-900">
            Your Data Hub Solution
          </h2>
          <p className="text-base sm:text-xl text-gray-600 max-w-2xl mx-auto">
            Buy data packages from multiple networks, manage your wallet, and track your orders all in one place.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
            <GuestPurchaseButton variant="secondary" className="w-full sm:w-auto" />
            <Link href="/auth/login">
              <Button size="lg" className="bg-gradient-to-r from-blue-600 to-purple-600 gap-2 w-full sm:w-auto">
                Login to Dashboard
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="w-full sm:w-auto gap-2" onClick={scrollToGuide}>
              Learn More
              <ChevronDown className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 mt-10 sm:mt-20">
          <div className="p-4 sm:p-6 bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg transition-shadow">
            <Package className="w-8 h-8 text-blue-600 mb-4" />
            <h3 className="font-semibold text-gray-900 mb-2">Data Packages</h3>
            <p className="text-sm text-gray-600">
              Browse and purchase data packages from multiple networks
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg transition-shadow">
            <Zap className="w-8 h-8 text-purple-600 mb-4" />
            <h3 className="font-semibold text-gray-900 mb-2">Instant Delivery</h3>
            <p className="text-sm text-gray-600">
              Get your data packages delivered instantly to your account
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg transition-shadow">
            <Users className="w-8 h-8 text-green-600 mb-4" />
            <h3 className="font-semibold text-gray-900 mb-2">24/7 Support</h3>
            <p className="text-sm text-gray-600">
              Our support team is always available to help you
            </p>
          </div>
          <div className="p-4 sm:p-6 bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-lg transition-shadow">
            <Lock className="w-8 h-8 text-orange-600 mb-4" />
            <h3 className="font-semibold text-gray-900 mb-2">Secure & Safe</h3>
            <p className="text-sm text-gray-600">
              Your transactions are protected with industry-standard security
            </p>
          </div>
        </div>
      </section>

      {/* ── How It Works ────────────────────────────────────── */}
      <section id="how-it-works" className="bg-white border-t border-b border-gray-100 py-16 sm:py-24">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="text-center mb-12">
            <span className="inline-block px-3 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded-full uppercase tracking-wider mb-3">
              How It Works
            </span>
            <h2 className="text-2xl sm:text-4xl font-bold text-gray-900 mb-3">
              Everything you need, step by step
            </h2>
            <p className="text-gray-500 max-w-xl mx-auto text-sm sm:text-base">
              Whether you're buying data for yourself, managing a dashboard, or running your own shop — we've got you covered.
            </p>
          </div>

          <Tabs defaultValue="guest" className="w-full">
            <TabsList className="grid grid-cols-3 w-full mb-10 h-auto">
              <TabsTrigger value="guest" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <ShoppingCart className="w-4 h-4" />
                <span>Buy from a Shop</span>
              </TabsTrigger>
              <TabsTrigger value="dashboard" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <Wallet className="w-4 h-4" />
                <span>Dashboard User</span>
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex flex-col gap-1 py-3 text-xs sm:text-sm">
                <Store className="w-4 h-4" />
                <span>Open a Shop</span>
              </TabsTrigger>
            </TabsList>

            {/* ── Tab 1: Buy from a Shop (no login) ── */}
            <TabsContent value="guest">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<Share2 className="w-4 h-4" />}
                    title="Get a Shop Link"
                    description="Ask your seller for their storefront link (e.g. datagod.store/shop/their-shop), or follow a link shared on WhatsApp, social media, or a flyer. No account needed."
                  />
                  <Step
                    number={2}
                    icon={<Phone className="w-4 h-4" />}
                    title="Choose Your Network"
                    description="Tap your network — MTN, Telecel, AT-iShare, or AT-BigTime — to reveal available data plans."
                    mockup={<MockNetworkPicker />}
                  />
                  <Step
                    number={3}
                    icon={<Package className="w-4 h-4" />}
                    title="Pick a Package"
                    description="Select the data bundle that fits your needs. Prices are set by the shop owner and shown upfront — no hidden fees."
                    mockup={<MockPackageCard />}
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<ShoppingCart className="w-4 h-4" />}
                    title="Enter Your Details & Order"
                    description="Enter the recipient's phone number and your email address, then tap Order Now. Double-check the number — deliveries to wrong numbers cannot be reversed."
                    mockup={<MockCheckout />}
                  />
                  <Step
                    number={5}
                    icon={<CreditCard className="w-4 h-4" />}
                    title="Pay via Paystack"
                    description="You'll be taken to the secure Paystack checkout. Complete payment and stay on the page until you see the green confirmation screen."
                    mockup={<MockPaystack />}
                  />
                  <Step
                    number={6}
                    icon={<CheckCircle2 className="w-4 h-4" />}
                    title="Instant Delivery"
                    description="Your data is delivered to the entered number within seconds. Use the Track Order tab on the shop to check your order status anytime."
                    mockup={<MockSuccess />}
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                <strong>Tip:</strong> You can also buy Airtime and WAEC/School Results Checker Vouchers from the same storefront — just tap the <em>Buy Airtime</em> or <em>Results Vouchers</em> tab at the top of the shop.
              </div>
            </TabsContent>

            {/* ── Tab 2: Dashboard User ── */}
            <TabsContent value="dashboard">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<UserPlus className="w-4 h-4" />}
                    title="Create a Free Account"
                    description="Sign up at datagod.store/auth/signup with your full name, phone number, and email. Check your email to verify your account."
                  />
                  <Step
                    number={2}
                    icon={<Wallet className="w-4 h-4" />}
                    title="Top Up Your Wallet"
                    description="Go to Dashboard → Wallet → Top Up. Pay via Paystack to load credit into your DATAGOD wallet instantly. A small platform fee applies."
                    mockup={<MockWallet />}
                  />
                  <Step
                    number={3}
                    icon={<Package className="w-4 h-4" />}
                    title="Buy Data Bundles"
                    description="Go to Buy Data, choose your network (MTN, Telecel, AT-iShare, AT-BigTime), pick a package, enter the recipient's number, and confirm. The cost is deducted from your wallet instantly."
                    mockup={<MockNetworkPicker />}
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<Zap className="w-4 h-4" />}
                    title="Buy Airtime"
                    description="Go to Buy Airtime, select the network, enter the amount and recipient number. Airtime is sent instantly and the amount is deducted from your wallet."
                  />
                  <Step
                    number={5}
                    icon={<GraduationCap className="w-4 h-4" />}
                    title="Get Results Checker Vouchers"
                    description="Go to Results Checker, choose your exam type (WAEC, BECE, etc.), and purchase. Your PIN and serial number are delivered instantly — use them on the exam body's official website."
                    mockup={<MockVoucher />}
                  />
                  <Step
                    number={6}
                    icon={<Search className="w-4 h-4" />}
                    title="Track All Your Orders"
                    description="Go to My Orders to see every purchase — data, airtime, and vouchers — with their status, date, and details. Contact support if an order doesn't arrive within 24 hours."
                    mockup={<MockTrackOrder />}
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-800">
                <strong>Tip:</strong> Using your wallet is faster than paying per order — load credit once and buy multiple times without going through Paystack each time.
              </div>
            </TabsContent>

            {/* ── Tab 3: Open a Shop ── */}
            <TabsContent value="agent">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-0">
                <div className="space-y-0">
                  <Step
                    number={1}
                    icon={<UserPlus className="w-4 h-4" />}
                    title="Create & Verify Your Account"
                    description="Start by creating a free DATAGOD account at datagod.store/auth/signup. Verify your email before proceeding."
                  />
                  <Step
                    number={2}
                    icon={<TrendingUp className="w-4 h-4" />}
                    title="Upgrade to Agent or Dealer"
                    description="Go to Dashboard → Upgrade. Choose an Agent or Dealer subscription plan. Dealers get cheaper base prices, allowing higher profit margins."
                  />
                  <Step
                    number={3}
                    icon={<Store className="w-4 h-4" />}
                    title="Create Your Shop"
                    description="Go to Dashboard → My Shop → Create Shop. Set your shop name, a custom URL slug, description, logo, and your WhatsApp contact. This becomes your public storefront."
                  />
                </div>
                <div className="space-y-0">
                  <Step
                    number={4}
                    icon={<Settings className="w-4 h-4" />}
                    title="Set Packages & Profit Margins"
                    description="Enable the data packages you want to sell and set your profit margin on each one. Your selling price = base price + your margin. You keep the margin on every sale."
                    mockup={<MockProfitMargin />}
                  />
                  <Step
                    number={5}
                    icon={<Share2 className="w-4 h-4" />}
                    title="Share Your Shop Link"
                    description="Your shop is live at datagod.store/shop/your-slug. Share it on WhatsApp, social media, or print it on flyers. Customers can order directly — no login required for them."
                    mockup={<MockShopLink />}
                  />
                  <Step
                    number={6}
                    icon={<Users className="w-4 h-4" />}
                    title="Add Sub-Agents (Optional)"
                    description="Grow your network by inviting Sub-Agents under your shop. They get their own storefronts, set their own margins on top of yours, and you earn from their sales too."
                  />
                </div>
              </div>
              <div className="mt-8 p-4 bg-purple-50 border border-purple-200 rounded-xl text-sm text-purple-800">
                <strong>Tip:</strong> Keep your WhatsApp number visible on your shop — customers trust sellers they can message directly. Use the Shop Settings page to configure your WhatsApp link.
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-12 text-center">
            <p className="text-gray-500 text-sm mb-4">Ready to get started?</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/auth/signup">
                <Button className="bg-gradient-to-r from-blue-600 to-purple-600 gap-2 w-full sm:w-auto">
                  Create Free Account
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-gradient-to-r from-blue-600 to-purple-600 text-white py-8 sm:py-16 mt-0">
        <div className="max-w-4xl mx-auto px-2 sm:px-6 text-center space-y-4 sm:space-y-6">
          <h2 className="text-xl sm:text-3xl md:text-4xl font-bold">Ready to Get Started?</h2>
          <p className="text-sm sm:text-lg text-blue-100">
            Join thousands of users who trust DATAGOD for their data needs
          </p>
          <Link href="/auth/signup">
            <Button size="lg" className="bg-white text-blue-600 hover:bg-gray-100 w-full sm:w-auto">
              Create Your Account
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-400 py-8 sm:py-12">
        <div className="max-w-6xl mx-auto px-2 sm:px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 sm:gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Lock className="w-5 h-5 text-blue-400" />
                <span className="font-semibold text-white">DATAGOD</span>
              </div>
              <p className="text-sm">Your trusted data hub solution</p>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Product</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#how-it-works" className="hover:text-white">How It Works</a></li>
                <li><a href="#how-it-works" className="hover:text-white">Features</a></li>
                <li><a href="#how-it-works" className="hover:text-white">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Company</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#" className="hover:text-white">About</a></li>
                <li><a href="#" className="hover:text-white">Blog</a></li>
                <li><a href="#" className="hover:text-white">Contact</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white mb-4">Legal</h4>
              <ul className="space-y-2 text-sm">
                <li><a href="#" className="hover:text-white">Privacy</a></li>
                <li><a href="/terms" className="hover:text-white">Terms</a></li>
                <li><a href="#" className="hover:text-white">Cookies</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-gray-800 pt-8 text-center text-sm">
            <p>&copy; 2025 DATAGOD. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
