-- New RPC for the redesigned Admin Dashboard hub: range-scoped revenue/
-- profit/orders + a daily chart series + the "Actions" quick-alert counts
-- (complaints/AFA/expiring dealer plans/debtors/pending shops) and the
-- Float & Liability figures. Additive -- does not touch or replace
-- get_admin_dashboard_stats_v2(), which /admin/page.tsx's existing
-- all-time totals and the get_admin_stats AI tool still rely on.
--
-- Profit is computed the same honest way documented for this session:
-- revenue minus what was actually paid out to shop owners (shop_profits,
-- a single ledger spanning every order type via its per-type FK columns)
-- minus the REAL wholesale cost of data volume sold (volume_gb x the
-- admin-configured supplier_cost_per_gb_* on app_settings). Non-data order
-- types (airtime/AFA/results checker/results check) still only get the
-- gross-margin treatment since there's no tracked supplier cost for them.
CREATE OR REPLACE FUNCTION get_admin_dashboard_hub_stats(p_range TEXT DEFAULT '7d')
RETURNS JSON AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_start TIMESTAMPTZ;
    v_prev_start TIMESTAMPTZ;
    v_today_start TIMESTAMPTZ := date_trunc('day', v_now);

    v_cost_mtn NUMERIC := 0;
    v_cost_telecel NUMERIC := 0;
    v_cost_at_ishare NUMERIC := 0;
    v_cost_at_bigtime NUMERIC := 0;

    v_range_revenue NUMERIC := 0;
    v_prev_revenue NUMERIC := 0;
    v_range_payout NUMERIC := 0;
    v_range_supplier_cost NUMERIC := 0;
    v_range_profit NUMERIC := 0;

    v_range_total_orders BIGINT := 0;
    v_range_completed_orders BIGINT := 0;
    v_today_orders BIGINT := 0;

    v_float_balance NUMERIC := 0;
    v_debtors_total NUMERIC := 0;
    v_debtors_count BIGINT := 0;

    v_complaints_pending BIGINT := 0;
    v_afa_pending BIGINT := 0;
    v_agents_expiring BIGINT := 0;
    v_pending_shops BIGINT := 0;

    v_chart_series JSON;
    v_result JSON;
