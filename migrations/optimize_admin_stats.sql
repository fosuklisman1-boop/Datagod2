-- Migration to optimize remaining high-latency admin paths

-- 1. Optimized Admin Dashboard Stats (v2)
-- Includes Airtime statistics and performance improvements
CREATE OR REPLACE FUNCTION get_admin_dashboard_stats_v2()
RETURNS JSON AS $$
DECLARE
    v_stats JSON;
    v_airtime_count BIGINT;
    v_airtime_revenue NUMERIC;
    v_airtime_completed BIGINT;
    v_total_orders BIGINT;
    v_completed_orders BIGINT;
    v_total_revenue NUMERIC;
BEGIN
    -- Get airtime stats
    SELECT 
        COUNT(*),
        COALESCE(SUM(CASE WHEN status = 'completed' THEN total_paid ELSE 0 END), 0),
        COUNT(*) FILTER (WHERE status = 'completed')
    INTO v_airtime_count, v_airtime_revenue, v_airtime_completed
    FROM airtime_orders;

    -- Get shop orders stats
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE order_status = 'completed' OR order_status = 'delivered'),
        COALESCE(SUM(total_price), 0)
    INTO v_total_orders, v_completed_orders, v_total_revenue
    FROM shop_orders;

    SELECT json_build_object(
        'totalUsers', (SELECT COUNT(*) FROM users),
        'totalShops', (SELECT COUNT(*) FROM user_shops),
        'totalSubAgents', (SELECT COUNT(*) FROM user_shops WHERE parent_shop_id IS NOT NULL),
        'totalOrders', v_total_orders,
        'totalRevenue', v_total_revenue,
        'pendingShops', (SELECT COUNT(*) FROM user_shops WHERE is_active = false),
        'completedOrders', v_completed_orders,
        'totalWalletBalance', (SELECT COALESCE(SUM(balance), 0) FROM wallets),
        'totalProfitBalance', (SELECT COALESCE(SUM(available_balance), 0) FROM shop_available_balance),
        'airtimeTotalOrders', v_airtime_count,
        'airtimeRevenue', v_airtime_revenue,
        'airtimeCompletedOrders', v_airtime_completed
    ) INTO v_stats;

    RETURN v_stats;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. User Financial Summary RPC
-- Aggregates user stats directly on the database to avoid fetching thousands of records
CREATE OR REPLACE FUNCTION get_user_financial_summary(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
    v_wallet_balance NUMERIC;
    v_total_topups NUMERIC;
    v_total_spent NUMERIC;
    v_transaction_count BIGINT;
    v_orders_total BIGINT;
    v_orders_completed BIGINT;
    v_orders_failed BIGINT;
    v_shop_id UUID;
    v_shop_stats JSON := NULL;
    v_withdrawals_summary JSON;
    v_withdrawal_history JSON;
BEGIN
    -- Wallet stats
    SELECT balance INTO v_wallet_balance FROM wallets WHERE user_id = p_user_id;
    
    -- Transaction aggregation
    SELECT 
        COALESCE(SUM(CASE WHEN type = 'credit' AND source = 'wallet_topup' AND status = 'completed' THEN amount ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN type = 'debit' AND status IN ('completed', 'success') THEN ABS(amount) ELSE 0 END), 0),
        COUNT(*)
    INTO v_total_topups, v_total_spent, v_transaction_count
    FROM transactions 
    WHERE user_id = p_user_id;

    -- Order counts (from the main orders table)
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status IN ('completed', 'delivered' , 'success')),
        COUNT(*) FILTER (WHERE status = 'failed')
    INTO v_orders_total, v_orders_completed, v_orders_failed
    FROM orders 
    WHERE user_id = p_user_id;

    -- Shop Stats if user owns a shop
    SELECT id INTO v_shop_id FROM user_shops WHERE user_id = p_user_id;
    
    IF v_shop_id IS NOT NULL THEN
        SELECT json_build_object(
            'shopId', s.id,
            'shopName', s.shop_name,
            'shopSlug', s.shop_slug,
            'createdAt', s.created_at,
            'totalOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id),
            'paidOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id AND payment_status = 'completed'),
            'completedOrders', (SELECT COUNT(*) FROM shop_orders WHERE shop_id = v_shop_id AND (order_status = 'completed' OR order_status = 'delivered')),
            'totalSales', (SELECT COALESCE(SUM(total_price), 0) FROM shop_orders WHERE shop_id = v_shop_id AND payment_status = 'completed'),
            'availableBalance', COALESCE(b.available_balance, 0),
            'withdrawnAmount', COALESCE(b.withdrawn_profit, 0),
            'totalProfit', COALESCE(b.total_profit, 0),
            'pendingProfit', COALESCE(b.pending_profit, 0),
            'creditedProfit', COALESCE(b.credited_profit, 0),
            'profitRecords', (SELECT COUNT(*) FROM shop_profits WHERE shop_id = v_shop_id)
        ) INTO v_shop_stats
        FROM user_shops s
        LEFT JOIN shop_available_balance b ON s.id = b.shop_id
        WHERE s.id = v_shop_id;
    END IF;

    -- Recent withdrawal history (last 10 for quick view)
    SELECT json_agg(t) INTO v_withdrawal_history FROM (
        SELECT 
            id, amount, fee_amount as "feeAmount", net_amount as "netAmount", 
            status, withdrawal_method as method, created_at as "createdAt", reference_code as "referenceCode"
        FROM withdrawal_requests
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 10
    ) t;

    -- Withdrawals summary
    SELECT json_build_object(
        'totalWithdrawn', COALESCE(SUM(CASE WHEN status IN ('completed', 'approved') THEN net_amount ELSE 0 END), 0),
        'pendingCount', COUNT(*) FILTER (WHERE status = 'pending'),
        'completedCount', COUNT(*) FILTER (WHERE status IN ('completed', 'approved')),
        'history', COALESCE(v_withdrawal_history, '[]'::json)
    ) INTO v_withdrawals_summary
    FROM withdrawal_requests
    WHERE user_id = p_user_id;

    RETURN json_build_object(
        'userId', p_user_id,
        'wallet', json_build_object(
            'balance', COALESCE(v_wallet_balance, 0),
            'totalTopUps', v_total_topups,
            'totalSpent', v_total_spent,
            'transactionCount', v_transaction_count
        ),
        'orders', json_build_object(
            'total', v_orders_total,
            'completed', v_orders_completed,
            'failed', v_orders_failed,
            'pending', (v_orders_total - v_orders_completed - v_orders_failed)
        ),
        'shop', v_shop_stats,
        'withdrawals', v_withdrawals_summary
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
