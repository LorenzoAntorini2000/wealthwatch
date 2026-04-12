// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { getUserSecret } from "../_shared/getUserSecret.ts";

const ENABLE_BANKING_API = "https://api.enablebanking.com";

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  // 1. Verify Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError(401, "Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return jsonError(401, "Invalid or expired session");
  }

  // 2. Read per-user Enable Banking credentials from Vault
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const appId = await getUserSecret(adminClient, user.id, "enable_banking_app_id");
  const privateKeyPem = await getUserSecret(adminClient, user.id, "enable_banking_private_key");
  if (!appId || !privateKeyPem) {
    return jsonError(400, "Enable Banking credentials not configured. Please add them in Settings.");
  }

  // Client for DB operations — uses user JWT so RLS (user_id = auth.uid()) works
  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );

  // Route on action field in request body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const action = body.action as string | undefined;
  if (action === "start") {
    return await handleStart(body, appId, privateKeyPem);
  } else if (action === "finish") {
    return await handleFinish(body, user.id, appId, privateKeyPem, supabaseUser);
  }
  return jsonError(400, 'Missing or invalid action (expected "start" or "finish")');
});

// ---------------------------------------------------------------------------
// Route A: POST /bank-connect/start
// ---------------------------------------------------------------------------

async function handleStart(
  body: Record<string, unknown>,
  appId: string,
  privateKeyPem: string,
): Promise<Response> {
  const { bank_name, account_id, country = "IT" } = body as {
    bank_name: string;
    account_id: string;
    country?: string;
  };
  if (!bank_name || !account_id) {
    return jsonError(400, "Missing bank_name or account_id");
  }

  const redirectUrl = Deno.env.get("BANK_REDIRECT_URL");
  if (!redirectUrl) {
    return jsonError(500, "Server misconfiguration: missing BANK_REDIRECT_URL");
  }

  let ebJwt: string;
  try {
    ebJwt = await buildEnableBankingJwt(appId, privateKeyPem);
  } catch (e) {
    console.error("JWT build error:", e);
    return jsonError(500, "Failed to build Enable Banking JWT");
  }

  // Find the ASPSP matching the given bank name
  let aspspRes: Response;
  try {
    aspspRes = await fetch(`${ENABLE_BANKING_API}/aspsps?country=${country}`, {
      headers: { Authorization: `Bearer ${ebJwt}` },
    });
  } catch {
    return jsonError(502, "Failed to reach Enable Banking API");
  }

  if (!aspspRes.ok) {
    console.error("ASPSP lookup failed:", aspspRes.status, await aspspRes.text());
    return jsonError(502, "Enable Banking ASPSP lookup failed");
  }

  const aspspData = await aspspRes.json();
  // The API may return { aspsps: [...] } or a bare array
  const aspspList: Array<{ name: string; country: string }> =
    aspspData.aspsps ?? aspspData ?? [];

  // Exact match first, then partial
  const aspsp =
    aspspList.find((a) => a.name.toLowerCase() === bank_name.toLowerCase()) ??
    aspspList.find((a) => a.name.toLowerCase().includes(bank_name.toLowerCase()));

  if (!aspsp) {
    const available = aspspList.map((a) => a.name);
    console.error("Bank not found:", bank_name, "| Available:", JSON.stringify(available));
    return jsonError(404, `Bank not found: ${bank_name}. Available: ${available.join(", ")}`);
  }

  // POST to Enable Banking to start the consent session
  console.log("Matched ASPSP:", JSON.stringify(aspsp));
  const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  let authRes: Response;
  try {
    authRes = await fetch(`${ENABLE_BANKING_API}/auth`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ebJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        aspsp: { name: aspsp.name, country: aspsp.country },
        state: account_id,       // used to correlate the redirect callback
        redirect_url: redirectUrl,
        psu_type: "personal",
        access: { valid_until: validUntil, balances: true, transactions: true },
      }),
    });
  } catch {
    return jsonError(502, "Failed to reach Enable Banking API");
  }

  if (!authRes.ok) {
    console.error("Auth start failed:", authRes.status, await authRes.text());
    return jsonError(502, "Enable Banking auth start failed");
  }

  const authData = await authRes.json();
  console.log("Auth start response:", JSON.stringify(authData));
  const auth_url: string = authData.url;
  const session_id: string = authData.authorization_id;

  if (!auth_url || !session_id) {
    console.error("Unexpected Enable Banking /auth response:", authData);
    return jsonError(502, "Unexpected Enable Banking response");
  }

  return jsonOk({ auth_url, session_id });
}