BEGIN
    -- Range window
    IF p_range = 'today' THEN
        v_start := v_today_start;
    ELSIF p_range = '30d' THEN
        v_start := v_now - INTERVAL '30 days';
    ELSE
        v_start := v_now - INTERVAL '7 days';
    END IF;
    v_prev_start := v_start - (v_now - v_start);

    -- Admin-configured supplier cost per GB (singleton config row)
    SELECT
        COALESCE(supplier_cost_per_gb_mtn, 0),
        COALESCE(supplier_cost_per_gb_telecel, 0),
        COALESCE(supplier_cost_per_gb_at_ishare, 0),
        COALESCE(supplier_cost_per_gb_at_bigtime, 0)
    INTO v_cost_mtn, v_cost_telecel, v_cost_at_ishare, v_cost_at_bigtime
    FROM app_settings WHERE key IS NULL LIMIT 1;

    -- Revenue + order counts, current window (all 5 order types)
    SELECT
        COALESCE(SUM(CASE WHEN payment_status = 'completed' AND created_at >= v_start THEN total_price ELSE 0 END), 0)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(fee), 0) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COALESCE(SUM(amount), 0) FROM afa_orders WHERE status = 'completed' AND created_at >= v_start),
        COUNT(*) FILTER (WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM airtime_orders WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE created_at >= v_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE created_at >= v_start),
        COUNT(*) FILTER (WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE status = 'completed' AND created_at >= v_start)
    INTO v_range_revenue, v_range_total_orders, v_range_completed_orders
    FROM shop_orders;

    -- Same, previous equal-length window (for the % change indicator)
    SELECT
        COALESCE(SUM(CASE WHEN payment_status = 'completed' AND created_at >= v_prev_start AND created_at < v_start THEN total_price ELSE 0 END), 0)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM airtime_orders WHERE status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(total_paid), 0) FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(fee), 0) FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
          + (SELECT COALESCE(SUM(amount), 0) FROM afa_orders WHERE status = 'completed' AND created_at >= v_prev_start AND created_at < v_start)
    INTO v_prev_revenue
    FROM shop_orders;

    -- Shop-owner payouts in range (single ledger across every order type)
    SELECT COALESCE(SUM(profit_amount), 0) INTO v_range_payout
    FROM shop_profits WHERE status = 'credited' AND created_at >= v_start;

    -- Real supplier cost for data volume sold in range
    SELECT COALESCE(SUM(
        volume_gb * CASE network
            WHEN 'MTN' THEN v_cost_mtn
            WHEN 'Telecel' THEN v_cost_telecel
            WHEN 'AT - iShare' THEN v_cost_at_ishare
            WHEN 'AT - BigTime' THEN v_cost_at_bigtime
            ELSE 0
        END
    ), 0) INTO v_range_supplier_cost
    FROM shop_orders WHERE payment_status = 'completed' AND created_at >= v_start;

    v_range_profit := v_range_revenue - v_range_payout - v_range_supplier_cost;

    -- Today's orders (always "today", independent of the selected range)
    SELECT
        COUNT(*) FILTER (WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM airtime_orders WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM results_checker_orders WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM results_check_requests WHERE created_at >= v_today_start)
          + (SELECT COUNT(*) FROM afa_orders WHERE created_at >= v_today_start)
    INTO v_today_orders
    FROM shop_orders;

    -- Float & Liability: wallets held for users vs. negative-balance debtors
    SELECT
        COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0),
        COALESCE(SUM(ABS(balance)) FILTER (WHERE balance < 0), 0),
        COUNT(*) FILTER (WHERE balance < 0)
    INTO v_float_balance, v_debtors_total, v_debtors_count
    FROM wallets;

    -- Quick-action counts
    SELECT COUNT(*) INTO v_complaints_pending FROM whatsapp_complaints WHERE status = 'pending';
    SELECT COUNT(*) INTO v_afa_pending FROM afa_orders WHERE status = 'pending';
    SELECT COUNT(*) INTO v_agents_expiring FROM user_subscriptions
        WHERE status = 'active' AND end_date >= v_now AND end_date < v_now + INTERVAL '7 days';
    SELECT COUNT(*) INTO v_pending_shops FROM user_shops WHERE is_active = false;

    -- Daily chart series (revenue + profit per day across the range)
    WITH days AS (
        SELECT generate_series(date_trunc('day', v_start), date_trunc('day', v_now), '1 day'::interval)::date AS d
    ),
    daily_shop AS (
        SELECT date_trunc('day', created_at)::date d, SUM(total_price) rev
        FROM shop_orders WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_airtime AS (
        SELECT date_trunc('day', created_at)::date d, SUM(total_paid) rev
        FROM airtime_orders WHERE status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_rc AS (
        SELECT date_trunc('day', created_at)::date d, SUM(total_paid) rev
        FROM results_checker_orders WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_rcs AS (
        SELECT date_trunc('day', created_at)::date d, SUM(fee) rev
        FROM results_check_requests WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_afa AS (
        SELECT date_trunc('day', created_at)::date d, SUM(amount) rev
        FROM afa_orders WHERE status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    daily_payout AS (
        SELECT date_trunc('day', created_at)::date d, SUM(profit_amount) payout
        FROM shop_profits WHERE status = 'credited' AND created_at >= v_start GROUP BY 1
    ),
    daily_supplier_cost AS (
        SELECT date_trunc('day', created_at)::date d,
            SUM(volume_gb * CASE network
                WHEN 'MTN' THEN v_cost_mtn
                WHEN 'Telecel' THEN v_cost_telecel
                WHEN 'AT - iShare' THEN v_cost_at_ishare
                WHEN 'AT - BigTime' THEN v_cost_at_bigtime
                ELSE 0
            END) cost
        FROM shop_orders WHERE payment_status = 'completed' AND created_at >= v_start GROUP BY 1
    ),
    combined AS (
        SELECT
            days.d,
            COALESCE(daily_shop.rev, 0) + COALESCE(daily_airtime.rev, 0) + COALESCE(daily_rc.rev, 0) + COALESCE(daily_rcs.rev, 0) + COALESCE(daily_afa.rev, 0) AS revenue,
            COALESCE(daily_payout.payout, 0) AS payout,
            COALESCE(daily_supplier_cost.cost, 0) AS supplier_cost
        FROM days
        LEFT JOIN daily_shop ON daily_shop.d = days.d
        LEFT JOIN daily_airtime ON daily_airtime.d = days.d
        LEFT JOIN daily_rc ON daily_rc.d = days.d
        LEFT JOIN daily_rcs ON daily_rcs.d = days.d
        LEFT JOIN daily_afa ON daily_afa.d = days.d
        LEFT JOIN daily_payout ON daily_payout.d = days.d
        LEFT JOIN daily_supplier_cost ON daily_supplier_cost.d = days.d
    )
    SELECT json_agg(json_build_object(
        'date', to_char(d, 'YYYY-MM-DD'),
        'revenue', revenue,
        'profit', revenue - payout - supplier_cost
    ) ORDER BY d)
    INTO v_chart_series
    FROM combined;

    SELECT json_build_object(
        'range', p_range,
        'rangeRevenue', v_range_revenue,
        'rangeRevenuePrevious', v_prev_revenue,
        'rangeProfit', v_range_profit,
        'rangeOrders', v_range_total_orders,
        'rangeCompletedOrders', v_range_completed_orders,
        'rangeSuccessRate', CASE WHEN v_range_total_orders > 0 THEN ROUND((v_range_completed_orders::numeric / v_range_total_orders) * 100, 1) ELSE 0 END,
        'todayOrders', v_today_orders,
        'floatBalance', v_float_balance,
        'debtorsTotal', v_debtors_total,
        'debtorsCount', v_debtors_count,
        'complaintsPending', v_complaints_pending,
        'afaPending', v_afa_pending,
        'agentsExpiring', v_agents_expiring,
        'pendingShops', v_pending_shops,
        'actionsTotal', v_complaints_pending + v_afa_pending + v_agents_expiring + v_pending_shops + v_debtors_count,
        'chartSeries', COALESCE(v_chart_series, '[]'::json)
    ) INTO v_result;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
