# Kharch n Save storefront

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
  aren't verified admins, can only read published products. Only a verified admin
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
`/admin/products`. Nothing here deletes a product, and nothing uses a secret key: every
read and write goes through the admin's own session with the publishable key, so the
database checks the same rules again.

### What admins can do

- **Find products:** search by name, brand, colour, item code or web address; filter by
  **Draft**, **Published** or **Archived**; 20 per page, most recently changed first.
- **Add a product** (**Add product**): name, brand, colour, department, styles, type
  (pre-loved pair or new shoes in several sizes), condition and condition notes,
  description, price in rupees, item code, web address name (suggested from the brand and
  name if left empty) and sizes with stock. It's saved as a **draft**. Photos are added on
  the next screen, once the product exists.
- **Edit a product:** the same fields, plus photos: upload, reorder (**Earlier** /
  **Later**; the first is the main photo), describe each one for screen readers, tick
  **Shows wear or a flaw** for defect close-ups, and **Remove** from the listing.
  **Save changes** saves the details, sizes and photo details together, all or nothing.
- **Status:** **Publish**, **Unpublish** (back to draft), **Archive**, and **Restore as
  draft** for archived products. These are disabled while there are unsaved changes.
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
| No deletion | Products are archived, never deleted, through the website or the API |
| Label name | Optional, for printed labels only (see [Printing labels](#printing-labels)). A label name that's typed or changed must fit the label; a product name too wide for the label doesn't block saving other changes, it blocks printing |
| Light-up soles | **Yes**, **No** or **Not recorded** (every product until someone checks; never assumed to be No). Yes needs a condition: Not checked, Both shoes work, One shoe works or Neither works, and may have a short description of how the lights activate, in the admin's own words. The shop shows a **Light-up** badge (product cards and page) only for Both shoes work; the product page states any other condition ("Lights not tested", "only one shoe", "don't work"). Editing these never changes stock |

### Product photos

- **Accepted:** JPEG, PNG or WebP, up to 4 MB, 400 to 8,000 pixels on each side and at
  most 40 megapixels. The server checks the file's actual contents (not its name), decodes
  the whole image, and refuses anything else, including HEIC, GIF, SVG, animated and
  damaged files (`lib/admin/photos.ts`).
- **Stored:** re-encoded as WebP, at most 2,000 pixels on the longest side, with all
  metadata removed (camera details and GPS location), in the **private** Storage bucket
  `product-photos` at `<product id>/<image id>.webp`. The database stores that path
  (`product_images.storage_path`), never a URL. Existing fixture photos keep their
  `/images/products/…` paths.
- **Who can see them:** Storage's rules let shoppers read a photo only while it belongs to
  a published product. Draft, archived and unused photos are private to verified admins.
  Admins preview them through `/admin/products/<id>/photos/<image id>`, which checks
  access on every request and is never cached.
- **Delivery to shoppers:** `/product-photos/<product id>/<image id>.webp` reads the photo
  with the public key and caches it with the catalogue (same `catalogue` tag), and
  `next/image` optimises it like any other local image.
- **No signed URLs.** The site never creates or stores Supabase signed URLs. A signed URL
  works for anyone who has it until it expires, and can't be cancelled early: removing an
  admin or unpublishing a product wouldn't stop it. If you ever create one in the
  dashboard, keep the expiry short and don't put it in the database.
- **After unpublishing:** the photo route stops serving the photo straight away, but copies
  already made can live a little longer: browsers may keep one for up to 60 seconds, and
  Next.js keeps its optimised versions for up to 4 hours (`images.minimumCacheTTL`, the
  default). Only someone who already had the image address could load it; the addresses
  contain random IDs. On a self-hosted server you can clear the optimised copies at once by
  deleting `.next/cache/images`.
- **Upload limits:** Server Actions accept up to 4.5 MB per request (`next.config.ts`), which
  also applies to every other action, and matches common hosting limits.

**Failures and clean-up.** A photo is uploaded first and only then recorded in the
database, so a product never points at a missing file:

- If the upload fails, nothing is recorded.
- If recording fails (for example, someone else saved first), the upload is deleted again.
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
`shop_settings`, then orders, then products, then sizes, each by id. Placing an order
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
  attempt; shared per-connection and whole-shop rate limits in the database; per-order
  limits; hold expiry; and a per-phone limit, which is only supplementary because
  anyone can type a different number. If Turnstile can't be reached, orders are refused.
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
   `supabase/migrations/20261101130000_item_codes_and_sale_prices.sql`. Each runs as one
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
apply it before running this code against dev.

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
5. **Client IP:** `CLIENT_IP_SOURCE` from the host's own documentation. Netlify's
   documentation (checked 2026-10-30) gives the IP only as `context.ip` /
   `getContext().ip` and documents no header, so it is undecided for Netlify. Hosts
   running several instances also need `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.
6. **Before switching on:** run the manual checks on that deployment: place, confirm,
   dispatch, fail, retry, deliver, expire, cancel, return, and the `/order#k=…` page.
   Update `/delivery-returns`, the cart's demo note and the footer note.
7. **Switch on:** `CHECKOUT_ENABLED=true`, then tick **Take orders**.

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
| `npm run test:e2e:checkout` | **The real checkout UI and Server Action through to stored orders and stock** (`e2e/checkout-local.spec.ts`): a successful order and its private page; a double click and two tabs at once; a lost response, then retry and refresh; changed details under the same key; spent and failing bot checks; abandoning a key before and after its order commits | internet access (Turnstile). It starts a throwaway PostgreSQL with every migration, a minimal stand-in for Supabase's HTTP API (`e2e/local-stack/postgrest-shim.mjs`, **not** PostgREST, Auth or Storage), a build in `.next-e2e` and three servers using Cloudflare's Turnstile **testing** keys |

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