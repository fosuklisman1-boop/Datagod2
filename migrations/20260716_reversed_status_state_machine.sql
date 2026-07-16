-- migrations/20260716_reversed_status_state_machine.sql
-- Permit ONLY completed -> reversed (the automated reversal safeguard). Every other exit
-- from completed stays blocked (notably completed -> pending). payment_status rule unchanged.
CREATE OR REPLACE FUNCTION public.enforce_order_state_machine()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.order_status = 'completed'
     AND NEW.order_status IS DISTINCT FROM 'completed'
     AND NEW.order_status IS DISTINCT FROM 'reversed' THEN
    RAISE EXCEPTION 'Invalid transition: order_status cannot move from completed to %', NEW.order_status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.payment_status = 'completed' AND NEW.payment_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Invalid transition: payment_status cannot move from completed to %', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
