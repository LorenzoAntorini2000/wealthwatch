# WealthWatch

A personal finance dashboard for tracking your net worth across bank accounts, investments, and cryptocurrency. Balances sync automatically from live integrations, with daily snapshots and interactive charts showing your wealth over time.

**Live app:** `https://lorenzoantorini2000.github.io/wealthwatch/`

---

## Features

- **Net worth dashboard** — total assets in EUR with delta vs. last snapshot
- **Three asset categories** — Bank, Investments, Crypto with individual totals
- **Net worth evolution chart** — line chart with 3M / 6M / 1Y / All time range and per-account filtering
- **Allocation donut chart** — visual breakdown of asset distribution
- **Category history chart** — stacked bar chart of category balances over time
- **Snapshot history table** — all recorded snapshots with CSV export
- **Add / edit / delete accounts** — manual balance entry for any account
- **Daily auto-snapshots** — balances are automatically snapshotted at 06:00 UTC every day
- **Fully responsive** — works on desktop and mobile

---

## Integrations

WealthWatch can sync balances automatically from three external sources:

### Enable Banking (PSD2 Open Banking)
Connect to 3000+ European banks via OAuth2 consent flow. Requires an Enable Banking developer account with an app ID and RSA private key.

### Crypto.com Exchange
Fetch your live cryptocurrency portfolio value in EUR. Requires a read-only Crypto.com API key and secret.

### Interactive Brokers (IBKR)
Fetch your account Net Asset Value via the IBKR Flex Web Service. Requires a Flex token and Flex query ID configured in your IBKR account.

All API credentials are stored encrypted in Supabase Vault and are never exposed to the browser.

---

## Tech Stack

**Frontend**
- Vanilla HTML, CSS, JavaScript
- [Chart.js 4.4](https://www.chartjs.org/) for all charts
- [Supabase JS SDK](https://supabase.com/docs/reference/javascript) for auth and data access

**Backend**
- [Supabase](https://supabase.com/) — PostgreSQL database, Auth, Vault (encrypted secrets)
- Supabase Edge Functions (Deno/TypeScript) for all external API calls
- `pg_cron` PostgreSQL extension for the daily snapshot job

**External APIs**
- [Enable Banking](https://enablebanking.com/) — PSD2 bank balance access
- [Crypto.com Exchange API](https://exchange-docs.crypto.com/) — crypto portfolio value
- [IBKR Flex Web Service](https://www.ibkr.com/en/trading/flex-web-service) — investment account NAV
- [Frankfurter](https://www.frankfurter.app/) — USD → EUR exchange rates

---

## Database Schema

| Table | Description |
|---|---|
| `accounts` | User accounts (name, type, balance, note) |
| `snapshots` | Daily net worth records (bank, invest, crypto, total) |
| `snapshot_accounts` | Per-account balance at each snapshot date |
| `bank_connections` | Enable Banking session metadata and consent state |
| `ibkr_connections` | IBKR account link metadata |
| `user_secrets` | Encrypted API credentials (pointers to Supabase Vault) |

All tables are protected by Row-Level Security — users can only access their own data.

---

## Edge Functions

| Function | Trigger | Purpose |
|---|---|---|
| `bank-connect` | Browser | Initiates and completes Enable Banking OAuth flow |
| `bank-balance` | Browser / cron | Fetches current balances from Enable Banking |
| `crypto-balance` | Browser / cron | Fetches Crypto.com portfolio total in EUR |
| `ibkr-balance` | Browser / cron | Fetches IBKR account NAV via Flex report |
| `daily-snapshot` | `pg_cron` at 06:00 UTC | Refreshes all balances and records daily snapshots for every user |

---

## Setup

### 1. Supabase project

Create a free project at [supabase.com](https://supabase.com). Run the migrations in [`supabase/migrations/`](supabase/migrations/) against your project to create the schema.

Deploy the Edge Functions from [`supabase/functions/`](supabase/functions/) using the Supabase CLI:

```bash
supabase functions deploy
```

Set the following Edge Function secrets:

```bash
supabase secrets set SUPABASE_URL=https://<project>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
supabase secrets set CRON_SECRET=<a-random-secret-for-the-cron-job>
```

Enable the `pg_cron` extension and schedule the daily snapshot job:

```sql
select cron.schedule(
  'daily-snapshot',
  '0 6 * * *',
  $$
    select net.http_post(
      url := 'https://<project>.supabase.co/functions/v1/daily-snapshot',
      headers := '{"Authorization": "Bearer <CRON_SECRET>"}'::jsonb
    );
  $$
);
```

### 2. Frontend configuration

In `app.js`, update the Supabase project URL and anon key at the top of the file.

### 3. Deploy to GitHub Pages

Upload `index.html`, `style.css`, and `app.js` to a GitHub repository. Enable GitHub Pages under **Settings → Pages**, deploy from the `main` branch root. Your app will be live at:

```
https://<your-username>.github.io/<repo-name>/
```

---

## Connecting integrations

All integrations are configured in the **Settings** tab of the app after signing in.

**Enable Banking**
1. Create a developer account at [enablebanking.com](https://enablebanking.com)
2. Generate an RSA key pair for your application
3. Enter your App ID and private key (PEM format) in Settings
4. Go to the **Accounts** tab, click the link icon on any bank account, and follow the OAuth consent flow

**Crypto.com**
1. In the Crypto.com Exchange app, create an API key with read-only permissions
2. Enter the API key and secret in Settings

**Interactive Brokers**
1. In IBKR Client Portal, create a Flex Query that includes `EquitySummaryByReportDateInBase`
2. Generate a Flex token and note the query ID
3. Enter both values in Settings
4. Go to the **Accounts** tab and link your IBKR account ID (e.g., `U1234567`)

---

## Data & Privacy

- All financial data is stored in your private Supabase project — not on any shared server
- API credentials are encrypted at rest using Supabase Vault
- The browser never receives decrypted credentials; all external API calls are made server-side by Edge Functions
- Row-Level Security ensures each user can only read and write their own data
