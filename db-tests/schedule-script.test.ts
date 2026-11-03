import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, read, type TestDatabase } from "./lib/db";

/*
 * supabase/setup/schedule_order_expiry.sql against a STAND-IN for pg_cron's
 * cron.job / cron.schedule / cron.unschedule (the local server has no
 * pg_cron). This checks the script's own logic only: it is repeat-safe and
 * leaves exactly one job, even if schedule() never updates an existing name.
 * Real pg_cron behaviour is verified on kharchnsave-dev, not here.
 */

const SCRIPT = read("supabase/setup/schedule_order_expiry.sql");
// The stand-in isn't a real extension, so skip only the "is pg_cron enabled?" check.
const WITHOUT_EXTENSION_CHECK = SCRIPT.replace(
  "if not exists (select 1 from pg_extension where extname = 'pg_cron') then",
  "if false then",
);

let db: TestDatabase;

beforeAll(async () => {
  db = await createDatabase("schedule_script");
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean not null default true);
    -- Deliberately naive: always inserts, even for an existing name.
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
    create function cron.unschedule(job_id bigint) returns boolean language sql as
      $$ with d as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from d) $$;`);
});

afterAll(async () => {
  await db?.close();
});

const jobs = async () =>
  (await db.query<{ jobname: string; schedule: string; command: string }>(
    "select jobname, schedule, command from cron.job where command like '%expire_order_holds%' order by jobid")).rows;

describe("schedule_order_expiry.sql", () => {
  it("refuses clearly when pg_cron isn't enabled", async () => {
    await expect(db.exec(SCRIPT)).rejects.toThrow(/pg_cron is not enabled/);
    expect(await jobs()).toEqual([]);
  });

  it("creates exactly one job", async () => {
    await db.exec(WITHOUT_EXTENSION_CHECK);
    expect(await jobs()).toEqual([
      { jobname: "kharchnsave-expire-order-holds", schedule: "* * * * *", command: "select private.expire_order_holds(50)" },
    ]);
  });

  it("is safe to run again, and removes duplicates under other names", async () => {
    await db.exec("select cron.schedule('old-expiry-job', '*/5 * * * *', 'select private.expire_order_holds()')");
    await db.exec("select cron.schedule('unrelated-job', '0 * * * *', 'select 1')");
    await db.exec(WITHOUT_EXTENSION_CHECK);
    await db.exec(WITHOUT_EXTENSION_CHECK);
    expect(await jobs()).toHaveLength(1);
    expect((await db.query("select jobname from cron.job where jobname = 'unrelated-job'")).rows).toHaveLength(1);
  });
});
