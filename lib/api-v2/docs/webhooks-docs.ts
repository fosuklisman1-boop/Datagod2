// Release 6 webhook docs. Shown only when WEBHOOKS_PUBLISHED (flags.ts) is true; until then the polling notes keep
// saying Datagod does not send webhooks. Text restates lib/api-v2/webhooks/* and migration 0200 only.
import type { V2DocSection } from "./registry"

/** The polling sentence used by Idempotency and the data order GET, with or without webhooks. */
export function pollingNote(published: boolean, lead = "To check on an order, poll its order endpoint"): string {
  return published
    ? `${lead}, or save a webhook URL in your dashboard to be told when it finishes (see Webhooks).`
    : `${lead}; Datagod does not send webhooks.`
}

export const WEBHOOKS_SECTION: V2DocSection = {
  id: "webhooks",
  label: "Webhooks",
  group: "start",
  intro:
    "Save one HTTPS URL in your dashboard (Developer API, Webhooks) and Datagod POSTs a signed JSON event to it when a live order reaches a final status: completed, failed or refunded. A later change between final statuses (for example failed then refunded) sends another event. Events cover live orders placed after you saved the URL, for 7 days after each order. Test keys do not send order events; use Send test event instead, which sends a webhook.test event at once.",
  steps: [
    "Event types: order.updated (data: product, reference, status, previous_status, recipient, amount, item, order_created_at) and webhook.test (the same shape with test: true).",
    "Headers: Content-Type application/json, Datagod-Event-Id (evt_ followed by 24 hex characters), Datagod-Event-Type, and Datagod-Signature: t=<unix seconds>,v1=<hex>.",
    "Check the signature: compute HMAC-SHA256 with your signing secret over the string \"<t>.<raw body>\" (the raw body exactly as received, before any JSON parsing), compare it with v1 in constant time, and refuse a t more than 5 minutes from your clock.",
    "Answer with any 2xx within 10 seconds. A redirect, any other status, a timeout or a connection error counts as a failure. Datagod does not follow redirects.",
    "Failed deliveries are retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours and 24 hours (7 attempts in all), then marked failed. You can resend any delivered or failed event from the dashboard.",
    "Delivery is at least once and not always in order: store the Datagod-Event-Id you have handled and ignore repeats, and treat the order endpoint as the source of truth for the current status.",
  ],
  callouts: [
    {
      tone: "info",
      title: "Your URL",
      body: "It must be HTTPS on the standard port with a public host name: no IP addresses, no localhost or internal names, no credentials in the URL. Rotate the signing secret from the dashboard if it leaks; the new one applies at once.",
    },
  ],
  endpoints: [],
}
