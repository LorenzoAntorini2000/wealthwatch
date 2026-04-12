// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonError(405, "Method not allowed");
  }

  // ── Authenticate via CRON_SECRET ───────────────────────────────────────
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) {
    console.error("CRON_SECRET env var is not set");
    return jsonError(500, "Server misconfiguration: CRON_SECRET not set");
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError(401, "Missing or invalid Authorization header");
  }
  if (authHeader.slice(7) !== cronSecret) {
    return jsonError(401, "Invalid secret");
  }

  // ── Service-role Supabase client (bypasses RLS) ────────────────────────
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── List all users ─────────────────────────────────────────────────────
  const { data: { users }, error: usersError } =
    await adminClient.auth.admin.listUsers({ perPage: 1000 });

  if (usersError || !users) {
    console.error("Failed to list users:", usersError);
    return jsonError(500, "Failed to list users");
  }

  console.log(`Processing ${users.length} user(s)`);

  let processed = 0;
  const errors: Array<{ user_id: string; error: string }> = [];

  for (const user of users) {
    try {
      await processUser(user.id, adminClient, supabaseUrl, serviceRoleKey);
      processed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error processing user ${user.id}:`, msg);
      errors.push({ user_id: user.id, error: msg });
    }
  }

  console.log(`Done — processed: ${processed}, errors: ${errors.length}`);
  return jsonOk({ processed, errors });
});

// ---------------------------------------------------------------------------
// Per-user snapshot logic
// ---------------------------------------------------------------------------

async function processUser(
  userId: string,
  adminClient: ReturnType<typeof createClient>,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const serviceHeaders = {
    "Authorization": `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  // 1. Refresh bank balances ────────────────────────────────────────────────
  const { data: bankConns } = await adminClient
    .from("bank_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active");

  if (bankConns && bankConns.length > 0) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/bank-balance`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(
          `bank-balance failed for user ${userId}: HTTP ${res.status} — ${body}`,
        );
      } else {
        console.log(`bank-balance refreshed for user ${userId}`);
      }
    } catch (e) {
      console.error(`bank-balance network error for user ${userId}:`, e);
    }
  }

  // 2. Refresh crypto balance ───────────────────────────────────────────────
  const { data: cryptoAccounts } = await adminClient
    .from("accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("type", "crypto");

  if (cryptoAccounts && cryptoAccounts.length > 0) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/crypto-balance`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ user_id: userId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.total_eur === "number") {
          // crypto-balance only returns a value; the write is our responsibility
          const { error: updateErr } = await adminClient
            .from("accounts")
            .update({ balance: data.total_eur })
            .eq("user_id", userId)
            .eq("type", "crypto");
          if (updateErr) {
            console.error(
              `Failed to write crypto balance for user ${userId}:`,
              updateErr.message,
            );
          } else {
            console.log(
              `crypto balance written for user ${userId}: ${data.total_eur} EUR`,
            );
          }
        }
      } else {
        const body = await res.text();
        console.error(
          `crypto-balance failed for user ${userId}: HTTP ${res.status} — ${body}`,
        );
      }
    } catch (e) {
      console.error(`crypto-balance network error for user ${userId}:`, e);
    }
  }

  // 3. Refresh IBKR balance ─────────────────────────────────────────────────
  const { data: ibkrConns } = await adminClient
    .from("ibkr_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active");

  if (ibkrConns && ibkrConns.length > 0) {
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/ibkr-balance`, {
        method: "POST",
        headers: serviceHeaders,
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(
          `ibkr-balance failed for user ${userId}: HTTP ${res.status} — ${body}`,
        );
      } else {
        console.log(`ibkr-balance refreshed for user ${userId}`);
      }
    } catch (e) {
      console.error(`ibkr-balance network error for user ${userId}:`, e);
    }
  }

  // 4. Read accounts (post-refresh; falls back to cached values on any refresh failure)
  const { data: accounts, error: accountsError } = await adminClient
    .from("accounts")
    .select("id, type, balance")
    .eq("user_id", userId);

  if (accountsError) {
    throw new Error(`Failed to read accounts: ${accountsError.message}`);
  }

  const accs = accounts ?? [];

  const bank = Math.round(
    accs
      .filter((a) => a.type === "bank")
      .reduce((s, a) => s + (parseFloat(a.balance) || 0), 0),
  );
  const invest = Math.round(
    accs
      .filter((a) => a.type === "invest")
      .reduce((s, a) => s + (parseFloat(a.balance) || 0), 0),
  );
  const crypto = Math.round(
    accs
      .filter((a) => a.type === "crypto")
      .reduce((s, a) => s + (parseFloat(a.balance) || 0), 0),
  );
  const total = bank + invest + crypto;

  // 5. Upsert snapshot (same conflict target as takeSnapshot() in app.js)
  const today = new Date().toISOString().split("T")[0];
  const { error: upsertError } = await adminClient
    .from("snapshots")
    .upsert(
      { user_id: userId, date: today, bank, invest, crypto, total },
      { onConflict: "user_id,date" },
    );

  if (upsertError) {
    throw new Error(`Failed to upsert snapshot: ${upsertError.message}`);
  }

  // 6. Upsert per-account balances
  const accountRows = accs.map((a) => ({
    user_id: userId,
    date: today,
    account_id: a.id,
    balance: Math.round(parseFloat(a.balance) || 0),
  }));
  const { error: acctError } = await adminClient
    .from("snapshot_accounts")
    .upsert(accountRows, { onConflict: "user_id,date,account_id" });

  if (acctError) {
    throw new Error(`Failed to upsert snapshot_accounts: ${acctError.message}`);
  }

  console.log(
    `Snapshot written for user ${userId}: bank=${bank}, invest=${invest}, crypto=${crypto}, total=${total}`,
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
