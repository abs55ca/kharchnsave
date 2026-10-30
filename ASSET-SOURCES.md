# Asset sources

Where every image in `public/images` came from. Product photos are **temporary
demonstration images**: they show stock photography, not Kharch n Save inventory,
and should be replaced with photos of the actual pairs before launch.

## Supplied by Kharch n Save

| File | Source | Notes |
| --- | --- | --- |
| `/images/hero/kharch-n-save-hero.png` | Hero banner supplied with the project brief (2172×724) | Used unmodified. Shows Nike Air Force 1 sneakers; confirm you have rights to use this campaign image. |
| `/images/brand/kharch-n-save-logo.svg` | `Logo/Logo-01.svg` from the brand files | viewBox cropped to the artwork; paths unchanged. |
| `/images/brand/kharch-n-save-logo-reverse.svg` | `Logo/Logo-01.svg` | Same artwork with the forest-green fill (`#163a2c`) switched to white for dark backgrounds. |
| `app/icon.png`, `app/apple-icon.png` | `Logo/Logo-03.png` (K mark) | Padded onto a white square. |
| `lib/brand/k-mark.ts` (K mark on `/links`, its social preview and the merchandise QR code in `merch/qr/`) | `Logo/Logo-03.svg` from the brand files | The green K and lime tag paths copied unchanged; viewBox cropped to the artwork. Two tiny unstyled paths from the Illustrator export (no fill colour, so they render as black specks) are left out. |
| `/images/departments/men.png`, `men-tilted.png` | Cut-outs supplied by Kharch n Save as `men.png` / `men-tilted.png` | Each pair cropped to a shared box and resized to 800 px wide. Shows Nike Lunarglide running shoes. |
| `/images/departments/women.png`, `women-tilted.png` | Supplied as `women.png` / `women-tilted.png` | As above. Shows ASICS running shoes. |
| `/images/departments/kids.png`, `kids-tilted.png` | Supplied as `kid.png` / `kid-tilted.png` | As above. Shows Nike kids' running shoes. |

## Unsplash photos

All photos below were downloaded from Unsplash's image CDN and are published under the
[Unsplash License](https://unsplash.com/license): free to use for commercial and
non-commercial purposes without permission or attribution. The license does not allow
selling unaltered copies or compiling photos to build a competing image service.
Attribution is not required, but photographers are credited here. None of these are
Unsplash+ images. Brands visible in photos (Nike, Jordan, Vans, New Balance, Converse)
belong to their owners; the license does not cover trademarks.

Search pages were filtered to free-license results (`?license=free`), and one photo page
was spot-checked and showed "Free to use under the Unsplash License" (checked 25 October 2026).

### Banners

| File | Photographer | Unsplash page | Size |
| --- | --- | --- | --- |
| `/images/banners/coming-soon-clothing.jpg` | Alyssa Strohmann | <https://unsplash.com/photos/TS--uNw-JqE> | 1200×900 |
| `/images/banners/coming-soon-shoes.jpg` | Nguyễn Duy Hưng | <https://unsplash.com/photos/JIVDJ5xZrWA> | 1200×800 |
| `/images/banners/kids-adventures.jpg` | Amanda Belec | <https://unsplash.com/photos/Z1JgfuSQ80s> | 2000×1333 |

### Demo product photos

| File | Photographer | Unsplash page | Size |
| --- | --- | --- | --- |
| `/images/products/air-jordan-1-black-red.jpg` | Taylor Smith | <https://unsplash.com/photos/aDZ5YIuedQg> | 1400×934 |
| `/images/products/baby-canvas-sneakers-teal-1.jpg` | Kawê Rodrigues | <https://unsplash.com/photos/GpQzF1AjVN0> | 1400×2100 |
| `/images/products/baby-canvas-sneakers-teal-2.jpg` | Kawê Rodrigues | <https://unsplash.com/photos/WTV6q0kxvrM> | 1400×2100 |
| `/images/products/canvas-sneakers-red.jpg` | Paulina Milde-Jachowska | <https://unsplash.com/photos/bJqg5g6EANs> | 1400×2104 |
| `/images/products/kids-high-tops-mint.jpg` | serjan midili | <https://unsplash.com/photos/UHVsk0zSVc8> | 1400×2097 |
| `/images/products/leather-brogues-tan.jpg` | Monaal Garg | <https://unsplash.com/photos/99NxpMVxWDA> | 1400×933 |
| `/images/products/new-balance-x90-pink.jpg` | Maksim Larin | <https://unsplash.com/photos/ezdrvzA1hZw> | 1400×1000 |
| `/images/products/nike-af1-shadow-pastel.jpg` | Ryan Plomp | <https://unsplash.com/photos/jvoZ-Aux9aw> | 1400×2100 |
| `/images/products/nike-air-force-1-black.jpg` | Andres Jasso | <https://unsplash.com/photos/PqbL_mxmaUE> | 1400×1960 |
| `/images/products/nike-air-max-sail-orange-1.jpg` | Luis Felipe Lins | <https://unsplash.com/photos/J2-wAQDckus> | 1400×1120 |
| `/images/products/nike-air-max-sail-orange-2.jpg` | Luis Felipe Lins | <https://unsplash.com/photos/LG88A2XgIXY> | 1400×1120 |
| `/images/products/nike-free-rn-red.jpg` | Ryan Waring | <https://unsplash.com/photos/164_6wVEHfI> | 1400×933 |
| `/images/products/pointed-pumps-ivory.jpg` | Emily Pottiger | <https://unsplash.com/photos/Zx76sbAndc0> | 1400×933 |
| `/images/products/star-print-sneakers-navy.jpg` | Edwin Ghasemi | <https://unsplash.com/photos/I5z7_ZYezdc> | 1400×2100 |
| `/images/products/stiletto-ankle-boots-black.jpg` | mostafa mahmoudi | <https://unsplash.com/photos/uianIkmhuvk> | 1400×933 |
| `/images/products/strappy-heeled-sandals-nude.jpg` | Chitto Cancio | <https://unsplash.com/photos/9urrzNhb3PU> | 1400×2108 |
| `/images/products/toddler-canvas-sneakers-red.jpg` | Steve O'Reilly | <https://unsplash.com/photos/HwfuoxlAOls> | 1400×935 |
| `/images/products/vans-old-skool-maroon.jpg` | Paul Gaudriault | <https://unsplash.com/photos/a-QH9MAAVNI> | 1400×2042 |

Images were downloaded at a fixed width and some were re-compressed (JPEG quality 74)
to keep the repository small. `next/image` resizes them further at request time.
