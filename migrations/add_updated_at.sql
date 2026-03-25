-- Ensure the updated_at column exists in airtime_orders
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'airtime_orders' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE public.airtime_orders ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
    END IF;
END $$;
