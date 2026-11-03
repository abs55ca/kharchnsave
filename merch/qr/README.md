# Merchandise QR code

The permanent QR code for Kharch n Save merchandise. It contains exactly
**https://kharchnsave.pk/qr**, which redirects (temporarily, so it can be changed
any time) to wherever `QR_REDIRECT_TARGET` in `lib/links.ts` points; today that's
the links page, `/links?utm_source=merch&utm_medium=qr`. Printed codes never need
replacing.

There are two designs with the same structure and the same content:

| Design | Files | Use |
| --- | --- | --- |
| **Main**: white modules and white K mark on forest green `#163a2c` | `kharchnsave-qr.svg`, `.pdf`, `.png` | The brand look. An **inverted** code (light on dark): see below. |
| **Light** (fallback): forest-green modules and green K mark on white | `light/kharchnsave-qr-light.svg`, `.pdf`, `.png` | Where scanning reliability matters more than looks. A normal code every scanner reads. |

SVG and PDF are vector (50 mm square, scale to any size): send those to printers.
The PNG is 2000 × 2000 px, for screens and quick mock-ups.

Regenerate with `npm run qr` (settings in `lib/qr/merch-qr.ts`); `npm test`
decodes the files here with two real QR decoders and fails if they are out of
date.

## Before ordering: test the main design on real phones

The main design is an **inverted QR code** (light modules on a dark background).
Most current phone camera apps read inverted codes, but not every scanner does:
some older Android phones, older QR apps and some in-app scanners may not. Before
ordering, print a proof at the real size on the real material and scan it with:

- several phones, **including older Android phones**, using the built-in camera app;
- the scanners inside **WhatsApp** and **Instagram**, and Google Lens;
- at arm's length and closer, in shop lighting and outdoors.

If any of these fail, use the light design for that product.

## Printing

- Keep the quiet zone: the 4-module border around the code (about 4 mm at 50 mm),
  in the design's background colour. On the main design the green border is part of
  the code; don't trim it or print it on a different green.
- Keep the colours exactly: don't swap, lighten or add effects, and don't place the
  code on a busy background.
- Print it at least **2 cm** wide, border included; 3 cm or more for fabric or
  anything scanned from further than an arm's length. Dark garments: the main
  design printed in white ink on the garment itself only works if the garment's
  colour is close to the forest green; otherwise print the whole square.

## Design

Version 6 (41 × 41 modules), error correction H. The K mark sits in the centre on a
cleared area of exactly 15 × 15 modules (9.4% of the image), with no tile behind it;
whole modules are cleared. For each design, the mask pattern is chosen so the logo
area uses at most 10 of the 14 errors each error-correction block can fix, leaving
room for scratches, dirt and blur.
