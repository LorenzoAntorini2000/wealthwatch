// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { getUserSecret } from "../_shared/getUserSecret.ts";

const FLEX_SEND_REQUEST_URL =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";

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
  console.log("[ibkr] authHeader present:", !!authHeader);
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[ibkr] missing/invalid auth header");
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
    console.log("[ibkr] service-role call for user:", userId);
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
    console.log("[ibkr] getUser result — user:", !!user, "error:", authError?.message);
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

  // 2. Read per-user IBKR Flex credentials from Vault
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey,
    { auth: { persistSession: false } },
  );
  const flexToken = await getUserSecret(adminClient, userId, "ibkr_flex_token");
  const queryId = await getUserSecret(adminClient, userId, "ibkr_flex_query_id");
  if (!flexToken || !queryId) {
    return jsonError(400, "IBKR credentials not configured. Please add them in Settings.");
  }

  // 3. Load active IBKR connections for this user
  const { data: connections, error: connError } = await supabaseUser
    .from("ibkr_connections")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");

  if (connError) {
    console.error("Failed to load ibkr_connections:", connError);
    return jsonError(500, "Failed to load IBKR connections");
  }

  if (!connections || connections.length === 0) {
    return jsonOk({ updated: 0, errors: 0, results: [] });
  }

  // 4. Step A — request Flex report generation
  let referenceCode: string;
  let retrievalUrl: string;
  try {
    const sendUrl = `${FLEX_SEND_REQUEST_URL}?t=${flexToken}&q=${queryId}&v=3`;
    const sendRes = await fetch(sendUrl, {
      headers: { "User-Agent": "Deno/2.0" },
    });

    if (!sendRes.ok) {
      console.error("IBKR SendRequest non-2xx:", sendRes.status, await sendRes.text());
      return jsonError(502, "IBKR token invalid");
    }

    const sendXml = await sendRes.text();
    console.log("IBKR SendRequest response:", sendXml);

    const status = sendXml.match(/<Status>(.*?)<\/Status>/)?.[1]?.trim();
    if (status !== "Success") {
      console.error("IBKR SendRequest status:", status);
      return jsonError(502, "IBKR token invalid");
    }

    referenceCode = sendXml.match(/<ReferenceCode>(.*?)<\/ReferenceCode>/)?.[1]?.trim() ?? "";
    retrievalUrl = sendXml.match(/<Url>(.*?)<\/Url>/)?.[1]?.trim() ?? "";

    if (!referenceCode || !retrievalUrl) {
      console.error("IBKR SendRequest missing ReferenceCode or Url in:", sendXml);
      return jsonError(502, "IBKR response parse error");
    }
  } catch (e) {
    console.error("IBKR SendRequest error:", e);
    return jsonError(502, "IBKR response parse error");
  }

  // 5. Wait ~2 seconds for the report to be generated
  await delay(2000);

  // 6. Step B — retrieve the Flex report (up to 3 retries with 3-second gaps)
  let statementXml: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await delay(3000);

    try {
      const getUrl = `${retrievalUrl}?t=${flexToken}&q=${referenceCode}&v=3`;
      const getRes = await fetch(getUrl, {
        headers: { "User-Agent": "Deno/2.0" },
      });

      if (!getRes.ok) {
        console.error(`IBKR GetStatement attempt ${attempt + 1} non-2xx:`, getRes.status);
        continue;
      }

      const xml = await getRes.text();
      console.log(`IBKR GetStatement attempt ${attempt + 1}:`, xml.slice(0, 300));

      // Check if still processing
      const statusMatch = xml.match(/<Status>(.*?)<\/Status>/);
      if (statusMatch && statusMatch[1].toLowerCase().includes("generat")) {
        console.log("IBKR report still generating, retrying...");
        continue;
      }

      statementXml = xml;
      break;
    } catch (e) {
      console.error(`IBKR GetStatement attempt ${attempt + 1} error:`, e);
    }
  }

  if (!statementXml) {
    return jsonError(502, "IBKR report timeout");
  }

  // 7. Parse XML — extract total NAV from EquitySummaryByReportDateInBase
  let navValue: number | null = null;

  // Primary: EquitySummaryByReportDateInBase total="..." attribute
  const equityMatch = statementXml.match(/<EquitySummaryByReportDateInBase[^>]*\stotal="([^"]+)"/);
  if (equityMatch) {
    navValue = parseFloat(equityMatch[1]);
  }

  // Fallback: NetAssetValue total="..." attribute
  if (navValue === null || isNaN(navValue)) {
    const navMatch = statementXml.match(/<NetAssetValue[^>]*\stotal="([^"]+)"/);
    if (navMatch) {
      navValue = parseFloat(navMatch[1]);
    }
  }

  if (navValue === null || isNaN(navValue)) {
    console.error("Could not extract NAV from statement XML:", statementXml.slice(0, 500));
    return jsonError(502, "IBKR response parse error");
  }

  // 8 & 9. Update accounts.balance and ibkr_connections.last_synced_at
  // Per spec D1: single IBKR account only — use the first connection
  const conn = connections[0];
  let updated = 0;
  let errors = 0;
  const results: Array<{ account_id: string; balance: number; currency: string }> = [];

  const { error: updateErr } = await supabaseUser
    .from("accounts")
    .update({ balance: navValue })
    .eq("id", conn.account_id);

  if (updateErr) {
    console.error("Failed to update account balance:", updateErr);
    errors++;
  } else {
    await supabaseUser
      .from("ibkr_connections")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", conn.id);

    results.push({ account_id: conn.account_id, balance: navValue, currency: "EUR" });
    updated++;
  }

  // 10. Return result
  return jsonOk({ updated, errors, results });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
