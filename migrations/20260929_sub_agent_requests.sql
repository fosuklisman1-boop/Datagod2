-- Customer-initiated "become a sub-agent" request queue. The existing
-- shop_invites flow is owner-initiated only (owner generates a code and
-- shares it); this adds the missing direction: a storefront visitor submits
-- a request, the shop owner approves/rejects it from their dashboard, and
-- approval generates a real shop_invites row (same accept flow as today,
-- reused rather than duplicated).
--
-- No anon/authenticated grants -- every read/write goes through service-role
-- API routes (app/api/shop/sub-agent-requests/*), same pattern the rest of
-- this session's guest-facing features use, avoiding the anon column-grant
-- pitfall hit earlier today.
CREATE TABLE IF NOT EXISTS sub_agent_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id UUID NOT NULL REFERENCES user_shops(id) ON DELETE CASCADE,
  requester_name TEXT NOT NULL,
  requester_phone TEXT NOT NULL,
  requester_email TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  invite_id UUID REFERENCES shop_invites(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sub_agent_requests_shop_status ON sub_agent_requests(shop_id, status);

ALTER TABLE sub_agent_requests ENABLE ROW LEVEL SECURITY;
-- No policies -- service-role only, matching the "no anon/authenticated
-- grants" comment above. Postgres denies all access by default once RLS is
-- enabled with zero policies, for every role except service_role (which
-- bypasses RLS entirely).
