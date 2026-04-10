// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

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

  // 2. Read IBKR Flex secrets
  const flexToken = Deno.env.get("IBKR_FLEX_TOKEN");
  const queryId = Deno.env.get("IBKR_FLEX_QUERY_ID");
  if (!flexToken || !queryId) {
    return jsonError(500, "Server misconfiguration: missing IBKR credentials");
  }

  // Client that operates as the user (RLS enforced)
  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );

  // 3. Load active IBKR connections for this user
  const { data: connections, error: connError } = await supabaseUser
    .from("ibkr_connections")
    .select("*")
    .eq("user_id", user.id)
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

    const sendDoc = new DOMParser().parseFromString(sendXml, "text/xml");
    const status = sendDoc.querySelector("Status")?.textContent?.trim();

    if (status !== "Success") {
      console.error("IBKR SendRequest status:", status);
      return jsonError(502, "IBKR token invalid");
    }

    referenceCode = sendDoc.querySelector("ReferenceCode")?.textContent?.trim() ?? "";
    retrievalUrl = sendDoc.querySelector("Url")?.textContent?.trim() ?? "";

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
  try {
    const doc = new DOMParser().parseFromString(statementXml, "text/xml");

    // Primary: EquitySummaryByReportDateInBase total attribute
    const equitySummary = doc.querySelector("EquitySummaryByReportDateInBase");
    if (equitySummary) {
      const totalAttr = equitySummary.getAttribute("total");
      if (totalAttr !== null && totalAttr !== "") {
        navValue = parseFloat(totalAttr);
      }
    }

    // Fallback: NetAssetValue element with total attribute
    if (navValue === null || isNaN(navValue)) {
      const nav = doc.querySelector("NetAssetValue");
      if (nav) {
        const totalAttr = nav.getAttribute("total");
        if (totalAttr !== null && totalAttr !== "") {
          navValue = parseFloat(totalAttr);
        }
      }
    }
  } catch (e) {
    console.error("XML parse error:", e);
    return jsonError(502, "IBKR response parse error");
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
