# Pricing rollout review — 2026-11-22

The reviewed code is merged through [PR #1](https://github.com/abs55ca/kharchnsave/pull/1)
and published on https://kharchnsave.netlify.app/ at commit `d0317794ef5bdff09de928f15a9969201c5cc630`.
[Netlify production deploy](https://app.netlify.com/projects/kharchnsave/deploys/6b02fdd792d58db9dfae0c99)
completed successfully. The earlier production attempt failed because pricing
columns were not installed yet; the new production build generated 50 pages.

The database expansion, corrections, final column restrictions and scheduler are
installed on **kharchnsave-dev** (`tjfaouvgrmeeambvekfz`). Historical migration
tracking has been reconciled with all 22 repository migrations. This is a
technical rollout record; the customer-launch checks below remain outstanding.

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
| Full database suite | 154 passed in GitHub Actions |
| ESLint / TypeScript | Passed; run `npx next typegen` before typecheck on a fresh checkout |
| Production build using the local API stand-in | Passed; 47 pages generated |
| Browser tests | All 16 passed in GitHub Actions (55.7 seconds) and in the user's Windows run |
| Live `npm run db:verify` against dev | All 42 checks passed |
| Live PostgREST pricing columns | HTTP 200 |
| Anonymous pricing-admin RPC, agent table, giveaway flag | Rejected with SQLSTATE 42501 |
| Actual pg_cron sale scheduler | Automatic run succeeded; heartbeat reported zero failures |

[GitHub CI](https://github.com/abs55ca/kharchnsave/actions/runs/45033113607) passed lint, typecheck, unit, database, production build and browser checks.
No Docker was used. Chromium could not launch in the review workspace; the
user ran the exact test command on their Windows checkout and supplied the
complete successful output. The refresh-token errors in the final test are
expected: it intentionally expires a session and verifies safe recovery.
The sale start/end appeared after two page loads in that run.

Netlify production serves the merged review commit. A hosted browser check
confirmed product display without unsupported discount badges, add-to-cart and
checkout rendering. Production home/shop/checkout return HTTP 200, and protected
admin pricing redirects to sign-in. Hosted authenticated admin operations and
scheduled cache refresh remain pending. The site still contains demo wording
and a published TEST listing; this is not yet a customer-launch signoff.

`.github/workflows/verify.yml` runs lint, generated-route typecheck, unit and
local PostgreSQL tests, then the production build and browser suite in GitHub
Actions. It uses no hosted secrets or Docker; browser failure traces are retained
for seven days. CI's browser suite is bounded to ten minutes.

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

## Final hardening and migration history

After confirming the reviewed production deploy, applied
`supabase/setup/complete_pricing_hardening.sql` as hosted migration
`20261122143848_complete_pricing_hardening`. Direct authenticated reads of
`label_name`, `reserved` and `inventory_version` are now denied; public pricing
columns remain readable. The staged-rollout regression also exercises the
intermediate explicit-column grant used on this project.

Compared 965 schema signatures from a fresh database built using every repository
migration against the hosted database: functions and API grants, columns and
column grants, constraints, triggers, RLS table flags, policies and indexes.
No missing or extra objects; the only differing signature is Supabase's platform
`rls_auto_enable()` implementation, replaced by a stub in local tests. Product
fingerprint `ccb00fcccc6da2fd69dd18870cc91538` and inventory fingerprint
`b2553ac131fffcf1ef942d06dad18e42` are unchanged; orders remain two.

Migration bookkeeping was repaired in a guarded transaction after this comparison.
The three rollout entries were replaced with the 22 canonical repository versions,
without running migration SQL again or changing application data. These entries
record reconciliation of the present schema, not historical execution timestamps.
The original version/name/statements are preserved in
[the rollout history archive](rollout/20261122-applied-migrations.json), with the
bookkeeping transaction in [the audit SQL](rollout/20261122-history-repair.sql).
**These are audit records, not scripts to replay.** Do not reset the hosted database.
For future updates, pull main and review `supabase db push --dry-run` first.

## Remaining customer-launch checks

1. Verify Auth signup/redirect settings and server-only agent settings described
   in README. Do not put secret keys in `NEXT_PUBLIC_*` variables.
2. Exercise authenticated preview/apply, one controlled test sale and its end,
   referral checkout, and scheduled cache refresh on the deployed app before
   activating real campaigns. Local/CI browser tests do not verify hosted CDN behavior.
3. Review published demo/test listings and demo wording before accepting customers.
   No product prices, stock, campaigns, agents or real orders were changed for smoke tests.

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
