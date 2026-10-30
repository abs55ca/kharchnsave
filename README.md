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
e2e/                    admin browser tests (Playwright; local Supabase only)
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
| `supabase/tests/barcodes_test.sql` | Tests for barcode format, assignment, uniqueness, immutability, access and the lookup. Rolls back |
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
| Price | Typed in rupees (`8500`, `8,500.50`); stored as exact integer paisa; up to Rs. 10,00,000 |
| New products | Always created as drafts |
| Publishing | Needs a price above zero, a description, at least one style, at least one size and at least one photo. Zero stock is allowed (it shows as sold out) |
| Identifiers | The product ID never changes. Item codes, web addresses and SKUs are unique. SKUs are made automatically as `<item code>-<size>` (e.g. `PL-M-1001-42.5`). Once a product has been published, its item code, SKUs and sizes are fixed and its sizes can't be removed (set stock to 0), so an SKU is never reused. Changing a published product's web address is allowed but breaks links people already have |
| Conflicts | Every product has a version number. A save names the version it started from; if someone else saved in between, it's refused ("Someone else saved this product…") instead of overwriting their work. Photo uploads and status changes work the same way |
| No deletion | Products are archived, never deleted, through the website or the API |

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

- **Format:** `U` + a 7-digit serial number + a check digit, e.g. `U00000013`. The only
  letter is `U`, which can't be mistaken for a digit. The check digit (Damm algorithm)
  catches every single-digit typo and every swap of two neighbouring digits when a code is
  typed by hand. About 10 million barcodes are possible.
- **Assigned when a size is created,** drafts included, so a pair can be labelled before it
  is photographed or published. The database issues them; nobody can choose one.
- **Never changed, moved, deleted or reused,** not even by the database owner (a trigger
  refuses it). Unpublishing, archiving, restoring, stock changes and a draft's item-code
  change all keep the barcode.
- **Removed sizes:** a draft's size can still be removed (or its EU size changed, which
  replaces it). Its barcode is then **retired**: kept in the register, never reused, and
  scanning it says the label is no longer in use. The product editor warns before you save
  such a change. Published sizes can't be removed, so their barcodes never retire.
- **Admin-only:** barcodes live in their own table, `variant_barcodes`, readable only by
  verified admins (membership + two-step verification). The storefront and the public key
  can't see them.
- **Item codes can't look like barcodes** (`U` followed by 8 digits), so a scan is never
  ambiguous.

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
typed in lower case and spaces are ignored.

**Scanning never changes anything.** Lookups are GET requests answered by
`admin_scan_lookup`, a `STABLE` database function: Postgres refuses any insert, update or
delete inside one.

### Printing labels

**Print label** (on each saved size in the product editor, and on a scan result) opens
`/admin/products/[id]/labels`. Each label has a short name, the EU size, a Code 128
barcode and its readable ID underneath. **No shop branding and no price.**

- **Short name:** brand and name (without "Unbranded"), cut at a whole word to at most 18
  characters, e.g. "New Balance Fresh Foam X 1080" → "New Balance Fresh". You can type a
  different short name for one print; the product isn't changed.
- **Quantity:** 1 for a pre-loved pair; for new shoes, the stock of that size. 1 to 100 per
  size. "Labels for all sizes" puts every size of a new style in one file.
- **Printing (works today):** **Download .zpl** or **Copy ZPL**, then in **Zebra Setup
  Utilities** select the printer and either send the downloaded file to it, or open the
  window for communicating with the printer, paste the ZPL and send it. The browser never
  prints to the USB printer directly.

**Layout** (203 dpi, 406 × 203 dots, `^LT20` label top, `^PR4` print speed, both included
in every label; UTF-8 text with `^CI28`). Printed and checked on the shop's ZD888: an
18-character name ("New Balance 574 Wh") and `EU 42.5` each print cleanly on one line.

| Element | Position | Notes |
| --- | --- | --- |
| Short name | `^FO28,14`, font `^A0N,26,26`, field `^FB228,1,0,L` (x 28–256) | The field ends 10 dots before the size's field starts, so even an over-wide name wraps inside its own box and never reaches the size |
| EU size | `^FO266,14`, font `^A0N,26,26`, field `^FB112,1,0,R` (x 266–378) | e.g. `EU 42.5` |
| Barcode | `^BY2`, `^FO102,46^BCN,88,N,N,N,N` (y 46–134) | Centred: 202 dots wide |
| Readable ID | `^FO0,145`, font `^A0N,30,30`, `^FB406,1,0,C` | e.g. `U00000013` |

Both text boxes keep at least 28 dots (3.5 mm) from the label's left and right edges.

**Barcode width:** a Code 128 symbol is 11 modules (start) + 11 per symbol + 11 (check) +
13 (stop). `U00000013` is encoded as Code B for `U`, a switch to Code C, then 4 digit
pairs: 6 symbols, **101 modules = 202 dots** (25.3 mm) at `^BY2`. Code 128 needs 10
modules (20 dots) of white on each side; centred, there are 102 dots each side. Even if
every character were encoded in Code B (9 symbols, 268 dots), it would still fit. The
generator allows at most **12 characters**: with 20 dots of quiet zone plus 8 dots (1 mm)
of position tolerance per side, a symbol may be at most 350 dots = 175 modules, and
35 + 11 × 12 = 167 ≤ 175 (13 characters would need 178).

