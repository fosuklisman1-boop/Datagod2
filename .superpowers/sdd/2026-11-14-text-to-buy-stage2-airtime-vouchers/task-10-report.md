# Task 10 report

Status: DONE_WITH_CONCERNS (step 5 not done)

Implemented: serviceCountsToday (store.ts; 9 head:true count queries, no RPC or migration), GET `services` field, Overview card "By service today" (Data/Airtime/Checkers, Off badge from mainEnabled/airtimeEnabled/resultsCheckerEnabled), fake db `.not(col,"is",null)`, runbook section 12 (stage 2) including the T6/T7/T8-9 carry-forward notes, T4 route test (combined patch without confirm => 400 confirm_required, confirm "true" => 400 invalid_confirm, nothing written).

TDD: RED = 4 failed (3 store, 1 route services) / 74 passed. GREEN = 24 files, 952 tests pass (lib/text-to-buy + app/api/admin/text-to-buy). tsc: no errors in text-to-buy files (pre-existing errors elsewhere in leaderboard and broadcast tests). Full suite: 12 failed, all the known ones (order-health 9, admin-users migration, pricing migration, standard-bundles runtime).

Step 5: not done. No admin session is available locally without reading secrets. Owner to check at 500px and 1280px.

Concerns:
- The card is a small table inside overflow-x-auto, not looked at in a browser.
- Runbook new section uses LF in a CRLF file (mixed endings).
- lib/ussd/bots/__snapshots__/uzo-golden.test.ts.snap is modified in the working tree (line-ending artifact of the full suite); the sandbox hook blocked `git restore`/`checkout`, so it was left unstaged and not committed. Restore it with `git restore` before merging.
