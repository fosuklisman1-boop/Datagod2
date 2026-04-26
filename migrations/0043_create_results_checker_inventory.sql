CREATE TABLE IF NOT EXISTS results_checker_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_board TEXT NOT NULL CHECK (exam_board IN ('WAEC', 'BECE', 'NOVDEC')),
  pin TEXT NOT NULL,
  serial_number TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'sold', 'used', 'expired', 'invalid')),
  batch_id TEXT,
  expiry_date DATE,
  reserved_by_order UUID,
  reservation_expires_at TIMESTAMPTZ,
  sold_to_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sold_at TIMESTAMPTZ,
  notes TEXT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(exam_board, pin)
);

-- Partial index: fast lookup of available vouchers per board (used in assignment query)
CREATE INDEX IF NOT EXISTS idx_rci_available
  ON results_checker_inventory(exam_board, created_at ASC)
  WHERE status = 'available';

CREATE INDEX IF NOT EXISTS idx_rci_batch ON results_checker_inventory(batch_id);
CREATE INDEX IF NOT EXISTS idx_rci_reserved_order ON results_checker_inventory(reserved_by_order);

ALTER TABLE results_checker_inventory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rci_service_role_full"
  ON results_checker_inventory FOR ALL TO service_role USING (true);
