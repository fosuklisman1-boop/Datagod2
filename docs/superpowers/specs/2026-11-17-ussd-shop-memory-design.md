# USSD shop memory (one remembered shop per phone, all channels)

Date: 2026-11-17. Status: design, awaiting owner approval.

## Intent

Repeat buyers on the shop USSD codes type the same 4-6 digit shop code on every dial. The SMS shop line
(Text-to-Buy) already remembers a sender's shop, and the WhatsApp shop bot remembers it too, but each keeps its own
table and USSD remembers nothing. The Hubtel shop code `*713*235#` alone carried about 4,400 paid sessions in the 30
days to 2026-11-07, most from repeat buyers. Goal: a returning caller reaches their shop's menu by pressing `1`
instead of typing a code, and the shop a customer last used is the same on USSD, SMS and WhatsApp.

## Goals

- On both shop USSD surfaces (Hubtel shop mode `*713*235#` in `lib/ussd-hubtel/flows/shop.ts`, and the Uzo shop
  menu in `lib/ussd-shop/handlers/shop.ts`), the code prompt offers the remembered shop as option `1`.
- ONE remembered shop per phone, shared by USSD (Hubtel + Uzo), the SMS shop line, the SMS missed-call helper and the
  WhatsApp shop bot.
- Existing customers get the shortcut from day one (backfill + last-purchase fallback), no re-entry needed.

## Non-goals

- "Buy again" (repeat last order) and dial-with-code (`*713*235*1234#`): considered, not chosen for this project.
- The main (non-shop) USSD codes, the Hubtel main code `*713*235*1#`, and the web storefronts.
- A list of several recent shops (option D, not chosen).
- Any change to prices, payment, profit or order placement.

## Anti-goals (a failure even if it works)

- A caller buys from a shop they did not choose. The shortcut must always name the shop on screen and require an
  explicit `1`; it never opens a shop's menu by itself.
- A shop code typed on the shortcut screen is mistaken for the shortcut, or the reverse.
- The shortcut adds latency that pushes a USSD reply past the gateway timeout.
- One channel's eligibility rule deletes the shared memory for the others (today the WhatsApp bot DELETES its pref
  when the shop is not WhatsApp-activated: with a shared row that would wipe the caller's USSD/SMS shop).
- Phone formats silently fail to match, so the memory "works" in tests and never fires in production.

## Constraints

- USSD screens are about 160 characters; sessions are short. One extra indexed read per dial at most.
- Shop codes are `ussd_shop_codes.code` VARCHAR(8), generated as 4-6 digits; `^[A-Za-z0-9]{1,8}$` is the accepted
  shape. A single digit `1` can never be a real code, so `1` is unambiguous on the code screen. Builder: confirm no
  live code is the single character `1` (one SELECT) before relying on this.
- Phone forms in use: Hubtel/Uzo give `+233XXXXXXXXX`; WhatsApp `from` is `233XXXXXXXXX`; SMS stores local
  `0XXXXXXXXX`. The shared table stores local `0XXXXXXXXX` only; every reader/writer normalises through one helper.
- Follows the repo rules: migration with self-rolling-back dry run and owner OK before apply; RLS on, no anon/
  authenticated grants, service role only; PII-free logs (no phone numbers in logs); TDD with logic in `lib/`; ships
  DARK behind an admin switch; fresh reviewer before merge (schema change).

## Approaches considered

1. **One new shared table (CHOSEN by the owner).** `shop_customer_prefs`, one row per phone. All channels read it
   first, fall back to the last purchase, and write it. Backfilled from both existing tables. True single memory;
   costs a migration and edits to live SMS and WhatsApp code.
2. Last purchase only, no table. USSD offers the shop of the newest paid `ussd_shop_orders` row (already written by
   every channel). Zero live changes, but only partly shared: a shop switch without a purchase is not seen.
3. USSD reads both old tables plus last purchase, newest wins. No live changes, but three reads per dial and a third
   drifting rule set.

## Design

### Data

New table `public.shop_customer_prefs`:

| column        | type        | notes                                                         |
|---------------|-------------|---------------------------------------------------------------|
| phone         | text PK     | local `0XXXXXXXXX`, CHECK `^0[0-9]{9}$`                        |
| shop_code_id  | uuid        | FK `ussd_shop_codes(id)` ON DELETE CASCADE                    |
| last_channel  | text        | `ussd_hubtel` / `ussd_uzo` / `sms` / `whatsapp`, CHECK list   |
| last_used_at  | timestamptz | default now()                                                 |

RLS on, zero policies, revoke from anon/authenticated (matches 0180's model). Backfill in the same migration:
union of `ttb_shop_prefs` (sender is already local) and `wa_shop_customer_prefs` (phone normalised from `233...`),
newest `last_used_at` wins per phone, rows whose phone does not normalise are skipped. The old tables are kept,
untouched and no longer written, so a code rollback still has (stale) data; dropping them is a later cleanup.

One shared module `lib/shop-commerce/customer-prefs.ts`: `toLocalPhone(raw)`, `getCustomerShop(db, phone)`,
`rememberCustomerShop(db, phone, shopCodeId, channel)`, plus `rememberedShopFor(db, phone)` which returns the
pref's shop if present, else the last-bought shop (reusing `lastBoughtShopCodeId` logic, moved here from
`lib/text-to-buy/store.ts`), seeding the pref once from the last purchase exactly as SMS does today.

