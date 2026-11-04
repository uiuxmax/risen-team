#!/usr/bin/env node
// Rebuild native/assets from the checked-in sign using the locked sharp version.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(root, "native/assets"));
const artwork = path.join(root, "assets/logo-sign.svg");
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const images = new Map(await Promise.all(sizes.map(async (size) => [size, await sharp(artwork).resize(size, size).png().toBuffer()])));
fs.mkdirSync(output, { recursive: true });

// Windows ICO directory entries point to complete PNG images.
const windowsSizes = sizes.slice(0, 6);
const header = Buffer.alloc(6 + windowsSizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(windowsSizes.length, 4);
let offset = header.length;
for (const [index, size] of windowsSizes.entries()) {
  const dimension = size;
  const image = images.get(dimension);
  const entry = 6 + index * 16;
  header[entry] = dimension === 256 ? 0 : dimension; header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
fs.writeFileSync(path.join(output, "app.ico"), Buffer.concat([header, ...windowsSizes.map((size) => images.get(size))]));

// Modern ICNS image types carry PNG payloads at each standard pixel size.
const macSizes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];
const chunks = macSizes.map(([type, size]) => {
  const image = images.get(size); const chunk = Buffer.alloc(8);
  chunk.write(type, 0, "ascii"); chunk.writeUInt32BE(image.length + 8, 4);
  return Buffer.concat([chunk, image]);
});
const icnsHeader = Buffer.alloc(8); icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
fs.writeFileSync(path.join(output, "app.icns"), Buffer.concat([icnsHeader, ...chunks]));
fs.writeFileSync(path.join(output, "menubar.png"), images.get(32));
