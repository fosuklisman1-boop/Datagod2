# API rebuild, Release 2: public developer docs

Date: 2026-11-23. Base: main `1246e0ad`, branch `feat/api-docs-r2`. Status: decisions pre-approved by the owner, taken by the controller.
Roadmap: [2026-11-22-api-rebuild-roadmap.md](2026-11-22-api-rebuild-roadmap.md). Release 1: [2026-11-22-api-approval-design.md](2026-11-22-api-approval-design.md).
Items marked **(call)** were decided by the designer and can be overruled.

## 1. Why

`/developers` is one long scroll of 44 registry sections with a Postman button. A developer cannot search it, try a call,
test a failure, import it into a tool or an AI assistant, copy a working PHP or Node client, look up an error, or see what
changed. This release makes `/developers` read and work like a professional API reference. `lib/api-v2/docs/registry.ts`
stays the single source: pages, search, Try-it, OpenAPI, the Markdown description and the error guide are all derived from it.

## 2. Decisions

1. `/developers` stays the hub. Each product group gets its own statically generated page. One shared shell, search on every page.
2. Search: client-side, instant, "/" shortcut.
3. Try-it on every endpoint: client-only, test keys only, same-origin `/api/v2`, key in React state only.
4. Sandbox failure testing with reserved recipient numbers (sandbox only, data purchase only).
5. OpenAPI 3.1 at `/developers/openapi.json`, Markdown at `/developers/api.md`, "Copy for AI" button.
6. Pages: go-live checklist, starter kits (PHP, Node.js, downloadable), error guide, changelog (data file, facts only).
7. Navy `--primary`, light theme only, `lg:` multi-column, 500 px without sideways scroll, scoped body overflow fix kept.
8. Out of scope: status page (Release 4), any change to live API behaviour, any migration.

## 3. Approaches

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | One layout, one dynamic route `[group]`, pure builders in `lib/api-v2/docs/`, thin routes and components | Reuses `DocsPage`, `EndpointBlock`, `CodeTabs`; the dashboard tab keeps working; every output has a drift test | **Chosen** |
| B | Rewrite the docs kit as a new component set for the public site | Freer design; two kits to keep in sync; dashboard tab diverges | Not chosen |
| C | Generate static MDX per product from the registry at build time | Great SEO; a build step and a second source of truth | Not chosen |

Within A, the section nav: (a) keep the in-page `SectionBar` left column and add a top tab strip for pages; (b) one shared
left nav listing pages with the active page's sections nested. **(call) (b)**: the owner asked for a shared sticky side nav;
(a) would put two navs side by side on `lg:`. The scroll-spy hook is extracted so the nested list highlights as you scroll.

## 4. Page map

All under `https://www.datagod.store`. Each page has its own `<title>`, description, canonical and OpenGraph.

| Path | Content | Source |
|---|---|---|
| `/developers` | Hub: hero, quick start, then registry sections Overview, Authentication (keys and approval), Key types, Response format, Errors and limits, Idempotency, Sandbox, Testing failures. Related-products row (main site only) | registry `start` group + quick-start block |
| `/developers/data` | Account, Wallet, Packages, Purchase, Bulk, Verify number, Orders, Order statuses, Bulk orders | registry |
| `/developers/airtime` | Airtime pricing, purchase, orders, shared claim rules | registry |
| `/developers/bills` | Bill payment flow, billers, lookup, pay, orders | registry |
| `/developers/bundles` | Standard Bundles overview, catalog, purchase, orders | registry |
| `/developers/results` | Voucher PINs, idempotency, types, purchase, orders | registry |
| `/developers/afa` | AFA registration, register, orders | registry |
| `/developers/sms` | SMS overview, send, balance, senders, campaigns, idempotency, sandbox | registry |
| `/developers/go-live` | Checklist | `go-live.ts` |
| `/developers/starter-kits` | PHP and Node.js, copy and download | `starter-kits.ts` |
| `/developers/errors` | Every documented error, grouped, searchable | registry + `error-guide.ts` |
| `/developers/changelog` | Dated entries | `changelog.ts` |
| `/developers/openapi.json`, `/developers/api.md` | Machine-readable API | generated |
| `/developers/starter-kits/php`, `/node` | Single-file downloads | `starter-kits.ts` |
| `/developers/search-index.json` | Search data, fetched on first open | generated |
| `/developers/postman/*` | Unchanged | unchanged |

