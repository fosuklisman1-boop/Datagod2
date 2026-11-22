# Auto-fulfil pending orders: design

Date: 2026-11-22. Owner request: "add a cron and its toggle on the order payment status page that will
act as the fulfill all pending button", with retry timing "admin configurable". The owner approved the
settings sketch and the behaviour listed under "Approved". Items under "Calls made while writing" are
the author's and may be overridden.

Builds on `2026-11-21-order-work-queue-design.md`.

## Why

Paid orders return to `pending` when suppliers refuse them, and today someone has to keep pressing
"Fulfill pending". On 2026-11-21 that was about 100 orders in an evening.

## Anti-goals

- Sending any order twice.
- An automatic loop: an order retried without a wait or a limit.
- Sending held, reversed, delivered or with-a-supplier orders automatically.
- Alert floods from automatic retries, or phone numbers in logs.
- Working only while an admin's browser tab is open.

## Approaches

- **A. Server cron feeding the existing `fulfillment_queue` (approved).** Same eligibility, duplicate
  guard, drain and routing as the button.
- B. Press the button from the open tab on a timer. Stops when the tab closes; two tabs race.
- C. Cron that calls suppliers directly. A second dispatch path that bypasses the queue guards.

## Approved

### The switch and settings (Order Payment Status)

- On/off, default **off**. Shows the last run time with queued / waiting / needs-you counts.
- Editable, with these starting values:
  - send new orders after 1 minute;
  - networks: MTN, Telecel, AT iShare, AT BigTime (all on);
  - most orders per run: 20;
  - per failure reason (the buckets in `lib/order-queue/failure-reason.ts`): retry yes/no, wait, max tries.

| Reason | Retry | Wait | Max tries |
|---|---|---|---|
| rate_limited | yes | 2 min | 5 |
| out_of_balance | yes | 30 min | 5 |
| supplier_unavailable | yes | 30 min | 5 |
| not_enabled | yes | 24 h | 3 |
| no_bundle | no | | |
| wrong_number | no | | |
| rejected (any other refusal) | yes | 60 min | 3 |

- Never automatic, not editable: held / outcome unknown, reversed, completed, anything with a live attempt.
- Routing: no supplier pin, so the normal supplier order and retry sequence, exactly like the button.
- Switching off takes effect within a minute and cancels automatic rows still waiting in the queue.
  Admin-queued rows are untouched.
- Out of tries: the order stays in Needs action for a person.
- Every change to the switch or settings is logged with the admin's id.

## Prerequisites found in the code (must ship before the switch can be turned on)

1. **An in-flight order still reads `pending`.** Purchase-time dispatch and
   `lib/ussd/fulfill.ts#fulfillUssdOrder` call the supplier before any status change or tracking row
   exists (supplier timeouts are 30 s each, times the retry sequence). A timer would send such an order
   again. Required: an atomic `pending -> processing` claim before the supplier call on the USSD paths
   (shop/bulk/api already lock in `processManualFulfillment`), and automatic eligibility must also skip
   any order whose `order_dispatch_claims` row is `claimed` in the last 10 minutes, or whose latest
   outcome is `submitted` or `unknown`.
2. **USSD non-MTN dispatch is fire-and-forget** (`createNonMTNOrder(...).then(...)`): the queue row
   completes before the supplier answers, and the order stays `pending`. Required: await it in the
   drain path.
3. **A blacklisted USSD number turns the paid order `failed`** in `fulfillUssdOrder`. The automatic
   path must exclude blacklisted numbers and blacklisted-queue orders before enqueueing.
4. **Per-failure admin pushes** (with phone numbers) fire on every refusal. Automatic rows must not
   send them; send one throttled, phone-free summary of orders that need a person.

## Facts the builder must respect

- `admin_settings` is readable and writable by service_role only (verified in prod 2026-11-22).
- `fulfillment_queue` allows one live row per order (0191). Its only writer is
  `lib/order-queue/enqueue.ts` through the admin route, which requires an admin uuid for the send log.
- The drain runs 20 rows a tick and re-checks that the order is still `pending`. It calls the
  fulfilment functions with forceManual, so it does not itself honour the auto-fulfilment switches.
- The button covers all four networks despite its "MTN" label, and is only shown while MTN
  auto-fulfilment is on.
- Shop and USSD orders must be paid (`payment_status = completed`). `held_registration` orders are not
  pending and belong to the whitelist-retry cron.
- Failed attempts mirror the order back to `pending`. A failure can happen without a tracking row
  (queue `error_message` only), so tries cannot be counted from tracking rows alone.
- `orders/download` claims pending orders for spreadsheet fulfilment.
- Network spellings differ per table; normalise as `combined_orders_view` does. Plain "AirtelTigo"
  cannot be assigned to iShare or BigTime.
- Hubnet: 50 calls a minute per key, shared with status sync.

## Calls made while writing (owner may override)

- **Max age:** only orders created in the last 7 days (editable, 1 to 30), so switching on can never
  send months-old orders. (Prod today: 2 paid pending orders, both from today.)
- **Existing switches win:** a network whose auto-fulfilment setting is off is skipped, because off
  means manual fulfilment. The panel says why it is skipped.
- **Tries** count automatic sends only, per order in total; the latest reason's limit applies. An
  admin's own send does not use up tries and is never blocked by them.
- **Wait** is measured from the latest refusal, whoever sent it. An unclassifiable failure uses
  "rejected".
- A pending order with any past held or reversed attempt is never automatic.
- Plain "AirtelTigo" orders are never automatic.
- Validation bounds: waits 1 minute to 7 days; tries 1 to 20; per run 1 to 100; first send 1 to 60 minutes.
- Invalid or unreadable settings mean off (fail closed).
- The cron runs every minute on cron-job.org (created disabled; enabled after owner OK) and overlapping
  runs cannot both queue one order.
- Changing settings requires `verifyAdminAccess` and a real admin user id (not the cron-secret bypass).

## Left to the builder

Schema (next free migration number, at least 0193), run/attempt storage, how queue rows are marked
automatic, SQL versus TypeScript selection, component layout, copy.

## Delivery

1. Prerequisites 1 and 2 as their own reviewed release.
2. Engine, cron, settings API and panel, released switched off.
3. Owner turns it on; watch the first runs for duplicates, refusals and Hubnet pauses.

Gates: money path + schema, so a fresh reviewer per task, a security review, PGlite tests, the prod
migration protocol, and owner OK before each push.
