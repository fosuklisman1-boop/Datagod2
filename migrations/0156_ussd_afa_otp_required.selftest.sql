-- 0156_ussd_afa_otp_required.selftest.sql
--
-- NOT A MIGRATION. Local PGlite selftest (psql-only, no real database touched). Run from the repo root with a
-- runner that expands `\i` (see memory reference-pglite-sql-tests). PASSES when it prints 'SELFTEST_OK'.
--
-- Scenarios: before the migration otp_required is refused; after it, otp_required and the old values insert and other
-- values are still refused; existing rows survive; idempotent re-run.

CREATE TABLE public.ussd_afa_orders (
  id serial PRIMARY KEY,
  payment_status varchar(50) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','completed','failed'))
);
INSERT INTO public.ussd_afa_orders (payment_status) VALUES ('completed');

DO $before$ BEGIN
  BEGIN
    INSERT INTO public.ussd_afa_orders (payment_status) VALUES ('otp_required');
    RAISE EXCEPTION 'FAIL fixture: otp_required allowed before the migration';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $before$;

\i migrations/0156_ussd_afa_otp_required.sql
-- Re-run: must be idempotent.
\i migrations/0156_ussd_afa_otp_required.sql

DO $selftest$
DECLARE v int;
BEGIN
  INSERT INTO public.ussd_afa_orders (payment_status) VALUES ('otp_required'), ('pending'), ('completed'), ('failed');
  SELECT count(*) INTO v FROM public.ussd_afa_orders;
  IF v <> 5 THEN RAISE EXCEPTION 'FAIL rows: %', v; END IF;
  BEGIN
    INSERT INTO public.ussd_afa_orders (payment_status) VALUES ('nonsense');
    RAISE EXCEPTION 'FAIL nonsense allowed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'SELFTEST_OK';
END $selftest$;
