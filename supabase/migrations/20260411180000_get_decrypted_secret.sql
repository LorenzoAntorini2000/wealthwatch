-- Replace the PostgREST view (which can't reach vault schema) with an RPC function
-- that runs SECURITY DEFINER so it can join against vault.decrypted_secrets directly.

DROP VIEW IF EXISTS user_secrets_decrypted;

CREATE OR REPLACE FUNCTION get_decrypted_secret(p_user_id uuid, p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT ds.decrypted_secret
  FROM user_secrets us
  JOIN vault.decrypted_secrets ds ON ds.id = us.value
  WHERE us.user_id = p_user_id AND us.key = p_key;
$$;

-- Callable by the service role only (Edge Functions use the service-role key for secret lookups).
-- Authenticated users cannot call this directly, preventing cross-user reads.
REVOKE ALL ON FUNCTION get_decrypted_secret(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_decrypted_secret(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_decrypted_secret(uuid, text) TO service_role;
