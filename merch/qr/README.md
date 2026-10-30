# Merchandise QR code

The permanent QR code for Kharch n Save merchandise. It contains exactly
**https://kharchnsave.pk/qr**, which redirects (temporarily, so it can be changed
any time) to wherever `QR_REDIRECT_TARGET` in `lib/links.ts` points; today that's
the links page, `/links?utm_source=merch&utm_medium=qr`. Printed codes never need
replacing.

| File | Use |
| --- | --- |
| `kharchnsave-qr.svg` | Vector, for printers and designers. 50 mm square, scales to any size. |
| `kharchnsave-qr.pdf` | Vector, one 50 mm page. |
| `kharchnsave-qr.png` | 2000 × 2000 px, for screens and quick mock-ups. |

Regenerate with `npm run qr` (settings in `lib/qr/merch-qr.ts`); `npm test`
decodes the files here with two real QR decoders and fails if they are out of
date.

**Printing:**

- Keep the white border (4 modules, about 4 mm at 50 mm) and the colours:
  dark green on white. Don't invert it, put it on a busy background, or change
  the logo.
- Print it at least **2 cm** wide, border included; 3 cm or more for fabric or
  anything scanned from further than an arm's length.
- Test a printed proof with a couple of phones (camera app and a QR app) before
  a full run.

**Design:** version 6 (41 × 41 modules), error correction H, forest green
`#163a2c` on white. The K mark sits on a white tile of exactly 15 × 15 modules in
the centre (9.4% of the image). Whole modules are cleared under it, and the mask
pattern is chosen so the tile and mark use at most 10 of the 14 errors each
error-correction block can fix, leaving room for scratches, dirt and blur.
