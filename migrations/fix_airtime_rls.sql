-- Disable RLS temporarily to debug visibility
ALTER TABLE public.airtime_orders DISABLE ROW LEVEL SECURITY;

-- Ensure join works by adding a foreign key to public.users if it doesn't exist
-- (user_id already references auth.users, but PostgREST needs a link to public.users for the join)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'airtime_orders_user_id_fkey_public'
    ) THEN
        ALTER TABLE public.airtime_orders 
        ADD CONSTRAINT airtime_orders_user_id_fkey_public 
        FOREIGN KEY (user_id) REFERENCES public.users(id);
    END IF;
END $$;
