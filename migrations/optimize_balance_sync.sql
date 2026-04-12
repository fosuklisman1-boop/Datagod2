-- Optimized balance breakdown RPC
-- This replaces the heavy "fetch-all" logic in JS with a single SQL aggregation.

CREATE OR REPLACE FUNCTION get_shop_balance_breakdown(p_shop_id UUID)
RETURNS JSON AS $$
DECLARE
    v_result JSON;
BEGIN
    SELECT json_build_object(
        'total_p', COALESCE(SUM(profit_amount), 0),
        'credited_p', COALESCE(SUM(CASE WHEN status = 'credited' THEN profit_amount ELSE 0 END), 0),
        'withdrawn_p', COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN profit_amount ELSE 0 END), 0),
        'total_w', (
            SELECT COALESCE(SUM(amount), 0) 
            FROM withdrawal_requests 
            WHERE shop_id = p_shop_id 
              AND status IN ('approved', 'completed')
        )
    ) INTO v_result
    FROM shop_profits
    WHERE shop_id = p_shop_id;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
