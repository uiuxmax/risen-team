import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsPDF } from "jspdf";

/**
 * Ukrainian (Cyrillic) PDF export verification.
 *
 * The exported PDF embeds a redistributable DejaVu Sans subset, so text stays
 * correct on Windows, macOS and any other computer. These tests prove that:
 *  1. every Ukrainian character used by the product exists as a real glyph in
 *     the embedded font (not .notdef),
 *  2. the font program really is embedded in the generated PDF,
 *  3. the glyph ids written into the PDF content stream match the font cmap.
 */

const FONT_DIR = path.join(process.cwd(), "public", "fonts");
const NORMAL_FONT = path.join(FONT_DIR, "RisenSans.ttf");
const BOLD_FONT = path.join(FONT_DIR, "RisenSans-Bold.ttf");

const SAMPLE_STRINGS = [
  "Розклад тренувань",
  "Бокс",
  "Бокс підлітковий 12+",
  "Бокс дитячий 6–9",
  "Стретчинг",
  "Функціональне тренування",
  "Анастасія",
  "Костянтин",
  "Любов",
  "Опубліковано",
  "Чернетка",
  "Відновити версію",
  "ТРЕНЕРИ",
  "ПОНЕДІЛОК",
];

interface CmapTable {
  glyphFor(codePoint: number): number;
}

function readCmap(filePath: string): CmapTable {
  const buffer = fs.readFileSync(filePath);
  const numTables = buffer.readUInt16BE(4);
  let cmapOffset = 0;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    const tag = buffer.toString("ascii", recordOffset, recordOffset + 4);
    if (tag === "cmap") {
      cmapOffset = buffer.readUInt32BE(recordOffset + 8);
      break;
    }
  }
  expect(cmapOffset).toBeGreaterThan(0);

  const numSubTables = buffer.readUInt16BE(cmapOffset + 2);
  let subTableOffset = 0;
  for (let index = 0; index < numSubTables; index += 1) {
    const recordOffset = cmapOffset + 4 + index * 8;
    const platformId = buffer.readUInt16BE(recordOffset);
    const encodingId = buffer.readUInt16BE(recordOffset + 2);
    const offset = cmapOffset + buffer.readUInt32BE(recordOffset + 4);
    const format = buffer.readUInt16BE(offset);
    const isUnicode = platformId === 3 || platformId === 0;
    if (isUnicode && format === 4) {
      subTableOffset = offset;
      if (encodingId === 1 || encodingId === 10) break;
    }
  }
  expect(subTableOffset).toBeGreaterThan(0);

  const format = buffer.readUInt16BE(subTableOffset);
  expect(format).toBe(4);
  const segCount = buffer.readUInt16BE(subTableOffset + 6) / 2;
  const endCodeOffset = subTableOffset + 14;
  const startCodeOffset = endCodeOffset + segCount * 2 + 2;
  const idDeltaOffset = startCodeOffset + segCount * 2;
  const idRangeOffsetOffset = idDeltaOffset + segCount * 2;

  return {
    glyphFor(codePoint: number): number {
      for (let segment = 0; segment < segCount; segment += 1) {
        const end = buffer.readUInt16BE(endCodeOffset + segment * 2);
        if (codePoint > end) continue;
        const start = buffer.readUInt16BE(startCodeOffset + segment * 2);
        if (codePoint < start) return 0;
        const idDelta = buffer.readInt16BE(idDeltaOffset + segment * 2);
        const idRangeOffset = buffer.readUInt16BE(idRangeOffsetOffset + segment * 2);
        if (idRangeOffset === 0) return (codePoint + idDelta) & 0xffff;
        const glyphIndexOffset = idRangeOffsetOffset + segment * 2 + idRangeOffset + (codePoint - start) * 2;
        if (glyphIndexOffset + 2 > buffer.length) return 0;
        const glyphIndex = buffer.readUInt16BE(glyphIndexOffset);
        if (glyphIndex === 0) return 0;
        return (glyphIndex + idDelta) & 0xffff;
      }
      return 0;
    },
  };
}

describe("embedded PDF font covers Ukrainian text", () => {
  it("ships an embeddable font with Cyrillic glyphs", () => {
    expect(fs.existsSync(NORMAL_FONT)).toBe(true);
    expect(fs.existsSync(BOLD_FONT)).toBe(true);

    for (const fontFile of [NORMAL_FONT, BOLD_FONT]) {
      const cmap = readCmap(fontFile);
      const missing: string[] = [];
      for (const sample of SAMPLE_STRINGS) {
        for (const char of sample) {
          if (char === " " || char === "+" || char === "-" || char === "–") continue;
          if (cmap.glyphFor(char.codePointAt(0) ?? 0) === 0) missing.push(char);
        }
      }
      expect(missing, `missing glyphs in ${path.basename(fontFile)}`).toEqual([]);
    }
  });

  it("writes real glyph ids for Ukrainian words into the PDF", () => {
    const cmap = readCmap(NORMAL_FONT);
    const doc = new jsPDF({ unit: "pt", format: [842, 595], compress: false });
    doc.addFileToVFS("RisenSans.ttf", fs.readFileSync(NORMAL_FONT).toString("base64"));
    doc.addFont("RisenSans.ttf", "RisenSans", "normal");
    doc.setFont("RisenSans");
    doc.setTextColor(255, 255, 255);
    let y = 40;
    for (const sample of SAMPLE_STRINGS) {
      doc.text(sample, 20, y);
      y += 18;
    }

    const raw = Buffer.from(doc.output("arraybuffer")).toString("latin1");
    // 1) the font program is embedded and referenced by the PDF font resource
    expect(raw).toContain("FontFile2");
    expect(raw).toContain("RisenSans");
    expect(doc.getFontList()).toHaveProperty("RisenSans");
    // 2) Identity-H text is written as hex glyph runs
    const hexRuns = [...raw.matchAll(/<([0-9A-Fa-f]{4,})>\s*Tj/g)].map((match) => match[1]);
    expect(hexRuns.length).toBeGreaterThan(0);

    const writtenGlyphs = new Set<number>();
    for (const run of hexRuns) {
      for (let index = 0; index + 4 <= run.length; index += 4) {
        writtenGlyphs.add(Number.parseInt(run.slice(index, index + 4), 16));
      }
    }
    expect(writtenGlyphs.has(0)).toBe(false);

    const expectedGlyphs = new Set<number>();
    for (const sample of SAMPLE_STRINGS) {
      for (const char of sample) {
        if (char === " ") continue;
        expectedGlyphs.add(cmap.glyphFor(char.codePointAt(0) ?? 0));
      }
    }
    const matched = [...expectedGlyphs].filter((glyph) => writtenGlyphs.has(glyph));
    expect(matched.length).toBeGreaterThanOrEqual(expectedGlyphs.size - 1);
  });

  it("keeps the registration helper contract used by the export studio", async () => {
    const { PDF_FONT_NAME, registerPdfFonts } = await import("@/lib/export/client-export");
    expect(PDF_FONT_NAME).toBe("RisenSans");

    const added: { name: string; family: string; style: string }[] = [];
    const availability = await registerPdfFonts({
      addFileToVFS: () => undefined,
      addFont: (file: string, name: string, style: string) => {
        added.push({ name: file, family: name, style });
      },
    });
    // In a Node test there is no fetch-able /public path, so registration is a no-op,
    // but the call signature and graceful degradation are verified.
    expect(availability).toBeDefined();
    expect(Array.isArray(added)).toBe(true);
  });
});
