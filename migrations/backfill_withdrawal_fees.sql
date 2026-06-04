-- =============================================================================
-- Backfill / report for zero-fee withdrawals
--
-- Context: withdrawals created from the browser silently got fee_amount = 0
-- because the client-side read of app_settings.withdrawal_fee_percentage ran as
-- `anon` and hit 42501 (the table is locked to service_role). The app fix routes
-- creation through a service-role API route. This script cleans up existing rows.
--
-- Run PART 1 (report) first and eyeball it. Then run PART 2 (backfill) — it only
-- touches PENDING rows (not yet paid out). It NEVER changes `processing` or
-- `completed` rows: those are in-flight or already paid and must not be mutated.
-- =============================================================================

-- ─── PART 1: REPORT (read-only) ──────────────────────────────────────────────

-- 1a. Zero-fee withdrawals grouped by status
SELECT status,
       COUNT(*)        AS rows,
       SUM(amount)     AS gross_amount
FROM   withdrawal_requests
WHERE  (fee_amount IS NULL OR fee_amount = 0)
  AND  amount > 0
GROUP  BY status
ORDER  BY status;

-- 1b. Estimated fees LOST on already-completed zero-fee withdrawals
--     (already paid in full — cannot be auto-recovered; for your records).
SELECT COUNT(*)                                                            AS completed_zero_fee,
       SUM(amount)                                                         AS gross_paid,
       ROUND(SUM(amount) * (SELECT withdrawal_fee_percentage / 100.0
                            FROM app_settings LIMIT 1), 2)                 AS est_fees_lost
FROM   withdrawal_requests
WHERE  status = 'completed'
  AND  (fee_amount IS NULL OR fee_amount = 0)
  AND  amount > 0;

-- 1c. Itemised completed zero-fee withdrawals (the ones you can't auto-fix)
SELECT id, shop_id, user_id, amount, withdrawal_method, created_at
FROM   withdrawal_requests
WHERE  status = 'completed'
  AND  (fee_amount IS NULL OR fee_amount = 0)
  AND  amount > 0
ORDER  BY created_at DESC;

-- 1d. Pending rows that PART 2 will recompute (preview before you run it)
SELECT w.id, w.shop_id, w.amount,
       ROUND(w.amount * s.pct, 2)              AS new_fee,
       w.amount - ROUND(w.amount * s.pct, 2)   AS new_net
FROM   withdrawal_requests w
CROSS  JOIN (SELECT withdrawal_fee_percentage / 100.0 AS pct
             FROM app_settings LIMIT 1) s
WHERE  w.status = 'pending'
  AND  (w.fee_amount IS NULL OR w.fee_amount = 0)
  AND  w.amount > 0
  AND  s.pct > 0
ORDER  BY w.created_at DESC;


-- ─── PART 2: BACKFILL (mutates PENDING rows only) ────────────────────────────
-- Recomputes fee_amount / net_amount for not-yet-paid (pending) withdrawals
-- using the CURRENT app_settings fee %. Safe to re-run (idempotent: only hits
-- rows that still have a 0/null fee).

BEGIN;

UPDATE withdrawal_requests w
SET    fee_amount = ROUND(w.amount * s.pct, 2),
       net_amount = w.amount - ROUND(w.amount * s.pct, 2),
       updated_at = NOW()
FROM   (SELECT withdrawal_fee_percentage / 100.0 AS pct
        FROM app_settings LIMIT 1) s
WHERE  w.status = 'pending'
  AND  (w.fee_amount IS NULL OR w.fee_amount = 0)
  AND  w.amount > 0
  AND  s.pct > 0;

-- Verify the affected rows look right, THEN COMMIT (or ROLLBACK to undo).
SELECT id, amount, fee_amount, net_amount, status
FROM   withdrawal_requests
WHERE  status = 'pending'
ORDER  BY updated_at DESC
LIMIT  50;

COMMIT;
-- ROLLBACK;  -- use this instead of COMMIT if the preview above looks wrong