The page-to-section map lives in `lib/api-v2/docs/pages.ts`. **(call)** Registry `group` stays as is (the dashboard and Postman
use it); `commission` is split into airtime, bills and bundles by section id, and `results` into results and AFA. A test makes
every registry section belong to exactly one page, so a new section without a page fails CI. `commission-idempotency` (shared by
airtime and bills) sits on the airtime page and the bills page links to it **(call)**.

Group pages are static (`generateStaticParams`, `dynamicParams = false`) and use no request headers, so they carry no
related-products row **(call)**; the hub keeps it. Static folders (`go-live`, `errors`, ...) win over `[group]`.

## 5. Data flow from the registry

```
registry.ts (v2DocsRegistry, V2_BASE_URL)
 ├─ pages.ts          DOC_PAGES: slug -> section ids; hub ids; pageForSection()
 ├─ search-index.ts   buildSearchIndex() -> entries; searchDocs(index, query)
 ├─ error-guide.ts    collectErrors() -> grouped, deduped; adviceFor()
 ├─ openapi.ts        buildOpenApi()      -> /developers/openapi.json
 ├─ api-markdown.ts   buildApiMarkdown()  -> /developers/api.md, Copy for AI
 ├─ samples.ts        (existing) buildSamples() -> EndpointBlock tabs, Try-it prefill via requestExample
 ├─ postman.ts        (existing)
 └─ starter-kits.ts   hand-written sources, kept in sync by a test against the registry
```

The shell (`app/developers/layout.tsx`, server) renders the header, `DocsSidebar`, `DocsSearch` and the scoped
`body{overflow-x:visible !important}` style. `DocsPage` gains `showSectionNav` (default true; the public pages pass false because
the sidebar carries the nested sections) and `tryIt` (default off, so `/dashboard/developer` is unchanged). `EndpointBlock` takes an
optional `tryIt` node rendered under the code samples.

Routes are thin: they call a builder and return the response (Postman route pattern, `dynamic = "force-dynamic"` for the
generated documents, as the Postman routes do; `search-index.json` is `force-static`). No route exports anything but HTTP handlers and route config.

## 6. Try-it console

- Test keys only. Allowed pattern `^dg2_(?:cs_|sms_)?test_[0-9a-f]+$` (exactly the three test prefixes, reusing the shape of
  `KEY_PATTERN` in `lib/api-v2/keys.ts`). Anything else, and above all `dg2_live_`, `dg2_cs_live_`, `dg2_sms_live_` and v1 `dg_live_`,
  is refused in the browser before any request: the field is cleared, nothing is sent, nothing is stored.
- The key lives in component state. Never `localStorage`, `sessionStorage`, a cookie, the URL or a query string. Input is
  `type="password"`, `autoComplete="off"`, `spellCheck={false}`. Unmount drops it.
- Request is built only from the registry endpoint: `fetch("/api/v2" + path)` with the path template filled by
  `encodeURIComponent` values; method from the registry. No free-form URL, so it cannot be used as a proxy. `credentials: "omit"` so
  site cookies are never attached; `cache: "no-store"`; `redirect: "error"`. Header `Authorization: <key>`.
- Same origin, so no CORS change. (The api host is only a rewrite of the same handlers.)
- Body prefilled from `requestExample` in an editable textarea; invalid JSON is reported before sending. Path parameters
  (`{reference}`, `{campaign_id}`) get inputs. GET endpoints with no params just send.
- Shows status, elapsed ms and the body. JSON is pretty-printed; non-JSON (HTML error page, empty body, network failure) is
  shown as text with a clear label and never throws. Response text is capped at 200 KB for display.
- A wrong key type returns the API's own 403; that is shown as is. A real test call writes `api_v2_logs` and counts against the
  key's rate limits like any call. It is documented.

## 7. Sandbox failure design

Findings in `lib/sandbox.ts` and `lib/api-v2/endpoints/data.ts`:

- A sandbox order is a `sandbox_orders` row with `resolves_at` = placement + 20 s. Status is never stored: `deriveSandboxStatus(resolves_at)`
  returns `pending` or `completed` at read time in `getSandboxOrder`, `getSandboxOrdersByReferences` and `listSandboxOrders`. No cron.
