-- 0115_hubtel_cs_config_patch.sql
-- Atomic merge into admin_settings['hubtel_cs_config'] so a 4075 auto-pause and an admin save
-- can never overwrite each other (previously both did read-modify-write). ADDITIVE.
-- Top-level keys in p_patch replace; "services" is merged key-by-key.

CREATE OR REPLACE FUNCTION hubtel_cs_config_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  INSERT INTO admin_settings (key, value, description, updated_at)
  VALUES ('hubtel_cs_config', '{}'::jsonb,
          'Hubtel Commission Services: master switch, transport mode, per-service switches, pause state, low-balance threshold.',
          now())
  ON CONFLICT (key) DO NOTHING;

  UPDATE admin_settings
     SET value = (COALESCE(value, '{}'::jsonb) || (p_patch - 'services'))
                 || CASE WHEN p_patch ? 'services'
                         THEN jsonb_build_object('services', COALESCE(value -> 'services', '{}'::jsonb) || (p_patch -> 'services'))
                         ELSE '{}'::jsonb END,
         updated_at = now()
   WHERE key = 'hubtel_cs_config'
  RETURNING value INTO v;

  RETURN v;
END;
$$;

REVOKE ALL ON FUNCTION hubtel_cs_config_patch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hubtel_cs_config_patch(jsonb) TO service_role;
