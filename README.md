# Kharch n Save storefront

> **2026-11-22 rollout update:** the compatible pricing/sales database expansion and
> scheduler are installed on `kharchnsave-dev`. The reviewed app is published on Netlify,
> final column restrictions are applied, and migration tracking is reconciled. See [current review and rollout status](docs/pricing-rollout-review.md);
> older "not applied" notes below describe the original implementation state.

Online store for **Kharch n Save** (*Style Zyada. Kharch Kam.*), a Pakistani shop selling
pre-loved men's and women's shoes and brand-new kids' shoes. China-branded shoes and
clothing are shown as "coming soon" and can't be bought.

Built with Next.js 16 (App Router, Cache Components, Partial Prefetching), React 19 and
Tailwind CSS 4.

> **Demo status:** the catalogue is read from Supabase and managed in the admin area, but
> currently holds development fixtures with temporary stock photos, the cart is stored in
> the browser, and checkout
> isn't connected. No payments are taken and no
> orders are created. Search engines are asked not to index the site (`robots` in
> `app/layout.tsx`) until it goes live.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

The storefront reads its catalogue from Supabase, so it needs `.env.local` first: see
[Supabase setup](#supabase-setup). Without it, pages that list products show an error
(there is no built-in sample data). `npm run build` also reads the catalogue, to
prerender pages.

Other scripts:

```bash
npm run lint       # ESLint
npm run build      # production build (also type-checks)
npm start          # serve the production build
```

## What's included

| Route | Purpose |
| --- | --- |
| `/` | Homepage: Men/Women/Kids shortcuts, hero, Fresh Finds tabs, EU size shortcuts, kids' banner, guides, coming-soon teasers |
| `/shop` | Catalogue with search, filters (category, new/pre-loved, size, price, brand, condition, style, availability) and sorting. All state lives in the URL, e.g. `/shop?category=women&size=38&sort=price-asc` |
| `/products/[slug]` | Product page: gallery, size selection, stock status, condition notes, add to cart |
| `/cart`, `/checkout` | Full cart and the demo checkout hand-off |
| `/size-guide`, `/condition-guide`, `/delivery-returns` | Help pages |
| `/coming-soon`, `/about`, `/account` | Supporting pages |
| `/admin/login`, `/admin/mfa`, `/admin` | Staff sign-in, two-step verification (authenticator app) and the admin dashboard (see [Admin area](#admin-area)) |
| `/admin/products`, `/admin/products/new`, `/admin/products/[id]` | Product list (search, status filters, pages), create and edit screens, photos, publishing (see [Product management](#product-management)) |
| `/product-photos/[productId]/[file]` | Shoppers' view of uploaded product photos (published products only) |
| `/admin/scan`, `/admin/products/[id]/labels` | In-store barcode lookup and label printing (see [Barcodes and labels](#barcodes-and-labels)) |
| `/links`, `/qr` | Links page (Instagram, Facebook, shop) and the permanent merchandise QR address that redirects to it (see [Links page and merchandise QR code](#links-page-and-merchandise-qr-code)) |

### Code layout

```
app/                    routes, layout, global styles and brand tokens (globals.css)
components/
  layout/               announcement bar, header, mobile menu, search, footer
  home/                 homepage sections
  catalogue/            filters, sorting, URL state, results
  product/              product card, gallery, purchase panel, badges
  cart/                 cart provider, drawer, lines, cart page, checkout hand-off
  ui/drawer.tsx         accessible side drawer (native <dialog>)
  admin/                login and two-step forms, admin navigation, product editor, sign-out,
                        scan box and results, label options
lib/
  admin/                product form rules (product-input.ts), admin catalogue reads and error
                        messages (products.ts), photo checks and re-encoding (photos.ts),
                        barcode lookups (scan.ts)
  barcodes/             barcode format, check digit and scan-input clean-up (code.ts)
  labels/               ZPL label generator for the Zebra printer (zpl.ts)
  links.ts              links page entries, the QR address and where /qr redirects
  qr/                   merchandise QR code generator (merch-qr.ts)
  brand/                the K mark's paths (k-mark.ts)
  auth/                 admin access check incl. two-step status (admin.ts), safe post-login paths
  catalog/              types, labels, Supabase catalogue reads, search/filters, URL query parsing,
                        product photo paths (photos.ts)
  cart/                 localStorage-backed cart store, availability types
  supabase/             config.ts (settings), server.ts (anonymous catalogue client),
                        session.ts (per-request signed-in client for /admin)
proxy.ts                refreshes admin sessions; runs on /admin only
  sizes.ts              EU/UK/US size tables
  site.ts               navigation and site copy
scripts/
  verify-catalogue.mjs  `npm run db:verify`: checks the Supabase catalogue with the public key
supabase/
  migrations/           database schema, applied in filename order
  seeds/                development fixtures (never for production)
  setup/                owner-run SQL templates (placeholders only)
  tests/                SQL tests for constraints and permissions
e2e/                    browser and HTTP tests (Playwright)
merch/qr/               the merchandise QR codes (SVG, PDF, PNG; light/ fallback): `npm run qr`
```

## Inventory model

- Each **pre-loved** pair is its own product with one variant (one EU size) and stock `1`
  (or `0` once sold). The cart won't allow more than one.
- **New** kids' styles have one variant per size, each with its own stock count. The
  cart caps quantity at the stock for that size.
- Prices are shown in rupees, e.g. `Rs. 8,500` (or `Rs. 8,500.50` when there are paisa).
  The database stores integer **paisa** (`price_paisa`, Rs. 8,500 = `850000`). Admins type
  rupees; the server converts them exactly, without floating-point arithmetic
  (`rupeesToPaisa` in `lib/admin/product-input.ts`). `lib/catalog/supabase-catalog.ts`
  divides by 100 once, and everything after it (`Product.price`, the cart) works in rupees.

### Catalogue data

Pages read products only through the async functions in `lib/catalog/catalog.ts`
(`getAllProducts`, `getProductBySlug`, `searchCatalog`, …). They load the published
catalogue from Supabase in `lib/catalog/supabase-catalog.ts`, on the server, with the
publishable key, so row-level security limits it to published products. Search, filters
and sorting then run over that list, which suits hundreds of products; a much larger
catalogue should move filtering into SQL (and past Supabase's 1,000-row default limit).

- **Freshness:** the catalogue query is cached with the `minutes` profile and tagged
  `catalogue`. Pages are prerendered at build time, then refreshed in the background at
  most once a minute while they get visits; after an hour without visits the next request
  waits for fresh data. Browsers may reuse a page for up to 5 minutes. Every admin
  change calls `updateTag("catalogue")`, so it shows up straight away; see
  [Product management](#product-management) for the one exception.
- **Failures:** the Supabase client retries a failed read up to 3 times (about 7 seconds
  in total). If Supabase still can't be reached, product sections show "We couldn't load
  these shoes" with a retry button and other pages show an error page. There is no
  fallback data. Pages already cached keep serving their last good version while the
  background refresh fails. A build fails if the catalogue can't be read.
- **Incomplete products:** a published product without at least one photo and one size
  is left out of the storefront, with a warning in the server log.
- **Cart:** lines are saved in the browser as snapshots. The cart re-checks them against
  the catalogue (`/api/cart/availability`) and marks lines that are sold out or no longer
  listed, such as ones saved from the old demo catalogue; those are left out of the
  subtotal. Cart prices and stock are display only: checkout must re-check them on the
  server.

The development fixtures' photos are in `public/images/products/`. Photos added in the
admin area are stored in Supabase Storage instead (see
[Product photos](#product-photos)). Record the source of any new third-party images in
`ASSET-SOURCES.md`.

## Backend: Supabase

**Decision:** Kharch n Save uses a custom ecommerce backend on **Supabase** (PostgreSQL)
instead of Shopify. Products, stock, carts and orders will live in our own database,
and the storefront will read them through `lib/supabase/server.ts`.

**Status:** the storefront reads its catalogue from Supabase (see
[Catalogue data](#catalogue-data) and [Catalogue database](#catalogue-database)), and
verified admins manage products and photos in the admin area (see
[Product management](#product-management)). Carts, orders and checkout are not built yet.
The development project is `kharchnsave-dev`.

### Supabase setup

1. Copy the template: `cp .env.example .env.local`
2. In the `kharchnsave-dev` dashboard, open **Connect** (or **Project Settings → API
   Keys**) and copy the **project URL** and the **publishable key** (`sb_publishable_…`)
   into `.env.local`:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   ```

3. Restart `npm run dev`. Re-run `npm run build` after changing these values: Next.js
   writes `NEXT_PUBLIC_` values into the build.

Notes:

- `.env.local` is git-ignored; only `.env.example` (placeholders) is committed.
- The publishable key is safe to expose in a browser. It can only read or write what the
  database's row-level security (RLS) policies allow, so every table needs RLS enabled
  with policies before the storefront reads it.
- Never put a **secret** or **service-role** key, or the database password, in a
  `NEXT_PUBLIC_` variable. None is needed yet.
- Server code gets the client with `getSupabase()`. It throws a clear error if the
  variables are missing, but importing the module never does, so the demo storefront
  runs without them. `isSupabaseConfigured()` reports whether both are set.

### Catalogue database

| File | Purpose |
| --- | --- |
| `supabase/migrations/20261027120000_create_catalogue.sql` | Tables `products`, `product_variants`, `product_images`, their rules, indexes and access policies |
| `supabase/seeds/dev_catalogue_fixtures.sql` | **Development only.** Four sample products (3 published, 1 draft) from the demo catalogue |
| `supabase/migrations/20261029120000_admin_product_management.sql` | Admin write access (verified admins only), publishing rules, stable IDs, version numbers, the admin functions and the photo storage rules (see [Product management](#product-management)) |
| `supabase/tests/catalogue_test.sql` | Tests for the data rules and for what the public can read and write. Rolls back; leaves nothing behind |
| `supabase/tests/product_management_test.sql` | Tests for admin access by role and two-step status, publishing rules, stable IDs and conflicting saves. Rolls back |
| `supabase/migrations/20261029200000_variant_barcodes.sql` | In-store barcodes: one permanent barcode per size, the admin-only register and the read-only scan lookup (see [Barcodes and labels](#barcodes-and-labels)) |
| `supabase/migrations/20261030120000_kns_barcodes.sql` | Barcode format `KNS` + 8 digits: retires the first U barcodes and gives those sizes KNS ones, one use per serial number, item-code rule, `KN5` read as `KNS` when scanning |
| `supabase/tests/barcodes_test.sql` | Tests for barcode format, assignment, uniqueness, immutability, access and the lookup. Rolls back |
| `supabase/migrations/20261031120000_inventory_ledger.sql` | Held stock (`reserved`), an inventory version per size, the add-only stock ledger with opening balances, and stock changes only through approved functions (see [Checkout and orders](#checkout-and-orders)) |
| `supabase/migrations/20261031130000_guest_orders.sql` | Shop settings, orders, order items, history and returns, the checkout gateway, rate limits, hold expiry and the guest and admin order functions |
| `supabase/migrations/20261031140000_settings_where_clauses.sql` | Adds WHERE clauses to the settings and delivery-city functions; Supabase's API refuses UPDATE or DELETE without one (pg-safeupdate) |
| `supabase/migrations/20261101120000_label_names_and_light_up.sql` | Optional label name (admin-only; the publishable key reads products column by column without it) and light-up soles (not recorded / no / yes with a condition); the admin product functions save them without touching stock |
| `supabase/migrations/20261101130000_item_codes_and_sale_prices.sql` | Automatic item codes (`ITEM-000001`, from their own sequence) and optional sale prices; checkout, in-store sales and order snapshots charge the sale price |
| `supabase/migrations/20261116120000_product_writes_through_functions_only.sql` | Products and photos change only through the admin functions: removes verified admins' direct insert/update/delete grants on `products` and `product_images` (which skipped the version check), and makes `admin_add_product_image` and `admin_set_publication_status` SECURITY DEFINER like the other admin product functions |
| `supabase/migrations/20261117120000_function_default_privileges.sql` | New functions are executable only by the roles they are explicitly granted to: removes the migration role's global `EXECUTE … TO PUBLIC` default and Supabase's `anon`/`authenticated` default in `public` (the old `private`-schema default had no effect) |
| `supabase/migrations/20261117120100_checkout_quota_quotes_and_phone_limit.sql` | Checkout: the shop-wide order quota is taken only by new orders, inside `place_cod_order` (refused, retried and bot attempts can't use it up; result `busy`); online quotes say nothing about draft, archived or unknown SKUs; the per-phone open-order limit holds under simultaneous orders (advisory lock per phone; expired holds don't count) |
| `supabase/migrations/20261117120200_internal_columns_admin_reads.sql` | Step 1 of 2 ("expand"): verified admins read the label name, held stock and inventory versions through `admin_get_products` and the scan functions. Changes no grants, so the previous version of the site keeps working |
| `supabase/migrations/20261117120300_idempotent_photo_registration.sql` | `admin_add_product_image` is keyed by the image id: each registration's original request and resulting version are kept in `private.photo_registrations`; a retry with the identical request gets the original version back, anything else is refused; a retry waits for a registration still in progress |
| `supabase/migrations/20261117120400_restrict_internal_columns.sql` | Step 2 of 2 ("contract"), applied last (stage D): signed-in users read products and sizes with the same columns as visitors (no `label_name`, `reserved`, `inventory_version`) |
| `db-tests/hardening.test.ts` | Regression tests for the four migrations above on real PostgreSQL: quota, quotes, the permission matrix, the per-phone limit under concurrency, default privileges, photo registration retries |
| `supabase/migrations/20261118120000_sales_agents.sql` | Sales agents: accounts (linked to Auth users), referral codes (fixed, never reused), current terms, the change log, and the admin functions to create, link, edit, suspend and enable them (see [Sales agents](#sales-agents)) |
| `supabase/migrations/20261118120100_referral_checkout.sql` | Referral codes at checkout: the order's discount, the per-order and per-line referral snapshot, rounding, free delivery after the discount, `quote_order` with a code, `place_cod_order` with the code locked |
| `supabase/migrations/20261118120200_commission_accounting.sql` | Commission states (worked out when read), the automatic deduction for returns after payout, manual adjustments, payouts, and the admin and agent read functions |
| `supabase/migrations/20261118120300_commission_hold_versions.sql` | Correction (forward): a commission hold/release names the latest hold event the admin saw, so a stale form can't release a newer hold |
| `db-tests/referrals.test.ts` | Tests for the three migrations above on real PostgreSQL (provisioning, permissions, checkout, rounding, lifecycle, payouts, races) |
| `supabase/migrations/20261121120000_score_pricing_and_sales.sql` | Score pricing (groups, scores, manual/automatic, price endings, costs, explicit giveaways), genuine price history and supported "was" prices, sale campaigns (one at a time, previews with tokens, schedule job), and clearance referral exclusion in checkout quotes (see [Score pricing and sales](#score-pricing-and-sales)) |
| `supabase/setup/schedule_sale_campaigns.sql` | Optional, after the migration: pg_cron job that starts and ends scheduled sales every minute |
| `db-tests/pricing.test.ts`, `db-tests/sale-schedule-script.test.ts` | Tests for the pricing migration and the schedule script on real PostgreSQL |
| `supabase/migrations/20261122150000_product_deletion.sql` | Permanent product deletion with every order containing it: preview with a token, typed confirmation, refusals for unfinished orders, refunds due and paid-out commission, a deletion log; the append-only guards let only this function delete (see [Deleting a product permanently](#deleting-a-product-permanently)) |
| `supabase/migrations/20261123120000_promotion_planner.sql` | Promotion planner (admin only): a discount percentage per product and the regular price it implies from the selling price, stored apart from prices and history; never shown to shoppers (see [Promotion planner](#promotion-planner)) |
| `supabase/migrations/20261124120000_size_sales.sql` | Sales by size (Pricing page): discount rules by EU size per pricing group, previewed per product, applied and ended as one size sale; the price guard and repricing treat its products like campaign products (see [Sales by size](#sales-by-size)) |
| `db-tests/size-sales.test.ts` | Tests for that migration: rules, matching and rounding (agreeing with the form), eligibility and reasons, applying, repeats, stale previews, conflicts with campaigns, manual sales and repricing, ending, checkout prices |
| `db-tests/promotions.test.ts` | Tests for that migration: access, proposals worked out by the database, stable percentages, and no change to prices, history, quotes or orders |
| `db-tests/product-deletion.test.ts` | Tests for that migration on real PostgreSQL (permissions, what is deleted and kept, refusals, stale previews, retries, a race with checkout, the guards outside a deletion) |
| `supabase/tests/item_codes_sale_prices_test.sql` | Tests for code assignment and collisions, existing codes, the sale price rules, quotes, free delivery, orders and in-store sales at sale prices, and historical orders. Rolls back and puts its counters back |
| `supabase/tests/label_names_light_up_test.sql` | Tests for the label name and light-up rules, who can read the label name, and that saving them leaves stock, held pairs, inventory versions and the ledger alone. Rolls back |
| `supabase/tests/orders_test.sql` | Tests for order permissions, the gateway secret, checkout, retries, hold expiry, admin actions, delivery and payment, returns, in-store sales, stale stock edits and ledger reconciliation. Rolls back |
| `supabase/setup/schedule_order_expiry.sql` | Schedules the hold-expiry job (needs `pg_cron`) |
| `supabase/setup/checkout_gateway_key_TEMPLATE.sql` | Registers the checkout gateway secret's hash |
| `scripts/verify-catalogue.mjs` | `npm run db:verify`: checks the fixtures through the API using the publishable key |

What the schema enforces:

- **Pre-loved pairs:** at most one size, with stock 0 or 1, also when a product or size
  is edited later. New products (kids) can have many sizes and any stock of 0 or more.
- **Valid data:** no negative prices or stock; EU sizes 15–50 in whole or half sizes;
  known departments, styles and condition grades; unique slugs, item codes and SKUs;
  `new` items are always condition "new". Published products need a listing date.
- **Publication** (`draft` / `published` / `archived`) is separate from **item status**
  (`new` / `preloved`). Only published products, and their sizes and photos, are visible.
- **Access:** RLS is enabled on all three tables. Visitors, and signed-in users who
  aren't verified admins, can only read published products, and only the storefront's
  columns (never the label name, held stock or inventory versions; verified admins read
  those through `admin_get_products`). Only a verified admin
  (membership **and** a two-step-verified session) can write, through the policies added
  in `20261029120000_admin_product_management.sql`. Nobody can delete a product through
  the API.
- **Photos** can be marked `shows_defect` for close-ups of wear on pre-loved pairs.

#### Applying it to `kharchnsave-dev` (SQL Editor)

1. Open the `kharchnsave-dev` project in the Supabase dashboard and choose **SQL Editor**
   → **New query**.
2. Open `supabase/migrations/20261027120000_create_catalogue.sql` in your editor, copy
   all of it, paste it into the query and click **Run**. Expect "Success. No rows
   returned". It runs as one unit: if anything fails, nothing is created. Running it a
   second time fails with "relation already exists", which is harmless.
3. New query: paste `supabase/seeds/dev_catalogue_fixtures.sql` and **Run**. You can rerun
   it at any time to reset the four fixtures; other products are never touched.
4. New query: paste `supabase/tests/catalogue_test.sql` and **Run**. Success means every
   test passed. A failure stops with a message starting `FAIL`, naming the test. The
   script rolls back, so it leaves no test data behind.
5. In a terminal in the project folder: `npm run db:verify`. Expect
   `All 27 checks passed.`

`npm run db:verify` uses the publishable key only, so it sees what shoppers see. It
proves the published fixtures are readable and the draft is not, and that the API
refuses writes (its write attempts match no rows, so they cannot change anything). It
cannot tell a hidden draft from a missing one, which is why it only counts the draft as
hidden after it has found the published fixtures, and why the SQL tests also exist.

Notes:

- If you later use the Supabase CLI (`supabase db push`), first record the migration as
  already applied: `supabase migration repair --status applied 20261027120000`.
- Remove the fixtures with `delete from public.products where slug like 'dev-%';` (sizes
  and photos are deleted with them). Never run the seed on a production project.

## Admin area

`/admin/login` signs staff in with email and password (Supabase Auth, cookie sessions
via `@supabase/ssr`). Admins then complete **two-step verification** at `/admin/mfa` with
a 6-digit code from an authenticator app (TOTP). `/admin` is the dashboard (product
counts by status), and `/admin/products` is where products are managed (see
[Product management](#product-management)). Every admin page has the admin navigation and
**Sign out**. There is no public sign-up screen.

How access is decided:

- **Signing in is not enough.** An account is an admin only if its Supabase Auth user ID
  is listed in `public.admin_members`
  (`supabase/migrations/20261027200000_create_admin_members.sql`). Email addresses and
  user-editable metadata are never used, and nobody becomes an admin automatically.
- **Two-step verification is mandatory.** After the password, an admin without an
  authenticator app must set one up (QR code or setup key, then a code to confirm it);
  an admin who has one must enter a code. The dashboard requires a verified factor **and**
  a session whose verified JWT says `aal: "aal2"` (it completed the code step). Having an
  app set up is not enough on its own; a password-only session is always sent back to
  `/admin/mfa`. Non-admins are refused even if they set up MFA through the API.
- **Checked on the server, on every request.** `getAdminAccess()` in `lib/auth/admin.ts`
  verifies the session with Supabase Auth (`getUser()`, so a signed-out or deleted account
  is refused at once; the cookie alone is never trusted), reads the membership, then
  checks the factor list (from Supabase Auth) and the session's `aal` claim (from
  `getClaims()`, which verifies the JWT signature). Every admin page, Server Action and
  Route Handler runs this check itself: pages through `getAdminPageClient()`, the product
  actions and the photo preview route through `getAdminClient()`, which hands out the
  signed-in Supabase client only to a verified admin. Hiding a button or relying on a
  redirect is not protection.
- **The two-step page has a narrower guard.** `/admin/mfa` and its two actions
  (`app/admin/mfa/actions.ts`) accept a verified, current member who hasn't completed the
  code step yet, and nothing else. Setup only starts when the admin presses **Set up
  authenticator app** (never while a page renders or is prefetched); starting again
  replaces an unfinished setup, and a verified factor is never removed by the app.
- **Fails closed.** If Supabase Auth, the membership lookup or the MFA service can't be
  reached, the admin area shows an error and stays locked.
- **Secrets stay out of logs and storage.** Codes, setup keys, QR codes, passwords and
  tokens are never logged or saved in the browser (the setup key exists only on the setup
  screen until it's closed). Server errors log only error codes. There are no backup
  codes and no bypass.
- **Memberships are owner-only.** RLS is enabled; visitors can't read the table, a
  signed-in user can read only their own row, and nobody can add, change or remove rows
  through the API. The owner manages them in the SQL Editor.
- **Sessions:** `proxy.ts` (on `/admin` paths only) refreshes expiring sessions and marks
  admin responses `private, no-store`. The session cookies are HttpOnly, `SameSite=Lax` and
  limited to `/admin`, so storefront pages never receive them and stay cacheable. The
  signed-in client (`lib/supabase/session.ts`) is created per request and is separate from
  the anonymous catalogue client; nothing signed-in is cached.
- After sign-in, people are only ever sent to a page inside `/admin` (`safeAdminPath`).

> **Rule for any future admin writes:** check access on the server in the action itself
> (as `app/admin/products/actions.ts` does), **and** make every write policy in the
> database require a verified admin with `(select public.is_catalogue_admin())`
> (membership **and** `aal2`), so a password-only session can't change anything even by
> calling the API directly. The product-management migration is the example to follow.

### Making yourself an admin (one-time owner setup)

Do these in order, in the `kharchnsave-dev` dashboard:

1. **Create the membership table.** SQL Editor → New query → paste all of
   `supabase/migrations/20261027200000_create_admin_members.sql` → **Run**. Expect
   "Success. No rows returned".
2. **Check it (optional, recommended).** New query → paste
   `supabase/tests/admin_members_test.sql` → **Run**. Success means every test passed. It
   uses three temporary test users and rolls everything back.
3. **Create your login.** Authentication → Users → **Add user** → **Create new user**.
   Enter your email and a long, unique password (a password manager helps), tick
   **Auto Confirm User**, and create it.
4. **Copy your user ID.** Click your new user and copy its **User UID** (a long code like
   `1a2b3c4d-…`).
5. **Make that user an admin.** New query → paste
   `supabase/setup/grant_admin_TEMPLATE.sql` → replace `PASTE-USER-UID-HERE` in the
   `insert` line with your User UID (keep the quotes) → **Run**. Don't save your real UID
   into the file in the project.
6. **Sign in.** Run `npm run dev`, open <http://localhost:3000/admin/login> and sign in.
   You'll be asked to set up two-step verification (next section).

To remove someone's access, run the `delete` line at the bottom of the template with their
User UID; their next page load is refused. Password resets for staff are done in
Authentication → Users for now.

### Setting up two-step verification (each admin, once)

1. Install an authenticator app on your phone, such as Google Authenticator, Microsoft
   Authenticator, 1Password or Authy.
2. Sign in at `/admin/login`. You'll land on **Set up two-step verification**.
3. Press **Set up authenticator app**. A QR code and a setup key appear.
4. In the app, add an account and scan the QR code (or type the setup key, choosing a
   time-based key). It appears as **Kharch n Save**.
5. Type the 6-digit code the app shows and press **Confirm and finish setup**. You land
   on the admin dashboard. Your other signed-in browsers are signed out (Supabase does
   this when a new factor is confirmed).
6. From now on, every sign-in asks for a current code after your password.

If you close or reload the page before confirming, just press **Set up authenticator app**
again: it replaces the unfinished setup. If the app already shows an old "Kharch n Save"
entry from an unfinished attempt, delete that entry in the app so you don't confuse them.

**Dashboard settings to check (nothing here is changed by the project):**
In Authentication, open the multi-factor settings and find the authenticator-app (TOTP)
option: it must allow both enrollment and verification. Supabase enables TOTP on every
project by default, so this is normally already right; if it's turned off, the setup
screen says authenticator apps are turned off. (Exact menu labels can differ between
dashboard versions.) Keep sign-ups disabled as recommended above.

### If a store admin loses their authenticator app

This is about the authenticator for **this store's** admin area. There are no backup codes,
no recovery page and no in-app reset, and a verified authenticator can't be removed from a
password-only session. The store owner removes it with Supabase's supported admin MFA API
([`auth.admin.mfa.listFactors`](https://supabase.com/docs/reference/javascript/auth-admin-listfactors)
and
[`auth.admin.mfa.deleteFactor`](https://supabase.com/docs/reference/javascript/auth-admin-mfa-deletefactor)).
These need the project's **secret key**, so they're run only from the owner's own computer,
never from the website. Don't edit the `auth` tables by hand in the SQL Editor; use the
API.

1. Confirm the request really comes from that person (by phone or in person, not just by
   email). If you suspect the account itself is compromised, first remove their
   `admin_members` row (see above) so they're locked out while you sort it out.
2. In Authentication → Users, copy that admin's **User UID**.
3. In Project Settings → API Keys, create a new secret key just for this (or use an
   existing one). Never put it in `.env.local`, a `NEXT_PUBLIC_` variable, the host's
   settings or any file in the project.
4. In a PowerShell terminal in the project folder (where `.env.local` provides the project
   URL), paste the key and UID for this terminal only:

   ```powershell
   $env:SUPABASE_SECRET_KEY = "paste-the-secret-key"
   $env:ADMIN_USER_ID = "paste-the-user-uid"
   $recover = @'
   import { createClient } from "@supabase/supabase-js";
   const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, ADMIN_USER_ID: userId, DELETE_FACTOR_ID: id } = process.env;
   const { auth } = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
   if (id) {
     const { error } = await auth.admin.mfa.deleteFactor({ userId, id });
     console.log(error ? `Failed: ${error.code ?? error.message}` : "Removed. If it was verified, they are now signed out everywhere.");
   } else {
     const { data, error } = await auth.admin.mfa.listFactors({ userId });
     if (error) console.log(`Failed: ${error.code ?? error.message}`);
     else console.table(data.factors.map((f) => ({ id: f.id, type: f.factor_type, status: f.status, created: f.created_at })));
   }
   '@
   $recover | node --env-file=.env.local --input-type=module -
   ```

   This **only lists** their factors (ID, type, status and date, with no secrets).
5. To remove one, copy its `id` from the list and run:

   ```powershell
   $env:DELETE_FACTOR_ID = "paste-the-factor-id"
   $recover | node --env-file=.env.local --input-type=module -
   ```

   Supabase signs the user out of all sessions when a verified factor is deleted. Run step
   4 again to confirm the list is empty; remove any leftover unverified entries the same
   way.
6. Close the terminal, then delete the secret key you created in step 3.
7. They sign in again and set up a new authenticator app as above.

Supabase marks the admin MFA API as experimental, so check the linked pages before using
it.

### If the owner loses access to their Supabase account

This is a different account: the one used to sign in to the Supabase dashboard, which
controls the whole project, including every step above. Protect it with its own MFA in your
Supabase account settings, and register a **backup** authenticator for it on a separate
device. Supabase says it can't restore access to a dashboard account if you lose every
second factor; see
[Lost access / forgot the MFA device](https://supabase.com/docs/guides/troubleshooting/lost-accessforgot-the-mfa-device-nAPT-7)
and [Multi-factor authentication for your account](https://supabase.com/docs/guides/platform/multi-factor-authentication).
Nothing in this app can recover it.

If the owner loses only their **store** authenticator but can still reach the Supabase
dashboard, they follow the store-admin steps above for their own User UID.

Recommended (not changed by this project): in Authentication's sign-up settings, turn off
"Allow new users to sign up" so accounts can only be created by you. Self-registered
accounts would still not be admins, but there is no reason to allow them.

If you later use the Supabase CLI, record this migration as applied first:
`supabase migration repair --status applied 20261027200000`.

### Verification status

**Confirmed by hand against `kharchnsave-dev` (real Supabase Auth and database), before
two-step verification was added:**

- The approved admin signs in and reaches the welcome page.
- Refreshing `/admin` works, with no rendering error.
- Signing out, then signing back in, works.
- A separate signed-in account without an `admin_members` row is refused access.

**Automated checks against `kharchnsave-dev` (no users created, nothing written):**
signed-out visits redirect to the login page with `no-store`, wrong credentials get the
generic error and no session cookie, forged or garbage cookies are refused, unsafe return
paths are replaced, and storefront pages set no cookies and stay cacheable.

**Still pending on the hosted project:**

- Session-expiry refresh (an access token expiring and being refreshed by `proxy.ts`
  while the admin stays signed in).
- Membership removal (deleting an admin's `admin_members` row, then confirming their next
  page load is refused).

Both behave correctly against a local stand-in for Supabase Auth and the REST API, but
that is a mock and does not prove how the hosted project behaves.

**Two-step verification, confirmed by hand against `kharchnsave-dev` with a real
authenticator app:**

- The owner set up an authenticator app (enrollment succeeded).
- After signing out and back in, an authenticator code is required.
- Visiting `/admin` after a password-only sign-in redirects to verification.
- A valid code grants access to the admin area.

Also tested end to end against the local stand-in (a mock of Supabase Auth's MFA endpoints
with real TOTP codes), plus signed-out and forged-token checks against `kharchnsave-dev`.

**Two-step verification, still pending on the hosted project:** the message for a wrong
code, a non-admin account being refused now that MFA is in place, the lost-authenticator
recovery (admin MFA API) and the session-expiry and membership-removal checks above.

## Product management

Verified admins (membership **and** two-step verification) manage the catalogue at
`/admin/products`. Nothing uses a secret key: every read and write goes through the admin's
own session with the publishable key, so the database checks the same rules again. Products
are normally archived; deleting one for good is a separate, guarded step (see
[Deleting a product permanently](#deleting-a-product-permanently)).

### What admins can do

- **Find products:** search by name, brand, colour, item code or web address; filter by
  **Draft**, **Published** or **Archived**; 20 per page, most recently changed first.
- **Add a product** (**Add product**): name, brand, colour, department, styles, type
  (pre-loved pair or new shoes in several sizes), condition and condition notes,
  description, price in rupees, item code, web address name (suggested from the brand and
  name if left empty) and sizes with stock. It's saved as a **draft**. Photos are added on
  the next screen, once the product exists.
- **Edit a product:** the same fields, plus photos: upload, reorder (drag a photo;
  on a phone, drag its ⠿ handle; or **Earlier** / **Later**; the first is the main photo), describe each one for screen readers, tick
  **Shows wear or a flaw** for defect close-ups, **Flip** an uploaded photo left to right (a mirrored copy
  takes its place; the original is removed when you save), and **Remove** from the listing.
  **Save changes** saves the details, sizes and photo details together, all or nothing.
- **Status:** **Publish**, **Unpublish** (back to draft), **Archive**, and **Restore as
  draft** for archived products. These are disabled while there are unsaved changes.
- **Delete permanently** (bottom of the edit page): removes the product **and every order
  containing it**, after typing its item code. See
  [Deleting a product permanently](#deleting-a-product-permanently).
- **Feedback:** each field shows its own error, with a summary at the top linking to the
  fields; the bar at the bottom shows "You have unsaved changes", "Saving…" or "Saved.".
  Leaving with unsaved changes (a link, closing or reloading the tab) asks first. The
  browser's Back button is not intercepted.

### Product rules

The server checks these first, for clear messages, and the database enforces them again
(`20261029120000_admin_product_management.sql` plus the original constraints):

| Rule | Detail |
| --- | --- |
| Pre-loved | One physical pair: exactly one EU size, stock 1 (for sale) or 0 (sold). Condition Excellent, Very Good or Good |
| New (kids) | One or more sizes, each with whole-number stock from 0 to 9,999. Condition is always New |
| Sizes | EU 15–50, whole or half sizes, no duplicates |
| Price | **Regular price**, typed in rupees (`8500`, `8,500.50`); stored as exact integer paisa; up to Rs. 10,00,000 |
| Sale price | Optional. Above zero and **strictly below** the regular price (checked by the form and by the database). Empty means no sale; clearing it ends the sale. While set, it's what customers pay everywhere: product cards and pages, price sorting and filters, the cart, checkout quotes, orders, the free-delivery threshold and in-store sales. The shop shows it with the regular price struck through and a "20% OFF" badge (rounded down; "Sale" under 1%); the percentage is calculated, never stored. A sale that starts, changes or ends between a customer's quote and their order triggers the usual "something changed" step at checkout. Orders already placed keep their prices |
| New products | Always created as drafts |
| Publishing | Needs a price above zero, a description, at least one style, at least one size and at least one photo. Zero stock is allowed (it shows as sold out) |
| Item codes | **Automatically generate item code** (ticked by default on Add Product) has the database assign `ITEM-000001`, `ITEM-000002`, … when the draft is created, from its own sequence (never the barcode sequence, a row count or MAX + 1); a number some product already uses is skipped. Typed codes can't take that form. Once assigned, the code behaves like any other: kept on every save, fixed once published. Untick the box to type a code |
| Identifiers | The product ID never changes. Item codes, web addresses and SKUs are unique. SKUs are made automatically as `<item code>-<size>` (e.g. `PL-M-1001-42.5`). Once a product has been published, its item code, SKUs and sizes are fixed and its sizes can't be removed (set stock to 0), so an SKU is never reused. Changing a published product's web address is allowed but breaks links people already have |
| Conflicts | Every product has a version number. A save names the version it started from; if someone else saved in between, it's refused ("Someone else saved this product…") instead of overwriting their work. Photo uploads and status changes work the same way |
| Deletion | Archive to hide a product. **Delete permanently** is the only way to delete one; it also deletes every order containing it, and is refused while any of those orders is unfinished (see [Deleting a product permanently](#deleting-a-product-permanently)). Nothing else deletes products, through the website or the API |
| Label name | Optional, for printed labels only (see [Printing labels](#printing-labels)). A label name that's typed or changed must fit the label; a product name too wide for the label doesn't block saving other changes, it blocks printing |
| Light-up soles | **Yes**, **No** or **Not recorded** (every product until someone checks; never assumed to be No). Yes needs a condition: Not checked, Both shoes work, One shoe works or Neither works, and may have a short description of how the lights activate, in the admin's own words. The shop shows a **Light-up** badge (product cards and page) only for Both shoes work; the product page states any other condition ("Lights not tested", "only one shoe", "don't work"). Editing these never changes stock |

### Deleting a product permanently

**Delete permanently**, at the bottom of a product's edit page, deletes the product from the shop
and the database for good, **together with every order that contains it**. Archive instead if
the product only needs to disappear from the shop.

**What the admin sees first.** The panel lists the product's sizes and photos and every order
containing it: number (linking to the order), status, total, date, the order's other products
(their lines go too, because the whole order is deleted), whether it has a referral, and anything
that blocks the delete. The button stays disabled until the item code is typed (any case), and a
final browser confirmation names the orders.

**Refused (nothing deleted) while any of those orders:**

| Blocker | Why | What to do |
| --- | --- | --- |
| Isn't finished: waiting for confirmation, confirmed, with the courier, or delivery failed | Its pairs are still held or in transit | Deliver, return or cancel it first. Delivered, returned, cancelled and in-store orders count as finished |
| Has a refund due | Money is still owed to the customer | Record the refund first |
| Agent commission paid out, or adjusted after a payout | Those are records of money that has moved; deleting them would corrupt the payout | Archive the product instead |

It is also refused, with the updated list shown, if anything changed after the page loaded: an
edit to the product, a new order, or a change to one of those orders (the page's preview carries a
token for exactly that state). A checkout that races the delete either gets its order in first
(then the delete is refused as changed) or finds the product gone.

**Deleted:** the product, its sizes, photo records, pricing settings, sale-campaign entries,
reference price and price history, its own stock-ledger rows, the photo files in Storage, and
each order containing it with all of that order's lines, events, returns, referral snapshot and
commission holds. The customer's private order link stops working.

**Kept:** other products' stock-ledger rows from those orders, so their stock history still adds
up (the link to the deleted order is removed); the product's barcodes, retired, so a printed
label is still recognised and a barcode is never issued twice; pricing request records (they can
cover several products); and one row in `private.product_deletions` with who deleted which item
code and name, when, and the order numbers deleted (no customer details).

**How it's enforced** (`20261122150000_product_deletion.sql`): `public.admin_delete_product`
requires a verified admin (membership and two-step verification), locks the product, its sizes
and the orders, checks the token and the blockers again, then deletes everything in one
transaction. Orders, order lines, events, returns, referral records and the stock ledger are
append-only by design; their guards allow a delete only while that function runs (the setting
`kns.product_purge`, for its own transaction). Every other delete is still refused, even by the
database owner. A retry after a lost answer is recognised by its request id and gets the original
answer. Photo files that can't be removed (Storage unavailable) stay private and unreferenced,
and the failure is logged.

**Setup (owner).** Nothing here is applied to a hosted project yet.
1. Apply `20261122150000_product_deletion.sql` in the SQL Editor (one transaction). It needs
   every earlier migration, through `20261122134446_pricing_review_guards.sql`.
2. Deploy this version of the site.

| Code | Database | What happens |
| --- | --- | --- |
| This version | without the migration | Everything else works; the edit page leaves out the delete panel (its read fails and is logged) |
| Previous version | with it | Works; it has no delete panel. Orders and the stock ledger behave exactly as before |
| This version | with it | Everything works |

**Verification** (read-only; after step 1):
```sql
select
  to_regprocedure('public.admin_delete_product(uuid, text, text, uuid)') is not null as installed,
  has_function_privilege('anon', 'public.admin_delete_product(uuid, text, text, uuid)', 'EXECUTE') as anon_can_call,        -- false
  has_function_privilege('authenticated', 'public.admin_delete_product(uuid, text, text, uuid)', 'EXECUTE') as signed_in_can_call, -- true (the function itself requires a verified admin)
  has_table_privilege('authenticated', 'private.product_deletions', 'SELECT') as signed_in_reads_log;                        -- false
```
Then, on dev, as a verified admin: open a test product that is in a cancelled order, check the
panel lists that order, type the item code and delete; check the product list shows "Deleted …",
the order is gone from Orders, and the photos are gone from Storage (`product-photos/<product id>/`).
A direct `delete from public.orders …` in the SQL Editor must still fail ("Orders are never deleted.").

**Verification status.** *Measured, local:* `db-tests/product-deletion.test.ts` (12 tests, real
PostgreSQL with every migration; orders taken through the real admin functions) and
`e2e/product-deletion-local.spec.ts` (2 tests, phone viewport, local stack). *Not verified:*
PostgREST, Storage file removal (the local tests' products use site images, not uploads), and the admin product
list's "Deleted" notice (the stand-in can't render that page); all need a real Supabase project.

### Product photos

- **Accepted:** JPEG, PNG or WebP, up to 4 MB, 400 to 8,000 pixels on each side and at
  most 40 megapixels. The server checks the file's actual contents (not its name), decodes
  the whole image, and refuses anything else, including HEIC, GIF, SVG, animated and
  damaged files (`lib/admin/photos.ts`).
- **Stored:** re-encoded as WebP (quality 80: on 24 product photos, 20% smaller than
  quality 85 with stitching and wear still sharp at 2x zoom), at most 2,000 pixels on
  the longest side, with all
  metadata removed (camera details and GPS location), in the **private** Storage bucket
  `product-photos` at `<product id>/<image id>.webp`. The database stores that path
  (`product_images.storage_path`), never a URL. Existing fixture photos keep their
  `/images/products/…` paths.
- **Who can see them:** Storage's rules let shoppers read a photo only while it belongs to
  a published product. Draft, archived and unused photos are private to verified admins.
  Admins preview them through `/admin/products/<id>/photos/<image id>`, which checks
  access on every request and is never cached. The list, scan page and editor ask it for
  a smaller copy made on request (`?size=thumb`, 256 px, about 4 KB; `?size=preview`,
  720 px, about 30 KB) instead of the stored photo (about 250 KB); **View full size** in
  the editor opens the stored photo.
- **Delivery to shoppers:** `/product-photos/<product id>/<image id>.webp` reads the photo
  with the public key and caches it with the catalogue (same `catalogue` tag), and
  `next/image` optimises it like any other local image. A photo's address never changes
  what it shows (each upload gets a new image id and never overwrites), so:
  - Netlify's shared CDN cache keeps the stored photo for at most **4 hours**
    (`Netlify-CDN-Cache-Control: public, durable, s-maxage=14400`, no stale serving),
    tagged `product-photos-<product id>`. Netlify's image CDN reads it from there whenever
    an edge node makes a size it hasn't made yet, instead of running the site's function
    (measured on 2026-11-17: 1.7–2 s per photo with the old 60-second cache).
  - Browsers keep each copy for at most **1 hour** (`Cache-Control: public, max-age=3600`).
  - `next/image` asks for 9 widths instead of 15 (`images` in `next.config.ts`), so
    shoppers share copies already made more often.
  - Coming from the catalogue, the product page shows the card's copy of the first photo
    at once and swaps in the sharper copy when it arrives (`lib/catalog/loaded-photo.ts`).
- **No signed URLs.** The site never creates or stores Supabase signed URLs. A signed URL
  works for anyone who has it until it expires, and can't be cancelled early: removing an
  admin or unpublishing a product wouldn't stop it. If you ever create one in the
  dashboard, keep the expiry short and don't put it in the database.
- **After unpublishing:** the photo route stops serving the photo straight away, and
  unpublishing, archiving or removing a photo calls `updateTag` for that product's tag.
  Netlify's Next.js runtime source passes it to Netlify's purge API, but that hasn't been
  observed on a host yet (pending owner check). Copies already made can live longer:
  - The stored photo in Netlify's shared cache: up to 4 hours if the purge doesn't happen.
  - A browser that showed the photo keeps it for up to 1 hour.
  - **Resized copies (`/_next/image`) are not bounded by these headers.** Netlify documents
    that a source image's headers don't control its own image cache, and resized product
    photos were measured stored for about a year per edge node (2026-11-17). Treat them as
    kept until the next deploy. Whether the tag purge clears them is **unverified**; check
    it on the host before relying on it. A deploy clears everything.
  - Self-hosted, Next.js keeps its resized copies for up to 4 hours
    (`images.minimumCacheTTL`); delete `.next/cache/images` to clear them at once.

  Only someone who already had the image address could load it; the addresses contain
  random IDs.
- **Upload limits:** Server Actions accept up to 4.5 MB per request (`next.config.ts`), which
  also applies to every other action, and matches common hosting limits.

**Failures and clean-up.** A photo is uploaded first and only then recorded in the
database, so a product never points at a missing file:

- If the upload fails, nothing is recorded.
- If the database refuses to record it (for example, someone else saved first), the
  upload is deleted again.
- If the answer is lost (a network error after the database may have committed), the
  site asks again with the same image id until the database answers: a repeat of the
  identical request (same product, expected version, path, dimensions and alt text, as
  first sent) returns the version that registration produced, never a later one, so if
  another admin saved in between, the editor's next save is refused as a conflict rather
  than overwriting their change; a repeat waits for a first attempt still in progress
  (`lib/admin/photo-registration.ts`). If no answer comes, the upload is **kept** and the
  admin is asked to reload: deleting it could leave a recorded photo pointing at nothing.
  An upload that turns out unrecorded is an unused file (see below).
- When a photo is removed from a listing, its file is deleted after the save succeeds.

If one of those deletions fails, an unused file is left in the bucket. It stays private
(shoppers can't see it) and only takes up space. To find unused files, run this read-only
query in the SQL Editor:

```sql
select o.name, o.created_at
from storage.objects o
where o.bucket_id = 'product-photos'
  and o.created_at < now() - interval '1 day'
  and not exists (select 1 from public.product_images i where i.storage_path = o.name)
order by o.created_at;
```

Then delete them in **Storage → product-photos**: open the product's folder (the first
part of the name), select the listed files and delete them. That goes through the Storage
API. Don't delete rows from `storage.objects` with SQL: that would leave the files behind.

### Keeping the shop up to date

Every successful admin change calls `updateTag("catalogue")`, which refreshes the cached
catalogue, the product photos and the cart's availability check (`/api/cart/availability`)
at once. Published changes appear, and unpublished or archived products disappear (their
page shows "not found"), on the next request.

One exception, from how Next.js handles cached pages: if a page was last generated more
than a minute ago, the first visitor after a change can still get that older version once
while it regenerates; the next request is up to date. With several server instances,
each instance learns about changes separately (see the Next.js caching docs).

### How access is enforced

- **Every page, action and route checks.** The product pages, the four product actions
  (`app/admin/products/actions.ts`) and the photo preview route each check identity,
  current membership and an `aal2` session on the server. Signed-out visitors are sent to
  sign in, password-only sessions to two-step verification. Actions return a message
  instead of redirecting, so unsaved work stays on the page while you sign in again in
  another tab.
- **The database checks again.** `public.is_catalogue_admin()` is true only for a member
  whose session completed two-step verification. Every write policy, and the admins'
  read access to drafts, require it. Visitors, signed-in non-admins and password-only
  admins can read only published products and can't write anything, even by calling the
  API directly.
- **Admin functions** (`admin_create_product`, `admin_save_product`,
  `admin_add_product_image`, `admin_set_publication_status`) run with the caller's own
  rights (`security invoker`), so they can't bypass those policies. Each does its work in
  one transaction. Visitors can't call them at all.
- **Column limits:** admins can't set IDs or version numbers, can't point a photo at an
  outside web address, and can't delete products. In Storage they can upload new files
  into an existing product's folder and delete files, but can't overwrite or move them.
- **Unchanged:** visitors' read access, and admin-membership management (still owner-only,
  in the SQL Editor).

### Setting it up on `kharchnsave-dev` (in this order)

This version of the website reads a new column, so **apply the migration before running
it**: until then, product pages show "We couldn't load these shoes". The migration
doesn't change any existing rows, and the previous version of the site works with it too.

1. **Be a verified admin.** You need an admin membership and two-step verification (see
   [Admin area](#admin-area)).
2. **Apply the migration.** SQL Editor → **New query** → paste all of
   `supabase/migrations/20261029120000_admin_product_management.sql` → **Run**. Expect
   "Success. No rows returned". It runs as one unit: if anything fails, nothing changes.
   If it stops on a constraint (for example `products_published_needs_description`), an
   existing published product breaks that new rule; fix that product in the Table Editor
   and run it again.
3. **Run the tests.** New query for each of these, then **Run**; each must finish without a
   `FAIL` message, and each rolls back, leaving nothing behind:
   `supabase/tests/catalogue_test.sql`, `supabase/tests/admin_members_test.sql`,
   `supabase/tests/product_management_test.sql`.
4. **Create the photo bucket.** **Storage** → **New bucket**:
   - Name: `product-photos` (exactly)
   - **Public bucket: off** (this is what keeps draft photos private)
   - Restrict file size: on, **4 MB**
   - Allowed MIME types: `image/webp`

   Save. (Labels can differ slightly between dashboard versions.)
5. **Check the bucket** with this read-only query. Expect one row with `public` = `false`:

   ```sql
   select id, public, file_size_limit, allowed_mime_types
   from storage.buckets where id = 'product-photos';
   ```

6. **Check the public view:** in a terminal in the project folder, `npm run db:verify`.
   Expect `All 27 checks passed.`
7. **Try it.** `npm run dev`, sign in at <http://localhost:3000/admin/login> with your
   authenticator code, then **Add product**: create a test draft, add a photo, publish it,
   look at it in the shop, then unpublish and archive it. Check that it's gone from the
   shop.
8. If you later use the Supabase CLI, record the migration as applied first:
   `supabase migration repair --status applied 20261029120000`.

No Authentication settings change. Deploying needs nothing new beyond the existing
environment variables (no secret key).

### Product management verification status

**Tested locally only.** Nothing below ran against `kharchnsave-dev`: no migration was
applied there, no bucket created and no products changed. The local tests used the
Supabase CLI's local stack in Docker (real Postgres, PostgREST, Supabase Auth with TOTP and
Supabase Storage, not a mock), with a production build of the site:

- **Database tests:** `catalogue_test.sql`, `admin_members_test.sql` and
  `product_management_test.sql` pass on a fresh database and when the migration is
  applied on top of existing data (existing rows unchanged). `npm run db:verify`: 27/27.
- **Direct API attempts** (88 checks) by a visitor, a non-member with two-step
  verification, a password-only admin and an admin without a factor: every admin function,
  direct table write and Storage upload, overwrite, move, list, signed URL and delete is
  refused; drafts and unused uploads can't be read; published photos can.
- **Browser, end to end** (85 checks): create → upload → save draft → publish → edit →
  conflicting save → remove photo → sold out → unpublish → archive → restore; validation
  messages; pre-loved and new-size stock rules; duplicate item code and web address; bad,
  oversized, damaged and disguised files; Storage and database failures during upload
  (nothing left behind); metadata removed from stored photos; private draft previews;
  storefront, shop search and cart availability before and after publishing; replaying a
  captured save action as signed out, password-only and non-member sessions (refused,
  nothing changed) and with an old version (refused as a conflict); no passwords, codes,
  keys or tokens in the server log.
- **Mutation checks:** deliberately removing the `aal2` requirement, opening the photo
  bucket to the public, or disabling the identifier lock each made the tests fail.
- **Storefront regression:** 53/53 browser checks against the local build.

**Still to check by hand on `kharchnsave-dev`,** after following the steps above: the
migration and tests in the SQL Editor, the bucket settings, a real upload from your phone,
publishing and unpublishing, and the photo appearing in the shop.

> **Note:** the API (88), browser (85) and storefront (53) checks above were one-off
> scripts run from a temporary folder during development, against a local Supabase stack
> that was started for that session. They were not kept and are **not in this
> repository**; only the SQL tests in `supabase/tests/` are. Repeatable browser tests now
> live in `e2e/` (see [Barcodes and labels](#barcodes-and-labels)).

## Barcodes and labels

Every sellable unit has its own permanent barcode, printed on a 2 × 1 inch label and
scanned at the counter with the USB scanner (Zebra DS4308, keyboard mode). A **sellable
unit** is a product's size row: a pre-loved pair (one of a kind), or one EU size of a new
kids' style (identical pairs share the barcode and have a stock count).

A barcode only **identifies** a size. Price, stock and every other detail always come
from the database, so changing a price never means reprinting labels. Item codes and SKUs
are unchanged; the barcode is a separate value.

### Barcodes

- **Format:** `KNS` + a 7-digit serial number + a check digit, e.g. `KNS00000013`. The
  check digit (Damm algorithm, over the 7 digits) catches every single-digit typo and every
  swap of two neighbouring digits when a code is typed by hand. `S` is easily typed as `5`,
  so the scan box reads `KN5` + 8 digits as `KNS`. About 10 million barcodes are possible,
  and each serial number is used once, whatever the prefix.
- **Retired U barcodes:** the first test labels used `U` + the same 8 digits (e.g.
  `U00000084`, only ever on `kharchnsave-dev`).
  `20261030120000_kns_barcodes.sql` retired them all and gave each of those sizes a KNS
  barcode with a new serial number. They stay in the register; scanning one says the label
  is no longer in use and shows the size's current barcode. No U barcode is issued any
  more, and a U barcode can't belong to a size.
- **Assigned when a size is created,** drafts included, so a pair can be labelled before it
  is photographed or published. The database issues them; nobody can choose one.
- **Never changed, moved, deleted or reused,** not even by the database owner (a trigger
  refuses it). Unpublishing, archiving, restoring, stock changes and a draft's item-code
  change all keep the barcode. The one exception was the switch to KNS above, done once by
  that migration: the test sizes got a new barcode, and their U barcodes were kept, retired.
- **Removed sizes:** a draft's size can still be removed (or its EU size changed, which
  replaces it). Its barcode is then **retired**: kept in the register, never reused, and
  scanning it says the label is no longer in use. The product editor warns before you save
  such a change. Published sizes can't be removed, so their barcodes never retire.
- **Admin-only:** barcodes live in their own table, `variant_barcodes`, readable only by
  verified admins (membership + two-step verification). The storefront and the public key
  can't see them.
- **Item codes can't look like barcodes** (`KNS`, `KN5` or `U` followed by 8 digits), so a
  scan is never ambiguous. Other item codes starting with `KNS`, e.g. `KNS-0001`, are fine.

### Scanning: `/admin/scan`

The scan box is focused when the page opens. The scanner types the code and presses Enter;
the box empties and is focused again immediately, ready for the next pair. A result shows
the photo, name, item code, SKU, EU size, price, stock, status and barcode, with links to
the product and to its label.

Messages say plainly when a pair is **archived** (not for sale), a **draft** (not in the
shop yet), **sold** (pre-loved, stock 0) or **out of stock** (new, stock 0 in that size),
when a label is **no longer in use** (retired), when a typed code has a **typo**, and when
**nothing is found** (with a hint if it looks like a manufacturer's box barcode). Typing an
**item code** lists every size with its barcode; an exact **SKU** also works. Letters may be
typed in lower case, spaces are ignored, and `KN5…` typed by hand is read as `KNS…`.

**Scanning never changes anything.** Lookups are GET requests answered by
`admin_scan_lookup`, a `STABLE` database function: Postgres refuses any insert, update or
delete inside one.

### Printing labels

**Print label** (on each saved size in the product editor, and on a scan result) opens
`/admin/products/[id]/labels`. Each label has the product's name, the EU size, a Code 128
barcode and its readable ID underneath. **No brand, no shop branding and no price.**

- **Name:** the product's **label name** (set in the product editor, next to a live
  preview), or its full product name when that's blank. The website always shows the full
  name. Every print and reprint (label page, Copy ZPL, Download .zpl) uses the same saved
  name; there's no one-off name any more, so a reprint matches the first print. A name
  that doesn't fit is **never shortened**: the label page explains why and links to the
  product, and the download route refuses it (409).
- **Fit rule** (`lib/labels/name-fit.ts`): one line, at most **224 dots** of estimated
  printed width in the 228-dot name box (4 dots spare). Width is measured per character,
  not counted: about 11 × "W" or 37 × "l" fit. Character widths are Arial Narrow Bold's,
  as an estimate of the printer's font 0 (CG Triumvirate Bold Condensed, whose metrics
  Zebra doesn't publish); "New Balance 574 Wh" measures 213 dots and printed on one line.
  Printable: ASCII letters, digits, punctuation and spaces, and Latin-1 accented letters
  (é, ñ, ü…). Curly quotes and dashes print as plain ones (the preview says "Prints as …").
  Anything else (emoji, other scripts, control characters) is refused by name. `^`, `\`,
  the tilde and `_` are sent as `^FH` hex escapes, so a name can never inject ZPL commands.
- **Preview:** a drawing of the label at its real layout, with the name stretched to its
  estimated width. The browser doesn't have the printer's font, so the preview shows size
  and fit, not exact letter shapes; the bars only show the barcode's real width.
- **Quantity:** 1 for a pre-loved pair; for new shoes, the stock of that size. 1 to 100 per
  size. "Labels for all sizes" puts every size of a new style in one file.
- **Printing (works today):** **Download .zpl** or **Copy ZPL**, then in **Zebra Setup
  Utilities** select the printer and either send the downloaded file to it, or open the
  window for communicating with the printer, paste the ZPL and send it. The browser never
  prints to the USB printer directly.

**Layout** (203 dpi, 406 × 203 dots, `^LT20` label top, `^PR4` print speed, both included
in every label; UTF-8 text with `^CI28`). Printed and checked on the shop's ZD888:
"New Balance 574 Wh" and `EU 42.5` each print cleanly on one line.

| Element | Position | Notes |
| --- | --- | --- |
| Name | `^FO28,14`, font `^A0N,26,26`, field `^FB228,1,0,L` (x 28–256) | One line. The field ends 10 dots before the size's field starts. Names wider than 224 estimated dots are refused |
| EU size | `^FO266,14`, font `^A0N,26,26`, field `^FB112,1,0,R` (x 266–378) | e.g. `EU 42.5` |
| Barcode | `^BY2`, `^FO80,46^BCN,88,N,N,N,N` (x 80–326, y 46–134) | Centred: 246 dots wide |
| Readable ID | `^FO0,145`, font `^A0N,30,30`, `^FB406,1,0,C` | e.g. `KNS00000013` |

Both text boxes keep at least 28 dots (3.5 mm) from the label's left and right edges.

**Barcode width:** a Code 128 symbol is 11 modules (start) + 11 per symbol + 11 (check) +
13 (stop). `KNS00000013` is encoded as Code B for `KNS`, a switch to Code C, then 4 digit
pairs: 8 symbols (the fewest possible), **123 modules = 246 dots** (30.8 mm) at `^BY2`.
Code 128 needs 10 modules (20 dots) of white on each side; centred, there are 80 dots each
side. Even if every character were encoded in Code B (11 symbols, 312 dots), it would
still fit. The barcode sits below the name and size (which end at y 40), so its extra
width can't touch them. The
generator allows at most **12 characters**: with 20 dots of quiet zone plus 8 dots (1 mm)
of position tolerance per side, a symbol may be at most 350 dots = 175 modules, and
35 + 11 × 12 = 167 ≤ 175 (13 characters would need 178).

**Text block (`^TB`):** Zebra documents `^TB` for firmware V60.14.x / V50.14.x and later,
but not whether the ZD888's V102.01.07Z firmware supports it, so labels rely on the
width check and the fixed-width `^FB` field instead.

**Calibration print** (do this once before printing real labels): on any label page,
**Download the calibration labels** (`/admin/labels/calibration`) and send the file to
the printer. It prints four labels, each next to `EU 42.5`, with names the width check
accepts at (or close to) its limit:

1. 11 × "W", the widest character (about 222 dots);
2. the checked reference, "New Balance 574 Wh" (about 213 dots);
3. 37 × "l", the narrowest character (about 220 dots);
4. "Écru Navy Trainers 31", accents and digits, exactly at the limit (224 dots).

Every name must print on **one line**, inside its box and clear of the size. If one wraps,
prints over itself or touches the size, the width estimate is too generous: raise
`NAME_SPARE_DOTS` in `lib/labels/name-fit.ts` and test again. If all four leave clear
room, the limit could be raised later, but only after another print test.

Then scan each label's barcode into `/admin/scan`: the calibration barcodes (`KNS99999992`,
`KNS00000013`, `KNS12345671`, `KNS00000021`) should give "Nothing found" or an existing size, never "Check
that code". If anything is cut off or crowded, note which label and what, so the positions
in `lib/labels/zpl.ts` can be adjusted. The wider KNS barcode (246 dots, 30.8 mm, instead
of the 202 dots already printed with U) hasn't been printed yet: reprint the calibration
labels once and check the bars and the 11-character ID print cleanly and scan.

**Later printing options** (not built):

| Option | What it gives | Needs |
| --- | --- | --- |
| Shared Windows printer + `.zpl` file association (`copy /b file.zpl \\PC\ZD888`) | Double-click a downloaded file to print | Windows printer sharing; a driver that passes raw data through |
| Zebra Browser Print | A Print button in the admin | Zebra's free local service on the shop PC, this site approved in it, Zebra's script bundled with the site; ZD888 support to confirm |
| QZ Tray | Silent printing from the browser | A local agent; silent printing needs a paid signing certificate |
| Network printing (port 9100) | Printing without USB | A networked printer and a local helper; the hosted site can't reach the shop's network, and the printer must never be exposed to the internet |
| WebUSB | Direct USB from Chrome or Edge | Replacing the Windows driver with WinUSB, which breaks Zebra Setup Utilities. Not recommended |

### Selling in the shop

The database side exists: `admin_record_in_store_sale` sells sizes with the same stock
rules and locks as online orders (see [Checkout and orders](#checkout-and-orders)). There
are no till screens yet. Scanning stays read-only; a sale is always a separate, explicit
action. Whether draft or archived products may be sold at the counter is a setting
(`in_store_sells_unpublished`), and refused until it is decided.

### Setting it up on `kharchnsave-dev` (in this order)

Apply the migration **before** running this version of the site against
`kharchnsave-dev`: the product editor reads barcodes, so editing products fails until the
migration is in place.

1. Supabase dashboard → `kharchnsave-dev` → **SQL Editor** → **New query**. Paste all of
   `supabase/migrations/20261029200000_variant_barcodes.sql` and click **Run**. Expect
   "Success. No rows returned" (or a result row from the counter's `setval`). It gives every
   existing size a barcode and changes no existing rows.
2. **New query**: paste all of `supabase/tests/barcodes_test.sql` and **Run**. It ends with
   `ROLLBACK` (nothing is kept). Success means every test passed; the first failure stops it
   with `FAIL <test>: <reason>`. Notices list each `PASS`.
3. Optionally re-run the other three test files the same way; they should still pass.
4. `npm run db:verify`: also checks that the public key can't read barcodes.

Running the SQL tests leaves small gaps in the serial numbers (the tests create sizes in a
transaction that is rolled back, and Postgres never gives sequence numbers back). Those
numbers were never issued to anything, so this is harmless.

### Switching `kharchnsave-dev` to KNS barcodes

`20261030120000_kns_barcodes.sql` goes with the version of the site that prints KNS
labels: until both are in place, label printing refuses the other format. Scanning works
throughout.

1. **SQL Editor → New query**, check that no item code is in the way (the migration would
   stop on it):
   `select item_code from public.products where item_code ~ '^KN[S5][0-9]{8}$';`
   Expect no rows.
2. **New query**: paste all of `supabase/migrations/20261030120000_kns_barcodes.sql` and
   **Run**. Expect "Success. No rows returned".
3. **New query**, check the result:

   ```sql
   select b.barcode, b.sku_at_issue, b.variant_id is not null as live
   from public.variant_barcodes b
   order by b.product_id, b.size_eu, b.created_at;
   ```

   Each size should have its old `U…` row (`live` false) followed by one `KNS…` row
   (`live` true), with serial numbers after the U ones. A size removed before today has
   only its U row.
4. Run `supabase/tests/barcodes_test.sql` as above (and optionally the other three).
5. `npm run db:verify`.
6. With this version of the site running against `kharchnsave-dev`: scan the old test label
   (`U00000084`). It should say the label is no longer in use and show the size's new KNS
   barcode, with a link to print its label. Print it, reprint the calibration labels, and
   scan them. Then throw the U label away.

### Tests

| Command | What | Needs |
| --- | --- | --- |
| `npm test` | Unit tests (Vitest): check digit, scan input, ZPL layout, barcode width, name shortening, quantities, ZPL injection | Nothing |
| SQL Editor or `supabase test db` | `supabase/tests/*.sql` | A Supabase database (local Docker stack, or the SQL Editor) |
| `npm run test:e2e` | Browser tests (Playwright) for the scan page and label download | Docker + the Supabase CLI's local stack with all migrations, `supabase/seeds/dev_catalogue_fixtures.sql` and `e2e/fixtures.sql`; a production build running against it (`E2E_BASE_URL`); a test admin with an authenticator app (`E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_ADMIN_TOTP_SECRET`); `npx playwright install chromium` once |

The browser tests only read data and sign in, and are skipped when the variables aren't
set. Never point them, or `e2e/fixtures.sql`, at a hosted project.

### Barcodes verification status

- **Unit tests:** barcode and label tests pass. Lint, type-check and production build pass.
- **KNS migration:** in PGlite (below) on dev-like data: sizes with U barcodes, one of them
  already retired, then `20261030120000_kns_barcodes.sql`. Every size ended up with one
  KNS barcode with a new serial number. Every U row was kept unchanged apart from its size
  link, and the already-retired one got no replacement. Scanning an old U label (typed in
  lower case) named the new barcode, and `kn5 …` found the size. Also run on the
  production path (no sizes when the migrations run): no U barcode ever exists, and the
  first size gets `KNS00000013`. Two deliberate breakages (no serial index; no KN5 rule)
  made `barcodes_test.sql` fail, as it should.
- **SQL:** all five migrations and all four SQL test files (276 checks, including the 68
  barcode checks) ran without errors in PGlite, a WebAssembly build of Postgres, with small
  stand-ins for Supabase's `auth` functions, API roles, default grants, `storage.objects`
  and an `rls_auto_enable()`-style event-trigger function, and also with real
  admin-created products present (an archived `TEST-0001` and a published listing whose
  slug starts with `test-`). The SQL tests count only the rows they create; their
  visibility checks cover every product in the database. They ran on a fresh database and on top of the dev fixtures (the
  backfill). **That is not Supabase:** PostgREST (the API's embedding of barcodes and the
  lookup functions), real Supabase Auth and the hosted project's grants are untested.
- **On `kharchnsave-dev`:** the migration applied (the backfill set the counter to 8).
  The first run of `barcodes_test.sql` failed only on its search_path check, which also
  flagged Supabase's own `rls_auto_enable()`. The check now applies the strict rule to
  every SECURITY DEFINER function except event triggers (which our migrations never create).
  Re-run the test there to confirm. The KNS migration hasn't been applied there yet (see
  the steps above).
- **Not run yet:** the browser tests (no local Supabase/Docker available), and a real print
  and scan of a KNS label on the ZD888 and DS4308.

## Links page and merchandise QR code

**`/qr`** is the permanent address printed on merchandise as a QR code
(`https://kharchnsave.pk/qr`). It answers with a **temporary 307 redirect**, marked
`no-store`, to `QR_REDIRECT_TARGET` in `lib/links.ts` (today
`/links?utm_source=merch&utm_medium=qr`). Browsers and caches never remember it, so
the printed codes can be pointed somewhere else later by changing that one value and
deploying. Never change it to a permanent (301/308) redirect.

**`/links`** is a standalone, mobile-first page (no shop header, footer or demo notice):
the K mark, name, tagline and a button per entry in `LINKS` (`lib/links.ts`):
Instagram, Facebook, Shop Men / Women / Kids and the homepage. External links open in a
new tab with `rel="noopener noreferrer"`. To add WhatsApp or anything else, add an entry
to `LINKS`. It has its own title, description and social preview image
(`app/links/opengraph-image.tsx`); `metadataBase` (root layout) is
`https://kharchnsave.pk`, so shared links show the production address.

Pages listed in `STANDALONE_PATHS` (`components/layout/site-chrome.tsx`) are shown without
the shop's chrome. The header and footer are still included in those pages' React data
(about 30 KB on `/links`, invisible); moving the shop's pages into a route group with
their own layout would remove that if it ever matters.

**The QR codes** (`npm run qr`, files and printing advice in `merch/qr/README.md`) always
encode `QR_CODE_URL` (`https://kharchnsave.pk/qr`), never the address the site is
running on. Version 6 (41 × 41), error correction H, a 4-module quiet zone, and the K
mark in the centre on a cleared area of exactly 15 × 15 modules (whole modules cleared,
no tile). Two designs:

- **Main** (`merch/qr/`): white modules and the white K mark (`public/brand/logo-white.svg`)
  on forest green, quiet zone included. This is an **inverted** code: test printed
  proofs on several phones, including older Android phones and the WhatsApp and
  Instagram scanners, before ordering.
- **Light** (`merch/qr/light/`): forest-green modules and the green K mark on white, a
  normal code, for merchandise where scanning reliability matters more than looks.

For each design, of the 8 mask patterns it uses the one that leaves the most error
correction spare after the logo area: at most 10 of the 14 errors each block can fix
are used, counting modules under the mark's edges and the lime tag as misread.

**Tests:**

- `npm test` decodes the committed PNG and SVG of both designs with two real decoders
  (jsQR and ZXing; the main design in their inverted mode): clean, with two scratches
  across them, and blurred (0.3 modules). It also checks that the main design, with its
  colours inverted, decodes as an ordinary dark-on-light code (and that a scanner
  without inverted support can't read it as printed), the logo area, the PDFs (one 50 mm
  page, vector only), that the files are up to date, and that the per-block error count
  predicts both decoders: each block still decodes with 14 errors in the worst case,
  and fails with 15 certain ones. Also covered: `/qr`'s 307 and headers, and that
  `/links` renders every configured link.
- `e2e/links.spec.ts` checks the same against a running build over HTTP (no browser
  needed): `npm run build`, `npm start`, then
  `E2E_BASE_URL=http://localhost:3000 npx playwright test e2e/links.spec.ts`.

## Checkout and orders

Guest checkout with **cash on delivery**, admin order management, and stock rules shared
with in-store sales. It is built and tested, and **switched off**: the website shows the
"Checkout isn't connected yet" page until it is configured, and the database refuses
orders until `shop_settings.orders_open` is on, which it can't be until every required
setting is decided.

### How an order works

1. **Cart → `/checkout`.** The page asks the database for a live quote (prices, stock,
   delivery). It is never cached. Anything that changed since the item was added is
   shown on its line ("Price is now…", "Only 1 available now…", "Sold out…"). Nothing is
   ordered until the customer taps **Update my cart** and places the order.
2. **Details:** full name, Pakistani mobile number, city, full address, optional landmark
   and note. These fields are provisional: confirm them against TCS's booking
   requirements before going live (city names, required fields, length limits).
3. **Place order:** the server checks the input, the rate limits and the Turnstile check,
   then the database recalculates every price, the delivery fee and the total from its own
   rows. If anything differs from what the customer saw, no order is placed and the new
   quote is shown instead.
4. **Placed:** the pairs are held for the order (`reserved`) for the hold time (24 hours),
   the cart is emptied, and the customer sees `/order#k=…`, a private link (see below).
5. **Admin:** confirms by phone or WhatsApp, dispatches with the courier and tracking
   number, then records delivery, a failed delivery, a return and the payment.

### Stock: available and held

| Column | Meaning |
| --- | --- |
| `product_variants.stock` | Pairs available to sell now (what the shop shows) |
| `product_variants.reserved` | Pairs held for online orders not yet dispatched |
| `stock + reserved` | Pairs on the shelf |

| Event | Available | Held | Ledger reason (once per…) |
| --- | --- | --- | --- |
| Order placed | −q | +q | `order_reserve` (item) |
| Cancelled or hold expired, before dispatch | +q | −q | `order_release` (item) |
| Dispatched | | −q | `order_dispatch` (item) |
| Failed delivery, delivered | | | (none: the parcel is out) |
| Parcel back, pair restocked | +n | | `return_restock` (return line) |
| Parcel back, pair written off | | | `return_write_off` (return line, recorded only) |
| In-store sale | −q | | `in_store_sale` (item) |
| Admin stock edit | ±, if unchanged since loaded | | `admin_set` |

Every change to `stock` or `reserved`, from any source, writes a row to
`public.stock_movements` (a trigger does it), so for every size `stock` = sum of
`available_delta` and `reserved` = sum of `reserved_delta`. The migration starts each
existing size with an `opening_balance` row. Each order or return movement has a unique
`event_key`, so it can only be applied once.

**Admins can no longer write sizes through the API directly.** The product form sends,
for each size, the stock and inventory version it loaded: a size's stock is written only
if the admin changed it, and only if nobody (an order, another admin) changed it since.
The version only ever increases, so 3 → 2 → 3 still counts as a change. Saving just the
description never touches stock.

### Order statuses and payment

| Status | Next |
| --- | --- |
| `awaiting_confirmation` | `confirmed`, `cancelled` (admin, or the hold expires) |
| `confirmed` | `dispatched`, `cancelled` |
| `dispatched` | `delivered`, `delivery_failed` |
| `delivery_failed` | `dispatched` (try again), `delivered`, `returned` |
| `delivered` | `returned` |
| `cancelled`, `returned` | none |

In-store sales are `completed`. Payment is what staff record; **the app never moves
money**:

| Payment | When |
| --- | --- |
| `pending` | Not collected yet. Stays pending through a failed delivery, which may be retried |
| `collected` | Delivered and the courier collected the full total |
| `settled` | The courier paid the shop |
| `refund_due` | A paid order came back |
| `refunded` | A refund was made outside the app (amount up to what was collected) |
| `void` | Cancelled, or returned without anything collected |

A dispatched order can't be cancelled and its stock isn't restored by a failed delivery:
pairs come back on sale only when the parcel is received and each pair is checked.

### Locking and retries

Every operation takes its locks in one order: the request key (an advisory lock), then
(placing an order only) the phone number (another advisory lock, so two orders from one
number can't both pass the open-order limit), then `shop_settings`, then orders, then
products, then sizes, each by id, and last the shop-wide quota row, held only for the
final insert. Customers with different numbers never wait for each other's phone
lock. Placing an order
holds the products it sells for reading, so a price change, unpublishing or a delivery-fee
change either waits for it or makes it see the new values (and return "quote changed").
The stock check and the order are one transaction. Lock waits are capped (2 s for orders,
5 s for the expiry job). The website retries lock timeouts, deadlocks, serialization
failures and network errors at most three times (`lib/db/retry.ts`); that is safe
because every order call carries its checkout key and every admin action a request id,
so a repeat returns the first result.

### Order hold expiry

An unconfirmed order holds its pairs until `hold_expires_at` (24 hours). Then:

- **Scheduled job:** `private.expire_order_holds()` runs every minute through `pg_cron`
  and releases expired orders, each order whole or not at all. Set up with
  `supabase/setup/schedule_order_expiry.sql` after enabling `pg_cron`.
- **Failures stay visible:** the work runs inside an inner block, so a failed run is
  rolled back but still recorded in `private.job_heartbeats` (and in
  `cron.job_run_details`). The admin Orders and Settings pages warn if the job isn't
  scheduled, hasn't succeeded for 10 minutes, failed, or left holds overdue by 5 minutes,
  and offer **Release expired holds now**.
- **Backups:** placing an order or an in-store sale releases expired orders on the sizes
  it needs first, and confirming an expired order releases it instead.
- **In the shop's pages:** the job can't reach Next.js, so a released pair appears when
  the cached catalogue next refreshes (in the background, at most once a minute while
  the shop gets visits; a page already open in a browser may keep its copy up to 5
  minutes). Checkout itself always reads live stock. Admin cancellations and returns
  refresh the catalogue at once.

### Security and privacy

- **The publishable key is public**, so the guest functions (`quote_order`,
  `place_cod_order`, `checkout_resolve`, `get_customer_order`,
  `checkout_register_attempt`) all require the **checkout gateway secret**. Only the
  website has it; the database stores only its SHA-256 hash. A call straight to the API
  without it is refused before anything is read.
- **Visitors** have no access to any order table; they can read only the storefront's
  size columns (not held stock). **Signed-in users** may `SELECT` the order tables, but
  row-level security returns rows only to verified admins (member + aal2). **Nobody**
  writes order tables or sizes directly; only the functions do. Internal helpers and
  private tables live in the `private` schema, which API roles can't use at all.
- **Bot protection:** Cloudflare Turnstile, checked on the server and bound to the order
  attempt; per-connection rate limits in the database, counted before Turnstile (a
  refusal stops there); a whole-shop "orders per minute" quota that only new orders use
  up, taken inside `place_cod_order` after every other check (so refused attempts, bots
  failing Turnstile and retries of a placed order can't exhaust it; when it is full the
  customer sees "we're receiving a lot of orders" and nothing is ordered); per-order
  limits; hold expiry; and a per-phone limit, which is only supplementary because
  anyone can type a different number. If Turnstile can't be reached, orders are refused.
- **Quotes** show a draft, archived or unknown SKU as just "unavailable", with no name,
  brand, size, condition or price (in-store quotes for verified admins are unchanged).
- **The order link** `/order#k=…` carries a 32-byte random key in the part after `#`,
  which browsers never send to servers; the page posts it in the request body. The
  database stores only its hash. An order number plus phone number is never enough. The
  page shows the first name, the last three digits of the phone number, the city, items
  and totals, never the address.
- **Retries never duplicate:** the key is made in the browser and kept (with a
  description of the cart, but no personal details) until the outcome is known. The same
  key with the same contents returns the existing order; with different contents it is
  refused. Before a new key is made after the cart changes, the old one is settled: the
  order is shown if it exists, otherwise the key is marked abandoned so a late request
  can never use it.
- **Logs** hold database error codes only, never personal details or keys.

### Checkout: setup

Nothing here has been done on any hosted project. There are three separate stages, and
the first two need no public deployment.

#### A. Apply the migrations to `kharchnsave-dev`

In the dev project's SQL Editor:

1. Run `supabase/migrations/20261031120000_inventory_ledger.sql`, then
   `supabase/migrations/20261031130000_guest_orders.sql`, then
   `supabase/migrations/20261031140000_settings_where_clauses.sql`, then
   `supabase/migrations/20261101120000_label_names_and_light_up.sql`, then
   `supabase/migrations/20261101130000_item_codes_and_sale_prices.sql`, then
   `supabase/migrations/20261116120000_product_writes_through_functions_only.sql`, then the
   five `supabase/migrations/20261117120*.sql` files as staged in stage D (the last one,
   `…120400`, only after every copy of the site runs this version). Each runs as one
   transaction: if it fails, nothing changes.
2. Run every `supabase/tests/*.sql` file. They roll back and leave nothing behind.
3. Optional now, needed before taking orders: enable `pg_cron` (Dashboard →
   Integrations → Cron) and run `supabase/setup/schedule_order_expiry.sql`. It is safe
   to run again and keeps exactly one job. A few minutes later,
   `select * from private.job_heartbeats;` should show a recent `last_succeeded_at`.
   **This pg_cron step has not been verified anywhere yet.** The script's own logic is
   tested against a stand-in, not real pg_cron.

**Which code goes with which database.**

| Code | Database | What happens |
| --- | --- | --- |
| This version (local) | dev **without** the migrations | Storefront, dashboard, product list, scan and labels work. **The product edit page fails to load** (it reads `reserved` and `inventory_version`). Adding a product saves it, but the redirect to its edit page then fails. **Orders and Settings show errors.** Checkout stays off unless configured. |
| This version (local) | dev **with** the migrations | Everything works. |
| The previous version (e.g. a hosted deployment of `c0aa0d6`) | dev **with** the migrations | Storefront, scan and labels work. Its product editor loads, but any stock change it saves is refused ("stock change must name the inventory version"). Nothing is lost. |

So apply the migrations before using the product editor with this version. Since the label
name and light-up change, this version also reads the new product columns: **without
`20261101120000_label_names_and_light_up.sql` the shop's product pages and the product
editor show errors.** Code from before that change keeps working with it applied (it
doesn't read the new columns, and its saves keep their values). The same holds for
`20261101130000_item_codes_and_sale_prices.sql`: this version reads `sale_price_paisa`, so
apply it before running this code against dev. **Since the 2026-11-17 hardening this
version reads products in the admin through `admin_get_products`: without
`20261117120200_internal_columns_admin_reads.sql` the product list and editor show
"couldn't be loaded".** The previous version keeps working with every 2026-11-17
migration except `20261117120400_restrict_internal_columns.sql`, after which its product
list and editor stop loading; stage D applies that one last, once no copy of the
previous version is left.

#### B. Run this version locally against `kharchnsave-dev`

No deployment needed. `.env.local` already points the site at dev.

1. Run the site as usual (`npm run dev`, or `npm run build && npm start`). Restart the
   dev server after pulling this code. The admin area, Orders and Settings work at once.
2. **To try checkout locally**, add to `.env.local` (never commit it):
   - `CHECKOUT_ENABLED=true`
   - `CHECKOUT_GATEWAY_SECRET`: run `node scripts/checkout-gateway-key.mjs`. It writes
     this for you and prints an `insert` statement; run that in dev's SQL Editor, which
     stores only the hash.
   - Cloudflare's **testing** keys, for local use only:
     `TURNSTILE_SITE_KEY=1x00000000000000000000AA`,
     `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` and
     `CHECKOUT_TURNSTILE_TESTING_KEYS=allow`. Without that last line, testing-key
     answers are refused, as they always are on a host. The admin pages show a warning
     while it is set.
   - `CLIENT_IP_SOURCE=none`, so everyone shares one rate-limit bucket. That's fine
     locally.
3. In the admin **Settings** page, fill in the settings and tick **Take orders**. This
   only affects dev. Real orders placed this way are dev data; cancel them in Orders.
4. Untick **Take orders** (or remove `CHECKOUT_ENABLED`) when done.

#### C. Hosted deployment (later, once hosting is decided)

1. **Database:** stage A on the hosted database the deployment will use, with the
   expiry job scheduled and healthy.
2. **Build settings:** set the host's environment before building.
   `NEXT_PUBLIC_SUPABASE_*` values are compiled into the build, server code included.
3. **Checkout secret:** a separate `CHECKOUT_GATEWAY_SECRET` for each deployment,
   registered by hash.
4. **Turnstile:** a real widget for the site's hostname (never the testing keys, and never
   `CHECKOUT_TURNSTILE_TESTING_KEYS`). Optionally set `TURNSTILE_ALLOWED_HOSTNAMES`.
5. **Client IP:** `CLIENT_IP_SOURCE` from the host's own documentation, proven with the
   three checks in stage E before checkout is switched on. Netlify's
   documentation (checked 2026-10-30) gives the IP only as `context.ip` /
   `getContext().ip` and documents no header, so it is undecided for Netlify. Hosts
   running several instances also need `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.
6. **Before switching on:** run the manual checks on that deployment: place, confirm,
   dispatch, fail, retry, deliver, expire, cancel, return, and the `/order#k=…` page.
   Update `/delivery-returns`, the cart's demo note and the footer note.
7. **Switch on:** `CHECKOUT_ENABLED=true`, then tick **Take orders**.

#### D. Hosted follow-up for the 2026-11-17 hardening (owner)

None of this has been done on a hosted project; everything below was tested on local,
throwaway PostgreSQL only (`npm run test:db`, including `db-tests/hardening.test.ts`
section 8, which runs stages 1 and 3 in order).

**Rollout, in four stages.** Only one change is incompatible with the previous version
of the site: `20261117120400_restrict_internal_columns.sql` stops its admin product list
and editor from loading (they read the label name and held stock directly). Everything
else works with both versions, so that one is applied last. Run each migration in the
SQL Editor (it runs as `postgres`, the role that owns the schema), one query per file;
each is one transaction, so a failed run changes nothing.

| Stage | Do | Previous version of the site | This version |
| --- | --- | --- | --- |
| 0. Inventory | List every copy of the site that uses this database: hosted deployments (production, previews/branch deploys) and anyone's local `npm run dev`/`npm start`. Note which commit each runs. | | |
| 1. Expand | Apply `20261117120000_function_default_privileges.sql`, `20261117120100_checkout_quota_quotes_and_phone_limit.sql`, `20261117120200_internal_columns_admin_reads.sql`, `20261117120300_idempotent_photo_registration.sql`, in that order. Run the check query below: it must match **Stage 1 complete**. | Works (its checkout shows a refusal it doesn't know, "busy", as a general error; checkout is off) | Works |
| 2. Switch the site | Short admin pause: ask admins to save their work and close admin tabs. Deploy this version to every copy found in stage 0 (restart local servers on this code); remove or redeploy any preview still on the previous version. Then admins reopen the admin. | Retired | Works |
| 3. Contract | Only when stage 0's list contains this version alone: apply `20261117120400_restrict_internal_columns.sql`. Run the check query (it must match **All hardening complete**) and the smoke test below. | Admin product list and editor fail (storefront, checkout, scan, labels still work) | Works |

Notes on stage 2: admin sign-ins (Supabase sessions) stay valid across the deploy, so
nobody has to sign in or redo two-step verification. A tab opened before the deploy runs
the old page code; its next Save, photo upload or status change is answered with an
error by the new server (Next.js only accepts actions from the build that served the
page). The editor keeps the typed values on screen, but reload before carrying on,
which is why admins save and close their tabs first.

Supabase CLI users: `supabase db push` would apply all five at once. Apply stage 1 in the
SQL Editor and record it with `supabase migration repair --status applied <version>`
for each, then push (or run `…120400` by hand) at stage 3.

**Check query** (read-only, safe at any stage; `null` means that function doesn't exist
yet). The three `*_default_execute` columns read the default EXECUTE privileges on
functions that `postgres` creates from now on. They look at the global default (when there
is no global entry, PostgreSQL's built-in default applies, and it includes PUBLIC) plus the
additions for the `public` and `private` schemas. Each privilege entry is checked by
grantee, so the owner's own `postgres=X/postgres` doesn't count as PUBLIC. That owner
privilege is intended (`…120000` keeps it) and is reported as `owner_default_execute`.
```sql
with fn_default as (
  -- EXECUTE on functions postgres creates from now on: the global default (the
  -- built-in default when no row exists, which includes PUBLIC) plus the
  -- additions for the public and private schemas.
  select x.grantee
  from (
    select coalesce(
      (select d.defaclacl from pg_default_acl d
       where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'),
      acldefault('f', 'postgres'::regrole)) as acl
    union all
    select d.defaclacl from pg_default_acl d
    where d.defaclrole = 'postgres'::regrole and d.defaclobjtype = 'f'
      and d.defaclnamespace in (to_regnamespace('public'), to_regnamespace('private'))
  ) a, aclexplode(a.acl) x
  where cardinality(a.acl) > 0 and x.privilege_type = 'EXECUTE'
)
select
  case
    when to_regprocedure('private.lock_phone(text)') is null
      or to_regprocedure('public.admin_get_products(uuid[])') is null
      or to_regclass('private.photo_registrations') is null then 'stage 1 incomplete'
    when has_column_privilege('authenticated', 'public.products', 'label_name', 'SELECT')
      or has_column_privilege('authenticated', 'public.product_variants', 'reserved', 'SELECT') then 'stage 1'
    else 'stage 3'
  end as stage,
  has_function_privilege('anon', to_regprocedure('public.admin_get_products(uuid[])'), 'EXECUTE') as anon_admin_read,
  exists (select 1 from fn_default where grantee = 0) as public_default_execute,
  exists (select 1 from fn_default where grantee in ('anon'::regrole, 'authenticated'::regrole)) as api_default_execute,
  exists (select 1 from fn_default where grantee = 'postgres'::regrole) as owner_default_execute,
  has_function_privilege('authenticated', to_regprocedure('public.admin_get_products(uuid[])'), 'EXECUTE') as admins_can_read,
  has_function_privilege('anon', to_regprocedure('public.place_cod_order(text, text, jsonb)'), 'EXECUTE') as checkout_works;
```

| Result | `stage` | `anon_admin_read` | `public_default_execute` | `api_default_execute` | `owner_default_execute` | `admins_can_read` | `checkout_works` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Stage 1 complete** (the four expand files) | `stage 1` | `false` | `false` | `false` | `true` | `true` | `true` |
| **All hardening complete** (after stage 3, `…120400`) | `stage 3` | `false` | `false` | `false` | `true` | `true` | `true` |

- `stage 1 incomplete` means `…120100`, `…120200` or `…120300` is missing. A missing
  `…120000` shows as `true` in `public_default_execute` and `api_default_execute`.
- Any other combination is not a state to continue from: stop and find the cause.
- **Stage 1 complete is not the end of the hardening.** Until stage 3, any signed-in
  account can still read label names and held stock directly.
- The hardening is complete only when the query shows the second row, every
  `supabase/tests/*.sql` file passes (they roll back), `npm run db:verify` passes, and the
  smoke test below passes.

Checked on 2026-11-21 on throwaway local PostgreSQL only (embedded, with
`db-tests/supabase-stub.sql`):
- Before stage 1, `public_default_execute` was `true`.
- After `…120000`, after stage 1 and after stage 3, the query gave the rows above.
- With EXECUTE for PUBLIC deliberately restored (global, `public` and `private` defaults)
  or for `anon`/`authenticated` (`public`), each in a transaction that was rolled back, the
  query reported it.
- The previous version of this query matched the owner's own entry, so it showed `true`
  after a correct `…120000`, and `false` before it.
**Smoke test** (after stages 2 and 3, as a verified admin): open the product list and a
product (label name and held stock show), print a label, scan a barcode, upload a photo,
save and publish.

**Recovery.** Every recovery keeps the access restrictions; none re-grants columns.
- A stage 1 migration fails: nothing from that file was applied. Fix the cause and run
  it again; later files wait.
- This version misbehaves after stage 2, before stage 3: roll the site back to the
  previous version; stage 1 works with it. Fix forward, then repeat stage 2.
- After stage 3, a copy of the previous version turns up, or the site has to be rolled
  back past this version: its admin product list and editor stay unavailable (shop,
  checkout, scan and labels keep working) until this version is deployed there again.
  Treat that as an admin maintenance window. **Don't undo `…120400` by granting the
  columns back:** a column grant can't be limited to admins, so it would show label
  names and held stock to every signed-in account again. Urgent product changes in the
  meantime go through the owner in the SQL Editor.
- Undoing stages 1–3 isn't scripted; prefer fixing forward. If `…120300` ever has to be
  replaced, keep `private.photo_registrations`: it is what makes upload retries safe.

**After the rollout:**

1. **From now on, grant new functions explicitly.** A function created by hand in the
   SQL Editor is callable by nobody but its owner until you
   `grant execute on function … to authenticated;` (or `anon`), as every migration does.
2. **Disable public sign-up** (Dashboard → Authentication → Sign In / Providers →
   **Allow new users to sign up**: off, then Save). Admin accounts are made by the owner,
   not by sign-up: Authentication → Users → **Add user** (or **Invite**) still works, then
   add the membership as in [Making yourself an admin](#making-yourself-an-admin-one-time-owner-setup).
   Existing admins and their two-step verification are unaffected. Check:
   `curl -s "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"`
   shows `"disable_signup":true`. (On 2026-11-16 it was `false`.)
3. **Client IP (`CLIENT_IP_SOURCE`)**: see the next section. Checkout must stay off on
   the host until its three checks pass.

#### E. Client IP header: choosing it and proving it (PENDING: no host selected yet)

**Choosing.** Use only a header the chosen host documents as **set by its own edge,
replacing anything the visitor sent**, and holding exactly one address (for example
Cloudflare's `CF-Connecting-IP` or Vercel's `x-real-ip`; read the chosen host's current
documentation: Netlify's documented none on 2026-10-30). Never `X-Forwarded-For` (the
site refuses it). Set `CLIENT_IP_SOURCE=header:<name>`.

**What the site does** (unit-tested: `lib/checkout/server-config.test.ts`):

| `CLIENT_IP_SOURCE` | On a request | Result |
| --- | --- | --- |
| unset, empty or invalid (e.g. `header:x-forwarded-for`) | | Checkout is off: `/checkout` shows "Checkout isn't connected yet", `/api/checkout/quote` answers `503 {"error":"disabled"}`, the admin pages list `CLIENT_IP_SOURCE` as not set |
| `none` | | Every request counts in one bucket shared by everyone (`ip:unknown`) |
| `header:<name>` | the header holds one valid address | That address's own bucket (stored only as an HMAC) |
| `header:<name>` | the header is missing, empty, a list or not an address | The shared bucket, as with `none` (strict, never a bypass) |

**Proving it on the deployment.** Three checks, all **pending** until a host is
selected. Prepare: checkout configured on that deployment (taking orders can stay off;
quotes still work), and in Settings a temporary **price checks per connection, 10 min**
of `5`. Use two devices on **different networks** (a laptop on Wi-Fi, a phone on mobile
data with Wi-Fi off) and confirm their public addresses differ. Rate-limit windows last
10 minutes: start each check in a fresh window (wait 10 minutes between checks).

```bash
# One quote request; prints the HTTP status (200, 429 or 503). Extra arguments are headers.
quote() { curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<site>/api/checkout/quote" \
  -H "content-type: application/json" "$@" -d '{"lines":[{"sku":"X","quantity":1,"unit_price_paisa":100}],"city":""}'; }
```

| # | Check | Steps | Pass |
| --- | --- | --- | --- |
| 1 | Two real addresses get separate buckets | Device A: `quote` 6 times. Then device B: `quote` once. | A's 6th is `429`; B's is `200` |
| 2 | Forged headers can't change who you are | Device A, while still limited from check 1 (same window): `quote -H "<header-name>: 198.51.100.1"`, then the same with `-H "X-Forwarded-For: 198.51.100.2"`, `-H "X-Real-IP: 198.51.100.3"`, `-H "CF-Connecting-IP: 198.51.100.4"`, `-H "True-Client-IP: 198.51.100.5"`, `-H "Forwarded: for=198.51.100.6"`. Also, in a fresh window, 7 requests from A each forging a different `<header-name>` value. | Every forged request from A is `429`; of the 7, the 6th and 7th are `429`. Any `200` means a visitor-supplied value was trusted: don't use that header |
| 3 | Missing or invalid header behaves as documented | (a) Set `CLIENT_IP_SOURCE=header:x-kns-not-set` (a header the host never sends) and redeploy. Fresh window: device A `quote` 5 times, then device B `quote` once. (b) Set `CLIENT_IP_SOURCE=header:x-forwarded-for` and redeploy: `quote` from either device; open `/checkout` and the admin Orders page. | (a) B's request is `429` (both share the one bucket). (b) `503`, the "isn't connected yet" page, and the admin warning naming `CLIENT_IP_SOURCE` |

Afterwards restore the real `CLIENT_IP_SOURCE`, redeploy, and set the quote limit back.
Record the date, host and header name here when all three pass.

| Check | Status |
| --- | --- |
| 1. Separate buckets for two real addresses | Pending (no host selected) |
| 2. Forged headers ignored | Pending (no host selected) |
| 3. Missing/invalid header behaviour on the host | Pending (no host selected); the site's side is unit-tested |


**To stop taking orders at once:** untick **Take orders** (the database refuses new
orders immediately), or unset `CHECKOUT_ENABLED`. Undoing the migrations isn't scripted.
Before real orders exist it means dropping the new tables and functions and restoring the
earlier `admin_save_product`; prefer switching off and fixing forward.

### Decisions still open

- **Delivery areas** (everywhere, or listed cities) and TCS's exact city and address
  requirements.
- **Free-delivery boundary:** "above Rs. 4,999" (includes Rs. 4,999.50; enter 4999.01)
  or "Rs. 5,000 and above" (enter 5000). The setting is an inclusive minimum.
- **Limits** (proposed, not approved):

  | Setting | Proposal | Why |
  | --- | --- | --- |
  | Sizes per order | 10 | Covers a family order; most orders are one or two pairs |
  | Pairs per order | 10 | Same |
  | Pairs of one size per order | 4 | Siblings in kids' sizes; stops one order emptying a size |
  | Unconfirmed orders per phone | 2 | Supplementary only (numbers can be invented) |
  | Order attempts per connection, 10 min / day | 10 / 50 | Pakistani mobile networks share addresses between many customers (carrier NAT), so per-connection limits must be generous |
  | Order-page lookups per connection, 10 min | 30 | Customers reload their order page |
  | Price checks per connection, 10 min | 120 | Checkout re-checks prices when the cart or city changes; generous because many customers share an address |
  | Order attempts per minute, whole shop | 30 | Emergency brake against a flood |

- **Hosting** (Netlify is a candidate) and its client-IP handling.
- **Selling unpublished products in the shop** (Settings, refused until decided).

### Tests

| Command | What | Needs |
| --- | --- | --- |
| `npm test` | Unit tests, including checkout input, keys, Turnstile, configuration, retries and the order flow with fakes | nothing |
| `npm run test:db` | Every migration and every `supabase/tests/*.sql` file on **real PostgreSQL** (fresh database, and existing data first), plus races with many simultaneous connections (`db-tests/concurrency.test.ts`) | nothing: it starts a throwaway local PostgreSQL server (the `embedded-postgres` package, no Docker); or set `DB_TESTS_URL` (localhost only) and `ALLOW_DB_TESTS=1` |
| `npx playwright test e2e/checkout.spec.ts` | Checkout while it is off: closed APIs, the order page, admin access | a running build |
| `npm run test:e2e:checkout` | **The real checkout UI and Server Action through to stored orders and stock** (`e2e/checkout-local.spec.ts`): a successful order and its private page; a double click and two tabs at once; a lost response, then retry and refresh; changed details under the same key; spent and failing bot checks; abandoning a key before and after its order commits. Also the sales-agent flows (`e2e/referrals-local.spec.ts`), score pricing and sales (`e2e/pricing-local.spec.ts`), permanent product deletion (`e2e/product-deletion-local.spec.ts`), and dragging photos into order and flipping an uploaded one (`e2e/photo-order-local.spec.ts`, mouse and touch). `E2E_SPECS=e2e/pricing-local.spec.ts` runs only the files named | internet access (Turnstile). It starts a throwaway PostgreSQL with every migration, a minimal stand-in for Supabase's HTTP API (`e2e/local-stack/postgrest-shim.mjs`, **not** PostgREST, Auth or Storage; it keeps product photos in memory with the bucket's access rules), a build in `.next-e2e` and three servers using Cloudflare's Turnstile **testing** keys |

The races cover: 20 buyers for one pre-loved pair (exactly one order); 8 buyers for 5
pairs; carts with the same sizes in opposite order; an online order against an in-store
sale; the same key 10 times at once; the same key with different contents; abandoning a
key while it is being placed; a lock timeout recovered by the retry helper; stale admin
stock edits, description saves, price changes, unpublishing and delivery-fee changes
during orders; the expiry job against a confirm, a second job and a new order; a whole
expiry run failing; two cancels, cancel against expiry and against dispatch; the same
return recorded twice; a failed delivery dispatched again by three admins at once. The
stock ledger is reconciled after each. `db-tests/schedule-script.test.ts` checks
`schedule_order_expiry.sql` against a stand-in for pg_cron (repeat-safe, exactly one
job), not real pg_cron.

### Checkout verification status (2026-10-30)

- **Passed locally:**
  - `npm test`: 147 tests.
  - `npm run test:db` on PostgreSQL 17.10: 23 tests. That covers 401 SQL checks across
    the five SQL files (125 in `orders_test.sql`, including a failed delivery dispatched
    again twice), 18 race tests and 3 schedule-script tests.
  - `npm run test:e2e:checkout`: 6 browser scenarios, on three separate runs.
  - `e2e/checkout.spec.ts` against a local build.
  - Lint, type-check and build.
- **Shown to catch regressions:** three deliberate mutations of the orders migration were
  each caught (a reused key accepted with different contents; skipping locked expired
  orders; the expiry job not recording a failed run).
- **Bugs found by these tests, and fixed:**
  - selling counted pairs held by an expired order another transaction had locked;
  - refreshing after a lost response showed "Your cart is empty" instead of the order.
- **Not yet verified:**
  - anything on a hosted Supabase project, including real PostgREST, Auth and **pg_cron
    scheduling**;
  - local Supabase (Docker not started);
  - a real Turnstile widget on a real hostname;
  - TCS booking;
  - the host's client-IP header.

## Sales agents

Admins create sales-agent accounts. Each agent has a login, a display name, a username and
one referral code, plus terms the admin sets: a customer discount and a commission. Anyone may
share a code: every qualifying order placed with it earns its agent commission, whoever shared
it. Public sign-up stays disabled; agents only exist because an admin created them.

| Where | What |
|---|---|
| `/admin/agents` | List (current terms, earnings by state), and **Add an agent** |
| `/admin/agents/<id>` | Earnings, **Record a payout**, **Manual adjustment**, referred orders with the terms saved on each, payouts and adjustments, current terms, code on/off, suspend/restore, password links, profile, change log |
| `/admin/orders/<id>` | The order's referral: code, agent, the terms used, per-line discount and commission, status |
| `/agent` | The agent's dashboard (phones first): code with **Copy**, discount and rate, earnings by state, release dates, referred orders and payouts (paginated). No customer details |
| `/agent/login`, `/agent/forgot-password`, `/agent/set-password`, `/agent/auth/confirm` | Sign-in, reset email, choosing a password, one-time links |
| Checkout | **Referral code (optional)** with Apply/Remove, a discount line, per-line "qualifies / sale item" notes |

### Rules

**Codes** (`lib/agents/code.ts`, `private.normalize_referral_code`): letters A-Z and digits
0-9, 3 to 16 characters. Case doesn't matter, and spaces and hyphens are ignored (`ah-med`,
` Ahmed ` and `AHMED` are one code). The creation form suggests the username's letters and digits
upper-cased (`ahmed` → `AHMED`) and checks availability as you type. A unique constraint decides
between simultaneous creations. Codes never change (a trigger refuses it) and are never
released: agents are never deleted, so a deactivated agent's code stays taken. Checking a code
at checkout says only whether it applies and its discount, never whose it is.

**Terms.** Percentages are stored in basis points (1000 = 10%), from 0 to 50%.
- The customer discount and the commission are independent.
- A code can't be enabled until a commission is set **and** the admin has explicitly chosen
  whether items already on sale qualify (no default).
- New terms apply to orders placed from then on. Every order keeps a snapshot of the terms it
  was placed with, which the admin pages show apart from the current terms.

**Money** (all in whole paisa; `20261118120100_referral_checkout.sql`):
- A line qualifies unless its product is on sale and the terms exclude sale items. A line that
  doesn't qualify pays its normal (sale) price and earns no commission. The quote says which
  lines qualify.
- Discount = discount % of the qualifying lines' total. Commission = commission % of
  (qualifying total − discount). Delivery never earns commission.
- **Rounding (the only rule):** each amount is calculated once per order and rounded half up
  to a whole paisa, then shared across the qualifying lines in proportion to their amounts,
  leftover paisa going to the largest remainders (earlier lines first on a tie). Line shares
  always add up exactly.
- Example: Rs. 5,000 qualifying, 10% → Rs. 500 off; commission 5% of Rs. 4,500 = Rs. 225.
- **Free delivery** is judged on the merchandise total **after** the discount
  (Rs. 5,200 with 10% off = Rs. 4,680, below a Rs. 5,000 threshold, so delivery is charged).
- One code per order. Cart limits, Turnstile, rate limits, the per-phone limit, the global
  quota and stock locking are unchanged, and nothing limits how often a code is used.

**Checkout.** The database validates the code and works out every amount. The browser sends
only the code and the discount it showed. A different discount, total, price, delivery fee, a
disabled code or changed terms returns `quote_changed` with the new quote, never an order. The
code and that discount are part of the request's identity, so a retry with the same checkout
key returns the same order and its single commission, while the same key with a different code
is refused. Orders without a code are normalised exactly as before, so their retries and the
previous website keep working. Commission never appears in a shopper-facing response.

### Commission lifecycle

States are worked out when read or paid (`private.commission_rows`), never stored, so a
repeated event, a status retry or a re-run can't move one twice.

| State | When |
|---|---|
| Awaiting delivery (estimate) | Placed, confirmed, dispatched, or a failed delivery being retried |
| Held | Delivered, less than 30 × 24 hours since the **recorded** delivery time. The delivery time can't change once recorded (trigger), so a replay can't restart or shorten the hold |
| Waiting for courier payment | Hold over, but payment isn't `settled` yet (`pending` or `collected`) |
| Available | Hold over **and** payment settled: can be paid out |
| Paid | Included in a payout |
| No commission | Delivered, but the commission is zero (e.g. a 0% rate). Never offered for payout |
| On hold (admin) | An admin put this order's commission on hold, e.g. while a return is arranged |
| Cancelled | Order cancelled: no commission |
| Reversed | Order returned: the returned lines' commission is reversed, line by line |

The hold ends exactly 720 hours after delivery, on the database's clock. Release times are
shown in Pakistan time (no daylight saving). The hold length is saved on each order.

**What blocks availability:** the 30-day hold, any payment status other than `settled`, and an
admin's commission hold. The order model has no "return requested" state. A return is recorded when the parcel is back
(`delivered` → `returned`), which reverses the commission at once. Returns are whole-parcel
today, but reversals are worked out per line from the return lines, so partial returns can be
added later.

**Returns after payout:** the payout stays as it was, and an automatic negative adjustment of
the paid amount is recorded. Outstanding adjustments count against the next payout.

**Commission holds** (admin order page, `admin_set_commission_hold`): an admin can hold one
order's commission while a return is being arranged, and release it later.
- Both need a reason. Every hold and release is kept with who made it and when.
- A hold changes nothing about the order, its payment or its saved terms.
- Payouts refuse held commissions, enforced in the database.
- Releasing removes only that block, so the 30-day hold and settled payment still apply.
- A hold and a payout of the same order can't both succeed: both lock the order row, so
  whichever comes second is refused.
- Each hold or release names the latest hold event the page showed
  (`20261118120300_commission_hold_versions.sql`). If the hold changed since, for example
  another tab released it and placed a new one, the change is refused (`hold_conflict`) and
  the admin reloads. An exact retry of an earlier request returns that request's original
  result first, without touching the current hold.

### Payouts

Payouts are recorded manually after paying the agent outside the app
(`admin_record_agent_payout`). In one transaction the database checks:
- every selected commission is available and unpaid;
- every outstanding deduction is included;
- the amount equals the selection's total and is more than zero;
- the date isn't in the future.

A request id makes retries safe; the same id with different details is refused. Each
commission and adjustment can be paid only once (unique constraints). A payout locks the agent,
then the orders, so a return and a payout of the same order happen one after the other. Payouts,
their lines, adjustments, referral snapshots and the agent change log are append-only. (The one
exception: [deleting a product permanently](#deleting-a-product-permanently) deletes the orders
containing it, with their referral snapshots and holds. It is refused for any order whose
commission was paid out or adjusted, so payouts and adjustments are never touched.)

Manual adjustments need a reason (5-300 characters) and record who made them and when.

**Retries of admin changes.** Every admin form sends a request id.
- The database keeps each request's identity: its action and full, normalised payload, plus
  the agent version the admin saw.
- The same id with the same identity is a replay. It isn't applied again, and it reports the
  agent version **that** change produced, never a newer one made by someone else. A stale
  form is therefore still refused as a conflict.
- The same id with anything else is refused (`request_mismatch`).
- Each form captures its complete request (id, target, action, expected version and every
  field) when it is first sent.
  - **No answer:** the form keeps that request and its button becomes **Retry unconfirmed
    save**, which resends exactly the same request, whatever has been typed since. Other
    forms on the page wait until it's resolved.
  - **Definitive answer** (applied, recognised as earlier, or refused): the form takes a new
    id, so rejected input can be corrected and sent as a new request.
  - **Blocked** (signed out, no admin access or two-step verification, sign-in or the database
    unreachable, a lock busy): the request wasn't checked, so nothing is resolved. An
    unconfirmed request keeps its id and stays unconfirmed, and other forms keep waiting
    (`lib/admin/request-outcome.ts`).
  - An unconfirmed request is also kept in the tab's session storage until it has a
    definitive answer. An expired session sends the tab to sign-in; after signing in (in that
    tab or another), open the same page again and the form offers **Retry unconfirmed save**
    for the original request. A reload keeps it too. Closing the tab loses it: check the page
    or the agent's change log before re-entering anything.
- Two copies of an agent-creation request are serialised before anything is read, so they
  return the same agent. Different requests for one email or code still conflict.

### Accounts and security

- **Agent sessions** use their own cookie (`kns-agent-auth`, path `/agent`, HttpOnly). An agent
  login is never sent to `/admin` or the shop, and an admin's never to `/agent`. `proxy.ts`
  refreshes it and marks every `/agent` response `no-store`, as for `/admin`.
- **Access** needs a verified identity (`getUser()`) and an **active** agent membership,
  checked on every page (`lib/auth/agent.ts`) and again in every `agent_*` function. Suspended
  agents and other logins see nothing. Agents can't call any `admin_*` function, can't read any
  table directly, and can't grant themselves anything: no API role has privileges on the agent
  or accounting tables. Admins keep their membership + aal2 requirement, and admins can't also
  be agents.
- **Creating an agent** happens on the server, after the admin's identity, membership and aal2
  are verified. Steps (`lib/agents/provision.ts`), each safe to repeat:
  1. Save the agent.
  2. Create the login with Auth's admin API, which needs `SUPABASE_SECRET_KEY` (server only,
     never `NEXT_PUBLIC_`). Only the Auth admin API is used with it.
  3. Link the login (refused for admins and for logins already used by another agent).
  4. Make a one-time password link for the admin to send.

  If anything fails part-way, **Finish set-up and create password link** on the agent's page
  completes it. Auth refuses a second user with the same email, so there are no duplicates.
- **Password links** open `/agent/auth/confirm`, which verifies them on the server and asks for
  a password (at least 10 characters). They work once and expire (Auth → Email link expiry).
  They aren't stored, and the change log notes that one was made.
- **Forgot password** emails a reset link through Supabase Auth. It only reaches agents once
  the project has custom SMTP (Supabase's built-in mail sends only to team members). Until then,
  admins create a link from the agent's page.

### Setup and rollout (owner)

Nothing here is applied yet. The previous version of the site works with or without these
migrations. **This version needs them.** From the code (not measured):
- the admin order page reads the order's referral (`admin_order_referral`), so it doesn't
  load without them;
- checkout quotes call `quote_order` with a referral-code argument;
- `/admin/agents` and `/agent` need the agent functions.

The product pages, scan and labels don't depend on them.

1. **Finish the 2026-11-17 hardening rollout first: all of stage D, through stage 3
   (`…120400`).** Stage D's check query must show **All hardening complete**; Stage 1
   complete is not enough. Checked on throwaway local PostgreSQL (2026-11-21), comparing
   functions, privileges, columns, policies and triggers with applying every file in
   filename order:
   - **`…120100` is required.** `20261118120100_referral_checkout.sql` replaces
     `place_cod_order` with a version that calls `private.lock_phone` and
     `private.take_quota_slot`. Applied before stage 1, the agent migrations still
     succeed, but checkout then fails. Applying `…120100` afterwards silently puts back a
     `place_cod_order` that records no referrals. Never apply these before stage 1.
   - **`…120400` is not a database dependency.** Stage 1, then these four files, then
     `…120400` gave the same result as filename order. It still comes first, for two
     reasons. Agents are signed-in accounts, and until `…120400` any signed-in account can
     read label names and held stock directly. And the Supabase CLI expects migrations in
     filename order.
   - **The gap in between.** While the database has the hardening but not these
     migrations, a copy running this version has the admin order page, checkout quotes and
     the agent pages failing (see above). Applying these four before `…120400` would close
     that gap, and its database result is the same. That is an owner decision, not the
     default. If you take it, create no agent until `…120400` is applied.
2. **Apply, in order:** `20261118120000_sales_agents.sql`, `…120100_referral_checkout.sql`,
   `…120200_commission_accounting.sql`, `…120300_commission_hold_versions.sql`. The
   deployed site keeps working:
   - `quote_order` still accepts three arguments;
   - `place_cod_order` takes the same input;
   - orders without a code behave as before.

   To check, run read-only in the SQL Editor:

   ```sql
   select to_regclass('public.sales_agents') is not null as agents,
          to_regprocedure('public.quote_order(text, jsonb, text, text)') is not null as quote_with_code,
          to_regclass('public.agent_payouts') is not null as payouts;
   ```
3. **Website settings** (server-only):
   - `SUPABASE_SECRET_KEY`: Project Settings → API Keys → Secret keys.
   - `AGENT_LINK_ORIGIN`: the site's public address, e.g. `https://kharchnsave.pk`.
4. **Supabase Auth settings:**
   - keep **Allow new users to sign up** off;
   - add `<AGENT_LINK_ORIGIN>/agent/auth/confirm` to **Redirect URLs** (for reset emails);
   - choose the **Email link expiry**;
   - optionally set up custom SMTP.
5. **Deploy this version**, then create a test agent with your own second email. Open the
   link, set a password, place a test order with the code, and check `/agent` and the admin
   pages.

**Recovery.** Prefer these before rolling anything back:
- **Stop accepting the code** (per agent) to stop new referral orders at once. Orders already
  placed keep their discount, and their commission continues normally.
- **Suspend** an agent to lock them out. Their earnings are kept.

Rolling the website back to the previous version is safe at any time. Totals stay correct;
only the discount and referral details aren't shown. Never delete or edit agents, referral
snapshots, payouts or adjustments by hand: corrections are adjustments, with a reason. Fix
database problems with a new forward migration.

### Verification status

**Measured (local).** All on this machine; commands and results are in the delivery notes.
- `db-tests/referrals.test.ts` (54 tests) runs on real PostgreSQL. It covers:
  - provisioning, its recovery and permissions;
  - code rules and racing creations;
  - retired codes and isolation;
  - checkout with and without codes, mixed carts and rounding;
  - free delivery, tampering and terms changes;
  - retries and concurrency;
  - the hold boundary, settlement, cancellations and returns;
  - payouts, including concurrent ones and the race with a return;
  - zero commissions beside positive ones;
  - commission holds, including a hold racing a payout and stale hold/release forms;
  - edit retries, and the creation interleaving that returned `email_exists`;
  - history.
- `e2e/referrals-local.spec.ts` runs the real pages against the local stand-in. It covers:
  - an admin creating an agent;
  - the agent setting a password, signing in and seeing only their own figures;
  - a shopper applying and removing codes and ordering;
  - hold, settlement and a payout;
  - a return after payout and a cancellation;
  - repeated admin edits without reloading, a lost answer retried, code off/on, suspend/restore;
  - unconfirmed saves: the original request is resent after edits, other forms wait, another
    admin's change isn't adopted, and refused input can be corrected; a payout retried after a
    lost answer is recorded once;
  - the commission-hold form on the admin order page in two tabs: a stale release is refused;
  - an adjustment and a payout whose answers were lost, retried with an expired session, then
    after signing in again: same request id throughout, one adjustment, one payout.

**Needs a real Supabase project (not verified).**
- Auth's `generateLink` and `verifyOtp` responses.
- Email link expiry.
- The reset email and its redirect allow-list.
- Secure cookies over HTTPS on the host.
- That the migration role can read `auth.users` from `admin_link_agent_user`. Supabase
  normally allows this. Check it once with an agent on `kharchnsave-dev` before production.

**Decisions for the owner:**
- Can an agent use their own code? It's allowed today.
- Should codes have expiry dates or usage caps? There are none.
- Should the hold length be a setting? It's fixed at 30 days.
- Should payouts use a method other than manual recording?

## Score pricing and sales

Admins rank pairs from 0 to 100 instead of pricing each by hand, and run sales from
**Admin → Pricing** and **Admin → Sales** (phones first). Everything is in
`supabase/migrations/20261121120000_score_pricing_and_sales.sql`; the arithmetic is mirrored
for instant estimates in `lib/pricing/rules.ts`.

**One pricing path.** `products.price_paisa` (regular) and `products.sale_price_paisa` (what
customers pay while set) stay the only prices that checkout, quotes, order snapshots, referral
discounts and commission read. Scores, groups and campaigns only **write** those two columns,
through admin functions, after a preview the admin confirmed, in one transaction. Nothing in
checkout trusts a price, score, discount or campaign sent by the browser.

### Rules

| Rule | How |
| --- | --- |
| Calculated price | `floor(group maximum × score / 100)` in paisa (integers only) |
| Price ending (default 95, setting 0-99) | The highest positive whole-rupee price ending in 95 that doesn't exceed the calculated amount; a price already ending in 95 keeps it; never above the maximum. Rs. 1,500 → 1,495; 2,000 → 1,995; 2,500 → 2,495; 5,000 → 4,995. Nothing possible (e.g. Rs. 90): "too small", flagged, nothing written |
| Score 0 | "Needs pricing" (nothing written), unless the admin explicitly makes it a giveaway (a confirm dialog; recorded as `giveaway_set`). A published product still can't cost 0 otherwise: `products_published_price_positive` now allows 0 only with `zero_price_approved`, which only the pricing functions set |
| Manual / automatic | Every existing product stays **manual** with its price; no score or cost is invented. Automatic products follow their group; manual ones are never repriced |
| Groups | Each has its own maximum (Rs. 100 to Rs. 10,00,000, whole rupees). Several groups can be adjusted together (or by a %) in one preview |
| Sale price | The same ending rule after `floor(regular × (100% − discount))`; the extra discount the ending adds is shown per line and in total |
| Costs and margins | Cost per item is optional; missing is **unknown**, never 0. Optional minimum profit (Rs.) and minimum margin (kept ÷ what the customer pays), checked against the **worst current** referral scenario of every enabled code (agents' terms differ) |
| History | Every change of a product's regular, sale or reference price or publication is written to `private.price_history` (append-only) with the reason, request and admin. History starts at the migration ("observed_at_migration"); nothing earlier is assumed |

The score is the pair's relative value. Discounts are separate (campaigns): a slower-selling pair
can get a larger discount without its score changing.

### Honest discounts

A crossed-out "was" price and a % badge appear only with a **supported reference price**:
`products.reference_price_paisa`, set by the database (never by a caller) when a sale starts,
and only if the price history shows the product was offered at that regular price, published
and not on sale, for at least `reference_min_days` if the owner set one. **No minimum is
assumed** (no legal duration is invented); set one if your own advice calls for it. Its
provenance (price, since when, until when) is in `private.product_reference_prices`.

- New or imported listings, drafts, prices raised just before a sale, and sales set before this
  migration have **no** reference: the shop shows the selling price only, no badge, and the
  admin coverage report lists them with the reason.
- `savings = reference − final price`; `percent = floor(100 × savings / reference)`. The final
  price is shown first; the was-price, % and rupee saving next to it (`components/product/product-price.tsx`).
- While a sale continues the reference can only go **down**: a new group maximum never raises a
  was-price or manufactures a bigger discount (lowering the regular price lowers the reference
  with it; a reference no longer above the sale price is dropped). The repricing preview shows
  each running sale's badge before → after.
- A checkout quote line carries `reference_price_paisa` (null without one) for the same display.

### Sales

- **Lifecycle:** draft → scheduled (start in the future) or running → ended; or cancelled.
  Activation, ending, cancelling and unscheduling are explicit buttons (with confirmations).
- **One sale at a time.** Activating a sale whose window overlaps another scheduled or running
  sale is refused (`campaign_overlap`, naming it): end, cancel or reschedule one. A product
  already on another sale (or with a manual sale price) is left out ("other_sale"), never stacked.
- **Selection** is explicit and stable: each product is on sale, kept at the regular price (with
  an optional note), or not chosen; bulk buttons pick all eligible pre-loved, all eligible new or a
  group. Nothing rotates, and nothing is reclassified as slow-selling by age. Changes to a running
  sale's selection are previewed and applied the same way.
- **Preview and apply:** the preview lists every product's regular and sale price, the actual
  discount after the price ending, the was-price shoppers will see (or why none), the referral
  scenarios, commission, what's kept after the recorded cost, and why any product is left out
  (unpublished, too small, no supported reference when the sale requires one, unknown cost or
  below the margin minimum without an explicit, recorded exception). Applying sends the preview's
  token: if anything changed since (a price, a product, an agent's terms), nothing is applied
  and the new preview comes back.
- **Scheduled start:** at the start, the reviewed sale price is applied only to products whose
  regular price is still the reviewed one; others are left out as "changed since review".
- **Presets** (editable starting points, not researched optimums): New shoes 10–15%, Recently
  listed pre-loved 10%, Slower-selling pre-loved 15–20%, Clearance 25–30%.
- **Coverage** (Sales page) counts published, in-stock **listings** (products, not sizes or
  pairs): eligible, on sale, actual %, the target (`ceil(85% × eligible)` for new, 100% for
  pre-loved; settings) and the gap; newly published listings not yet in or out of the sale
  ("needs review"); products kept at the regular price; left out with reasons; and on sale
  without a was-price.

**Starts and ends** run from `private.run_sale_schedule()`: every minute by pg_cron after
`supabase/setup/schedule_sale_campaigns.sql`, or when an admin presses **Run due starts and
ends now** (Sales). Without pg_cron, sales start and end only from that button, and the Sales
page shows overdue ones. Timing: up to a minute after the set time with pg_cron. Checkout
always charges the database's current price and catches a change between quote and order
(`quote_changed`). The shop's cached catalogue is refreshed by every pricing and sale admin
action (`updateTag`, as for product saves) and otherwise within its cache profile (about a
minute) after a scheduled start or end. **Measured locally** (`next start`,
`e2e/pricing-local.spec.ts`): after an admin action, the first product-page request was still
served from the previous catalogue and the second showed the new prices. The same applies to
existing product saves. On the host this depends on its cache/CDN (not verified).

### Agents and profit

The referral rules are unchanged (`private.checkout_quote`, `private.record_order_referral`):
sale discount first, then the code's discount on the qualifying sale amount, then commission on
qualifying goods after the customer's discount; delivery earns none. A 20% sale then a 10% code
is 28% off, not 30%. Discount and commission are still worked out once per order and shared
across lines. A line qualifies unless its product is on sale and the agent's terms exclude sale
items, **or** its sale explicitly excludes referral discounts (a clearance option, shown on the
product page and at checkout as "Clearance item: referral codes don't apply"; agents earn
nothing on those lines). The Sales page warns when enabled agents' terms exclude sale items while
pre-loved listings are on sale; to let them earn on ordinary sale products, set "Discount on items
already on sale? Yes" on the agent's page (new orders only; existing orders keep their snapshot).

### Access and data

Costs, scores, groups, margins, history and campaigns live in the `private` schema (no API role
can read it) and are returned only by `admin_*` functions, which require a verified admin
(member + aal2) before reading their input; agents, signed-in non-admins, aal1 admins and
visitors get 42501. Visitors see only `reference_price_paisa` and `referral_excluded` (granted
to anon and authenticated alike). Every write function is `SECURITY DEFINER` with
`search_path = ''`, explicitly granted to `authenticated` only, versioned (stale forms:
`version_conflict`) and keyed by the form's request id (a retry returns the original answer; the
same id with other data: `request_mismatch`). The product form can't change an automatic
product's price (`auto_priced`) or a running sale's prices (`campaign_price`): its price fields
are read-only there, and the database refuses it anyway.

### Setup and rollout (owner)

Nothing here is applied to a hosted project yet.

1. **Before:** every earlier migration, through `20261118120300_commission_hold_versions.sql`
   (the 2026-11-17 hardening through stage 3, then the sales-agent migrations). This one replaces
   `private.checkout_quote` as the referral migration left it and reads `public.sales_agents`.
   Check, read-only:
   ```sql
   select to_regprocedure('public.quote_order(text, jsonb, text, text)') is not null as referrals,
          to_regclass('public.order_referrals') is not null as referral_snapshots,
          to_regprocedure('public.admin_get_products(uuid[])') is not null as hardening,
          not has_column_privilege('authenticated', 'public.products', 'label_name', 'SELECT') as hardening_stage_3;
   ```
   All four must be `true`.
2. **Apply** `20261121120000_score_pricing_and_sales.sql` in the SQL Editor (one transaction).
   Then apply `20261122134446_pricing_review_guards.sql` before using pricing or sales.
   On `kharchnsave-dev` both are already installed; see the review linked above.
3. **Deploy this version** of the site to every copy that uses the database, **before activating
   any sale or setting any sale price**. See the compatibility limits below.
4. **Optional:** enable pg_cron and run `supabase/setup/schedule_sale_campaigns.sql`.
5. In **Pricing**, create groups, then score products in bulk (preview, confirm). Set costs where
   known. In **Sales**, create a sale, choose products, preview, confirm.

**Compatibility limits.**

| Code | Database | What happens |
| --- | --- | --- |
| This version | **without** this migration | The shop and product pages fail to load (they read `reference_price_paisa`); Pricing and Sales fail. Apply the migration first |
| Previous version | **with** it | Works (checkout, agents, orders unchanged; quote lines have two extra fields it ignores). But its shop shows any sale price with the regular price crossed out, whether supported or not, so don't start sales until this version is deployed. Its product form's save is refused for automatic or running-sale prices (shown as a general error) |
| This version | with it | Everything works |

**Verification queries** (read-only; run after step 2):
```sql
select
  to_regprocedure('public.admin_apply_campaign(uuid, integer, uuid, text)') is not null as installed,
  has_function_privilege('anon', 'public.admin_pricing_overview()', 'EXECUTE') as anon_can_call_admin,      -- false
  has_function_privilege('authenticated', 'public.admin_pricing_overview()', 'EXECUTE') as signed_in_can_call, -- true (the function itself requires a verified admin)
  has_column_privilege('anon', 'public.products', 'reference_price_paisa', 'SELECT') as anon_reads_reference, -- true
  has_column_privilege('anon', 'public.products', 'zero_price_approved', 'SELECT') as anon_reads_giveaway_flag, -- false
  has_table_privilege('authenticated', 'private.product_pricing', 'SELECT') as signed_in_reads_costs,      -- false
  (select count(*) from private.product_pricing) as products_opted_in,                                     -- 0 right after the migration
  (select count(*) from private.price_history where reason = 'observed_at_migration') = (select count(*) from public.products) as history_started;
```
Then run every `supabase/tests/*.sql` file (they roll back) and `npm run db:verify`. On dev,
smoke-test as a verified admin: score one product (preview → confirm), change its group's
maximum, run a one-product sale (preview → start now → product page shows the was-price only if
supported → end), and check a referral order at checkout keeps its snapshot.

**Recovery** (no rewriting of orders, referral snapshots, commissions or history):
- Stop a sale: **End the sale now** (prices go back to regular at once). Cancel or unschedule
  scheduled ones. Stop the job: `select cron.unschedule(jobid) from cron.job where jobname = 'kharchnsave-sale-schedule';`
- Stop automatic pricing for products: switch them to **Manual** in Pricing (their current price
  stays). A wrong repricing is fixed forward: change the maximum back, preview, confirm.
- Orders placed during a sale keep their prices, discounts and commission. Never edit
  `private.price_history`, `private.pricing_events` or order tables by hand; fix problems with a
  new forward migration.

### Verification status

**Measured (local, this machine):**
- `db-tests/pricing.test.ts` (29 tests) on real PostgreSQL with every migration: the rules agree with
  `lib/pricing/rules.ts` on a grid; every admin function refuses anon, signed-in users (aal1/aal2),
  aal1 admins and agents; private tables are unreadable; score pricing, needs-pricing, too-small,
  explicit giveaways; the product form can't change automatic prices; stale previews, replays,
  request mismatches and 6 identical requests at once; maximum and ending changes; supported and
  unsupported references (new listing, draft, minimum days); campaigns (start, end, overlap, two
  activations at once, schedule start/end, changed-since-review, cancel/unschedule, duplicate
  activation); a maximum change during a sale (badge stays 20%, not 36%); margins with unknown
  costs, violations, overrides and the worst of three agents' terms; checkout (28% combined,
  commission basis, snapshot unchanged after the sale ends, quote_changed, clearance exclusion);
  coverage by listing (`ceil(85%)`, sold out and drafts excluded, needs review).
- `db-tests/sale-schedule-script.test.ts`: the pg_cron script against a stand-in (repeat-safe, one job).
- `lib/pricing/rules.test.ts`, `lib/catalog/pricing.test.ts`: endings, scores, sales, badges, coverage, scenarios.
- `e2e/pricing-local.spec.ts` (phone viewport) on the local stack: bulk scoring with preview, a lost answer
  retried once, a new maximum, a sale created/selected/started/ended, the product page showing the
  supported was-price and saving (and no badge without history), the product form's price locked.

**Needs a real Supabase project or the host (not verified):** PostgREST serving the new
functions and columns; pg_cron running `schedule_sale_campaigns.sql`; the hosted cache/CDN
refresh after scheduled starts and ends.

**Assumptions and limits (v1):** one active sale at a time; pricing groups are an explicit
assignment (no category system); the giveaway needs automatic pricing with score 0; group names
can't be renamed or groups deleted yet; margin checks use per-unit estimates (an order's
discount and commission are rounded once per order and can differ by a paisa); scheduled times
are entered in Pakistan time (UTC+5).

### Promotion planner

`/admin/pricing/promotions` (linked from **Pricing**) plans discount percentages for the catalogue
without changing a single price. For every priced draft or published product it shows: product,
score, current selling price, assigned percentage, **proposed regular price**, the actual saving,
and whether that proposed price passes the reference-price check.

- **Percentages:** 20, 25, 30 or 35%. The target shares are 20% of products at 20%, 35% at 25%,
  30% at 30% and 15% at 35% ([`lib/promotions/plan.ts`](lib/promotions/plan.ts)).
- **Who gets what:** with reliable age and sales data (80% of products listed 60+ days and 30+
  pairs sold), older and slower stock gets the larger discounts. Otherwise the assignment is seeded
  randomness: models are ordered by a hash of a fixed seed and their smallest product id. Never by
  size, price or score.
- **Stable:** **Save assignments** stores them in `private.promotion_assignments`. A saved
  percentage never changes. Every listing of a model (same brand and name, i.e. its other sizes)
  shares one percentage, including sizes added later.
- **Proposed regular price** = selling price ÷ (1 − discount), to the paisa (half up), worked out
  by the database. The page shows the true saving, and its percentage worked out at full
  precision from the stored prices, then rounded (half up, not truncated) to two decimals
  (Rs. 3,795 at 35% → Rs. 5,838.46, a saving of Rs. 2,043.46: 34.99998…% → **35.00%**;
  Rs. 2,995 from Rs. 4,278.57 → **30.00%**). If a selling price changes, the
  proposal is marked out of date. **Refresh proposals** recalculates it at the same percentage.
- **What it never touches:** selling prices, sale prices, the scoring formula, price history,
  checkout quotes, orders and payments (`db-tests/promotions.test.ts`,
  `e2e/promotions-local.spec.ts`).
- **What shoppers see:** nothing from the planner. A crossed-out price appears only during a sale,
  set by the database from the product's genuine price history, and is labelled **Was**. The
  planner's last column runs that same check (`private.reference_candidate`) on each proposal.
  Until the product has really been offered at that price, it says "Proposal only". No MSRP or
  other reference price is on record.

**Status (2026-11-23).** Implemented and tested locally only (unit, database and browser tests
on a local stand-in). The migration has **not** been applied to any hosted Supabase project, and
the site version with the planner has **not** been deployed, so it isn't live anywhere yet.

**Setup (owner).** Apply `20261123120000_promotion_planner.sql` (needs every earlier migration),
then deploy. Without the migration, only the planner page fails to load; everything else works.

### Sales by size

**Pricing → Sales by size** puts products of one pricing group on sale with a percentage chosen by
EU size, e.g. EU 25–30 at 30% and EU 36 at 35%.

- **Rules:** a single size, or an inclusive range. Whole or half sizes (29.5 matches 25–30), never
  rounded. A single-size rule overrides a range. Overlapping ranges and two rules for one size are
  refused, row by row. Unmatched sizes get the optional default discount; without one, no sale.
  Rules are saved per group when applied ([`lib/pricing/size-rules.ts`](lib/pricing/size-rules.ts)
  mirrors the database's checks for instant feedback).
- **Prices:** sale price = regular price × (1 − discount), in whole paisa, rounded half up. Always
  from the regular price (never compounded onto a sale price). Regular prices, scores, group
  maximums and the score formula don't change. The customer price changes to the sale price; the
  preview shows both.
- **Preview:** every product in the group, with its EU size(s), matching rule, regular price,
  current customer price, sale price, the actual saving and percentage, margin (or "Cost
  unknown"), and its status:
  - **Eligible:** goes on sale when applied.
  - **Unchanged:** no rule matches, or it's already on this sale.
  - **Blocked**, with the reason:
    - not published;
    - free;
    - in another sale campaign (named);
    - a manual sale price;
    - margin rule;
    - sizes under different rules.

  Counts come first, and when nothing qualifies, the reasons are summarised.
- **Sizes and products:** prices are per product, and a size is a product's variant. The
  imported kids' shoes are one product per size, so each size gets its own rule. A product with
  several sizes goes on sale only if all its sizes get the same percentage; otherwise it is blocked
  ("its sizes fall under different rules"), never discounted at one rate for every size. So the
  shop never needs a "From" price, and its cards, product pages, cart and checkout keep using the
  one server-side price.
- **Apply eligible sales:** the database recomputes the plan and applies it only if it matches the
  preview's token (otherwise nothing changes and the new preview is shown). It applies everything
  in one transaction, recorded in the price history ("size_sale_start"). A retry of the same request
  gets its original answer; applying again adds only newly eligible products. One size sale runs
  per group; to change its rules, end it first.
- **"Was" prices:** the existing rule decides. The shop crosses out the regular price only if the
  product was genuinely offered at it (published, no sale, for the minimum days). Otherwise it
  shows the sale price alone. The preview says which.
- **Conflicts:**
  - While a product is in a running size sale, its prices can't be edited on its product page.
  - Sale campaigns skip it ("other_sale").
  - Repricing a group skips it ("It's in a running size sale").
  - A size sale never overwrites a campaign's or a manual sale price.
- **End size-based sales:** removes only this sale's sale prices (regular prices stay) and records
  "size_sale_end".
- The promotion planner's saved assignments are not read or changed.

**Setup (owner).** Apply `20261124120000_size_sales.sql` (after every earlier migration, through
`20261123120000_promotion_planner.sql`), then deploy. It seeds the editable starting rules (EU 25–30
at 30%, EU 36 at 35%) for a group named "Kids Sneakers" if one exists. Without the migration, only
this section of the Pricing page is unavailable.

**Status (2026-11-24).** Implemented and tested locally only (unit, database and browser tests on a
local stand-in). The migration has **not** been applied to any hosted project, the site version with
this feature has **not** been deployed, and no live sale has been started.

### Price spread

**Pricing → Settings → Price spread (%, 0 to 5)** stops every shoe in a group at the same score
from getting exactly the same price.

- **The rule:** each product gets its own fixed offset, from 0 up to the spread, below its score
  price: the last 8 hex digits of its id, as a number, mod (spread in basis points + 1). Then the
  price ending as usual: calculated = floor(maximum × score × (10000 − offset) / 1 000 000).
- **Only lower:** a score of 100 never goes above the group maximum.
- **Fixed per product:** repricing again never moves it, so prices don't jump around.
- **With the 95 ending:** prices land on the Rs. 100 steps within the spread, e.g. a Rs. 3,000
  score price with a 5% spread gives Rs. 2,795, Rs. 2,895 or Rs. 2,995.
- **Nothing changes on save:** automatic prices show as out of date until **Review out-of-date
  automatic prices** is previewed and confirmed. Products in a running size sale are skipped (end
  it first, reprice, then apply the size sale again; its rules stay saved).
- 0 (the default) turns it off and gives exactly the previous prices.
  [`lib/pricing/rules.ts`](lib/pricing/rules.ts) (`spreadOffsetBp`, `scorePrice`) mirrors the
  database for the instant estimate; `db-tests/pricing.test.ts` checks both agree.

**Setup (owner).** Apply `20261125120000_price_spread.sql` (after every earlier migration, through
`20261124120000_size_sales.sql`), then deploy. The setting starts at 0. Without the migration, the
Settings form says the spread needs it and everything else works as before.

## Enabling online payments

Only cash on delivery is built. Card or wallet payments (for example JazzCash or
Easypaisa) would need a payment provider, its webhook, and new payment statuses.
Customer accounts, order emails and SMS aren't built either.

## Before launch

- [ ] Real product photos and listings in place of the demo catalogue
- [ ] Delivery areas, charges and timelines (`/delivery-returns`)
- [ ] Returns and exchange policy for pre-loved and new items
- [ ] Payment methods offered
- [ ] Contact details (phone, WhatsApp, email, address) for the footer
- [ ] Confirm the condition grades in `lib/catalog/labels.ts` match how stock is graded
- [ ] Confirm rights to the supplied hero and department shoe images (they show Nike and
      ASICS sneakers)
- [ ] Domain, and `metadataBase` for share images
- [ ] Production Supabase project and its environment variables on the host
- [ ] Two-step verification confirmed by hand on the hosted project for every admin
- [ ] Product-management migration applied, its tests passing, and the private
      `product-photos` bucket created (see [Product management](#product-management))
- [ ] Any new admin write policies require `public.is_catalogue_admin()` (membership
      and `aal2`; see [Admin area](#admin-area))
# store
#   k h a r c h n s a v e  
 