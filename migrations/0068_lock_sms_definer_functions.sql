-- migrations/0068_lock_sms_definer_functions.sql
-- SECURITY FIX (found in M3 adversarial review): four SMS SECURITY DEFINER functions from
-- Foundation (0062/0063) were left with PostgreSQL's default EXECUTE-to-PUBLIC grant, so any
-- 'authenticated' tenant could call them directly via PostgREST and mint/issue/settle credits,
-- defeating the entire metering + solvency model. Lock them to the backend service identity
-- only, matching the pattern used by activate_sms_account / debit_sms_for_send / etc.

REVOKE ALL ON FUNCTION adjust_sms_units(UUID, INT, TEXT, TEXT, UUID)            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION adjust_sms_units(UUID, INT, TEXT, TEXT, UUID)        TO service_role;

REVOKE ALL ON FUNCTION credit_sms_units_if_solvent(UUID, INT, TEXT, INT, TEXT)  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION credit_sms_units_if_solvent(UUID, INT, TEXT, INT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION get_or_create_sms_account(UUID, TEXT, UUID)             FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION get_or_create_sms_account(UUID, TEXT, UUID)         TO service_role;

REVOKE ALL ON FUNCTION settle_pending_sms_credits(INT)                          FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION settle_pending_sms_credits(INT)                      TO service_role;
