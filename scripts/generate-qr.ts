/**
 * Writes the merchandise QR codes: `npm run qr`.
 *
 *   merch/qr/kharchnsave-qr.{svg,pdf,png}               main: white on forest green (inverted)
 *   merch/qr/light/kharchnsave-qr-light.{svg,pdf,png}   fallback: forest green on white
 *
 * SVG and PDF are vector (50 mm, scale to any size); PNG is 2000 × 2000 px.
 * The content is always MERCH_QR.url (lib/links.ts: https://kharchnsave.pk/qr),
 * never the address the site happens to be running on. No secrets are read.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildMerchQr,
  MERCH_QR,
  MERCH_QR_DESIGNS,
  renderMerchQrPdf,
  renderMerchQrPng,
  renderMerchQrSvg,
} from "@/lib/qr/merch-qr";

async function main() {
  console.log(`QR codes for ${MERCH_QR.url}`);
  console.log(`  version ${MERCH_QR.version} (41 × 41 modules), error correction ${MERCH_QR.errorCorrectionLevel}`);
  for (const design of Object.values(MERCH_QR_DESIGNS)) {
    const qr = await buildMerchQr(design);
    await mkdir(dirname(design.files.svg), { recursive: true });
    await writeFile(design.files.svg, renderMerchQrSvg(qr));
    await writeFile(design.files.pdf, await renderMerchQrPdf(qr));
    await writeFile(design.files.png, await renderMerchQrPng(qr));

    const total = qr.size + 2 * MERCH_QR.border;
    const area = qr.logoArea.size ** 2;
    const { certain, worstCase } = qr.misreadCodewordsPerBlock;
    console.log(`\n${design.id}: ${design.description}, mask ${qr.mask}`);
    console.log(
      `  logo area ${qr.logoArea.size} × ${qr.logoArea.size} modules: ${((area / qr.size ** 2) * 100).toFixed(1)}% of the code, ` +
        `${((area / total ** 2) * 100).toFixed(1)}% of the image with its quiet zone`,
    );
    console.log(
      `  codewords misread in the logo area, per block: ${worstCase.join(", ")} at worst ` +
        `(${certain.join(", ")} certainly); each block corrects ${qr.correctablePerBlock}`,
    );
    for (const file of Object.values(design.files)) console.log(`  wrote ${file}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
