-- Step 1: user-level secrets stored encrypted via Supabase Vault
-- The `value` column stores a Vault secret ID (uuid); plaintext never touches this table.
-- Retrieval: JOIN against vault.decrypted_secrets on id = value.

-- Enable the Vault extension (no-op if already active)
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- ─── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE user_secrets (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key        text        NOT NULL,
  value      uuid        NOT NULL,   -- vault.decrypted_secrets.id
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE user_secrets ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own rows.
-- The service role bypasses RLS, allowing daily-snapshot to read any user's secrets.
CREATE POLICY "Users manage their own secrets"
  ON user_secrets FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Upsert helper (called via supabase.rpc() from the browser) ───────────────
-- SECURITY DEFINER so it can call vault functions that are otherwise restricted.
-- The key whitelist prevents arbitrary keys from being stored.

CREATE OR REPLACE FUNCTION upsert_user_secret(p_key text, p_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_user_id  uuid := auth.uid();
  v_vault_id uuid;
  v_allowed  text[] := ARRAY[
    'enable_banking_app_id',
    'enable_banking_private_key',
    'cryptocom_api_key',
    'cryptocom_secret',
    'ibkr_flex_token',
    'ibkr_flex_query_id'
  ];
BEGIN
  -- Auth guard
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Key whitelist
  IF p_key != ALL(v_allowed) THEN
    RAISE EXCEPTION 'Unknown secret key: %', p_key;
  END IF;

  -- Check whether a vault secret already exists for this user+key
  SELECT value INTO v_vault_id
  FROM user_secrets
  WHERE user_id = v_user_id AND key = p_key;

  IF v_vault_id IS NOT NULL THEN
    -- Update the existing vault secret in-place (the UUID stays the same)
    PERFORM vault.update_secret(v_vault_id, p_value);

    UPDATE user_secrets
    SET updated_at = now()
    WHERE user_id = v_user_id AND key = p_key;
  ELSE
    -- Create a new vault secret and record its ID
    v_vault_id := vault.create_secret(
      p_value,
      v_user_id::text || '/' || p_key   -- human-readable name in Vault
    );

    INSERT INTO user_secrets (user_id, key, value)
    VALUES (v_user_id, p_key, v_vault_id);
  END IF;
END;
$$;

-- Only authenticated users should be able to call this function
REVOKE ALL ON FUNCTION upsert_user_secret(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_user_secret(text, text) TO authenticated;

-- ─── Status helper (returns configured/not-set per key, never the value) ──────

CREATE OR REPLACE FUNCTION get_user_secret_status()
RETURNS TABLE (key text, is_configured boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    k.key,
    (us.user_id IS NOT NULL) AS is_configured
  FROM (
    VALUES
      ('enable_banking_app_id'),
      ('enable_banking_private_key'),
      ('cryptocom_api_key'),
      ('cryptocom_secret'),
      ('ibkr_flex_token'),
      ('ibkr_flex_query_id')
  ) AS k(key)
  LEFT JOIN user_secrets us
    ON us.user_id = auth.uid() AND us.key = k.key;
$$;

REVOKE ALL ON FUNCTION get_user_secret_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_secret_status() TO authenticated;

-- ─── Decrypted view (used by getUserSecret() helper in Edge Functions) ────────
-- Joins user_secrets against vault.decrypted_secrets so Edge Functions can
-- retrieve plaintext values with a simple .from("user_secrets_decrypted") query.
-- Not exposed to the browser (no RLS policy grants SELECT to authenticated).

CREATE VIEW user_secrets_decrypted
WITH (security_invoker = true)   -- runs as the calling role, so RLS is respected
AS
  SELECT
    us.user_id,
    us.key,
    ds.decrypted_secret AS decrypted_value,
    us.updated_at
  FROM user_secrets us
  JOIN vault.decrypted_secrets ds ON ds.id = us.value;

-- Allow the service role (used by Edge Functions) to query the view.
-- Authenticated users do NOT get SELECT on this view; they use get_user_secret_status() instead.
GRANT SELECT ON user_secrets_decrypted TO service_role;
