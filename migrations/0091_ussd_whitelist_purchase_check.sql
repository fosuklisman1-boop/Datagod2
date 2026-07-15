-- Returns TRUE if the phone number has any completed purchase across ALL
-- order tables OR appears in the manual admin whitelist.
-- Accepts local format (0XXXXXXXXX) and optionally the raw carrier MSISDN
-- (+233XXXXXXXXX or 233XXXXXXXXX) so dialing_phone columns match regardless
-- of how the carrier sends the number.
CREATE OR REPLACE FUNCTION has_completed_purchase(local_phone text, msisdn text DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    -- Web / dashboard / bulk data orders
    SELECT 1 FROM orders
      WHERE phone_number = local_phone AND status = 'completed'

    UNION ALL

    -- USSD data bundle orders (caller)
    SELECT 1 FROM ussd_orders
      WHERE payment_status = 'completed'
        AND (dialing_phone = local_phone OR (msisdn IS NOT NULL AND dialing_phone = msisdn))

    UNION ALL

    -- USSD shop data bundle orders (caller)
    SELECT 1 FROM ussd_shop_orders
      WHERE payment_status = 'completed'
        AND (dialing_phone = local_phone OR (msisdn IS NOT NULL AND dialing_phone = msisdn))

    UNION ALL

    -- Airtime orders (caller)
    SELECT 1 FROM airtime_orders
      WHERE payment_status = 'completed'
        AND (dialing_phone = local_phone OR (msisdn IS NOT NULL AND dialing_phone = msisdn))

    UNION ALL

    -- Results checker voucher orders (caller)
    SELECT 1 FROM results_checker_orders
      WHERE payment_status = 'completed'
        AND (dialing_phone = local_phone OR (msisdn IS NOT NULL AND dialing_phone = msisdn))

    UNION ALL

    -- AFA registration orders (web)
    SELECT 1 FROM afa_orders
      WHERE phone_number = local_phone AND status = 'completed'

    UNION ALL

    -- USSD AFA registration orders (caller)
    SELECT 1 FROM ussd_afa_orders
      WHERE payment_status = 'completed'
        AND (dialing_phone = local_phone OR (msisdn IS NOT NULL AND dialing_phone = msisdn))

    UNION ALL

    -- Manual admin whitelist (always grants access)
    SELECT 1 FROM ussd_whitelist
      WHERE phone_number = local_phone

    LIMIT 1
  )
$$;
