# Pricing rollout review — 2026-11-22

The compatible database expansion is installed on **kharchnsave-dev**
(`tjfaouvgrmeeambvekfz`). The app rollout is incomplete: no deployment URL was
identified, and browser tests could not launch Chromium in the review workspace.
GitHub write access through the repository owner is now verified.

## Corrections

- Minimum margin now checks every eligible agent scenario. The agent leaving
  the least cash is not necessarily the one leaving the lowest percentage.
  A regression with 20% discount/0% commission versus 0% discount/15% commission
  previously accepted an 85% margin against a 90% minimum.
- Campaign application now captures the product UPDATE result before cleanup
  overwrites PL/pgSQL FOUND. A mismatched reviewed price correctly returns false
  and does not mark the campaign line applied.
- Preview wording labels the displayed scenario as the lowest amount kept.
  Local PostgreSQL test servers use TCP only, without requiring a Unix socket.

The forward correction is
`supabase/migrations/20261122134446_pricing_review_guards.sql`.
Both regression tests failed before the correction and pass after it.

## Validation

| Check | Result |
| --- | --- |
| Unit tests | 288 passed |
| Full database suite | 153 passed |
| Additional staged-rollout regression | 1 passed separately (154 database tests total) |
| ESLint / TypeScript | Passed; run `npx next typegen` before typecheck on a fresh checkout |
| Production build using the local API stand-in | Passed; 47 pages generated |
| Browser tests | Blocked at browser launch: Chromium's socket call was denied by the workspace |
| Live `npm run db:verify` against dev | All 42 checks passed |
| Live PostgREST pricing columns | HTTP 200 |
| Anonymous pricing-admin RPC, agent table, giveaway flag | Rejected with SQLSTATE 42501 |
| Actual pg_cron sale scheduler | Automatic run succeeded; heartbeat reported zero failures |

No Docker was used. The browser results from the earlier implementation report
were not independently reproduced. Hosted admin interaction, referral checkout
and cache/CDN behavior still require an actual app deployment.

## Database changes actually applied

The existing database had no migration-history table, despite having earlier
schema changes. Existing objects and functions were inspected before applying
only the missing compatible changes. The Nov 17 expand functions were retained.

Hosted migration `20261122135902_score_pricing_sales_reviewed_expansion`
applied these source files together:

1. `20261116120000_product_writes_through_functions_only.sql`
2. `20261118120000_sales_agents.sql`
3. `20261118120100_referral_checkout.sql`
4. `20261118120200_commission_accounting.sql`
5. `20261118120300_commission_hold_versions.sql`
6. `20261121120000_score_pricing_and_sales.sql`
7. `20261122134446_pricing_review_guards.sql`

The transaction checked that existing product prices, product versions,
publication states, inventory and order count were unchanged. Post-application
checks confirmed the same product and inventory fingerprints, seven initial
price-history observations, zero pricing opt-ins, zero campaigns, zero agents
and the existing two orders.

Hosted migration `20261122140020_pricing_legacy_column_permissions` replaced
authenticated users' table-wide product SELECT with explicit column grants.
It retains all previously readable columns, including `label_name` for older
app compatibility, plus the two public pricing columns. It excludes the new
`zero_price_approved` flag. Costs, scores and history remain inaccessible to API
roles. Product/photo writes now require the guarded admin functions.

`supabase/setup/schedule_sale_campaigns.sql` installed one active job,
`kharchnsave-sale-schedule`, every minute. Its first observed automatic run
succeeded. There are no campaigns to activate. The existing order-hold expiry
job remains active.

## Remaining rollout

1. Publish this correction and identify every app/local server using dev.
   Deploy/restart them on the corrected code. Do not activate sales yet.
2. Once every app uses `admin_get_products`, apply
   `supabase/setup/complete_pricing_hardening.sql`. This is the deferred
   Nov 17 column-access contract, preserving the newer public pricing columns.
   Until then, signed-in users retain the previous access to label names and
   held-stock fields. Create no agent accounts before completing this step.
3. Verify Auth signup/redirect settings and server-only agent/checkout settings
   described in README. Do not put secret keys in `NEXT_PUBLIC_*` variables.
4. Run browser tests in an environment where Chromium can start, then exercise
   preview/apply, one test sale and its end, referral checkout, and scheduled
   cache refresh on the deployed app before activating real campaigns.
5. Reconcile historical migration tracking before using `supabase db push`.
   The hosted combined migration is not a repository filename. Do not replay
   old CREATE migrations or mark the deferred contract applied prematurely.

Security advisors were reviewed. New agent tables have RLS and no direct API
grants; their no-policy notices reflect RPC-only access. Admin functions require
membership plus aal2; checkout functions retain their gateway guard. Leaked
password protection remains disabled; see
[Supabase password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

For recovery, leave campaigns inactive or end/cancel them through admin actions.
Disable the scheduler if necessary with
`select cron.unschedule(jobid) from cron.job where jobname = 'kharchnsave-sale-schedule';`.
Preserve history and order snapshots; correct pricing forward through reviewed
admin actions rather than editing stored prices or order records directly.
