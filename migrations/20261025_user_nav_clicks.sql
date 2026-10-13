-- Sidebar "NEW" tag click counts, stored on the user's account so a cleared tag
-- stays cleared on every device. A tag shows at 0 and 1 clicks; the 2nd click
-- clears it (clicks capped at 2). Registry of tagged hrefs: lib/nav-new.ts.
-- Read/written only by /api/user/nav-new via the service-role client.
-- Service-role only: RLS on with no policies, all privileges revoked from public roles
-- (migration 0060 grants authenticated CRUD on all tables by default, hence the REVOKE).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS user_nav_clicks (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  href       TEXT        NOT NULL CHECK (char_length(href) BETWEEN 1 AND 200),
  clicks     INT         NOT NULL DEFAULT 0 CHECK (clicks BETWEEN 0 AND 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, href)
);

ALTER TABLE user_nav_clicks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE user_nav_clicks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE user_nav_clicks TO service_role;

-- Atomic increment, capped at 2. Returns the new count.
CREATE OR REPLACE FUNCTION nav_click(p_user_id UUID, p_href TEXT)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO user_nav_clicks AS u (user_id, href, clicks, updated_at)
  VALUES (p_user_id, p_href, 1, now())
  ON CONFLICT (user_id, href) DO UPDATE
    SET clicks = LEAST(2, u.clicks + 1), updated_at = now()
  RETURNING u.clicks;
$$;

REVOKE ALL ON FUNCTION nav_click(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION nav_click(UUID, TEXT) TO service_role;

COMMIT;
