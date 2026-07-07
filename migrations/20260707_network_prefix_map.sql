-- Admin-editable network prefix map. Seeds the canonical table (053 IS MTN)
-- and redefines gh_is_mtn to read it (STABLE, hardcoded fallback), so order
-- validation (TS) and registry classification (SQL capture trigger) always
-- agree — an admin-added prefix takes effect in both at once.

INSERT INTO admin_settings (key, value, description)
VALUES (
  'network_prefix_map',
  '{"MTN":["24","25","53","54","55","59"],"TELECEL":["20","50"],"AT":["26","27","56","57"]}'::jsonb,
  'Significant 2-digit prefix -> network map. Drives order-time prefix validation (TS) and gh_is_mtn (SQL). Admin-editable via /api/admin/settings/network-prefixes.'
)
ON CONFLICT (key) DO NOTHING;

-- gh_is_mtn: was IMMUTABLE with a hardcoded list; now STABLE reading the map.
-- Fallback chain: no settings row -> NULL -> hardcoded; empty MTN list -> NULLIF -> hardcoded.
CREATE OR REPLACE FUNCTION gh_is_mtn(raw text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    substring(normalize_gh_phone(raw) FROM 2 FOR 2) = ANY (
      COALESCE(
        NULLIF(
          (SELECT array(SELECT jsonb_array_elements_text(value->'MTN'))
             FROM admin_settings WHERE key = 'network_prefix_map'),
          '{}'::text[]
        ),
        ARRAY['24','25','53','54','55','59']
      )
    ),
    false
  );
$$;
REVOKE ALL ON FUNCTION gh_is_mtn(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION gh_is_mtn(text) TO service_role;
