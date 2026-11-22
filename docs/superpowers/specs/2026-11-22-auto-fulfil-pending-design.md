# Auto-fulfil pending orders: design

Date: 2026-11-22 (revised the same day after the builder check). Owner request: "add a cron and its
toggle on the order payment status page that will act as the fulfill all pending button", with retry
timing "admin configurable". The owner approved the settings sketch and, after the builder check,
chose the **age-gated** version over adding an atomic claim to every purchase path. Items under
"Calls made while writing" are the author's and may be overridden.

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

Double-send protection (owner's choice after the builder check):

- **Age gate (chosen).** The cron only touches orders that have been quiet for longer than any send
  can take. Small; touches no purchase path; relies on time, not a lock.
- Atomic claim in every purchase path (checkout, bulk, v1, v2, wallet, payment attempts) plus an
  attempt ledger. Strongest, but rewrites every money path. Not chosen; possible later.

## The age gate (the core safety rule)

Every purchase path calls the supplier while the order still reads `pending`, and a send can take up
to the route limit of 300 s. So an order is automatic-eligible only when **both** hold:

1. the order was created at least **minimum age** ago (default 10 min, never below 10 min);
2. nothing has touched it for the same minimum age: no `fulfillment_queue` row for it created or
   updated within that window (any source, any status), and no tracking/attempt/`fulfillment_logs`
   row for it within that window.

Rule 2 also covers USSD non-MTN dispatch, which is fire-and-forget: its queue row finishes before the
supplier answers, but the order stays quiet-blocked for the next 10 minutes, long after the call ends.

## Approved

### The switch and settings (Order Payment Status)

- On/off, default **off**. Shows the last run time with queued / waiting / needs-you counts.
- Editable, with these starting values:
  - minimum age / quiet time: 10 minutes (10 to 120);
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
| rejected (a definite refusal not in another bucket) | yes | 60 min | 3 |

A wait shorter than the minimum age has no effect: the age gate always applies as well.

- Never automatic, not editable: held / outcome unknown (timeouts, network errors, unparseable
  replies), reversed, completed, anything with a live attempt, and any pending order that ever had a
  held or reversed attempt.
- Routing: no supplier pin, so the normal supplier order and retry sequence, exactly like the button.
- Switching off takes effect within a minute: the cron stops, automatic rows still waiting in the
  queue are cancelled, and the drain re-checks the switch before sending an automatic row.
  Admin-queued rows are untouched.
- Out of tries: the order stays in Needs action for a person.
- Every change to the switch or settings is logged with the admin's id.

## Required with the engine (same release, still switched off)

1. **Attempt record.** Refusals often leave no tracking row (queue `error_message` only), so tries
   cannot be counted from tracking rows. Record each automatic send and its outcome bucket per order.
2. **Blacklisted numbers.** `fulfillUssdOrder` turns a paid order `failed` for a blacklisted number.
   The cron must skip blacklisted numbers and blacklisted-queue orders before enqueueing.
3. **Alerts.** Per-failure admin pushes (with phone numbers) fire on every refusal. Automatic rows
   must not send them; send one throttled, phone-free summary of orders that need a person.
4. **Drain time.** The drain handles 20 rows a tick inside a 300 s limit. Automatic rows must not push
   a tick past it: cap automatic rows per tick so admin rows are not starved, and stop taking rows
   when the tick nears its limit (the rest wait for the next tick).

## Facts the builder must respect

- `admin_settings` is readable and writable by service_role only (verified in prod 2026-11-22).
- `fulfillment_queue` allows one live row per order (0191). Its only writer is
  `lib/order-queue/enqueue.ts` through the admin route, which requires an admin uuid for the send log.
  Automatic rows need their own clearly marked source, not a fake admin id.
- The drain re-checks that the order is still `pending`. It calls the fulfilment functions with
  forceManual, so it does not itself honour the auto-fulfilment switches.
- The button covers all four networks despite its "MTN" label, and is only shown while MTN
  auto-fulfilment is on.
- Shop and USSD orders must be paid (`payment_status = completed`). `held_registration` orders are not
  pending and belong to the whitelist-retry cron.
- Failed attempts mirror the order back to `pending`.
- `orders/download` claims pending orders for spreadsheet fulfilment (they leave `pending`); the
  "Download failed" export claims nothing.
- CodeCraft non-MTN sends are recorded in `fulfillment_logs`, so the age gate and history checks must
  read it too.
- Network spellings differ per table; normalise as `combined_orders_view` does. Plain "AirtelTigo"
  cannot be assigned to iShare or BigTime.
- Hubnet: 50 calls a minute per key, shared with status sync.

## Calls made while writing (owner may override)

- **Max age:** only orders created in the last 7 days (editable, 1 to 30), so switching on can never
  send months-old orders.
- **Existing switches win:** a network whose auto-fulfilment setting is off is skipped, because off
  means manual fulfilment. The panel says why it is skipped.
- **Tries** count automatic sends only, per order in total; the latest reason's limit applies. An
  admin's own send does not use up tries and is never blocked by them.
- **Wait** is measured from the latest refusal, whoever sent it.
- **Unclassifiable failures are not retried automatically** (they might have been created); they stay
  for a person. Only the definite-refusal buckets above retry.
- Plain "AirtelTigo" orders are never automatic.
- Validation bounds: minimum age 10 to 120 minutes; waits 1 minute to 7 days; tries 1 to 20; per run
  1 to 100.
- Invalid or unreadable settings mean off (fail closed).
- The cron runs every minute on cron-job.org (created disabled; enabled after owner OK) and overlapping
  runs cannot both queue one order (the 0191 unique index).
- Changing settings requires `verifyAdminAccess` and a real admin user id (not the cron-secret bypass).

## Left to the builder

Schema (next free migration number, check origin/main first; at least 0193), attempt storage, how
queue rows are marked automatic, SQL versus TypeScript selection, component layout, copy.

## Delivery

1. Engine, attempt record, cron route, settings API and panel, released **switched off**.
2. Owner turns it on; watch the first runs for duplicates, refusals and Hubnet pauses.

Gates: money path + schema, so a fresh reviewer per task, a security review, PGlite tests, the prod
migration protocol, and owner OK before each push.