**Text block (`^TB`):** Zebra documents `^TB` for firmware V60.14.x / V50.14.x and later,
but not whether the ZD888's V102.01.07Z firmware supports it, so labels rely on the
18-character limit and the fixed-width `^FB` field instead.

**Calibration print** (do this once before printing real labels): on any label page,
**Download the calibration labels** (`/admin/labels/calibration`) and send the file to
the printer. It prints three labels:

1. the worst case, 18 × "W" next to `EU 42.5`: "W" is so wide that the name overprints
   itself inside its box; check it never reaches the size and the size stays readable;
2. the checked reference, "New Balance 574 Wh" (18 characters) with `EU 42.5`: both should
   print cleanly on one line, as on the label already checked;
3. the same as 1 but with `^TB`: if the name is cut off neatly inside its box, the firmware
   supports `^TB`; if it runs across the label, it doesn't (the normal labels don't use it).

Then scan each label's barcode into `/admin/scan`: the calibration barcodes (`U99999992`,
`U00000013`, `U12345671`) should give "Nothing found" or an existing size, never "Check that
code". If anything is cut off or crowded, note which label and what, so the positions in
`lib/labels/zpl.ts` can be adjusted.

**Later printing options** (not built):

| Option | What it gives | Needs |
| --- | --- | --- |
| Shared Windows printer + `.zpl` file association (`copy /b file.zpl \\PC\ZD888`) | Double-click a downloaded file to print | Windows printer sharing; a driver that passes raw data through |
| Zebra Browser Print | A Print button in the admin | Zebra's free local service on the shop PC, this site approved in it, Zebra's script bundled with the site; ZD888 support to confirm |
| QZ Tray | Silent printing from the browser | A local agent; silent printing needs a paid signing certificate |
| Network printing (port 9100) | Printing without USB | A networked printer and a local helper; the hosted site can't reach the shop's network, and the printer must never be exposed to the internet |
| WebUSB | Direct USB from Chrome or Edge | Replacing the Windows driver with WinUSB, which breaks Zebra Setup Utilities. Not recommended |

### Selling later (design notes, nothing built)

A confirmed sale should be one database function that, in a single transaction, locks the
sizes involved, checks there is enough stock, lowers it, records the sale and its lines
(size, barcode and price at the time), and bumps the product's `version` so an open editor
can't overwrite the lower stock. A request ID makes a double-submitted scan harmless; the
`stock >= 0` and pre-loved `stock <= 1` rules are the last line of defence.

**Open question:** which products can be sold in the shop. Don't assume only published
ones: a pair may be on the shelf before its listing is published, so whether drafts (and
never archived products?) can be sold at the counter is still to be decided.

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

### Tests

| Command | What | Needs |
| --- | --- | --- |
| `npm test` | Unit tests (Vitest): check digit, scan input, ZPL layout, barcode width, name shortening, quantities, ZPL injection | Nothing |
| SQL Editor or `supabase test db` | `supabase/tests/*.sql` | A Supabase database (local Docker stack, or the SQL Editor) |
| `npm run test:e2e` | Browser tests (Playwright) for the scan page and label download | Docker + the Supabase CLI's local stack with all migrations, `supabase/seeds/dev_catalogue_fixtures.sql` and `e2e/fixtures.sql`; a production build running against it (`E2E_BASE_URL`); a test admin with an authenticator app (`E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_ADMIN_TOTP_SECRET`); `npx playwright install chromium` once |

The browser tests only read data and sign in, and are skipped when the variables aren't
set. Never point them, or `e2e/fixtures.sql`, at a hosted project.

### Barcodes verification status

- **Unit tests:** 37/37 pass. Lint, type-check and production build pass.
- **SQL:** all four migrations and all four SQL test files (265 checks, including the 57
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
  Re-run the test there to confirm.
- **Not run yet:** the browser tests (no local Supabase/Docker available), and a real print
  and scan on the ZD888 and DS4308.

## Enabling real checkout

No payment provider is configured in this project, so the cart is a clearly labelled demo
and `/checkout` explains that ordering isn't available yet. There is no payment form and
no fake order confirmation.

To take real orders you'll need:

1. **Real listings** in the catalogue, added in the admin area (see
   [Product management](#product-management)).
2. **Code changes:**
   - Reimplement `lib/catalog/catalog.ts` with Supabase queries.
   - Replace `lib/cart/cart-store.ts` with a server-side cart and order flow so stock
     and prices are re-checked, and unique pairs reserved, on the server.
   - Remove the demo notices (`DemoCheckoutNote`, the product-page sample notice, the
     footer note) and the `robots` noindex rule.
3. **Payments:** integrate a payment option that works in Pakistan (for example a local
   gateway, or cash on delivery if you offer it).
4. **Order emails, delivery charges and customer accounts**, which Supabase doesn't
   provide out of the box.

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
