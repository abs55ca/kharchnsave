import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, read, type TestDatabase } from "./lib/db";

/*
 * supabase/setup/schedule_sale_campaigns.sql against a STAND-IN for pg_cron's
 * cron.job / cron.schedule / cron.unschedule (the local server has no
 * pg_cron), like db-tests/schedule-script.test.ts. This checks the script's
 * own logic only; real pg_cron is verified on kharchnsave-dev, not here.
 */

const SCRIPT = read("supabase/setup/schedule_sale_campaigns.sql");
const WITHOUT_EXTENSION_CHECK = SCRIPT.replace(
  "if not exists (select 1 from pg_extension where extname = 'pg_cron') then",
  "if false then",
);

let db: TestDatabase;

beforeAll(async () => {
  db = await createDatabase("sale_schedule_script");
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean not null default true);
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
    "select jobname, schedule, command from cron.job where command like '%run_sale_schedule%' order by jobid")).rows;

describe("schedule_sale_campaigns.sql", () => {
  it("refuses clearly when pg_cron isn't enabled", async () => {
    await expect(db.exec(SCRIPT)).rejects.toThrow(/pg_cron is not enabled/);
    expect(await jobs()).toEqual([]);
  });

  it("creates exactly one job, and is safe to run again", async () => {
    await db.exec("select cron.schedule('old-sale-job', '*/5 * * * *', 'select private.run_sale_schedule()')");
    await db.exec("select cron.schedule('unrelated-job', '0 * * * *', 'select 1')");
    await db.exec(WITHOUT_EXTENSION_CHECK);
    await db.exec(WITHOUT_EXTENSION_CHECK);
    expect(await jobs()).toEqual([{ jobname: "kharchnsave-sale-schedule", schedule: "* * * * *", command: "select private.run_sale_schedule()" }]);
    expect((await db.query("select jobname from cron.job where jobname = 'unrelated-job'")).rows).toHaveLength(1);
  });

  it("the job's command runs and records its heartbeat", async () => {
    const { rows } = await db.query<{ r: { ended: number; started: number; failed: number } }>((await jobs())[0].command.replace("select ", "select ") + " as r");
    expect(rows[0].r).toMatchObject({ ended: 0, started: 0, failed: 0 });
    const beat = await db.query("select last_succeeded_at is not null as ok from private.job_heartbeats where job = 'sale_schedule'");
    expect(beat.rows[0].ok).toBe(true);
  });
});
