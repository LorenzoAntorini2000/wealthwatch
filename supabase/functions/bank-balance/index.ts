// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

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

  // 1. Verify caller: accept a user JWT or the service-role key (from daily-snapshot)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError(401, "Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const isServiceRole = token === serviceRoleKey;

  let userId: string;
  let supabaseUser: ReturnType<typeof createClient>;

  if (isServiceRole) {
    // Called server-side: user_id must be provided in the request body
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    if (!body.user_id || typeof body.user_id !== "string") {
      return jsonError(400, "user_id is required when calling with service-role key");
    }
    userId = body.user_id;
    supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      serviceRoleKey,
      { auth: { persistSession: false } },
    );
  } else {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return jsonError(401, "Invalid or expired session");
    }
    userId = user.id;
    supabaseUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
  }

  // 2. Read Enable Banking secrets
  const appId = Deno.env.get("ENABLE_BANKING_APP_ID");
  const privateKeyPem = Deno.env.get("ENABLE_BANKING_PRIVATE_KEY");
  if (!appId || !privateKeyPem) {
    return jsonError(500, "Server misconfiguration: missing Enable Banking credentials");
  }

  // 3. Load active bank connections for this user
  const { data: connections, error: connError } = await supabaseUser
    .from("bank_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  if (connError) {
    console.error("Failed to load bank_connections:", connError);
    return jsonError(500, "Failed to load bank connections");
  }

  if (!connections || connections.length === 0) {
    return jsonOk({ updated: 0, errors: 0, results: [] });
  }

  // 4. Build Enable Banking JWT (one token, valid for all calls below)
  let ebJwt: string;
  try {
    ebJwt = await buildEnableBankingJwt(appId, privateKeyPem);
  } catch (e) {
    console.error("JWT build error:", e);
    return jsonError(500, "Failed to build Enable Banking JWT");
  }

  // 5. Fetch balance for each connection
  let updated = 0;
  let errors = 0;
  const results: Array<{
    account_id: string;
    balance: number;
    currency: string;
    bank_name: string;
  }> = [];

  for (const conn of connections) {
    try {
      const balRes = await fetch(
        `${ENABLE_BANKING_API}/accounts/${conn.eb_account_uid}/balances`,
        { headers: { Authorization: `Bearer ${ebJwt}` } },
      );

      if (balRes.status === 401 || balRes.status === 403) {
        console.error(`Session expired for connection ${conn.id}`);
        await supabaseUser
          .from("bank_connections")
          .update({ status: "expired" })
          .eq("id", conn.id);
        errors++;
        continue;
      }

      if (!balRes.ok) {
        console.error(`Balance fetch failed for ${conn.id}:`, balRes.status, await balRes.text());
        errors++;
        continue;
      }

      const balData = await balRes.json();
      const balances: Array<{ balance_amount: { amount: string; currency: string }; balance_type: string }> =
        balData.balances ?? balData ?? [];

      // Pick the most useful balance type for a wealth tracker
      const preferred = ["expected", "interimAvailable", "closingBooked"];
      let picked = null;
      for (const type of preferred) {
        picked = balances.find((b) => b.balance_type === type) ?? null;
        if (picked) break;
      }
      // Fallback: use the first available balance
      if (!picked && balances.length > 0) picked = balances[0];

      if (!picked) {
        console.error(`No balance found for connection ${conn.id}`);
        errors++;
        continue;
      }

      const amount = parseFloat(picked.balance_amount.amount);
      const currency = picked.balance_amount.currency;

      // Update the account balance
      const { error: updateErr } = await supabaseUser
        .from("accounts")
        .update({ balance: amount })
        .eq("id", conn.account_id);

      if (updateErr) {
        console.error(`Failed to update account ${conn.account_id}:`, updateErr);
        errors++;
        continue;
      }

      // Update last_synced_at on the connection
      await supabaseUser
        .from("bank_connections")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", conn.id);

      results.push({
        account_id: conn.account_id,
        balance: amount,
        currency,
        bank_name: conn.bank_name,
      });
      updated++;
    } catch (e) {
      console.error(`Unexpected error for connection ${conn.id}:`, e);
      errors++;
    }
  }

  return jsonOk({ updated, errors, results });
});

// ---------------------------------------------------------------------------
// Helper: build a signed RS256 JWT for Enable Banking
// ---------------------------------------------------------------------------

async function buildEnableBankingJwt(
  appId: string,
  privateKeyPem: string,
): Promise<string> {
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
