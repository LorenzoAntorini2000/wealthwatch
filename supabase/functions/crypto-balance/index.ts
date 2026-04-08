// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const CRYPTOCOM_API_URL =
  "https://api.crypto.com/exchange/v1/private/user-balance";
const FRANKFURTER_URL =
  "https://api.frankfurter.app/latest?from=USD&to=EUR";

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
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonError(401, "Missing or invalid Authorization header");
  }
  const token = authHeader.slice(7);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(
    token,
  );
  if (authError || !user) {
    return jsonError(401, "Invalid or expired session");
  }

  // 2. Read API credentials from environment secrets
  const apiKey = Deno.env.get("CRYPTOCOM_API_KEY");
  const secret = Deno.env.get("CRYPTOCOM_SECRET");
  if (!apiKey || !secret) {
    return jsonError(500, "Server misconfiguration: missing API credentials");
  }

  // 3. Build Crypto.com request body
  const nonce = Date.now();
  const id = nonce;
  const method = "private/user-balance";
  const params: Record<string, unknown> = {};

  // 4. Compute HMAC-SHA256 signature
  // params_string = sorted key-value pairs concatenated (empty string when params is {})
  // sig_payload = method + id + api_key + params_string + nonce
  const paramsStr = Object.keys(params).sort().map(k => k + params[k]).join("");
  const sigPayload = method + id + apiKey + paramsStr + nonce;
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(sigPayload),
  );
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 5. POST to Crypto.com API
  let cryptoRes: Response;
  try {
    cryptoRes = await fetch(CRYPTOCOM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        method,
        api_key: apiKey,
        params,
        nonce,
        sig: signature,
      }),
    });
  } catch {
    return jsonError(502, "Failed to reach Crypto.com API");
  }

  if (!cryptoRes.ok) {
    console.error("Crypto.com non-2xx:", cryptoRes.status, await cryptoRes.text());
    return jsonError(502, "Crypto.com API returned a non-2xx status");
  }

  const cryptoData = await cryptoRes.json();
  console.log("Crypto.com code:", cryptoData.code, "msg:", cryptoData.message);
  if (cryptoData.code !== 0) {
    return jsonError(502, "Crypto.com API returned a business error");
  }

  // 6. Sum all position_balances[].market_value to get total USD
  const positionBalances: Array<{ market_value: string | number }> =
    cryptoData?.result?.data?.[0]?.position_balances ?? [];
  const totalUsd = positionBalances.reduce(
    (sum, pos) => sum + parseFloat(String(pos.market_value)),
    0,
  );

  // 7. Fetch live USD → EUR exchange rate
  let eurRate: number;
  try {
    const fxRes = await fetch(FRANKFURTER_URL);
    if (!fxRes.ok) throw new Error("FX fetch failed");
    const fxData = await fxRes.json();
    eurRate = fxData.rates.EUR as number;
  } catch {
    return jsonError(502, "Failed to fetch EUR exchange rate");
  }

  // 8. Convert to EUR and return
  const totalEur = parseFloat((totalUsd * eurRate).toFixed(2));

  return new Response(JSON.stringify({ total_eur: totalEur }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
