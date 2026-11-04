import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { projectPaths } from "@/db/paths";
import type Database from "better-sqlite3";
import sharp from "sharp";

export const MAX_LOGO_BYTES = 4 * 1024 * 1024;
const MAX_LOGO_DIMENSION = 8192;
const referencePattern = /^assets\/logos\/([a-f0-9]{64})\.(png|jpg|webp)$/;
type LogoExtension = "png" | "jpg" | "webp";
const mimeTypes: Record<LogoExtension, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

function imageExtension(bytes: Buffer): LogoExtension {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) throw new Error("Logo dimensions exceed the limit.");
    if (!bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) throw new Error("Incomplete PNG logo.");
    return "png";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return "jpg";
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" &&
      bytes.readUInt32LE(4) + 8 === bytes.length && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "webp";
  throw new Error("Use a PNG, JPEG or WebP logo.");
}

export function decodeLogoDataUrl(value: string): { bytes: Buffer; extension: LogoExtension } {
  // Reject before decoding so an attacker cannot allocate an arbitrarily large buffer.
  if (value.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64) throw new Error("Logo exceeds the 4 MiB limit.");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error("Invalid logo data URL.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_LOGO_BYTES || bytes.toString("base64") !== match[2]) throw new Error("Invalid or oversized logo.");
  const extension = imageExtension(bytes);
  if (mimeTypes[extension] !== match[1]) throw new Error("Logo media type does not match its contents.");
  return { bytes, extension };
}

function logoDirectory(root: string, create: boolean): string {
  const directory = projectPaths(root).logos;
  for (const candidate of [path.dirname(/* turbopackIgnore: true */ directory), directory]) {
    if (create) fs.mkdirSync(/* turbopackIgnore: true */ candidate, { recursive: true });
    const stats = fs.lstatSync(/* turbopackIgnore: true */ candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Project assets must be ordinary project directories.");
  }
  return directory;
}

/** Immutable files are installed before the caller commits the reference in SQLite. */
export function storeLogoDataUrl(root: string, value: string): string {
  const { bytes, extension } = decodeLogoDataUrl(value);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = logoDirectory(root, true);
  const reference = `assets/logos/${digest}.${extension}`;
  const target = path.join(/* turbopackIgnore: true */ directory, `${digest}.${extension}`);
  if (fs.existsSync(/* turbopackIgnore: true */ target)) {
    readLogoDataUrl(root, reference);
    return reference;
  }
  const temporary = path.join(/* turbopackIgnore: true */ directory, `${digest}.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(/* turbopackIgnore: true */ temporary, "wx");
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); }
    finally { fs.closeSync(handle); }
    // A competing writer has the same content hash, so replacement is safe.
    // Rename also works on portable FAT/exFAT volumes, which do not support hard links.
    try { fs.renameSync(/* turbopackIgnore: true */ temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      readLogoDataUrl(root, reference);
    }
    return reference;
  } finally { fs.rmSync(/* turbopackIgnore: true */ temporary, { force: true }); }
}

/** Hydrate for SVG/PDF/browser rendering and portable exchange; never return a local OS path. */
export function readLogoDataUrl(root: string, reference: string): string {
  const match = referencePattern.exec(reference);
  if (!match) throw new Error("Invalid project logo reference.");
  const target = path.join(/* turbopackIgnore: true */ logoDirectory(root, false), `${match[1]}.${match[2]}`);
  const stats = fs.lstatSync(/* turbopackIgnore: true */ target);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_LOGO_BYTES) throw new Error("Invalid project logo file.");
  const bytes = fs.readFileSync(/* turbopackIgnore: true */ target);
  if (createHash("sha256").update(bytes).digest("hex") !== match[1] || imageExtension(bytes) !== match[2]) {
    throw new Error("Project logo is corrupted.");
  }
  return `data:${mimeTypes[match[2] as LogoExtension]};base64,${bytes.toString("base64")}`;
}

export function isLogoReference(value: string): boolean { return referencePattern.test(value); }

/**
 * Compatibility boundary for logos accepted by the former upload UI. SVG is
 * rasterized once; no SVG or XML is installed in the portable resource folder.
 * Input is a buffer, never a filename. External references and active content
 * are refused before librsvg parses it, and decoding is bounded by pixel/time limits.
 */
export async function normalizeLegacyLogoDataUrl(value: string): Promise<string> {
  if (!value.startsWith("data:image/svg+xml")) {
    decodeLogoDataUrl(value);
    return value;
  }
  if (value.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 64) throw new Error("Logo exceeds the 4 MiB limit.");
  const match = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4 !== 0) throw new Error("Invalid legacy SVG logo data URL.");
  const input = Buffer.from(match[1], "base64");
  if (input.length > MAX_LOGO_BYTES || input.toString("base64") !== match[1]) throw new Error("Invalid or oversized SVG logo.");
  const svg = input.toString("utf8");
  // XML character references are expanded before checking CSS/attribute values,
  // preventing an encoded 'url(' or href protocol from evading the preflight.
  const inspection = svg.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_whole, digits: string) => {
    const code = digits[0].toLowerCase() === "x" ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) throw new Error("Invalid SVG character reference.");
    return String.fromCodePoint(code);
  }).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  if (!/^\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(svg) ||
      /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:script|foreignObject|iframe|object|embed|image)\b|\bon\w+\s*=|\bxml:base\s*=|@|\\/i.test(inspection) ||
      /\bhref\s*=\s*(?!["']#)[^\s>]+/i.test(inspection) ||
      /url\s*\(\s*(?!["']?#)/i.test(inspection)) {
    throw new Error("Legacy SVG logo contains unsupported external or active content.");
  }
  const output = await sharp(input, { limitInputPixels: 16 * 1024 * 1024, failOn: "warning" })
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .png().timeout({ seconds: 5 }).toBuffer();
  if (output.length > MAX_LOGO_BYTES) throw new Error("Normalized logo exceeds the 4 MiB limit.");
  const normalized = `data:image/png;base64,${output.toString("base64")}`;
  decodeLogoDataUrl(normalized);
  return normalized;
}

export async function normalizeLogoDataUrl(root: string, value: string): Promise<string> {
  if (isLogoReference(value)) { readLogoDataUrl(root, value); return value; }
  return storeLogoDataUrl(root, await normalizeLegacyLogoDataUrl(value));
}

/** Prepare immutable resources before the transaction; the original graph stays untouched. */
export async function prepareHallMigrationLogos(sqlite: Database.Database, root: string): Promise<Record<string, string>> {
  const values = new Set<string>();
  for (const row of sqlite.prepare("SELECT logo_data_url FROM schedule_settings WHERE logo_data_url IS NOT NULL").all() as { logo_data_url: string }[]) {
    if (row.logo_data_url) values.add(row.logo_data_url);
  }
  for (const row of sqlite.prepare("SELECT snapshot FROM schedule_versions").all() as { snapshot: string }[]) {
    const snapshot = JSON.parse(row.snapshot) as { settings?: { logoDataUrl?: unknown } };
    if (typeof snapshot.settings?.logoDataUrl === "string" && snapshot.settings.logoDataUrl) values.add(snapshot.settings.logoDataUrl);
  }
  const references: Record<string, string> = {};
  // Sequential decoding bounds peak memory even for a project with many SVG histories.
  for (const value of values) references[value] = await normalizeLogoDataUrl(root, value);
  return references;
}

// Do not garbage-collect immutable logos here: history and other halls may retain references.
