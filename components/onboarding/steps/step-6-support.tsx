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
        <h3 className="text-2xl font-bold text-foreground text-center">
          Get Support
        </h3>
        <p className="text-muted-foreground text-center">
          We're here to help. Multiple ways to reach our support team.
        </p>
      </div>

      <div className="space-y-4 mt-6">
        {/* Support Channel 1 */}
        <div className="flex gap-4 p-4 bg-success/10 rounded-lg border border-border">
          <div className="flex-shrink-0">
            <MessageCircle className="w-6 h-6 text-success mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-foreground">WhatsApp Support</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Get instant help on WhatsApp. We respond within minutes during business hours.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-success border-success/30 hover:bg-success/10"
              asChild
            >
              <a href="https://wa.me/233546961942" target="_blank" rel="noopener noreferrer">
                Open WhatsApp
              </a>
            </Button>
          </div>
        </div>

        {/* Support Channel 2 */}
        <div className="flex gap-4 p-4 bg-primary/5 rounded-lg border border-primary/20">
          <div className="flex-shrink-0">
            <Mail className="w-6 h-6 text-primary mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-foreground">Email Support</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Send detailed queries via email. We respond within 24 hours.
            </p>
            <p className="text-sm font-mono text-primary mt-2">support@datagod.com</p>
          </div>
        </div>

        {/* Support Channel 3 */}
        <div className="flex gap-4 p-4 bg-primary rounded-lg border border-border">
          <div className="flex-shrink-0">
            <HelpCircle className="w-6 h-6 text-primary mt-1" />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-foreground">FAQ & Documentation</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Browse our FAQ and help articles for quick answers to common questions.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-primary border-primary hover:bg-primary/10"
            >
              View FAQ
            </Button>
          </div>
        </div>
      </div>

      <div className="bg-primary border border-border rounded-lg p-4 space-y-3">
        <h4 className="font-semibold text-foreground text-sm">Common Issues:</h4>
        <ul className="space-y-2 text-sm text-foreground">
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

      <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm text-foreground">
        <p className="font-semibold text-blue-900 mb-2">💡 Pro Tip:</p>
        <p>Check our FAQ first! Most issues are resolved in seconds. We're available 24/7 for urgent issues.</p>
      </div>
    </div>
  )
}
