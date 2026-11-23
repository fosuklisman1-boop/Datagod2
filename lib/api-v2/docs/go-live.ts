// Go-live checklist data for /developers/go-live (spec section 9). Pure: no I/O.
// Restates only what the docs registry says. No approval time, price or SLA is stated: none is documented.

import { docPath, sectionHref } from "./pages"

export interface GoLiveStep {
  id: string
  title: string
  body: string
  links: { label: string; href: string }[]
}

export const GO_LIVE_STEPS: readonly GoLiveStep[] = [
  {
    id: "test-key",
    title: "Create a test key",
    body: "Open Dashboard, then Developer API, and generate a test (sandbox) key. A test key is active immediately, needs no approval, and uses a sandbox wallet, so nothing real is ordered or charged.",
    links: [
      { label: "Developer API dashboard", href: "/dashboard/developer" },
      { label: "Authentication", href: sectionHref("authentication") },
    ],
  },
  {
    id: "sandbox-run",
    title: "Run a starter kit against the sandbox",
    body: "Download the PHP or Node.js starter kit, set your test key in the DATAGOD_API_KEY environment variable and run it. Confirm you can read your balance, place an order and poll it by its reference.",
    links: [
      { label: "Starter kits", href: docPath("starter-kits") },
      { label: "Sandbox", href: sectionHref("sandbox") },
    ],
  },
  {
    id: "failure-numbers",
    title: "Test the failure paths",
    body: "Data orders with a test key to a reserved number behave on purpose: 0240000404, 0200000404 and 0270000404 fail after a short delay, and 0240000202, 0200000202 and 0270000202 stay pending forever. Make sure your software handles a failed order and an order that never completes.",
    links: [{ label: "Sandbox failure numbers", href: sectionHref("sandbox-failures") }],
  },
  {
    id: "verify-phone",
    title: "Verify the phone number on your account",
    body: "Live purchases require the phone number on your Datagod account to be verified. Until it is, a live key gets 403 PHONE_NOT_VERIFIED. Verify the number in the dashboard before you request a live key.",
    links: [
      { label: "Developer API dashboard", href: "/dashboard/developer" },
      { label: "Data purchase", href: sectionHref("data-purchase") },
    ],
  },
  {
    id: "request-live-key",
    title: "Request a live key",
    body: "Generate a live key on the Developer API page. A live key starts as pending: every call returns 403 until Datagod approves it. If your account type does not include the API, use Request API access on the dashboard first. Approval gives API access only; your prices do not change.",
    links: [
      { label: "Developer API dashboard", href: "/dashboard/developer" },
      { label: "Key types", href: sectionHref("key-types") },
    ],
  },
  {
    id: "message-admin",
    title: "Message the admin on WhatsApp",
    body: "Your dashboard shows a request code and a Message admin on WhatsApp button. The button opens WhatsApp with the code already typed, so the admin can find your request. Send the message as it is.",
    links: [{ label: "Developer API dashboard", href: "/dashboard/developer" }],
  },
  {
    id: "wait-approval",
    title: "Wait for approval",
    body: "Keep using your test key while you wait. Once Datagod approves the live key it becomes active and works immediately; you do not need to generate it again. Calls made before approval return 403.",
    links: [{ label: "Authentication", href: sectionHref("authentication") }],
  },
  {
    id: "first-live-order",
    title: "Place a first live order",
    body: "Start with one small order and a fresh, unique reference. Store the reference before you send the request. If the outcome is ever unknown, do not place the order again under a new reference: poll the same reference.",
    links: [
      { label: "Idempotency", href: sectionHref("idempotency") },
      { label: "Data purchase", href: sectionHref("data-purchase") },
    ],
  },
  {
    id: "poll-keep-old-key",
    title: "Poll the order and keep your old key until the new one is approved",
    body: "Poll the order by its reference until it reaches a final status. When you replace a live key, your current live key keeps working until the new one is approved and stops at that moment, so update your integration only after approval. If a key has leaked, revoke it straight away instead.",
    links: [
      { label: "Orders", href: sectionHref("data-orders") },
      { label: "Order statuses", href: sectionHref("order-statuses") },
    ],
  },
]
