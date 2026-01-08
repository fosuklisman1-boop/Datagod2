"use client"

import Link from "next/link"
import { Metadata } from "next"
import { Button } from "@/components/ui/button"
import { Package, Zap, Users, ArrowRight, Lock } from "lucide-react"

export const metadata: Metadata = {
  title: "DATAGOD - Buy Data Packages & Airtime | Start Today",
  description: "Affordable mobile data, airtime, and digital services for Ghana. Instant delivery from MTN, Telecel, AT and more. Sign up today for quick access.",
  keywords: [
    "buy data packages",
    "mobile airtime",
    "data bundles",
    "instant delivery",
    "Ghana data services",
  ],
  openGraph: {
    title: "DATAGOD - Buy Data Packages & Airtime | Start Today",
    description: "Affordable mobile data, airtime, and digital services for Ghana. Instant delivery from MTN, Telecel, AT and more.",
    type: "website",
    url: "https://www.datagod.store",
    images: [
      {
        url: "https://www.datagod.store/og-image.png",
        width: 1200,
        height: 630,
        alt: "DATAGOD Homepage",
      },
    ],
  },
};

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
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
            <Link href="/auth/login">
              <Button size="lg" className="bg-gradient-to-r from-blue-600 to-purple-600 gap-2 w-full sm:w-auto">
                Login to Dashboard
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Button size="lg" variant="outline" className="w-full sm:w-auto">
              Learn More
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

      {/* CTA Section */}
      <section className="bg-gradient-to-r from-blue-600 to-purple-600 text-white py-8 sm:py-16 mt-8 sm:mt-20">
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
      <footer className="bg-gray-900 text-gray-400 py-8 sm:py-12 mt-8">
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
                <li><a href="#" className="hover:text-white">Features</a></li>
                <li><a href="#" className="hover:text-white">Pricing</a></li>
                <li><a href="#" className="hover:text-white">Security</a></li>
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
                <li><a href="#" className="hover:text-white">Terms</a></li>
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