- The v2 data path (`sandboxPurchase`, `sandboxBulk`) builds the row from `sandboxParams()`; `orderFields` is written into
  `response` jsonb, and `mapSandboxOrder` reads only named fields from it, so extra keys never reach the public order.
- Those three read helpers are shared with every v2 product and with v1. v1 and non-data v2 rows never carry a marker.
- The live path (`livePurchase`, `place_api_v2_order`) never calls any of this.

Design (smallest safe version, data purchase and data bulk only) **(call)**:

1. Reserved numbers, by pattern, so they work for every network: the local 10-digit number is the network's 3-digit prefix
   plus `0000404` (**order fails**) or `0000202` (**order stays pending**). Examples `0240000404` (MTN fail), `0200000202` (Telecel pending),
   `0270000404` (AT fail). They pass the prefix and network checks like any number of that network.
2. `lib/api-v2/sandbox-outcomes.ts` (pure): `sandboxOutcomeFor(local: string): "fail" | "stuck" | null`.
3. `sandboxParams()` adds `sandbox_outcome: "fail" | "stuck"` to `orderFields` only when the rule matches. The marker is set by our code
   from a validated recipient, never copied from the request body.
4. `lib/sandbox.ts` gains `deriveSandboxOrderStatus(row)`: `stuck` returns `pending` forever; `fail` returns `pending` until
   `resolves_at`, then `failed`; no marker returns the existing result. The three read helpers use it. Return type widens to
   include `failed`; `tsc` shows every consumer.
5. Behaviour: placement still returns 201 `pending` and debits the sandbox balance. After 20 s a `fail` order reads `failed`. **No
   automatic sandbox refund** **(call)**: a refund would need a write inside a read path. The docs say so and point to the existing
   sandbox balance reset in the dashboard. The real API credits back as `refunded`; the sandbox shows `failed` only.
6. Replays, lookups, the order list and bulk items all read the same derived status. Reusing the same reference returns the same order.
7. Not covered, and said so in the docs: airtime, bills, bundles, results, AFA and SMS. Their sandbox paths have different
   order shapes and some are `instant`; each would need its own marker and review.

Why not a bigger version: failure and pending for every product means touching six handlers, the instant-order path and the
voucher issuance for results, none of which a docs release should change.

## 8. OpenAPI and Markdown

`buildOpenApi(registry, baseUrl)` returns an OpenAPI 3.1.0 document: `servers` = `V2_BASE_URL`; security schemes `ApiKeyAuth`
(header `Authorization`, raw key), `BearerAuth` and `XApiKey` (the three accepted forms); one operation per endpoint with `operationId` =
endpoint id, `summary`, `description` (notes), `tags` (page title), path and query params, request body schema from `params` plus
`requestExample`, a 200 response (201 noted in the description where the registry says so) with an inferred schema and the registry
example, one `responses` entry per documented error status with the messages as examples, and a shared `Error` schema. Param types in
the registry are free text (`string`, `number`, `integer`, `boolean`, `array`, `string[]`, others); unknown types map to `string` with the
original text kept in `description`. `buildApiMarkdown(registry)` renders the whole API as Markdown: intro sections, then each endpoint
(method and path, summary, key type, rate limit, params table, request and response examples, errors, notes), then the sandbox failure numbers.
Both are pure functions of the registry. Drift tests compare operation and error counts with the registry; there is no OpenAPI
validator dependency (none installed, none added), so a small structural validator in the test checks required 3.1 fields and `$ref` targets.

## 9. Content pages

- **Go-live** (`go-live.ts`, steps as data): create a test key; run the starter kit against the sandbox; test failures (reserved numbers);
  verify the account phone (live data needs it, per the registry note); request a live key; Message admin on WhatsApp with the code; wait
  for approval; first live order with a small amount and a fresh reference; poll it; keep the old live key until the new one is approved.
  Every step links to the registry page or dashboard that does it. No SLA or approval time is stated (none is documented).
- **Starter kits** (`starter-kits.ts`): two single-file, dependency-free programs (PHP with the cURL extension, Node.js 18+ built-in fetch),
  each with `getBalance`, `buyData` (with a reference), `pollOrder`, and `buyDataSafely`, which maps `409 REFERENCE_REUSED` (stop, never retry with the
  same reference for different content), `409 OUTCOME_UNKNOWN`/`REQUEST_IN_PROGRESS` and network timeouts (never place a new order; poll by the same reference) and
  `402`. The key is read from an environment variable. Downloads are served with `Content-Disposition: attachment`.
