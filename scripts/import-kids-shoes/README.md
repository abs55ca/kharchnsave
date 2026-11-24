# Kids' shoes import (one-off)

Uploads the 103 kids' shoes in `C:\Users\abs55\Documents\KharchnSave\images\New folder` as
**draft** products, with all their photos, through the same database functions as the admin
product pages, signed in as you (admin email, password and 6-digit code; nothing is stored).

Each folder becomes one listing:

- **Size and stock:** one size (from the photo named after it, e.g. `31.jpg`; Folder 93 is 29.5), stock 1.
- **Product details:** department Kids, new, brand Unbranded. The item code is assigned automatically (`ITEM-…`).
- **Photos:** all of the folder's photos. The timestamped shots come first and the size photo last (it is sometimes the sole).
- **Price:** Rs. 0, so it stays a hidden draft until you price it.

Names, colours and descriptions are in [`shoes.ts`](shoes.ts): generic names, because several
designs copy characters, team logos or sportswear marks. **Folder 43 is skipped** (no size
photo).

## Run it (from the project folder)

```sh
# 1. Check everything, upload nothing (lists every listing and its web address):
npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts --dry-run

# 2. Try one shoe, then look at it in Admin → Products (drafts):
npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts --only 1

# 3. The rest (the shoe from step 2 is skipped as already done):
npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/index.mts
```

It uses the Supabase project in `.env.local` and prints its address before asking you to sign in.
It takes roughly 10–20 minutes for all 511 photos, depending on your upload speed.

**If it stops** (no internet, the session expired, a photo refused), just run the same command again.
Progress is saved after every step in
`C:\Users\abs55\Documents\KharchnSave\images\kids-shoes-import-progress.json`. A rerun continues
where it stopped, finds a product whose answer was lost by its web address, and never records a
photo twice. Don't delete that file until the import has finished.

## Pricing them by size

`price.mts` puts every imported shoe (from the progress file above) on automatic pricing in the
**Kids Sneakers** group (maximum Rs. 4,000). Each shoe's score comes from its size, in a
straight line from 45 at EU 22 to 100 at EU 36 (never below 45; see [`size-score.ts`](size-score.ts)).
With the Rs. 95 price ending, that gives Rs. 1,795 (EU 22) up to Rs. 3,995 (EU 36):

```sh
# The expected prices per size (nothing online):
npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/price.mts --dry-run

# Sign in, see the database's preview per size, type "yes" to apply:
npx tsx --tsconfig scripts/import-kids-shoes/tsconfig.json scripts/import-kids-shoes/price.mts
```

It creates the group if it doesn't exist (and stops if a group with that name has another
maximum). Nothing is applied if any shoe would be skipped, or if anything changed between the
preview and your "yes". Running it again changes nothing. The shoes stay drafts.

Later, changing the group's maximum on the **Pricing** page reprices them all together, keeping
each one's size-based score.

## Afterwards

1. Check the prices, then publish the shoes.
2. Add Folder 43 by hand once you know its size.

## Tests

- `npx vitest run --config scripts/import-kids-shoes/vitest.config.mts`: resume and retry rules with a fake Supabase, and the size scores and prices.
- `--dry-run`: every listing passes the admin form's checks, and every photo goes through the
  site's photo processing.
