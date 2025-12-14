"use client"

import { MessageCircle, Mail, HelpCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

export function Step6Support() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center mb-6">
        <div className="text-6xl">💬</div>
      </div>

      <div className="space-y-4">
        <h3 className="text-2xl font-bold text-gray-900 text-center">
          Get Support
        </h3>
        <p className="text-gray-600 text-center">
          We're here to help. Multiple ways to reach our support team.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Support Channel 1 */}
        <div className="flex gap-4 p-4 bg-green-50 rounded-lg border border-green-200">
          <div className="flex-shrink-0">
            <MessageCircle className="w-6 h-6 text-green-600 mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-gray-900">WhatsApp Support</h4>
            <p className="text-sm text-gray-600 mt-1">
              Get instant help on WhatsApp. We respond within minutes during business hours.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-green-600 border-green-600 hover:bg-green-50"
              asChild
            >
              <a href="https://wa.me/233546961942" target="_blank" rel="noopener noreferrer">
                Open WhatsApp
              </a>
            </Button>
          </div>
        </div>

        {/* Support Channel 2 */}
        <div className="flex gap-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
          <div className="flex-shrink-0">
            <Mail className="w-6 h-6 text-blue-600 mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-gray-900">Email Support</h4>
            <p className="text-sm text-gray-600 mt-1">
              Send detailed queries via email. We respond within 24 hours.
            </p>
            <p className="text-sm font-mono text-blue-600 mt-2">support@datagod.com</p>
          </div>
        </div>

        {/* Support Channel 3 */}
        <div className="flex gap-4 p-4 bg-purple-50 rounded-lg border border-purple-200">
          <div className="flex-shrink-0">
            <HelpCircle className="w-6 h-6 text-purple-600 mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-gray-900">FAQ & Documentation</h4>
            <p className="text-sm text-gray-600 mt-1">
              Browse our FAQ and help articles for quick answers to common questions.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-purple-600 border-purple-600 hover:bg-purple-50"
            >
              View FAQ
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-gray-900 text-sm">Common Issues:</h4>
        <ul className="space-y-2 text-sm text-gray-700">
          <li className="flex gap-2">
            <span>❓</span> <span>Data not received? Check with your network provider</span>
          </li>
          <li className="flex gap-2">
            <span>❓</span> <span>Payment issues? Try another payment method</span>
          </li>
          <li className="flex gap-2">
            <span>❓</span> <span>Refund requests? We process them within 48 hours</span>
          </li>
        </ul>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-gray-700">
        <p className="font-semibold text-blue-900 mb-2">💡 Pro Tip:</p>
        <p>Check our FAQ first! Most issues are resolved in seconds. We're available 24/7 for urgent issues.</p>
      </div>
    </div>
  )
}
