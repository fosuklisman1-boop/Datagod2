# Hubtel main code: separate menu per USSD code

Date: 2026-11-07. Status: awaiting owner approval.

## Why

Hubtel is issuing a second USSD code, on the same merchant account (`2040747`), to serve as a main code for Datagod. The exact code is not known yet.

Today one setting decides what every Hubtel code shows. `hubtel_ussd_config.mode` is global (production: `shop`, enabled) and the router ignores `ServiceCode`. A second code on the existing URLs would open the shop-code prompt, and switching the mode to `main` would break `*713*235#`, which serves the shop orders behind 4,089 of the 4,386 paid Hubtel transactions on record.

## Goals

- The new code opens the main menu, with its own on/off switch, service toggles, brand and welcome line.
- `*713*235#` keeps behaving exactly as it does today.
- The new code can be built, deployed and left off before Hubtel supplies it.

## Non-goals

- Changing or retiring the Uzo main code. It stays live permanently (owner decision).
- Changing prices, or who pays Hubtel's charge. The customer keeps paying it on top (owner decision).
- A separate price tier. Both main codes read `app_settings.ussd_price_tier` (owner decision; verified in `lib/ussd-hubtel/catalog.ts` and `lib/ussd/handlers/bundles.ts`).
- Reporting revenue per code. Main orders stay `channel='ussd'`; join `hubtel_transactions` to separate them from Uzo.
- Changes to the relay, IP whitelist, credentials, callbacks, fulfilment, status checks or the database schema.

## Anti-goals: this fails even if the new code works, if

- A request to the existing URL (no `line`) changes in any way: shop prompt, welcome, services, billing or switch state.
- Saving the new code's settings can alter the shop code's settings, or the reverse.
- An unrecognised `line` value opens any menu.
- The new code becomes reachable by customers before the owner switches it on.

## Owner decisions

| Topic | Decision |
|---|---|
| `*713*235#` | Stays on shops |
| Uzo main | Stays live permanently, alongside the new code |
| Launch services | All six: Buy Data Bundle, AFA Registration, Buy Airtime, Results Checker, Standard Bundles, Pay Bills |
| Brand | Clingshub |
| Hubtel's charge | Customer pays, on top |
| Prices | Same setting as Uzo main |
| Admin page | Two tabs, one per code; transactions, sessions and logs stay shared below |

## Design (builder's calls, not owner decisions, unless noted above)

### Routing

The new code's Service Interaction URL carries `line=main`:

`https://www.datagod.store/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>&line=main`

In `app/api/ussd-hubtel/interaction/route.ts`, after the existing secret check, parse `line` with a pure function in `lib/ussd-hubtel`:

| `line` | Result |
|---|---|
| absent | Existing behaviour: `getHubtelUssdConfig` |
| exactly `main` | Main line config (below) |
| anything else, including empty or different case | Well-formed `release` with "Service unavailable. Please try again later."; no router call, no session write |

An unrecognised `line` also logs a `console.warn` containing no secret and no customer data. The parsed line may be added to the existing `[HUBTEL] Incoming` log.

The route selects the config by overriding `getConfig` on the router deps. `hubtelRouter` needs no knowledge of lines: it already takes everything from `deps.getConfig()` and pins `session.mode` at the start of a session.

`ServiceCode` stays unused: its format on shared codes is unverified, and the URL does not depend on it. If Hubtel cannot give the new code its own Interaction URL, stop and revisit this section.

The Fulfilment URL is shared and unchanged. Nothing downstream of the router reads the Hubtel config (confirmed by searching `lib/ussd-hubtel`, `app/api/ussd-hubtel` and `app/api/cron`), so payment confirmation, callbacks and status checks need no change.

One display-only reader sits outside that path: `app/admin/utility-bills/page.tsx` reads `GET /api/admin/ussd-hubtel/config` and passes `.config` to `botSurfaceStatus`, which shows whether Pay Bills is live on Hubtel. It keeps reading the shop line, so `GET` must keep `config` unchanged. Builder's call: leave it as is, and record in the runbook that this status does not reflect the Main code. No money moves on it.

### Main line settings

Stored under a **new** `admin_settings` key, `hubtel_ussd_main_line_config`. The existing `hubtel_ussd_config` row is never read or written by main line code paths. A shared row would need read-modify-write across both lines, and `setHubtelUssdConfig` rebuilds the whole stored object, so a separate key removes the risk of one line overwriting the other.

Stored shape: `{ enabled, visibility, brandName, welcome }`. Resolved shape: the existing `HubtelUssdConfig`, so all flows work unchanged.

| Field | Rule |
|---|---|
| `mode` | Always `main`; not stored and not accepted |
| `enabled` | Only an explicit `true` enables; a missing row means **off** |
| `visibility` | Defaults to all six on, using the existing `DEFAULT_VISIBILITY` |
| `brandName` | Default `Clingshub`; existing validation |
| `welcome` | Optional override; otherwise `Welcome to <brand>`; existing validation |

