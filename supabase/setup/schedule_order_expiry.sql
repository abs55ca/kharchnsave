-- Releases expired order holds every minute (README, "Order hold expiry").
--
-- Needs the pg_cron extension, which the project owner enables first:
-- Dashboard → Integrations → Cron (or Database → Extensions → pg_cron).
-- Run this in the SQL Editor after 20261031130000_guest_orders.sql.
--
-- Safe to run again: it removes every existing job that runs the expiry
-- (whatever its name), then creates exactly one. It doesn't rely on how
-- cron.schedule treats an existing job name, which pg_cron's README doesn't
-- specify. Everything happens in one transaction: if any step fails, the
-- jobs are left as they were.
--
-- pg_cron runs only one instance of a job at a time; a run that is due while
-- the previous one is still going is queued, not run in parallel (pg_cron
-- README). The job runs as the user who scheduled it, in the database this is
-- run in.
--
-- NOT YET VERIFIED on Supabase: this script has only been reviewed, not run
-- (the local test server has no pg_cron). Check it on kharchnsave-dev with
-- the queries at the end.

do $$
declare
  existing record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not enabled. Enable it first: Dashboard → Integrations → Cron.';
  end if;

  for existing in
    select jobid from cron.job
    where jobname = 'kharchnsave-expire-order-holds' or command like '%private.expire_order_holds%'
  loop
    perform cron.unschedule(existing.jobid);
  end loop;

  perform cron.schedule('kharchnsave-expire-order-holds', '* * * * *', 'select private.expire_order_holds(50)');

  if (select count(*) from cron.job where command like '%private.expire_order_holds%') <> 1 then
    raise exception 'Expected exactly one hold-expiry job after scheduling.';
  end if;
end;
$$;

-- The result: exactly one row, active.
select jobid, jobname, schedule, command, active
from cron.job
where command like '%private.expire_order_holds%';

-- A minute or two later, recent runs (Postgres's own record):
--   select status, return_message, start_time, end_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'kharchnsave-expire-order-holds')
--   order by start_time desc limit 10;
--
-- The job's own record. It also notes failures inside a run that rolled back,
-- which cron.job_run_details reports as "succeeded":
--   select * from private.job_heartbeats;
--
-- cron.job_run_details is never cleaned automatically (pg_cron README). To
-- keep a week of history, optionally:
--   select cron.schedule('kharchnsave-clean-cron-history', '0 3 * * *',
--     $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
--
-- To stop the expiry job:
--   select cron.unschedule(jobid) from cron.job where jobname = 'kharchnsave-expire-order-holds';