- **Error guide** (`error-guide.ts`): the registry has 145 distinct status and message pairs across 47 error codes. Each guide entry has
  status, code (or the validation field), message pattern, meaning, fix, and the endpoints that return it. Advice comes from an explicit table
  keyed by code, a rule for field-validation messages, and a short table for the eight access errors; a test fails if a registry error falls
  through to no advice.
- **Changelog** (`changelog.ts`): dated entries, each with a `source` field (commit or doc, not rendered) and a test that dates are ISO, newest first, and not in the future unless `scheduled`. Allowed facts only (the list is in Task 3 of the plan): 2026-10-22 v2 launch of data and wallet; 2026-10-24 airtime and bills;
  2026-10-26 results checker and AFA; 2026-10-27 SMS, `api.datagod.store/v2` base URL, Postman collection; 2026-10-28 Standard Bundles; 2026-11-12 cap of 20 new MTN items per
  bulk call; 2026-11-22 approval, Message admin and API access requests; 2026-11-23 live-key approval; v1 sunset 2026-11-30. Nothing else.

## 10. Look

Navy `--primary` (`224 68% 33%`), light theme only: the public layout does not add `dark:` work; existing `dark:` classes inside the
shared kit are harmless. Every page widens on `lg:` (sidebar 240 px, content `minmax(0,1fr)`, code blocks scroll inside themselves). At 500 px: no
horizontal page scroll, tables inside `overflow-x-auto`, long paths `break-all`, the sidebar becomes a "Docs menu" sheet. The scoped body overflow
style moves into the layout; `html` keeps `overflow-x:hidden`.

## 11. Risks and abuse cases

| Risk | Handling |
|---|---|
| Live key pasted into Try-it and sent from a browser | Prefix allow-list before any request, field cleared, never stored; test covers every live prefix and v1 `dg_live_` |
| Try-it as an open proxy or cookie-carrying call | URL built only from registry paths, encoded params, `credentials: "omit"` |
| XSS through a response or error message | Rendered as text in `<pre>`, never as HTML |
| Sandbox marker reaching a live order or v1 | Marker only from v2 `sandboxParams`; live path untouched; v1 rows have none; a test pins all three |
| Real recipient equals a reserved number | Sandbox only; live behaviour identical for every number |
| A failed sandbox order not refunded surprises a developer | Documented in Testing failures and the go-live checklist |
| Docs drift from the API | Single registry; drift tests for pages, OpenAPI, Markdown, error guide, starter kits, changelog |
| Search index or OpenAPI leaking secrets | Built from public registry text only; no env, DB or key data |
| Starter kit encourages unsafe retry | Kit never retries a purchase with a new reference; test runs the Node kit against a mocked fetch |
| Invented changelog | Entries limited to the listed facts with sources; test blocks future dates |
| Slash shortcut stealing typing | Ignored inside inputs, textareas, selects, contenteditable and with modifier keys |
| Sticky positioning breaks again | Scoped body overflow style kept in the shared layout |

## 12. Testing

Vitest runs in the node environment and only includes `lib/**/*.test.ts` and `app/**/*.test.ts`: UI logic lives in `lib/` and components are
checked with `renderToStaticMarkup` from `.test.ts` files. Pure tests: pages coverage, search ranking, error-guide coverage, OpenAPI structure
and drift, Markdown drift, starter-kit sync and a mocked-fetch run of the Node kit, sandbox outcome rule and derived status, Try-it key refusal and request building,
changelog shape, sitemap entries, route handlers (status, headers, body). `next build` with placeholder env proves the static params
and route exports. Manual check list in the final task: 500 px width, `/` shortcut, Try-it with a test key against a preview, never against a live key.

## 13. Rollout

No migration, no environment variable, no change to live API behaviour. Merge to main behind nothing (pages are additive; `/developers` keeps its URL).
Order: tasks run in sequence on `feat/api-docs-r2`; final review by a fresh reviewer; push after the placeholder-env build; then the production
protocol: verify `/developers`, `/developers/data`, `/developers/openapi.json`, `/developers/api.md`, a Try-it call with a test key, and the reserved
failing number end to end with a test key (sandbox money only). The channel announcement is prepared at the end. Rollback is reverting the merge:
nothing stored depends on it.
