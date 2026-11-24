// Public changelog data. Every entry is backed by a commit or repo doc named in `source` (not rendered).
// Item text restates only what the docs registry already says. Newest first.

import { V2_BASE_URL } from "./registry"

export interface ChangelogEntry {
  date: string
  status: "released" | "scheduled"
  title: string
  items: string[]
  source: string
}

/** The v1 retirement instant (00:00 GMT on the entry date). */
const V1_RETIREMENT_AT = Date.UTC(2026, 10, 30)

/**
 * The changelog as of `now`: the v1 retirement entry reads "scheduled" before 2026-11-30 00:00 GMT
 * and "released" from then on. The clock is injectable for tests.
 */
export function changelogAt(now: Date = new Date()): ChangelogEntry[] {
  return CHANGELOG.map((e) => {
    if (e.date !== "2026-11-30" || now.getTime() < V1_RETIREMENT_AT) return e
    return {
      ...e,
      status: "released",
      items: [
        "Version 1 of the API was retired on 2026-11-30 at 00:00 GMT.",
        "Version 1 requests are now refused with HTTP 410. Version 2 keeps working.",
      ],
    }
  })
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: "2026-11-30",
    status: "scheduled",
    title: "Version 1 of the API is retired",
    items: [
      "Version 1 of the API is scheduled to be retired on 2026-11-30 at 00:00 GMT.",
      "After that time, version 1 requests are refused with HTTP 410. Version 2 keeps working.",
    ],
    source:
      "docs/superpowers/specs/2026-11-12-retire-api-v1-design.md (410 gate); date in docs/superpowers/specs/2026-11-22-api-rebuild-roadmap.md",
  },
  {
    date: "2026-11-24",
    status: "released",
    title: "Service status, announcements and pauses",
    items: [
      "A new public status page shows whether each service is operational, degraded or paused, with its 24-hour success rate.",
      "Datagod can pause one service for everyone: new purchases and sends then return HTTP 503 \"This service is temporarily unavailable\" (or a note from Datagod); order lookups keep working. Retry with the same reference once it is back.",
      "Datagod can pause API access for one account: every key of that account then returns HTTP 403 \"API access paused by Datagod\". Nothing is revoked; access returns when the pause is lifted.",
      "Maintenance and other announcements now appear at the top of the developer docs and the developer dashboard.",
    ],
    source: "feat/api-admin-r4 (Release 4 admin console); messages in lib/api-v2/access.ts",
  },
  {
    date: "2026-11-23",
    status: "released",
    title: "Live keys need admin approval",
    items: [
      "A live key starts as pending. Every call returns 403 until Datagod approves it; once approved it works immediately.",
      "Replacing a live key never takes your integration down: your current live key keeps working until the new one is approved, and stops at that moment.",
      "Test (sandbox) keys are active immediately and need no approval.",
    ],
    source: "1246e0ad (merge to main, 2026-11-23); text in lib/api-v2/docs/registry.ts, Authentication section",
  },
  {
    date: "2026-11-22",
    status: "released",
    title: "Message admin, API access requests and request codes",
    items: [
      "Your dashboard shows a request code and a Message admin button that opens WhatsApp with the code already typed, so the admin can find and approve your request.",
      "If your account type does not include the API, use Request API access on the dashboard, then message the admin with the code shown. Approval gives API access only; your prices do not change.",
    ],
    source: "7b7a3aea, 89f6c327",
  },
  {
    date: "2026-11-12",
    status: "released",
    title: "At most 20 new MTN items per bulk call",
    items: [
      "A bulk call (POST /data/bulk) can include at most 20 new MTN orders; more returns 400 and nothing is charged.",
      "Replayed items do not count, so split larger MTN batches across calls.",
    ],
    source: "322e71b1",
  },
  {
    date: "2026-10-28",
    status: "released",
    title: "Standard Bundles",
    items: [
      "Browse the Standard Bundles catalog (GET /bundles/catalog), buy a bundle (POST /bundles/purchase) and track bundle orders (GET /bundles/orders).",
      "These endpoints use a commission key.",
    ],
    source: "6815c9cc",
  },
  {
    date: "2026-10-27",
    status: "released",
    title: "SMS endpoints, new base URL and Postman collection",
    items: [
      "Send single and bulk SMS (POST /sms/send), check your balance (GET /sms/balance) and list senders (GET /sms/senders) and campaigns (GET /sms/campaigns). SMS keys spend SMS credits, not your wallet.",
      `Every request is now made over HTTPS to ${V2_BASE_URL}.`,
      "A Postman collection of the endpoints is available to download.",
    ],
    source: "bfc4cf2c (SMS reference), 92e30bca (base URL), 854dd804 (Postman collection)",
  },
  {
    date: "2026-10-26",
    status: "released",
    title: "Results checker and AFA registration",
    items: [
      "Buy results checker vouchers (POST /resultschecker/purchase) for WASSCE, BECE and NOVDEC and read past voucher orders (GET /resultschecker/orders).",
      "Register customers for AFA (POST /afa/register) and check each registration order (GET /afa/orders).",
      "These endpoints use a standard key.",
    ],
    source: "8e09170a",
  },
  {
    date: "2026-10-24",
    status: "released",
    title: "Airtime and utility bills",
    items: [
      "Buy airtime for any Ghana network (POST /airtime/purchase) and track each airtime order (GET /airtime/orders).",
      "Pay utility bills: list billers (GET /utilities/billers), look up the customer account (POST /utilities/lookup) and pay from your wallet (POST /utilities/pay).",
      "These endpoints use a commission key.",
    ],
    source: "31882690",
  },
  {
    date: "2026-10-22",
    status: "released",
    title: "Developer API v2 launched",
    items: [
      "Check your account role (GET /account/role) and wallet balance (GET /wallet/balance).",
      "List data packages (GET /packages) and buy data bundles singly (POST /data/purchase) or in bulk (POST /data/bulk).",
      "Version 1 of the API keeps working unchanged; version 2 runs beside it.",
    ],
    source: "d9ccdc48 (docs registry), 7cc9ed6b (data, packages, verification and orders)",
  },
]