// ---------------------------------------------------------------------------
// Route B: POST /bank-connect/finish
// ---------------------------------------------------------------------------

async function handleFinish(
  body: Record<string, unknown>,
  userId: string,
  appId: string,
  privateKeyPem: string,
  supabase: ReturnType<typeof createClient>,
): Promise<Response> {
  const { code, session_id, account_id, bank_name = "", country = "IT" } = body as {
    code: string;
    session_id: string;
    account_id: string;
    bank_name?: string;
    country?: string;
  };
  if (!code || !session_id || !account_id) {
    return jsonError(400, "Missing code, session_id, or account_id");
  }

  let ebJwt: string;
  try {
    ebJwt = await buildEnableBankingJwt(appId, privateKeyPem);
  } catch (e) {
    console.error("JWT build error:", e);
    return jsonError(500, "Failed to build Enable Banking JWT");
  }

  // Exchange the authorisation code for account UIDs
  let finishRes: Response;
  try {
    finishRes = await fetch(`${ENABLE_BANKING_API}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ebJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code, auth_id: session_id }),
    });
  } catch {
    return jsonError(502, "Failed to reach Enable Banking API");
  }

  if (!finishRes.ok) {
    console.error("Auth finish failed:", finishRes.status, await finishRes.text());
    return jsonError(502, "Enable Banking auth finish failed");
  }

  const finishData = await finishRes.json();
  console.log("Auth finish response:", JSON.stringify(finishData));
  const allAccounts: Array<Record<string, unknown>> = finishData.accounts ?? finishData.account_ids ?? [];
  // Filter out accounts without a uid (e.g. cards returned by some banks)
  const accounts = allAccounts.filter((acc) => acc.uid);
  console.log(`Accounts: ${allAccounts.length} total, ${accounts.length} with uid`);
  const consentExpiresAt: string | null = finishData.access?.valid_until ?? null;

  if (accounts.length === 0) {
    return jsonError(502, "No linkable accounts returned from Enable Banking (no uid)");
  }

  // Remove any previous connections for this account (e.g. expired/error rows)
  // so that find() in the frontend always returns the fresh active connection.
  const { error: deleteError } = await supabase
    .from("bank_connections")
    .delete()
    .eq("user_id", userId)
    .eq("account_id", account_id);

  if (deleteError) {
    console.error("DB delete error:", deleteError);
    return jsonError(500, "Failed to clear old bank connection");
  }

  // Insert one row per account UID returned by Enable Banking
  const rows = accounts.map((acc) => ({
    user_id: userId,
    account_id,
    eb_session_id: session_id,
    eb_account_uid: acc.uid,
    bank_name,
    country,
    consent_expires_at: consentExpiresAt,
    status: "active",
  }));

  const { error: insertError } = await supabase
    .from("bank_connections")
    .insert(rows);

  if (insertError) {
    console.error("DB insert error:", insertError);
    return jsonError(500, "Failed to save bank connection");
  }

  return jsonOk({ linked_accounts: rows.length });
}

// ---------------------------------------------------------------------------
// Helper: build a signed RS256 JWT for Enable Banking
// ---------------------------------------------------------------------------

async function buildEnableBankingJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
  // Strip PEM header/footer and whitespace, then base64-decode to DER bytes
  const pemContents = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");

  const derBuffer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    derBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const headerB64 = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: appId }));
  const payloadB64 = b64url(
    JSON.stringify({ iss: appId, aud: "api.enablebanking.com", iat: now, exp: now + 3600 }),
  );
  const signingInput = `${headerB64}.${payloadB64}`;

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlBuf(signatureBuffer)}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function b64url(str: string): string {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function b64urlBuf(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
