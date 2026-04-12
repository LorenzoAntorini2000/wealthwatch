import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Retrieve a per-user secret stored in the Vault-backed `user_secrets` table.
 *
 * @param client  A Supabase client.  Must be a **service-role** client when
 *                reading on behalf of another user (e.g. from daily-snapshot),
 *                or a user-JWT client when reading for the authenticated user.
 * @param userId  The UUID of the user whose secret is requested.
 * @param key     One of the six allowed key names (e.g. "cryptocom_api_key").
 * @returns       The plaintext secret value, or `null` if not configured.
 */
export async function getUserSecret(
  client: SupabaseClient,
  userId: string,
  key: string,
): Promise<string | null> {
  const { data, error } = await client.rpc("get_decrypted_secret", {
    p_user_id: userId,
    p_key: key,
  });

  if (error) {
    console.error(`getUserSecret(${key}):`, error.message);
    return null;
  }

  return (data as string) ?? null;
}