Reuse the existing resolve and validation helpers rather than copying them. A config read failure already throws, and the route already answers "Service unavailable" in that case.

### Behaviour that follows from this

- Each line's switch is independent. Turning one off ends only that line's in-flight sessions.
- Standard Bundles and Pay Bills on the new code still require the cashback bots gate, as everywhere else. That gate is on in production today, and these menus already show on `*713*235#`.
- AFA is hidden on the shop line by design. Its toggle stays where it is on the Shop tab, and the shop line's stored `afa: false` is untouched.
- A "Session expired" restart uses the URL's line, so it stays on the right menu.

### Admin API: `app/api/admin/ussd-hubtel/config/route.ts`

- `GET` also returns `mainLine` (the resolved config), keeping existing fields unchanged.
- `POST` with `line: "main"` updates only the main line. `mode` together with `line: "main"` is a 400. Any other `line` value is a 400. No `line` keeps today's behaviour exactly.
- The env-ready check for enabling applies to both lines.
- Audit log: a new action `hubtel_ussd_main_line_config_update`, with old and new values, written in the same way as the existing action.

### Admin page: `app/admin/ussd-hubtel/page.tsx`

- Tabs: **Main code** and **Shop code**, each with the switch, services, brand and welcome controls. Default tab: Shop code, because it is the live one.
- The Shop code tab holds today's controls, including the Mode selector and its existing confirmation. The label states it applies to the existing URL only.
- The Main code tab has no Mode selector. It shows the two URLs to register with the secret as a placeholder, never the real value.
- Environment, payments, sessions and callback logs stay below the tabs, shared.
- Follows the existing desktop layout and navy token conventions, with `lg:` widening. No sidebar change, as this is not a new item.

### Screen length

Hubtel screens on `USSD` are cut at 182 characters with `...` (`lib/ussd-hubtel/protocol.ts`). With six services and a 60-character welcome, the "Session expired." restart prefix can exceed this. Default brand text fits. Add a test using the worst case in `screen-fit.test.ts`. If it fails, shorten the prefix on overflow so `0. Exit` is never cut, for the main menu only.

## Testing

Test first, with logic in `lib/`. Required cases:

- Line parsing: absent, `main`, empty, `MAIN`, unknown value.
- Route: wrong secret still 401 with `line=main`; unknown `line` releases and never calls the router; no `line` uses the existing config loader and never the main line loader; `line=main` does the reverse.
- Main line config: missing row is off; only `true` enables; invalid stored values fall back; `mode` is always `main` even if a row stores `shop`.
- Isolation: saving the main line never writes `hubtel_ussd_config`; saving the shop line never writes the new key.
- Router: `line=main` while the shop config is `mode: shop` opens the main menu with six items; main line off releases even when shop is on, and the reverse; a mid-session "Session expired" restart stays on the line.
- Admin API: `line`/`mode` combinations, validation, audit action, env-ready check.
- Existing Hubtel test files must pass unmodified, apart from additions. That is the regression guard for the anti-goals.

## Review and release

- Tier: live payment channel route, so a fresh reviewer is mandatory, including an abuse-case pass (free, someone else's, twice, cheaper, no auth, at scale).
- Before push: `tsc`, Vitest (9 known `order-health-service` failures only), a real placeholder-env `next build`.
- No migration. Merge to `main` needs owner OK; check local `main` for other sessions' commits first; watch the deploy.
- Post-deploy checks (builder's call, because the webhook secret is write-only and must not go in commands, and the firewall may block scripted calls):
  - Shop line unchanged: new paid `hubtel_transactions` rows keep arriving after the deploy time, and the owner dials `*713*235#` once.
  - Main line off: `hubtel_ussd_main_line_config` has no row in `admin_settings`, which unit tests prove means off.
  - Route deployed: a request with `line=main` and no secret, sent from a normal browser or allowed client, returns 401. If the firewall blocks it, record that and rely on the checks above.
  - The end-to-end "Service unavailable" check happens at launch: once Hubtel attaches the code, the owner dials it while it is still off.
- Update `docs/hubtel-ussd-runbook.md`.

## Launch (after Hubtel supplies the code)

1. Register the Main URL and shared Fulfilment URL with Hubtel. Keep the code restricted. Owner dials it while off and expects "Service unavailable".
2. Owner switches the Main code on and tests from their own phone with small purchases. Priority: **AFA (0 ever sold through Hubtel), Pay Bills (1 ever sold), Check Results**. Then one purchase each of data, airtime, Standard Bundles and vouchers. Confirm each row on `/admin/ussd-hubtel` is `fulfilled` with `callback_status=sent`, and read the screens on a real handset.
3. If anything is wrong, switch only the Main code off.
4. Hubtel removes the restriction. Watch `needs_review` and `callback_failed` for the first hours.
5. Decide which main code to publish. `public_ussd_codes` is empty and holds one code, while two main codes will be live.

## Open with Hubtel

- The exact code, dedicated or shared.
- Whether it can have its own Service Interaction URL. **The routing design depends on this.**
- A sample request for the new code.
- Whether its charges match the current code.
