DO $$ 
BEGIN 
    -- Add is_flagged column to airtime_orders
    IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'airtime_orders' AND COLUMN_NAME = 'is_flagged') THEN
        ALTER TABLE airtime_orders ADD COLUMN is_flagged BOOLEAN DEFAULT false;
    END IF;
END $$;
