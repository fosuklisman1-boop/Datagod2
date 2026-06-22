-- 0085_security_detection_triggers.sql
--
-- Database-level attack detection. Each trigger calls public.raise_security_alert
-- (0084), which writes a security_alerts row whose own AFTER INSERT trigger fires
-- real-time delivery to admins. These run INSIDE the write path, so every detector
-- is FAIL-OPEN: any error is caught and the original write proceeds untouched. A
-- detector bug can therefore never block orders/wallets/withdrawals/signups.
--
-- Thresholds tuned from the 2026-06-22 forensic baseline:
--   * orders: app never writes status='delivered'; legit price tops out ~2200 (airtime)
--   * withdrawals: 'approved' WITHOUT moolre_transfer_id is the NORMAL pre-payout state;
--     only 'completed' without a transfer id is anomalous
--   * admin self-top-ups run up to ~2000, so wallet credit alerts fire at >= 10000
-- Applied live via the Management API 2026-06-22.

-- 1) Privilege escalation: any account flipped to/from admin.
CREATE OR REPLACE FUNCTION public.sec_detect_role_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF lower(COALESCE(NEW.role, '')) = 'admin' THEN
      PERFORM public.raise_security_alert('critical', 'privilege_escalation',
        'Account promoted to ADMIN: ' || COALESCE(NEW.email, NEW.id::text),
        jsonb_build_object('user_id', NEW.id, 'email', NEW.email, 'old_role', OLD.role, 'new_role', NEW.role),
        COALESCE(NEW.email, NEW.id::text));
    ELSIF lower(COALESCE(OLD.role, '')) = 'admin' THEN
      PERFORM public.raise_security_alert('high', 'privilege_change',
        'Admin role removed: ' || COALESCE(NEW.email, NEW.id::text),
        jsonb_build_object('user_id', NEW.id, 'old_role', OLD.role, 'new_role', NEW.role),
        COALESCE(NEW.email, NEW.id::text));
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_role_change_trg ON public.users;
CREATE TRIGGER sec_detect_role_change_trg AFTER UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_role_change();

-- 2) Suspicious order: status the app never writes, absurd price, or no phone.
CREATE OR REPLACE FUNCTION public.sec_detect_order()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE reasons text[] := '{}';
BEGIN
  IF lower(COALESCE(NEW.status, '')) = 'delivered' THEN reasons := array_append(reasons, 'status=delivered'); END IF;
  IF COALESCE(NEW.price, 0) >= 10000 THEN reasons := array_append(reasons, 'price=' || NEW.price); END IF;
  IF NEW.phone_number IS NULL OR NEW.phone_number = '' THEN reasons := array_append(reasons, 'null phone'); END IF;
  IF array_length(reasons, 1) > 0 THEN
    PERFORM public.raise_security_alert('high', 'forged_order',
      'Suspicious order ' || COALESCE(NEW.order_code, NEW.id::text) || ' (' || array_to_string(reasons, ', ') || ')',
      jsonb_build_object('order_id', NEW.id, 'order_code', NEW.order_code, 'price', NEW.price, 'status', NEW.status, 'phone', NEW.phone_number, 'user_id', NEW.user_id),
      NEW.user_id::text);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_order_trg ON public.orders;
CREATE TRIGGER sec_detect_order_trg AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_order();

-- 3) Wallet mint: a new wallet born funded, or a large unexplained balance jump.
CREATE OR REPLACE FUNCTION public.sec_detect_wallet()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.balance, 0) >= 50 THEN
      PERFORM public.raise_security_alert('high', 'wallet_mint',
        'New wallet created with non-zero balance (' || NEW.balance || ')',
        jsonb_build_object('wallet_id', NEW.id, 'user_id', NEW.user_id, 'balance', NEW.balance), NEW.user_id::text);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.balance, 0) - COALESCE(OLD.balance, 0) >= 20000 THEN
      PERFORM public.raise_security_alert('high', 'wallet_mint',
        'Large wallet balance jump (+' || (NEW.balance - OLD.balance) || ')',
        jsonb_build_object('wallet_id', NEW.id, 'user_id', NEW.user_id, 'old', OLD.balance, 'new', NEW.balance), NEW.user_id::text);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_wallet_trg ON public.wallets;
CREATE TRIGGER sec_detect_wallet_trg AFTER INSERT OR UPDATE OF balance ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_wallet();

-- 4) Large wallet credit (non-debit transaction >= 10000; routine admin credits are <= 2000).
CREATE OR REPLACE FUNCTION public.sec_detect_wallet_txn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF COALESCE(NEW.amount, 0) >= 10000
     AND lower(COALESCE(NEW.type, '')) NOT LIKE '%debit%'
     AND lower(COALESCE(NEW.type, '')) NOT LIKE '%spend%'
     AND lower(COALESCE(NEW.type, '')) NOT LIKE '%order%'
     AND lower(COALESCE(NEW.type, '')) NOT LIKE '%withdraw%' THEN
    PERFORM public.raise_security_alert('high', 'wallet_credit',
      'Large wallet credit (' || NEW.amount || ', type ' || COALESCE(NEW.type, '?') || ')',
      jsonb_build_object('txn_id', NEW.id, 'user_id', NEW.user_id, 'amount', NEW.amount, 'type', NEW.type, 'reference', NEW.reference),
      NEW.user_id::text);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_wallet_txn_trg ON public.wallet_transactions;
CREATE TRIGGER sec_detect_wallet_txn_trg AFTER INSERT ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_wallet_txn();

-- 5) Withdrawal marked completed without a Moolre transfer = money paid with no payout record.
CREATE OR REPLACE FUNCTION public.sec_detect_withdrawal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
BEGIN
  IF lower(COALESCE(NEW.status, '')) = 'completed'
     AND (NEW.moolre_transfer_id IS NULL OR NEW.moolre_transfer_id = '') THEN
    PERFORM public.raise_security_alert('critical', 'withdrawal_anomaly',
      'Withdrawal marked completed without Moolre transfer (' || COALESCE(NEW.reference_code, NEW.id::text) || ', ' || COALESCE(NEW.amount, 0) || ')',
      jsonb_build_object('withdrawal_id', NEW.id, 'amount', NEW.amount, 'status', NEW.status, 'user_id', NEW.user_id, 'shop_id', NEW.shop_id),
      NEW.user_id::text);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_withdrawal_trg ON public.withdrawal_requests;
CREATE TRIGGER sec_detect_withdrawal_trg AFTER INSERT OR UPDATE ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_withdrawal();

-- 6) Signup flood: >= 6 new auth.users in 5 min (de-duped to one alert per 10 min).
CREATE OR REPLACE FUNCTION public.sec_detect_signup_velocity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $f$
DECLARE cnt int; recent int;
BEGIN
  SELECT count(*) INTO cnt FROM auth.users WHERE created_at > now() - interval '5 minutes';
  IF cnt >= 6 THEN
    SELECT count(*) INTO recent FROM public.security_alerts WHERE category = 'signup_flood' AND created_at > now() - interval '10 minutes';
    IF recent = 0 THEN
      PERFORM public.raise_security_alert('high', 'signup_flood',
        cnt || ' signups in 5 minutes (possible flood/attack)',
        jsonb_build_object('count_5min', cnt, 'latest_email', NEW.email), NEW.email);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$f$;
DROP TRIGGER IF EXISTS sec_detect_signup_velocity_trg ON auth.users;
CREATE TRIGGER sec_detect_signup_velocity_trg AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sec_detect_signup_velocity();
