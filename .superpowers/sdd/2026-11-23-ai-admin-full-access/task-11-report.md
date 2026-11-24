# Task 11: users catalog (report)

Commit: 7c9c0a89 `feat(ai-admin): users catalog`. Files: lib/ai-admin-catalog/areas/users.ts, areas/users.test.ts, excluded.ts (+6 rows), index.ts, pending.ts (-51 rows, PENDING_BUDGET 366 -> 315).

RED: first run of users.test.ts (entries written, PENDING/EXCLUDED not yet updated) failed 5 tests (routes still in PENDING, 6 exclusions missing, my own regex too wide on "author_id"). GREEN: `npx vitest run lib/ai-admin-catalog` 9 files / 325 tests pass; lib/ai-prompts, ai-tool-registry snapshot, ai-drafts, ai-tools: 19 files / 393 pass. tsc: no errors in ai-admin-catalog files (only the two known pre-existing files).

Counts: 45 catalogued, 6 excluded, PENDING 366 -> 315 (0 users-area routes left).

## Catalogued (id, risk, how)

Lookups (resultKeep, no email / auth data / tokens): users.list, users.profile, users.stats, users.orders, users.transactions, users.audit, users.signals, users.shop, users.notes_list, users.tags_get, users.custom_prices_get, users.phone_audit (/admin/user-phone-audit; idsOnly left out of schema), users.debtors, users.signup_sources (/admin/settings), roles.list, roles.audit, roles.members, roles.permissions_get, roles.prices_get, roles.rates_get. Phone numbers are kept where the admin UI shows them (users list, profile, phone audit, role members); emails never.

Typed (no card): POST update-balance (money, prepare_wallet_adjustment), POST users/suspend (danger, prepare_user_suspension), POST users/update-role (danger, prepare_role_change). Checked each handler: the typed executor (lib/ai-drafts/execute.ts) posts exactly these bodies to these routes.

Cards, danger: set-admin, set-admin-by-email (auth "other": bearer token + users.role check, not verifyAdminAccess; 60 s timeout, it pages all auth users), remove-admin, remove-user (DELETE with body; lists every deletion, wallet balance lost, refusals for self/admin), change-user-password (secretFields newPassword "New password" 8-128; body only userId; card says all sessions end and the user is not told), users/update-user (password key NOT in schema, so a password only goes through the secure box route), roles create / update / archive / move / members-move (capped at 50 ids, handler allows 200) / permissions PUT / prices PUT / rates PUT.
Cards, money: users/:id/phone-verified (refunds for that phone go to the verified account), users/:id/custom-prices PUT.
Cards, normal: force-logout, password-reset (user's inbox only), notes create/edit/delete, tags.

Side effects named on cards: sessions ended, emails/push/SMS sent or NOT sent, audit row written or NOT written (set-admin-by-email and update-user write none), margins re-balanced on dealer moves, price fallback down the role ladder, member counts, below-cost refusal / loss override, custom-role switch (CUSTOM_ROLE_ASSIGNMENT_ENABLED false: members/move to a custom role says every user would be skipped; roles create says no user can be given it yet). The hub routes themselves do not check the flag, so create/edit/prices/rights still run.

## Excluded (6)

- GET customers/:id/history, customers/analytics, customers/list: not admin routes; shop-owner routes that read only the caller's own shop via bearer token, useless to an admin.
- GET initialize-balance: a GET that upserts every shop's available_balance from `shop_profits` read in one request, so capped at the first 1000 rows by PostgREST; on a bigger table it saves wrong balances. One-off setup script, similar to the other excluded repair scripts.
- POST users/bulk: maxDuration 300 (up to 200 users, or notify up to 5000).
- GET users/export: up to 5000 users' contact details in one reply, same data as users.list.

## Concerns

1. initialize-balance exclusion departs from the brief's "balance edits/initialization = money"; the row-cap bug is the reason. Reverse by adding a money entry if the owner wants it, but the 1000-row cap should be fixed first.
2. remove-admin handler sets role to "user" for ANY target (no check it is an admin, no last-admin or self check). The card warns about all three. A server-side guard would be better; not changed here.
3. set-admin accepts any uuid and reports success even if no such user exists; the card says so.
4. users/update-user changes sign-in email and phone with no audit row and no notice; rated danger. It also does not reset phone_verified.
5. Risk of suspend (danger) and force-logout (normal) are my choice; the table only fixes the others.
6. users/bulk exclusion means bulk role/suspend changes must use the page; roles/members/move covers bulk role moves up to 50.

## Fix round 1

- users.update_user card now shows the FULL new email and phone (old values stay masked) and adds a "Danger: This changes the sign-in details of an admin account." line when the target is an admin.
- POST set-admin-by-email moved to EXCLUDED ("use users.set_admin by id ..."). Catalogued 44, excluded 7, PENDING unchanged at 315.
- users.set_admin card shows full name, user id and masked phone from the DB, and "(no such user — the route still reports success)" when missing.
- roles.members_move schema refuses to_role admin and sub_agent.
- last_sign_in_at / lastSignInAt dropped from users.list and users.profile resultKeep (test forbids sign-in timestamps).
- Tests added/updated for each; lib/ai-admin-catalog all green.
