-- Enable pg_cron extension (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the daily snapshot job at 06:00 UTC every day
-- (= 07:00 Paris CET in winter / 08:00 CEST in summer)
--
-- The job calls the daily-snapshot Edge Function with the CRON_SECRET.
-- Replace <CRON_SECRET> below with the actual secret value before applying.
SELECT cron.schedule(
  'daily-snapshot',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://ylmynyndlqpnwulwewyt.supabase.co/functions/v1/daily-snapshot',
      headers := '{"Authorization": "Bearer 92c0594c240d632ae3233ba9c0a1854c", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    );
  $$
);
