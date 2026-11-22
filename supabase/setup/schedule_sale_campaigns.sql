-- Starts and ends scheduled sales every minute (README, "Score pricing and sales").
--
-- Needs the pg_cron extension, which the project owner enables first:
-- Dashboard → Integrations → Cron (or Database → Extensions → pg_cron).
-- Run this in the SQL Editor after 20261121120000_score_pricing_and_sales.sql.
--
-- Safe to run again: it removes every existing job that runs the sale
-- schedule (whatever its name), then creates exactly one. It doesn't rely on
-- how cron.schedule treats an existing job name. Everything happens in one
-- transaction: if any step fails, the jobs are left as they were.
--
-- pg_cron runs one instance of a job at a time; a run that is due while the
-- previous one is still going is queued, not run in parallel. The job runs
-- as the user who scheduled it, in the database this is run in.
--
-- Without it, sales still start and end when an admin presses "Run due
-- starts and ends now" (Sales), and the Sales page shows overdue ones.
--
-- NOT YET VERIFIED on Supabase: only reviewed, and run against a stand-in
-- for pg_cron locally (db-tests/sale-schedule-script.test.ts). Check it on
-- kharchnsave-dev with the queries at the end.

do $$
declare
  existing record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled. Enable it first: Dashboard → Integrations → Cron.';
  end if;

  for existing in
    select jobid from cron.job
    where jobname = 'kharchnsave-sale-schedule' or command like '%private.run_sale_schedule%'
  loop
    perform cron.unschedule(existing.jobid);
  end loop;

  perform cron.schedule('kharchnsave-sale-schedule', '* * * * *', 'select private.run_sale_schedule()');

  if (select count(*) from cron.job where command like '%private.run_sale_schedule%') <> 1 then
    raise exception 'Expected exactly one sale schedule job after scheduling.';
  end if;
end;
$$;

-- The result: exactly one row, active.
select jobid, jobname, schedule, command, active
from cron.job
where command like '%private.run_sale_schedule%';

-- A minute or two later, recent runs:
--   select status, return_message, start_time, end_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'kharchnsave-sale-schedule')
--   order by start_time desc limit 10;
--
-- The job's own record (also notes failures inside a run that rolled back):
--   select * from private.job_heartbeats where job = 'sale_schedule';
--
-- To stop it (sales then start and end only from "Run due starts and ends now"):
--   select cron.unschedule(jobid) from cron.job where jobname = 'kharchnsave-sale-schedule';
