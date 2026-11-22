# API rebuild: roadmap

Date: 2026-11-22. Base: main `21d1fb33`. Status: approved by owner 2026-11-22.
Release 1 design: [2026-11-22-api-approval-design.md](2026-11-22-api-approval-design.md).

## Intent

The owner wants the three API surfaces to be more professional and to do more:

- public docs: `/developers`
- developer dashboard: `/dashboard/developer`
- admin console: `/admin/api-keys`

In the owner's words: "redesign, new tools and also a feature where when someone requests for api key they will be asked to
contact admin for approval and they will see a message admin button which admin will set a whatsapp link".

## Approaches

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Approval first, then one surface at a time (look and tools together) | Surfaces differ in style for a while; no page built twice | **Chosen by owner** |
| B | Redesign all three, then add tools | Better looking sooner; approval waits; layouts reopened | Not chosen |
| C | Build behind a preview switch, launch once | Nothing live for weeks; money and cosmetic changes land together; conflicts with a fast-moving main | Not chosen |

## Releases

Each release gets its own design, owner approval, plan, review gates and channel announcement.

| # | Release | Scope |
|---|---|---|
| 1 | Approval (aim: before 2026-11-30) | Message-admin button and admin-set link, access requests and API-only grants, approval inbox + reject, alerts both ways, no-outage key swap, admin audit trail, request-log fix |
| 2 | Public docs | Redesign, page per product + search, Try-it console (test keys only), sandbox failure testing, OpenAPI + "copy for AI", go-live guide, starter kits (PHP, Node.js), error guide, changelog |
| 3 | Developer dashboard (after v1 sunset, 2026-11-30 00:00 GMT) | Redesign, usage + request logs, order finder + CSV, low-balance alert, remove legacy v1 section |
| 4 | Admin console | Redesign, developer profiles with pause, pause per service, announcements, status page, business report, v1 history moved to an Archive tab |
| 5 | Money protection | Daily spend cap per live key, fraud warnings |
| 6 | Webhooks | Signed events, retries, delivery log, send-test button |

## Known constraints for later releases

- **Docs source:** docs, Postman, search, OpenAPI and Try-it are all generated from `lib/api-v2/docs/registry.ts`.
- **Try-it:** same-origin `/api/v2`, no CORS change, refuse any key without the `dg2_test_` prefix before sending.
- **Logs:** history with failure reasons starts at Release 1. Retention clean-up arrives with Release 3 and must not
  break the totals that the stats functions compute from `api_v2_logs`.
- **Spend cap:** products debit through different engines and none share a spend ledger. The cap needs an atomic
  reserve-before-debit with release on a known no-charge result. SMS spends credits, not GHS.
- **Webhooks:** developer-supplied URLs are an SSRF surface. HTTPS only, block private and redirected targets, sign payloads.
- **Global kill** permanently revokes every key. Pause per service must be a separate, reversible control.
- **Business report:** profit is only as complete as `package_costs`. Show "no cost set", never a guessed cost.
- **Every page:** navy accent, dark mode, phone layout plus `lg:` multi-column.

## Not chosen by the owner

Developer landing page, IP allow-list, new-IP alert with self-service key pause, approval for test keys, approval by role upgrade.

## Anti-goals

- Breaking a working live integration, or changing the v2 request and response contract.
- Giving anyone different prices as a side effect of API access.
- Treating a WhatsApp message as proof of identity.