### Rules shared by every channel

- **Read:** pref row first; if present its answer is final (SMS's current rule: no fallback to last purchase when
  the remembered shop no longer resolves). No row: last purchase. Neither: no memory.
- **Eligibility is per channel and never deletes:** a channel that cannot use the remembered shop (inactive shop,
  not WhatsApp-activated, shop has no services on this menu) simply does not offer it. Only an explicit new choice
  overwrites the row. The WhatsApp bot's `clearShopPref` call is removed.
- **Write:** when a caller successfully enters a valid, active shop by code on any channel (WhatsApp's current
  rule), and after an order is placed (SMS's current rule). Writes are best-effort: a failed write never fails the
  caller's request.

### USSD screens (both Hubtel and Uzo)

Caller with a usable remembered shop:

```
Welcome to Clingshub
Enter shop code
1. KofiData (last used)
0. Exit
```

- `1`: the remembered shop's product menu, exactly as if its code had been typed (same networks lookup, same
  data-whitelist check). Does not count as a code attempt.
- Any other input: today's code handling, unchanged (including the 3-attempt cap). A valid new code becomes the
  remembered shop.
- `0`: exit, unchanged.
- The retry screen after a wrong code keeps the `1.` line, so a typo does not lose the shortcut.
- No usable memory: the screen is byte-for-byte today's prompt.
- Shop name is truncated so the whole screen stays within the USSD length budget (builder picks the cut, ellipsis
  allowed). The Uzo prompt keeps its own "Welcome to DataGod" header.

Hubtel specifics: the session stores the offered `shopCodeId` so `1` resolves the same shop that was shown. The
existing lost-session recovery (`recoverShopCodeEntry`, ClientState `SHOP_ENTER_CODE`) must handle `1` by looking
the memory up again; if it no longer resolves, show the plain code prompt.

### Other channels

- SMS shop line + missed-call helper: swap `getShopPref`/`setShopPref`/`lastBoughtShopCodeId` deps to the shared
  module; behaviour otherwise unchanged. The admin Try-it route keeps its no-write override.
- WhatsApp shop bot (`lib/whatsapp-bot/shop-router.ts`, `shop-ai.ts`, `lib/ai-tools.ts`): read/write the shared
  module; drop `clearShopPref`; a non-activated remembered shop falls through to code entry without deleting.

### Switch and rollout

- Admin setting `ussd_shop_memory_enabled` (default off) gates only the USSD shortcut. SMS and WhatsApp move to
  the shared table at deploy (their behaviour is unchanged, only the storage).
- Order: apply migration (with backfill) -> deploy code -> owner turns the USSD switch on -> live dial on both
  codes.
- One setting, shown as an on/off switch on the admin USSD page (builder picks the page).

## Decided by the owner

- Flow: shortcut on the code screen (option A).
- Memory shared across USSD, SMS and WhatsApp, via one new table (approach 1).
- Both Hubtel `*713*235#` and the Uzo shop code.
- Newest wins across channels: a shop chosen on any channel (valid code entry or placed order) replaces the
  memory everywhere. This is an intended change for SMS and WhatsApp users.

## My calls (owner can override)

- Storage format local `0XXXXXXXXX`; `last_channel` column for support/debugging.
- Write on code entry AND after order; a pref row is final (no last-purchase fallback once a row exists).
- Never delete on ineligibility; only a new explicit choice overwrites.
- Old tables kept read-only for rollback.
- Label text "(last used)"; switch default off.

## Builder-check answers

- **Key on the code row, not the shop.** `ussd_shop_codes.code` is UNIQUE, but `shop_id` is not, so a shop could
  have several code rows. Both existing pref tables key on `shop_code_id` with ON DELETE CASCADE. The new table does
  the same, so the shortcut always opens exactly the code the caller used. Deleting a code drops its memories, which
  is correct.
- **The backfill can't break the foreign key:** both source tables already cascade on code delete, so every row
  points at a live code. The dry run reports row counts per source and the merged total.
- **Offer-time cost (USSD):** one query that joins pref to code to shop, returning code id, status and display name.
  Status must be `active`, else no offer. That single read replaces the anti-goal's "one extra read". The networks
  lookup and whitelist check run only when `1` is pressed, sharing the typed-code path. If the shop fails anything
  after `1` is pressed, show the plain code prompt with "That shop is unavailable." The attempt is not counted.
- **Uzo state:** `1` is handled only in the ENTER_SHOP_CODE step (Uzo) / SHOP_ENTER_CODE (Hubtel). Other steps are
  untouched.
- **Last-purchase source:** `ussd_shop_orders.dialing_phone`, matched in all three forms (`+233`, `233`, `0`)
  as `lastBoughtShopCodeId` already does. This is proven live on SMS.
- **Switch read:** the existing `admin_settings` row, read once per dial. A missing row or a failed read counts as
  OFF, and the code screen stays as it is today.
- **Recycled or SIM-swapped numbers** may see the previous owner's last shop name. That's accepted: only a shop name
  is shown, and nothing can be bought without the new owner paying.
- **Cross-channel overwrite:** see the owner decision below.

## Left to the builder

- Exact truncation length and helper placement; whether the networks lookup is shared between "typed code" and
  "pressed 1" (it should be one function); test layout; admin switch placement; migration number (next free).
