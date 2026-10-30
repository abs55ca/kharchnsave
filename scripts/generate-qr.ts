/**
 * Writes the merchandise QR code: `npm run qr`.
 *
 *   merch/qr/kharchnsave-qr.svg   vector, for printers (50 mm, scales to any size)
 *   merch/qr/kharchnsave-qr.pdf   vector, one 50 mm page
 *   merch/qr/kharchnsave-qr.png   2000 × 2000 px
 *
 * The content is always MERCH_QR.url (lib/links.ts: https://kharchnsave.pk/qr),
 * never the address the site happens to be running on. No secrets are read.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildMerchQr,
  MERCH_QR,
  MERCH_QR_FILES,
  renderMerchQrPdf,
  renderMerchQrPng,
  renderMerchQrSvg,
} from "@/lib/qr/merch-qr";

async function main() {
  const qr = await buildMerchQr();

  await mkdir(dirname(MERCH_QR_FILES.svg), { recursive: true });
  await writeFile(MERCH_QR_FILES.svg, renderMerchQrSvg(qr));
  await writeFile(MERCH_QR_FILES.pdf, await renderMerchQrPdf(qr));
  await writeFile(MERCH_QR_FILES.png, await renderMerchQrPng(qr));

  const total = qr.size + 2 * MERCH_QR.border;
  const tileArea = qr.tile.size ** 2;
  console.log(`QR code for ${qr.url}`);
  console.log(`  version ${MERCH_QR.version} (${qr.size} × ${qr.size} modules), error correction ${MERCH_QR.errorCorrectionLevel}, mask ${qr.mask}`);
  console.log(
    `  logo tile ${qr.tile.size} × ${qr.tile.size} modules: ${((tileArea / qr.size ** 2) * 100).toFixed(1)}% of the code, ` +
      `${((tileArea / total ** 2) * 100).toFixed(1)}% of the image with its border`,
  );
  console.log(
    `  codewords misread under the tile and mark, per block: ${qr.misreadCodewordsPerBlock.worstCase.join(", ")} at worst ` +
      `(${qr.misreadCodewordsPerBlock.certain.join(", ")} certainly); each block corrects ${qr.correctablePerBlock}`,
  );
  for (const file of Object.values(MERCH_QR_FILES)) console.log(`  wrote ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
