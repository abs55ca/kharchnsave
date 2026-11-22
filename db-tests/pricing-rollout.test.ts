import { expect, it } from "vitest";
import { createDatabase, migrationSteps, read } from "./lib/db";

it("supports the staged dev rollout and retains public pricing columns when internal reads are restricted", async () => {
  // The inspected dev baseline had Nov 17 expand but lacked Nov 16 hardening.
  const baseline = migrationSteps("supabase/migrations/20261117120300_idempotent_photo_registration.sql")
    .filter(([name]) => !name.includes("20261116120000"));
  const db = await createDatabase("pricing_rollout", baseline);
  try {
    const expansion = migrationSteps().filter(([name]) =>
      name.includes("20261116120000") || name > "supabase/migrations/20261117120400_restrict_internal_columns.sql",
    );
    await db.exec(expansion.map(([, sql]) => sql).join("\n"));
    const { rows } = await db.query("select has_any_column_privilege('authenticated','public.products','UPDATE') as direct_write, has_column_privilege('authenticated','public.products','label_name','SELECT') as legacy_read, has_column_privilege('anon','public.products','reference_price_paisa','SELECT') as reference_read");
    expect(rows[0]).toEqual({ direct_write: false, legacy_read: true, reference_read: true });

    // The live compatibility step replaced table SELECT with column grants.
    // Verify the later table-level REVOKE removes this explicit internal grant too.
    await db.exec("revoke select on public.products from authenticated; grant select (id, label_name, reference_price_paisa, referral_excluded) on public.products to authenticated;");

    await db.exec(read("supabase/setup/complete_pricing_hardening.sql"));
    const result = await db.query("select has_column_privilege('authenticated','public.products','label_name','SELECT') as legacy_read, has_column_privilege('authenticated','public.products','reference_price_paisa','SELECT') as reference_read, has_column_privilege('authenticated','public.products','zero_price_approved','SELECT') as giveaway_read, has_column_privilege('authenticated','public.product_variants','reserved','SELECT') as held_stock_read");
    expect(result.rows[0]).toEqual({ legacy_read: false, reference_read: true, giveaway_read: false, held_stock_read: false });
  } finally {
    await db.close();
  }
});
