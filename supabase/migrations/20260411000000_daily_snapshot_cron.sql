-- Enable pg_cron extension (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule the daily snapshot job at 06:00 UTC every day
-- (= 07:00 Paris CET in winter / 08:00 CEST in summer)
--
-- IMPORTANT: This migration intentionally uses placeholder values.
-- After applying, run the following command manually (or via CI using
-- environment variables) to set the real secret and project URL.
-- NEVER commit the real CRON_SECRET or project URL to this file.
--
-- Post-migration update command:
--
--   SELECT cron.alter_job(
--     job_id := (SELECT jobid FROM cron.job WHERE jobname = 'daily-snapshot'),
--     command := $cmd$
--       SELECT net.http_post(
--         url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/daily-snapshot',
--         headers := '{"Authorization": "Bearer <CRON_SECRET>", "Content-Type": "application/json"}'::jsonb,
--         body    := '{}'::jsonb
--       );
--     $cmd$
--   );
--
SELECT cron.schedule(
  'daily-snapshot',
  '0 6 * * *',
  $$
    SELECT net.http_post(
      url     := 'https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/daily-snapshot',
      headers := '{"Authorization": "Bearer <CRON_SECRET>", "Content-Type": "application/json"}'::jsonb,
      body    := '{}'::jsonb
    );
  $$
);
